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
