/**
 * 每服务商「真实在途 HTTP 请求」闸 (2.1.8, 优化计划 第二批 请求级并发调度)。
 *
 * 背景:RequestScheduler 已经在**页面级**做了每服务商(lane)并发页数上限 +
 * 前台保留槽 + 429 自适应。但一个页面任务内部还会并发多个真实请求
 * (CHUNK_CONCURRENCY=2,补救阶段更高),所以「N 个并行页」会被放大成
 * 2N~4N 个请求同时打向**同一个服务商**——这才是 429、卡顿与浪费的直接来源。
 *
 * 本闸补上第二层:所有真实请求出手前先经 `run(lane, foreground, fn)` 取得该
 * lane 的一个在途名额,`fn` 结束(成功/失败)即释放。lane 满时排队;**前台
 * (当前页)请求插到后台等待者之前**,保证用户正在看的页永远优先出手。
 *
 * 纯逻辑、无 DOM、无计时器,单元可测(注入 fn)。abort 交由 fn 自身处理:
 * 被取消的请求在轮到它时立即 reject 并释放名额,不会泄漏。
 */

import { PaperMirrorError } from '../types/models';

interface Waiter {
	foreground: boolean;
	resolve: () => void;
}

export class RequestGate {
	private readonly defaultCap: number;
	private readonly caps = new Map<string, number>();
	private readonly inFlight = new Map<string, number>();
	private readonly waiters = new Map<string, Waiter[]>();
	/** 峰值在途(诊断用):lane → 见过的最大并发。 */
	private readonly peak = new Map<string, number>();

	constructor(defaultCap = 4) {
		this.defaultCap = Math.max(1, Math.floor(defaultCap));
	}

	/** 设定某 lane 的在途上限(≥1)。调低不打断已在途请求,只收窄后续放行。 */
	setCap(lane: string, cap: number): void {
		this.caps.set(lane, Math.max(1, Math.floor(cap)));
		this.drain(lane);
	}

	private capOf(lane: string): number {
		return this.caps.get(lane) ?? this.defaultCap;
	}

	inFlightOf(lane: string): number {
		return this.inFlight.get(lane) ?? 0;
	}

	pendingOf(lane: string): number {
		return this.waiters.get(lane)?.length ?? 0;
	}

	peakOf(lane: string): number {
		return this.peak.get(lane) ?? 0;
	}

	/**
	 * 取得名额 → 跑 fn → 无论成败释放名额。
	 *
	 * `signal` 是 2.5.8 补上的:在此之前**等待本身不可中断** —— 模块开头写着
	 * 「abort 交由 fn 自身处理」,但被 abort 的请求只有轮到它时才 reject,在此
	 * 之前它一直挂在这里。后果不在闸内而在闸外:`run` 是在 `try` **之前**
	 * await 取名额的,页任务停在这里 → `translatePage` 挂着 → RequestScheduler
	 * `execute` 的 finally 不可达 → 该 job 一直留在 `active`,既占着全局与 lane
	 * 的槽位,又让 `isScheduled('page-N')` 恒为真;而 `ensurePage` 一见
	 * `isScheduled` 就早退、`promote` 又只对**排队中**的任务生效 —— 于是导航
	 * 取消或空闲看门狗 abort 过的那一页既不结束、也无法重新排期,用户翻回去
	 * 只看到原文,后面的页还起不来。现在 abort 会立刻把等待者摘出队列并 reject。
	 */
	async run<T>(lane: string, foreground: boolean, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire(lane, foreground, signal);
		try {
			return await fn();
		}
		finally {
			this.release(lane);
		}
	}

	private acquire(lane: string, foreground: boolean, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			// 已经取消了就别再占名额 —— 占了也只是马上还回来。
			return Promise.reject(new PaperMirrorError('CANCELLED', 'Cancelled before acquiring a request slot.'));
		}
		const cur = this.inFlight.get(lane) ?? 0;
		if (cur < this.capOf(lane)) {
			this.bump(lane, cur + 1);
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const q = this.waiters.get(lane) ?? [];
			// settled 同时防两件事: drain 唤醒后又收到 abort(此时名额已记在
			// 账上,交给 fn 自己去 reject 并释放),以及 abort 之后再被唤醒。
			let settled = false;
			const cleanup = (): void => {
				if (signal) {
					signal.removeEventListener('abort', onAbort);
				}
			};
			const onAbort = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				const list = this.waiters.get(lane);
				if (list) {
					const i = list.indexOf(w);
					if (i >= 0) {
						list.splice(i, 1);
					}
				}
				reject(new PaperMirrorError('CANCELLED', 'Cancelled while waiting for a request slot.'));
			};
			const w: Waiter = {
				foreground,
				resolve: () => {
					if (settled) {
						return;
					}
					settled = true;
					cleanup();
					resolve();
				}
			};
			if (signal) {
				signal.addEventListener('abort', onAbort, { once: true } as AddEventListenerOptions);
			}
			if (foreground) {
				// 前台插到第一个后台等待者之前(不越过其他前台,保序公平)。
				const idx = q.findIndex(x => !x.foreground);
				if (idx >= 0) {
					q.splice(idx, 0, w);
				}
				else {
					q.push(w);
				}
			}
			else {
				q.push(w);
			}
			this.waiters.set(lane, q);
		});
	}

	private release(lane: string): void {
		const cur = this.inFlight.get(lane) ?? 1;
		this.inFlight.set(lane, Math.max(0, cur - 1));
		this.drain(lane);
	}

	private drain(lane: string): void {
		const q = this.waiters.get(lane);
		if (!q) {
			return;
		}
		while (q.length && (this.inFlight.get(lane) ?? 0) < this.capOf(lane)) {
			const w = q.shift()!;
			this.bump(lane, (this.inFlight.get(lane) ?? 0) + 1);
			w.resolve();
		}
	}

	private bump(lane: string, next: number): void {
		this.inFlight.set(lane, next);
		if (next > (this.peak.get(lane) ?? 0)) {
			this.peak.set(lane, next);
		}
	}
}
