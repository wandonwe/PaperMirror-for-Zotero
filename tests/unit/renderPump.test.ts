/**
 * 页渲染泵 (2.8.0 第一批): 当前页优先 + 取消过时渲染。
 *
 * 这里驱动的是真实的 RenderPump —— 泵的窗口、"要不要重画"、结果落地全部
 * 注入,所以整套优先级与取消行为可以在没有 DOM 的情况下逐条验证。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	RenderPump, orderRenderCandidates, shouldAbortInFlight, KEEP_PAGES
} from '../../src/ui/renderPump';
import type { PageRenderResult } from '../../src/ui/translationPane';

// ---- 排序 -------------------------------------------------------------------

test('orderRenderCandidates: 按到当前页的距离排,不再按页码从小到大 (2.8.0 第一批)', () => {
	const order = orderRenderCandidates({ current: 7, first: 4, last: 10, buffer: 0, needs: () => true });
	assert.equal(order[0], 7, '当前页最先 —— 老实现会先渲染第 4 页');
	assert.deepEqual(order, [7, 6, 8, 5, 9, 4, 10], '距离相同时先小页码');
});

test('orderRenderCandidates: 可视页整体先于预取页,再近的预取页也不抢 (2.8.0 第一批)', () => {
	// 可视 10..12,预取 9 与 13。第 9 页离当前页只有 1,第 12 页有 2 ——
	// 但 9 是用户看不见的页,不该抢在 12 前面。
	const order = orderRenderCandidates({ current: 10, first: 10, last: 12, buffer: 1, needs: () => true });
	assert.deepEqual(order, [10, 11, 12, 9, 13], '分层必须在距离之前');
});

test('orderRenderCandidates: 只排要重画的页,负页码不进候选', () => {
	const done = new Set([5, 6]);
	assert.deepEqual(
		orderRenderCandidates({ current: 6, first: 4, last: 8, buffer: 0, needs: p => !done.has(p) }),
		[7, 4, 8], '已完成的页不进候选');
	assert.deepEqual(
		orderRenderCandidates({ current: 0, first: 0, last: 1, buffer: 2, needs: p => p <= 1 }),
		[0, 1], '第 0 页之前没有页可预取(负页码被 needs 之外的下界挡住)');
	assert.deepEqual(
		orderRenderCandidates({ current: 3, first: 3, last: 3, buffer: 0, needs: () => false }), [],
		'没有要重画的页就返回空');
});

test('shouldAbortInFlight: 离开「可视范围前后各 1 页」才取消', () => {
	const win = { first: 10, last: 12 };
	for (const page of [9, 10, 11, 12, 13]) {
		assert.equal(shouldAbortInFlight({ page, ...win }), false, `第 ${page} 页还在保留范围内`);
	}
	assert.equal(shouldAbortInFlight({ page: 8, ...win }), true);
	assert.equal(shouldAbortInFlight({ page: 14, ...win }), true);
	assert.equal(KEEP_PAGES, 1);
});

// ---- 泵行为 -----------------------------------------------------------------

interface Harness {
	pump: RenderPump;
	/** 每页的重建何时完成 —— 测试自己决定。 */
	finish(page: number, result?: PageRenderResult): void;
	started: number[];
	committed: { page: number; result: PageRenderResult; aborted: boolean }[];
	/** 每页返回时它的 signal 是否已被取消 —— 取消必须真的传到渲染器。 */
	abortedAtFinish: Map<number, boolean>;
	move(win: { current: number; first: number; last: number; buffer?: number }): void;
	timers: Map<unknown, { fn: () => void; ms: number }>;
	/** 每次启动渲染时拿到的 signal,按启动顺序。 */
	signals: AbortSignal[];
	fireTimer(handle: unknown): void;
	settle(): Promise<void>;
}

function harness(initial: { current: number; first: number; last: number; buffer?: number }): Harness {
	let win = { buffer: 0, ...initial };
	const pendingRenders = new Map<number, { resolve: (r: PageRenderResult) => void; signal: AbortSignal }>();
	const started: number[] = [];
	const committed: Harness['committed'] = [];
	const abortedAtFinish = new Map<number, boolean>();
	const rendered = new Set<number>();
	const timers = new Map<unknown, { fn: () => void; ms: number }>();
	const signals: AbortSignal[] = [];
	let timerId = 0;
	const pump = new RenderPump({
		windowOf: () => win,
		needsRender: page => !rendered.has(page),
		anyWaiting: () => false,
		render: (page, signal) => {
			started.push(page);
			signals.push(signal);
			return new Promise<PageRenderResult>(resolve => {
				pendingRenders.set(page, { resolve, signal });
			});
		},
		commit: (page, result, aborted) => {
			committed.push({ page, result, aborted });
			if (!aborted) {
				rendered.add(page);
			}
		},
		now: () => 0,
		setTimer: (fn, ms) => {
			const handle = ++timerId;
			timers.set(handle, { fn, ms });
			return handle;
		},
		clearTimer: handle => { timers.delete(handle); },
		schedule: () => {}
	});
	return {
		pump, started, committed, abortedAtFinish, timers, signals,
		finish: (page, result = 'translated') => {
			const entry = pendingRenders.get(page);
			if (!entry) {
				throw new Error(`page ${page} was never started`);
			}
			pendingRenders.delete(page);
			// 真实渲染器在提交 DOM 前查 signal (readerSession 的 current());
			// 这里如实模拟那道闸: 被取消就什么都不提交,只回 false。
			abortedAtFinish.set(page, entry.signal.aborted);
			entry.resolve(entry.signal.aborted ? false : result);
		},
		move: next => {
			win = { buffer: 0, ...next };
			pump.request();
		},
		fireTimer: handle => {
			const t = timers.get(handle);
			timers.delete(handle);
			t?.fn();
		},
		settle: async () => { await new Promise(r => setTimeout(r, 0)); }
	};
}

test('上一页迟迟不返回、用户翻到远处: 旧任务被取消,新页立刻开始 (2.8.0 第一批)', async () => {
	const h = harness({ current: 2, first: 1, last: 3 });
	void h.pump.run();
	await h.settle();
	assert.deepEqual(h.started, [2], '先渲染当前页');

	// 第 2 页卡住不返回,用户翻到第 40 页。
	h.move({ current: 40, first: 39, last: 41 });
	await h.settle();
	assert.equal(h.pump.busyPage, 2, '旧任务还在飞,但已被 abort');

	// 卡住的旧任务这时才返回 —— 它必须发现自己被取消,不提交 DOM。
	h.finish(2);
	await h.settle();
	assert.equal(h.abortedAtFinish.get(2), true, '取消必须真的传到渲染器 —— 它据此不提交 DOM');
	assert.deepEqual(h.committed.map(c => [c.page, c.aborted]), [[2, true]], '被取消的一页按取消结算');
	assert.deepEqual(h.started, [2, 40], '新页在旧任务返回后立刻开始,且是当前页');

	h.finish(40);
	await h.settle();
	assert.equal(h.committed.at(-1)!.aborted, false);
	assert.equal(h.started[1], 40, '新页优先于同窗口的 39 / 41');
});

test('只翻一页时不取消: 旧任务仍在保留范围内,照常完成 (2.8.0 第一批)', async () => {
	const h = harness({ current: 5, first: 4, last: 6 });
	void h.pump.run();
	await h.settle();
	assert.deepEqual(h.started, [5]);
	h.move({ current: 6, first: 5, last: 7 });
	await h.settle();
	h.finish(5);
	await h.settle();
	assert.equal(h.abortedAtFinish.get(5), false, '还在窗口内的任务不该被取消');
	assert.equal(h.committed[0]!.aborted, false);
	assert.equal(h.started[1], 6, '接着渲染新的当前页');
});

test('20 秒超时同时触发取消,且正常完成会清掉定时器 (2.8.0 第一批)', async () => {
	const h = harness({ current: 1, first: 1, last: 1 });
	void h.pump.run();
	await h.settle();
	assert.equal(h.timers.size, 1, '每页挂一个超时');
	const [handle, entry] = [...h.timers.entries()][0]!;
	assert.equal(entry.ms, 20000);

	h.fireTimer(handle); // 超时
	await h.settle();
	assert.equal(h.committed[0]!.aborted, true, '超时必须 abort,不能只让 race 先返回');
	assert.equal(h.signals[0]!.aborted, true,
		'超时那一趟的 signal 必须已取消 —— 渲染器据此在返回前放弃提交 DOM');

	// 下一页正常完成: 超时定时器必须被清掉,不留 20 秒挂单。
	const h2 = harness({ current: 1, first: 1, last: 1 });
	void h2.pump.run();
	await h2.settle();
	h2.finish(1);
	await h2.settle();
	assert.equal(h2.timers.size, 0, '正常完成后不留挂单');
});

test('泵送期间到达的更新不会被吞掉: 用满步数退出时补排一次 (2.8.0 第一批)', async () => {
	let scheduled: number[] = [];
	const pending = new Map<number, (r: PageRenderResult) => void>();
	const done = new Set<number>();
	const pump = new RenderPump({
		windowOf: () => ({ current: 0, first: 0, last: 1, buffer: 0 }),
		needsRender: page => !done.has(page),
		anyWaiting: () => false,
		render: page => new Promise<PageRenderResult>(resolve => pending.set(page, resolve)),
		commit: (page, _r, aborted) => { if (!aborted) done.add(page); },
		now: () => 0,
		setTimer: () => 1,
		clearTimer: () => {},
		schedule: ms => { scheduled.push(ms); },
		// 一趟只渲染一页 —— 模拟"步数用满,但活还没干完"。
		maxSteps: 1
	});
	void pump.run();
	await new Promise(r => setTimeout(r, 0));
	pump.request();             // 泵送期间到达的更新
	scheduled = [];
	pending.get(0)!('translated');
	await new Promise(r => setTimeout(r, 0));
	assert.deepEqual(scheduled, [0], '退出时必须补排一次,否则这次更新永远没人处理');
	assert.equal(done.has(1), false, '第 1 页还欠着 —— 正是补排要接着干的活');
});

// ---- 接线的结构闸 -----------------------------------------------------------

test('renderDocPage 把 signal 折进 current(),取消后不提交 DOM (结构性回归闸, 2.8.0)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const start = src.indexOf('private async renderDocPage(');
	assert.ok(start > 0, '找不到 renderDocPage');
	assert.ok(/renderDocPage\(pageIndex: number, slot: HTMLElement, width: number, signal\?: AbortSignal\)/.test(src),
		'renderDocPage 必须接收 AbortSignal');
	const body = src.slice(start, src.indexOf('private ', start + 40));
	assert.ok(/const current = \(\): boolean => !this\.destroyed[\s\S]*?signal\?\.aborted !== true;/.test(body),
		'signal 必须折进 current() —— 否则每个已有检查点都不是取消检查点');
	for (const commit of body.split('slot.replaceChildren(').slice(1)) {
		void commit;
	}
	const commits = body.split('slot.replaceChildren(').length - 1;
	assert.equal(commits, 2, 'renderDocPage 有两处提交 DOM(译文页 / 原文兜底)');
	assert.equal(body.split('return false; // 取消后绝不提交 DOM').length - 1, 2,
		'两处提交前都必须有取消闸');
	assert.ok(/this\.pane\.setPageRenderer\(\(pageIndex, slot, width, signal\)/.test(src),
		'渲染器注册时必须把 signal 透传下去');
});

test('面板经 RenderPump 泵送,不再自己按页码扫描 (结构性回归闸, 2.8.0)', () => {
	const src = readFileSync(join(process.cwd(), 'src/ui/translationPane.ts'), 'utf8');
	assert.ok(!/private async pumpRenders/.test(src), '老的 pumpRenders 循环必须已经拆掉');
	assert.ok(/this\.pump\.request\(\)/.test(src), 'scheduleEnsure 必须走 pump.request(),它会先取消过时任务');
	assert.ok(/render: \(page, signal\) => this\.renderSlot\(page, signal\)/.test(src),
		'渲染必须带 signal');
	assert.ok(/current: Math\.max\(first, Math\.min\(last, this\.currentPage\)\)/.test(src),
		'窗口必须带上当前页,否则"当前页优先"无从谈起');
	const commit = src.slice(src.indexOf('private commitRender('), src.indexOf('private releaseFarSlots('));
	assert.ok(/if \(aborted\) \{[\s\S]{0,120}?this\.slotDirty\[page\] = true;\s*\n\s*return;/.test(commit),
		'被取消的一页只标脏、不写状态');
	assert.ok(!/nextSlotState/.test(commit.slice(commit.indexOf('if (aborted)'), commit.indexOf('return;', commit.indexOf('if (aborted)')))),
		'取消分支里不得写槽状态机');
});
