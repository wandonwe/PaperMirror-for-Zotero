import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestScheduler } from '../../src/translation/requestScheduler';
import { PaperMirrorError } from '../../src/types/models';

const noDelay = () => Promise.resolve();

test('respects max concurrency of 2', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 2, delayFn: noDelay });
	let active = 0;
	let maxActive = 0;
	const make = (k: string) => scheduler.enqueue(k, 0, async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise(r => setTimeout(r, 10));
		active--;
		return k;
	});
	await Promise.all([make('a'), make('b'), make('c'), make('d')]);
	assert.equal(maxActive, 2);
});

test('retries retryable errors then succeeds', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 1, maxRetries: 3, delayFn: noDelay });
	let attempts = 0;
	const result = await scheduler.enqueue('x', 0, async () => {
		attempts++;
		if (attempts < 3) {
			throw new PaperMirrorError('RATE_LIMITED', 'slow down', { retryable: true });
		}
		return 'ok';
	});
	assert.equal(result, 'ok');
	assert.equal(attempts, 3);
});

test('does not retry non-retryable errors', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 1, delayFn: noDelay });
	let attempts = 0;
	await assert.rejects(scheduler.enqueue('y', 0, async () => {
		attempts++;
		throw new PaperMirrorError('INVALID_API_KEY', 'nope', { retryable: false });
	}));
	assert.equal(attempts, 1);
});

test('cancel rejects a queued job', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 1, delayFn: noDelay });
	const slow = scheduler.enqueue('slow', 0, async () => {
		await new Promise(r => setTimeout(r, 50));
		return 1;
	});
	const queued = scheduler.enqueue('queued', 0, async () => 2);
	scheduler.cancel('queued');
	await assert.rejects(queued, (e: unknown) => e instanceof PaperMirrorError && e.code === 'CANCELLED');
	await slow;
});

test('cancelExcept drops stale queued jobs', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 1, delayFn: noDelay });
	const running = scheduler.enqueue('run', 10, async () => {
		await new Promise(r => setTimeout(r, 30));
		return 'run';
	});
	const keep = scheduler.enqueue('keep', 5, async () => 'keep');
	const drop = scheduler.enqueue('drop', 1, async () => 'drop');
	scheduler.cancelExcept(new Set(['run', 'keep']));
	await assert.rejects(drop, (e: unknown) => e instanceof PaperMirrorError && e.code === 'CANCELLED');
	assert.equal(await running, 'run');
	assert.equal(await keep, 'keep');
});

test('higher priority runs first', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 1, delayFn: noDelay });
	const order: string[] = [];
	const block = scheduler.enqueue('block', 100, async () => {
		await new Promise(r => setTimeout(r, 10));
		order.push('block');
	});
	const low = scheduler.enqueue('low', 1, async () => { order.push('low'); });
	const high = scheduler.enqueue('high', 50, async () => { order.push('high'); });
	await Promise.all([block, low, high]);
	assert.deepEqual(order, ['block', 'high', 'low']);
});

test('isQueued is true only while WAITING, false once running', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 1, delayFn: noDelay });
	let release!: () => void;
	const running = scheduler.enqueue('run', 10, async () => {
		await new Promise<void>(r => { release = r; });
	});
	const waiting = scheduler.enqueue('wait', 1, async () => 'w');
	assert.equal(scheduler.isQueued('run'), false, 'the active job is not "queued"');
	assert.equal(scheduler.isScheduled('run'), true, 'but it IS scheduled');
	assert.equal(scheduler.isQueued('wait'), true, 'the waiting job is queued');
	release();
	await running; await waiting;
});

test('promote raises a queued job so it runs next', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 1, delayFn: noDelay });
	const order: string[] = [];
	const block = scheduler.enqueue('block', 100, async () => {
		await new Promise(r => setTimeout(r, 10));
		order.push('block');
	});
	const a = scheduler.enqueue('a', 5, async () => { order.push('a'); });
	const b = scheduler.enqueue('b', 1, async () => { order.push('b'); });
	// b was lowest; promote it above a — it must now run before a.
	scheduler.promote('b', 900);
	await Promise.all([block, a, b]);
	assert.deepEqual(order, ['block', 'b', 'a']);
});

test('reservedForeground keeps a slot free so the current page never waits', async () => {
	// 2 slots, 1 reserved → background may hold at most 1 slot. Two background
	// prefetches are enqueued and would fill both slots under the old scheduler;
	// a foreground job enqueued AFTER them must still start immediately.
	const scheduler = new RequestScheduler({ maxConcurrent: 2, reservedForeground: 1, delayFn: noDelay });
	const running = new Set<string>();
	let fgStarted = false;
	const hold = (k: string) => scheduler.enqueue(k, 1, async () => {
		running.add(k);
		await new Promise(r => setTimeout(r, 30));
		running.delete(k);
	});
	const bg1 = hold('bg1');
	const bg2 = hold('bg2');
	await new Promise(r => setTimeout(r, 5));
	// Only ONE background job may be active at once (cap = 2 - 1).
	assert.equal(running.size, 1, 'background is capped to leave the reserved slot free');
	const fg = scheduler.enqueue('fg', 900, async () => { fgStarted = true; }, { foreground: true });
	await new Promise(r => setTimeout(r, 5));
	assert.equal(fgStarted, true, 'the foreground page started at once, not after a prefetch finished');
	await Promise.all([bg1, bg2, fg]);
});

test('per-lane caps: each provider lane runs independently up to its own cap', async () => {
	// Global 8 (won't bind); lane A cap 1, lane B cap 2 → at most 1 A + 2 B active.
	const scheduler = new RequestScheduler({ maxConcurrent: 8, delayFn: noDelay });
	scheduler.configureLanes({ A: 1, B: 2 });
	const active = new Map<string, number>([['A', 0], ['B', 0]]);
	const peak = new Map<string, number>([['A', 0], ['B', 0]]);
	const hold = (key: string, lane: string) => scheduler.enqueue(key, 1, async () => {
		active.set(lane, (active.get(lane) ?? 0) + 1);
		peak.set(lane, Math.max(peak.get(lane) ?? 0, active.get(lane) ?? 0));
		await new Promise(r => setTimeout(r, 20));
		active.set(lane, (active.get(lane) ?? 0) - 1);
	}, { lane });
	await Promise.all([
		hold('a1', 'A'), hold('a2', 'A'), hold('a3', 'A'),
		hold('b1', 'B'), hold('b2', 'B'), hold('b3', 'B')
	]);
	assert.equal(peak.get('A'), 1, 'lane A never exceeds its cap of 1');
	assert.equal(peak.get('B'), 2, 'lane B never exceeds its cap of 2');
});

test('a busy lane never blocks a page on another lane (pool parallelism)', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 8, delayFn: noDelay });
	scheduler.configureLanes({ A: 1, B: 1 });
	const started: string[] = [];
	let releaseA!: () => void;
	scheduler.enqueue('a1', 10, async () => { started.push('a1'); await new Promise<void>(r => { releaseA = r; }); }, { lane: 'A' });
	scheduler.enqueue('a2', 9, async () => { started.push('a2'); }, { lane: 'A' }); // queued behind a1 (lane full)
	scheduler.enqueue('b1', 1, async () => { started.push('b1'); }, { lane: 'B' }); // different lane → runs now
	await new Promise(r => setTimeout(r, 5));
	assert.ok(started.includes('a1') && started.includes('b1'), 'other-lane page runs while lane A is busy');
	assert.ok(!started.includes('a2'), 'same-lane page waits for its lane');
	releaseA();
});

test('foreground lane keeps a slot for the current page', async () => {
	// Lane L cap 2, marked as the foreground lane → background may use only 1,
	// leaving 1 for a foreground (current-page) job that arrives later.
	const scheduler = new RequestScheduler({ maxConcurrent: 8, reservedForeground: 1, delayFn: noDelay });
	scheduler.configureLanes({ L: 2 });
	scheduler.setForegroundLane('L');
	const running = new Set<string>();
	const hold = (k: string, fg: boolean) => scheduler.enqueue(k, fg ? 900 : 1, async () => {
		running.add(k); await new Promise(r => setTimeout(r, 30)); running.delete(k);
	}, { lane: 'L', foreground: fg });
	const bg1 = hold('bg1', false);
	const bg2 = hold('bg2', false);
	await new Promise(r => setTimeout(r, 5));
	assert.equal(running.size, 1, 'background capped at laneCap-1 on the foreground lane');
	let fgStarted = false;
	const fg = scheduler.enqueue('cur', 900, async () => { fgStarted = true; }, { lane: 'L', foreground: true });
	await new Promise(r => setTimeout(r, 5));
	assert.equal(fgStarted, true, 'the current page starts into the reserved lane slot at once');
	await Promise.all([bg1, bg2, fg]);
});

test('adaptive: a 429 halves the erroring lane cap; other lanes untouched', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 8, maxRetries: 0, delayFn: noDelay });
	scheduler.configureLanes({ A: 4, B: 4 });
	await assert.rejects(scheduler.enqueue('a1', 1, async () => {
		throw new PaperMirrorError('RATE_LIMITED', 'slow down', { retryable: false });
	}, { lane: 'A' }));
	assert.equal(scheduler.laneCap('A'), 2, 'lane A halved 4 → 2 after a 429');
	assert.equal(scheduler.laneCap('B'), 4, 'lane B is untouched');
});

test('adaptive: a timeout drops the lane cap by one', async () => {
	const scheduler = new RequestScheduler({ maxConcurrent: 8, maxRetries: 0, delayFn: noDelay });
	scheduler.configureLanes({ A: 4 });
	await assert.rejects(scheduler.enqueue('a1', 1, async () => {
		throw new PaperMirrorError('TIMEOUT', 'too slow', { retryable: false });
	}, { lane: 'A' }));
	assert.equal(scheduler.laneCap('A'), 3, 'lane A 4 → 3 after a timeout');
});
