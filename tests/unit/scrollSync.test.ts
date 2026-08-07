import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncGuard, createSyncController } from '../../src/reader/scrollSynchronizer';

test('SyncGuard suppresses echoes during cooldown', () => {
	let now = 1000;
	const guard = new SyncGuard({ cooldownMs: 400, now: () => now });
	guard.willMove('pane');
	// An event from the pane during cooldown is an echo -> not propagated
	assert.equal(guard.shouldPropagate('pane'), false);
	// The other side is still free
	assert.equal(guard.shouldPropagate('pdf'), true);
	now += 500;
	assert.equal(guard.shouldPropagate('pane'), true);
});

test('controller does not create an infinite loop', () => {
	let now = 0;
	const guard = new SyncGuard({ cooldownMs: 400, now: () => now });
	const calls: string[] = [];
	const controller = createSyncController({
		scrollPaneToPage: () => {
			calls.push('pane-scrolled');
			// Simulate the pane emitting a scroll event as a result:
			controller.onPaneNavigated(5);
		},
		navigatePdfToPage: () => {
			calls.push('pdf-navigated');
			controller.onPdfPageChanged(5);
		}
	}, guard);

	controller.onPdfPageChanged(5); // user scrolled the PDF
	// pane scrolls once; its echo must be suppressed (no pdf-navigated back)
	assert.deepEqual(calls, ['pane-scrolled']);
});

test('disabled controller propagates nothing', () => {
	const calls: string[] = [];
	const controller = createSyncController({
		scrollPaneToPage: () => calls.push('pane'),
		navigatePdfToPage: () => calls.push('pdf')
	});
	controller.enabled = false;
	controller.onPdfPageChanged(2);
	controller.onPaneNavigated(3);
	assert.deepEqual(calls, []);
});
