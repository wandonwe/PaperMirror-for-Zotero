/**
 * 长文本稳定性 — settleStrictPage's final-measure contract and the
 * last-resort shrink hand-off.
 *
 * The "译文显示后又消失" bug: settle used to fire its callback identically
 * 2–3 times per render (initial + fonts.ready + a second load wave), the
 * session counted a compress round on EVERY firing, so one render burned the
 * whole budget and long blocks reverted to English. The contract now is:
 * any number of provisional calls (final=false), then EXACTLY ONE final call
 * (final=true) once fonts have settled — consequential action happens only
 * on that one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleStrictPage, shrinkStrictBlocks, type UnfitBlock } from '../../src/ui/strictPageReplacement';

interface FakeFonts {
	status?: string;
	ready?: Promise<unknown>;
}

function fakeElement(fonts: FakeFonts | undefined, unfit: UnfitBlock[] = []): {
	el: HTMLElement;
	calls: { unfit: UnfitBlock[]; final: boolean }[];
} {
	const calls: { unfit: UnfitBlock[]; final: boolean }[] = [];
	const el = {
		isConnected: true,
		ownerDocument: { fonts },
		pmSettleStrict: () => unfit
	} as unknown as HTMLElement;
	return { el, calls };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

test('no font API → a single, final measure', async () => {
	const { el, calls } = fakeElement(undefined);
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	await flush();
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.final, true);
});

test('fonts already loaded → one provisional then exactly one final', async () => {
	const { el, calls } = fakeElement({ status: 'loaded', ready: Promise.resolve() });
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	await flush();
	assert.deepEqual(calls.map(c => c.final), [false, true]);
});

test('second font-load wave → two provisionals, still exactly one final', async () => {
	const { el, calls } = fakeElement({ status: 'loading', ready: Promise.resolve() });
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	await flush();
	assert.deepEqual(calls.map(c => c.final), [false, false, true]);
	assert.equal(calls.filter(c => c.final).length, 1, 'never more than one final measure');
});

test('a disconnected element gets no late measures', async () => {
	const { calls } = fakeElement({ status: 'loaded', ready: Promise.resolve() });
	const el = {
		isConnected: true,
		ownerDocument: { fonts: { status: 'loaded', ready: Promise.resolve() } },
		pmSettleStrict: () => []
	} as unknown as HTMLElement;
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	(el as unknown as { isConnected: boolean }).isConnected = false; // slot re-rendered
	await flush();
	assert.deepEqual(calls.map(c => c.final), [false], 'stale element must not act');
});

test('the final measure reports unfit blocks with a budget', async () => {
	const unfit: UnfitBlock[] = [{ id: 'page-0-block-3', maxChars: 120 }];
	const { el, calls } = fakeElement({ status: 'loaded', ready: Promise.resolve() }, unfit);
	settleStrictPage(el, (u, final) => calls.push({ unfit: u, final }));
	await flush();
	const final = calls.find(c => c.final)!;
	assert.deepEqual(final.unfit, unfit);
});

test('shrinkStrictBlocks delegates to pmShrinkFit and returns the leftovers', () => {
	const el = {
		pmShrinkFit: (ids: string[]) => ids.filter(id => id.endsWith('stubborn'))
	} as unknown as HTMLElement;
	assert.deepEqual(
		shrinkStrictBlocks(el, ['a', 'b-stubborn']),
		['b-stubborn'],
		'only blocks that fail even the shrink stage remain revert candidates'
	);
});

test('shrinkStrictBlocks without the hook falls back to reverting everything', () => {
	const el = {} as HTMLElement;
	assert.deepEqual(shrinkStrictBlocks(el, ['a', 'b']), ['a', 'b']);
});
