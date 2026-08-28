import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestGate } from '../../src/translation/requestGate';

const flush = () => new Promise<void>(r => setTimeout(r, 0));
function deferred(): { p: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const p = new Promise<void>(r => { resolve = r; });
	return { p, resolve };
}

test('RequestGate caps真实在途请求数,释放后再放行', async () => {
	const gate = new RequestGate(2); // 默认每 lane 在途上限 2
	const d = [deferred(), deferred(), deferred(), deferred()];
	const started: number[] = [];
	const done = d.map((x, i) => gate.run('L', false, () => { started.push(i); return x.p; }));
	await flush();
	assert.deepEqual(started, [0, 1], '只放行 2 个,其余排队');
	assert.equal(gate.inFlightOf('L'), 2);
	assert.equal(gate.pendingOf('L'), 2);
	d[0]!.resolve(); await flush();
	assert.deepEqual(started, [0, 1, 2], '一个完成 → 放行下一个');
	d[1]!.resolve(); await flush();
	assert.deepEqual(started, [0, 1, 2, 3]);
	d[2]!.resolve(); d[3]!.resolve(); await Promise.all(done);
	assert.equal(gate.inFlightOf('L'), 0, '全部释放');
	assert.equal(gate.peakOf('L'), 2, '峰值 = 上限');
});

test('前台请求插到后台等待者之前', async () => {
	const gate = new RequestGate(1);
	const occupy = deferred();
	const busy = gate.run('L', false, () => occupy.p); // 占住唯一名额
	await flush();
	const order: string[] = [];
	const bg = gate.run('L', false, () => { order.push('bg'); return Promise.resolve(); });
	const fg = gate.run('L', true, () => { order.push('fg'); return Promise.resolve(); });
	await flush();
	assert.deepEqual(order, [], '名额被占,两者都在等');
	occupy.resolve(); await flush(); await flush();
	await Promise.all([busy, bg, fg]);
	assert.deepEqual(order, ['fg', 'bg'], '当前页请求优先出手');
});

test('不同 lane 互不阻塞;setCap 收窄后续放行', async () => {
	const gate = new RequestGate(1);
	const a = deferred();
	const b = deferred();
	const startedA: boolean[] = [];
	const startedB: boolean[] = [];
	const ra = gate.run('A', false, () => { startedA.push(true); return a.p; });
	const rb = gate.run('B', false, () => { startedB.push(true); return b.p; });
	await flush();
	assert.equal(startedA.length, 1, 'A 起了');
	assert.equal(startedB.length, 1, 'B 与 A 不同 lane,同时起');
	a.resolve(); b.resolve(); await Promise.all([ra, rb]);
	// 提高上限后一次放行多个
	gate.setCap('C', 3);
	const dc = [deferred(), deferred(), deferred(), deferred()];
	let running = 0; let peak = 0;
	const rc = dc.map(x => gate.run('C', false, () => { running++; peak = Math.max(peak, running); return x.p.then(() => { running--; }); }));
	await flush();
	assert.equal(running, 3, 'cap 3 → 同时 3 个');
	dc.forEach(x => x.resolve());
	await Promise.all(rc);
	assert.equal(peak, 3);
});

// ---- 等待可中断 (2.5.8) ----------------------------------------------------

test('abort 立刻把等待者摘出队列并 reject,不必等轮到它', async () => {
	// 在此之前等待本身不可中断: 被 abort 的请求只有轮到它时才 reject。而
	// `run` 是在 try **之前** await 取名额的 —— 页任务停在这里,调度器
	// execute 的 finally 就不可达,job 一直留在 active,该页既不结束也无法
	// 重新排期(isScheduled 恒真、promote 只对排队中的任务生效)。
	const gate = new RequestGate(1);
	gate.setCap('L', 1);
	let releaseHolder!: () => void;
	const holder = gate.run('L', true, () => new Promise<void>(r => { releaseHolder = r; }));
	await new Promise(r => setTimeout(r, 0));
	const ac = new AbortController();
	let ran = false;
	const waiter = gate.run('L', false, async () => { ran = true; }, ac.signal);
	await new Promise(r => setTimeout(r, 0));
	assert.equal(gate.pendingOf('L'), 1, '先确实排上了队');
	ac.abort();
	await assert.rejects(waiter, /Cancelled while waiting/);
	assert.equal(ran, false, 'fn 一次都不该跑');
	assert.equal(gate.pendingOf('L'), 0, '等待者要从队列里摘掉,不能留成幽灵');
	// 名额记账没被打乱: 持有者释放后新请求照常放行。
	releaseHolder();
	await holder;
	let after = false;
	await gate.run('L', true, async () => { after = true; });
	assert.equal(after, true);
	assert.equal(gate.inFlightOf('L'), 0);
});

test('入闸前就已 abort 的请求不占名额', async () => {
	const gate = new RequestGate(1);
	gate.setCap('L', 1);
	const ac = new AbortController();
	ac.abort();
	let ran = false;
	await assert.rejects(
		gate.run('L', true, async () => { ran = true; }, ac.signal),
		/Cancelled before acquiring/
	);
	assert.equal(ran, false);
	assert.equal(gate.inFlightOf('L'), 0, '占了也只是马上还回来,索性别占');
});

test('已经拿到名额之后再 abort,由 fn 自己收尾,名额照常释放', async () => {
	const gate = new RequestGate(1);
	gate.setCap('L', 1);
	const ac = new AbortController();
	const p = gate.run('L', true, async () => {
		ac.abort();
		throw new Error('aborted inside fn');
	}, ac.signal);
	await assert.rejects(p, /aborted inside fn/);
	assert.equal(gate.inFlightOf('L'), 0, 'finally 释放了名额');
	assert.equal(gate.pendingOf('L'), 0);
});

test('不传 signal 时行为与旧版一致', async () => {
	const gate = new RequestGate(1);
	gate.setCap('L', 1);
	const order: string[] = [];
	let release!: () => void;
	const holder = gate.run('L', true, () => new Promise<void>(r => { release = r; }));
	await new Promise(r => setTimeout(r, 0));
	const queued = gate.run('L', false, async () => { order.push('queued'); });
	release();
	await holder;
	await queued;
	assert.deepEqual(order, ['queued']);
});
