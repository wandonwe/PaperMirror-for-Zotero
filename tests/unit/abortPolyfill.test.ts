import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PMAbortController } from '../../src/utils/abortPolyfill';

test('polyfill signal starts unaborted and fires listeners on abort', () => {
	const controller = new PMAbortController();
	assert.equal(controller.signal.aborted, false);
	let fired = 0;
	controller.signal.addEventListener('abort', () => fired++);
	controller.abort();
	assert.equal(controller.signal.aborted, true);
	assert.equal(fired, 1);
	// Double abort must not re-fire
	controller.abort();
	assert.equal(fired, 1);
});

test('removeEventListener works and throwIfAborted throws after abort', () => {
	const controller = new PMAbortController();
	let fired = 0;
	const listener = (): void => { fired++; };
	controller.signal.addEventListener('abort', listener);
	controller.signal.removeEventListener('abort', listener);
	controller.abort(new Error('stop'));
	assert.equal(fired, 0);
	assert.throws(() => controller.signal.throwIfAborted(), /stop/);
});

test('polyfill signal is compatible with the RequestScheduler contract', async () => {
	// The scheduler only relies on signal.aborted + abort() semantics.
	const controller = new PMAbortController();
	const seen: boolean[] = [];
	const job = async (signal: { aborted: boolean }): Promise<void> => {
		seen.push(signal.aborted);
		controller.abort();
		seen.push(signal.aborted);
	};
	await job(controller.signal);
	assert.deepEqual(seen, [false, true]);
});
