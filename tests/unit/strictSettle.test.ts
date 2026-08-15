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
import { settleStrictPage, shrinkStrictBlocks, applyCompressedStrict, planStrictRetry, type UnfitBlock } from '../../src/ui/strictPageReplacement';
import { supportsCharBudget } from '../../src/translation/providers/types';
import { getProvider } from '../../src/translation/providers/registry';

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

test('planStrictRetry routes budget-capable, in-budget blocks to compress', () => {
	const unfit: UnfitBlock[] = [
		{ id: 'a', maxChars: 40 },
		{ id: 'b', maxChars: 40 },
		{ id: 'c', maxChars: 40 }
	];
	const rounds = new Map<string, number>([['a', 0], ['b', 2], ['c', 1]]);
	const plan = planStrictRetry(unfit, {
		roundsFor: id => rounds.get(id) ?? 0,
		maxRounds: 2,
		budgetCapable: true
	});
	assert.deepEqual(plan.compress.sort(), ['a', 'c'], 'b has spent its 2 rounds → shrink');
	assert.deepEqual(plan.shrink, ['b']);
});

test('planStrictRetry sends everything to shrink when the engine ignores budgets', () => {
	const unfit: UnfitBlock[] = [{ id: 'a', maxChars: 40 }, { id: 'b', maxChars: 40 }];
	const plan = planStrictRetry(unfit, { roundsFor: () => 0, maxRounds: 2, budgetCapable: false });
	assert.deepEqual(plan.compress, []);
	assert.deepEqual(plan.shrink, ['a', 'b']);
});

test('applyCompressedStrict delegates to pmApplyCompressed', () => {
	const seen: Map<string, string>[] = [];
	const el = {
		pmApplyCompressed: (m: Map<string, string>) => { seen.push(m); return [{ id: 'x', maxChars: 20 }]; }
	} as unknown as HTMLElement;
	const still = applyCompressedStrict(el, new Map([['x', '短']]));
	assert.equal(seen.length, 1);
	assert.deepEqual(still, [{ id: 'x', maxChars: 20 }]);
});

test('applyCompressedStrict without the hook is a no-op', () => {
	assert.deepEqual(applyCompressedStrict({} as HTMLElement, new Map([['x', 'y']])), []);
});

test('supportsCharBudget is explicit per provider, not tied to explain', () => {
	// LLM/prompt-driven engines honour the budget…
	assert.equal(supportsCharBudget(getProvider('anthropic')), true);
	assert.equal(supportsCharBudget(getProvider('openai')), true);
	assert.equal(supportsCharBudget(getProvider('deepseek')), true);
	// …fixed MT services do not, so the renderer must not waste rounds on them.
	assert.equal(supportsCharBudget(getProvider('bing-free')), false);
	assert.equal(supportsCharBudget(getProvider('google-free')), false);
	assert.equal(supportsCharBudget(getProvider('deepl')), false);
});

test('ladderFor never crushes lines below the source leading', async () => {
	const { ladderFor } = await import('../../src/ui/strictPageReplacement');
	// A body paragraph set at 1.3 leading: no ladder step tightens below 1.3.
	const body = ladderFor(1.3);
	assert.ok(body.every(s => s.lineHeight >= 1.3), 'body lines never below source leading');
	assert.ok(body[0]!.lineHeight >= body[body.length - 1]!.lineHeight, 'loose → tight order');
	// A tight one-line heading (natural ~1.0) gets a 1.0 step it can pass —
	// the fixed 1.14 floor used to make short headings fail outright.
	const heading = ladderFor(1.0);
	assert.ok(heading.some(s => Math.abs(s.lineHeight - 1.0) < 1e-9), 'heading gets a 1.0 step');
	// Absurd inputs are clamped into [1.0, 1.42].
	assert.ok(ladderFor(5).every(s => s.lineHeight <= 1.42));
	assert.ok(ladderFor(0).every(s => s.lineHeight >= 1.0));
});

// ---------------------------------------------------------------------------
// 1.0.5 批次2: BabelDOC 算法3 —— 缩字前先扩边界(空白测量,纯函数)
// ---------------------------------------------------------------------------

import { computeExpansionAllowance } from '../../src/ui/strictPageReplacement';

test('expansion is clipped by the nearest right/below blocker with margin (算法3)', () => {
	const box = { left: 100, top: 100, width: 100, height: 40 };
	const blockers = [
		{ left: 260, top: 90, width: 50, height: 60 },  // right neighbour, 60px gap
		{ left: 100, top: 180, width: 100, height: 30 } // below neighbour, 40px gap
	];
	const { right, down } = computeExpansionAllowance(box, blockers, 612, 792, 12);
	assert.equal(right, 57, 'right = 260 − 200 − 3');
	// cap = max(2.8×字号=33.6, 0.5×高=20) → min(37px 间隙−边距, 33.6) = 33.6
	assert.ok(Math.abs(down - 33.6) < 0.01, `down=${down}`);
});

test('expansion respects the 90% page-width / caps and never goes negative', () => {
	const box = { left: 500, top: 700, width: 80, height: 40 };
	const free = computeExpansionAllowance(box, [], 612, 792, 12);
	// 612×0.9 = 550.8 → right allowance = 0 (box already past the limit is clamped ≥0)
	assert.equal(free.right, 0);
	assert.ok(free.down > 0 && free.down <= Math.max(12 * 2.8, 20));
	const tight = computeExpansionAllowance(box, [{ left: 500, top: 741, width: 80, height: 20 }], 612, 792, 12);
	assert.equal(tight.down, 0, 'blocker 1px below → clamp to 0, not negative');
});

// ---------------------------------------------------------------------------

test('auditStrictGeometry: null on a non-strict element, passthrough on the hook (1.1.0)', async () => {
	const { auditStrictGeometry } = await import('../../src/ui/strictPageReplacement');
	assert.equal(auditStrictGeometry({} as unknown as HTMLElement), null);
	const el = {
		pmGeometryAudit: () => ({ violations: 2, adjusted: 1, reverted: 1 })
	} as unknown as HTMLElement;
	assert.deepEqual(auditStrictGeometry(el), { violations: 2, adjusted: 1, reverted: 1 });
});
