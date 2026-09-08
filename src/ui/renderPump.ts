/**
 * 页渲染泵 (2.8.0 第一批: 当前页优先 + 取消过时渲染)。
 *
 * 此前 pumpRenders 在可视窗口里**按页码从小到大**挑第一个待渲染的页,并且
 * 一旦某页的重建卡住(pdf.js 忙、字体未就绪、严格排版慢),整个泵就被它占住
 * 20 秒 —— 用户翻到新页,新页要排在那 20 秒之后。两件事分开修:
 *
 *   排序   当前页 → 其他可见页(按到当前页的距离)→ 邻近预取页。
 *   取消   在飞任务一旦离开「可视范围前后各 keep 页」,立刻 abort;超时同样
 *          abort(而不是只让 Promise.race 先返回,留一个没人管的任务继续跑
 *          到底、最后往一个早已不该更新的槽里提交 DOM)。
 *
 * 这个模块**不碰 DOM、不认识 slot**: 窗口、"这页要不要重画"、结果如何落到槽
 * 状态机,全部由调用方经 deps 提供。于是优先级与取消都能在没有 DOM 的单测里
 * 直接驱动 —— 这正是"模拟上一页迟迟不返回,切到新页,新页先开始"要验证的。
 */

import type { PageRenderResult } from './translationPane';

/** 在飞任务允许留在窗口外的页数 —— 超过就取消。 */
export const KEEP_PAGES = 1;
/** 单趟泵送最多渲染多少页(防止死循环)。 */
export const MAX_STEPS = 24;
/** 只是在等退避的页,过这么久再来看一眼。 */
export const RETRY_POLL_MS = 1500;
/** 单页重建的硬超时: 到点取消,不是只让 race 返回。 */
export const RENDER_TIMEOUT_MS = 20000;

export interface RenderWindow {
	/** 阅读器当前页 —— 距离排序的原点。 */
	current: number;
	/** **严格可视**范围的首末页,闭区间。 */
	first: number;
	last: number;
	/** 可视范围之外还要预取几页。 */
	buffer: number;
}

export interface CandidateInput extends RenderWindow {
	/** 这一页现在要不要重画(已含退避判断)。 */
	needs(page: number): boolean;
}

/**
 * 候选页排序 —— 纯函数。返回值第一项就是这一趟该渲染的页;空数组 = 没得渲染。
 *
 * 两层: **可视页**整体先于**预取页**;层内按到当前页的距离排(当前页距离为 0,
 * 自然排第一),距离相同的先渲染页码小的。分层是必须的 —— 一个距离更近的
 * 预取页也不该抢在任何一个用户正看着的页前面。
 */
export function orderRenderCandidates(input: CandidateInput): number[] {
	const { current, first, last, buffer } = input;
	const byDistance = (a: number, b: number): number =>
		Math.abs(a - current) - Math.abs(b - current) || a - b;
	const visible: number[] = [];
	const prefetch: number[] = [];
	for (let page = Math.max(0, first - buffer); page <= last + buffer; page++) {
		if (!input.needs(page)) {
			continue;
		}
		(page >= first && page <= last ? visible : prefetch).push(page);
	}
	visible.sort(byDistance);
	prefetch.sort(byDistance);
	return [...visible, ...prefetch];
}

/** 在飞的这一页是否已经远到该取消了 —— 纯函数。 */
export function shouldAbortInFlight(input: {
	page: number;
	first: number;
	last: number;
	keep?: number;
}): boolean {
	const keep = input.keep ?? KEEP_PAGES;
	return input.page < input.first - keep || input.page > input.last + keep;
}

export interface RenderPumpDeps {
	/** 当前窗口。每渲染完一页都会重新问一次。 */
	windowOf(): RenderWindow | null;
	/** 这一页要不要重画(调用方自己判退避)。 */
	needsRender(page: number): boolean;
	/** 还有页在等退避吗 —— 决定要不要排一次轮询。 */
	anyWaiting(): boolean;
	/** 真正重建一页。必须尊重 signal: 取消后不得再提交 DOM。 */
	render(page: number, signal: AbortSignal): Promise<PageRenderResult>;
	/** 一页渲染结束(含被取消)后回写槽状态。 */
	commit(page: number, result: PageRenderResult, aborted: boolean): void;
	/** 一趟泵送结束时的收尾(释放远处的槽)。 */
	afterPass?(): void;
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** 排一次后续泵送(延迟毫秒)。 */
	schedule(delayMs: number): void;
	timeoutMs?: number;
	maxSteps?: number;
}

export class RenderPump {
	private running = false;
	/** 泵送期间到达的更新 —— 退出时必须补一次,否则这次更新被吞掉。 */
	private pending = false;
	private inFlight: { page: number; controller: AbortController } | null = null;

	constructor(private readonly deps: RenderPumpDeps) {}

	get busyPage(): number | null {
		return this.inFlight?.page ?? null;
	}

	/**
	 * 有更新到达(滚动、翻页、译文到达、尺寸变化)。先看在飞任务是不是已经
	 * 过时 —— 过时就取消,好让当前页立刻开始,而不是排在它后面。
	 */
	request(): void {
		this.abortStale();
		if (this.running) {
			this.pending = true;
			return;
		}
		void this.run();
	}

	/** 在飞任务离开「可视范围前后各 KEEP_PAGES 页」就取消。 */
	abortStale(): void {
		const flight = this.inFlight;
		const win = this.deps.windowOf();
		if (!flight || !win) {
			return;
		}
		if (shouldAbortInFlight({ page: flight.page, first: win.first, last: win.last, keep: win.buffer })) {
			flight.controller.abort();
		}
	}

	/** 面板销毁 / 切视图: 在飞任务立刻取消。 */
	cancelAll(): void {
		this.inFlight?.controller.abort();
		this.inFlight = null;
		this.pending = false;
	}

	async run(): Promise<void> {
		if (this.running) {
			this.pending = true;
			return;
		}
		this.running = true;
		try {
			for (let step = 0; step < (this.deps.maxSteps ?? MAX_STEPS); step++) {
				this.pending = false;
				const win = this.deps.windowOf();
				if (!win) {
					break;
				}
				const target = orderRenderCandidates({
					...win,
					needs: page => this.deps.needsRender(page)
				})[0];
				if (target === undefined) {
					// 剩下的只是在等退避 —— 过一会儿再来,不空转。
					if (this.deps.anyWaiting()) {
						this.deps.schedule(RETRY_POLL_MS);
					}
					break;
				}
				await this.renderOne(target);
			}
			this.deps.afterPass?.();
		}
		finally {
			this.running = false;
			if (this.pending) {
				// 泵送期间到达的更新不能被吞掉 (2.8.0): 此前 pumping 为真时
				// 的 scheduleEnsure 直接返回,那一次更新就永远没人处理了。
				this.pending = false;
				this.deps.schedule(0);
			}
		}
	}

	private async renderOne(page: number): Promise<void> {
		const controller = new AbortController();
		this.inFlight = { page, controller };
		let timer: unknown = null;
		let result: PageRenderResult = false;
		try {
			result = await new Promise<PageRenderResult>(resolve => {
				// 超时必须**同时取消**: 只让 race 先返回会留下一个没人管的
				// 任务继续跑到底,最后往一个早已不该更新的槽里提交 DOM。
				timer = this.deps.setTimer(() => {
					controller.abort();
					resolve(false);
				}, this.deps.timeoutMs ?? RENDER_TIMEOUT_MS);
				this.deps.render(page, controller.signal).then(resolve, () => resolve(false));
			});
		}
		finally {
			// 正常完成也要清掉定时器,否则每页留一个 20 秒的挂单。
			this.deps.clearTimer(timer);
			this.inFlight = null;
		}
		this.deps.commit(page, result, controller.signal.aborted);
	}
}
