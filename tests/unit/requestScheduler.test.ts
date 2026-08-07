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
