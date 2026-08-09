import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	collapseSpanningLanes,
	expandSpanningLanes,
	laneOf,
	requiredPageHeight,
	resolveColumnFlow,
	translatedFontSize,
	type PlacedBlock
} from '../../src/ui/pageLayout';

const OPTS = { pageHeight: 800, minGap: 4 };

function block(id: string, column: number, top: number, height: number, left = 50, width = 200): PlacedBlock {
	return { id, column, left, top, width, height, sourceHeight: height };
}

const topOf = (blocks: PlacedBlock[], id: string): number =>
	blocks.find(b => b.id === id)!.top;

// ---- the normal case: Chinese is shorter, so nothing moves -------------------

test('a translation shorter than its source leaves the grid untouched', () => {
	// Source paragraphs at 100 and 200; the first now needs only 60px.
	const out = resolveColumnFlow([
		block('a', 0, 100, 60),
		block('b', 0, 200, 80)
	], OPTS);
	assert.equal(topOf(out, 'a'), 100);
	assert.equal(topOf(out, 'b'), 200, 'the second paragraph stays where the original was');
});

test('paragraphs are never pulled upward to close a gap', () => {
	const out = resolveColumnFlow([
		block('a', 0, 100, 10),
		block('b', 0, 400, 10)
	], OPTS);
	assert.equal(topOf(out, 'b'), 400);
});

// ---- the overflow case: push down instead of shrinking ----------------------

test('a translation that runs long pushes the next paragraph down', () => {
	const out = resolveColumnFlow([
		block('a', 0, 100, 140), // original was ~90 tall; the translation needs 140
		block('b', 0, 200, 60)
	], OPTS);
	assert.equal(topOf(out, 'a'), 100);
	assert.equal(topOf(out, 'b'), 100 + 140 + 4);
});

test('pushes cascade down the whole column', () => {
	const out = resolveColumnFlow([
		block('a', 0, 100, 200),
		block('b', 0, 200, 100),
		block('c', 0, 320, 40)
	], OPTS);
	assert.equal(topOf(out, 'b'), 304);
	assert.equal(topOf(out, 'c'), 408);
});

test('a push in one column never moves the other column', () => {
	const out = resolveColumnFlow([
		block('left', 0, 100, 300, 50, 200),
		block('right', 1, 120, 40, 320, 200)
	], OPTS);
	assert.equal(topOf(out, 'right'), 120, 'the right column is independent');
});

test('blocks are flowed in visual order regardless of input order', () => {
	const out = resolveColumnFlow([
		block('c', 0, 320, 40),
		block('a', 0, 100, 200),
		block('b', 0, 200, 100)
	], OPTS);
	assert.equal(topOf(out, 'a'), 100);
	assert.equal(topOf(out, 'b'), 304);
});

test('resolveColumnFlow tolerates an empty page', () => {
	assert.deepEqual(resolveColumnFlow([], OPTS), []);
});

// ---- page growth ------------------------------------------------------------

test('the page keeps its original height when nothing overflows', () => {
	assert.equal(requiredPageHeight([block('a', 0, 100, 60)], 800), 800);
});

test('the page grows just enough to hold a pushed paragraph', () => {
	assert.equal(requiredPageHeight([block('a', 0, 700, 160)], 800), 860);
});

// ---- full-width blocks ------------------------------------------------------

test('a spanning block participates in every column', () => {
	const bands = [{ left: 50, right: 250 }, { left: 320, right: 520 }];
	const banner = laneOf(50, 520, bands, 600);
	assert.equal(banner, -1, 'a full-width block gets its own lane');

	const expanded = expandSpanningLanes([
		{ ...block('banner', banner, 100, 120, 50, 470) },
		block('left', 0, 150, 40, 50, 200),
		block('right', 1, 150, 40, 320, 200)
	], 2);
	const flowed = collapseSpanningLanes(resolveColumnFlow(expanded, OPTS));
	// The banner overflows, so BOTH columns are pushed clear of it.
	assert.equal(topOf(flowed, 'left'), 224);
	assert.equal(topOf(flowed, 'right'), 224);
});

test('collapseSpanningLanes keeps the lowest position of a duplicated block', () => {
	const collapsed = collapseSpanningLanes([
		block('x', 0, 100, 20),
		block('x', 1, 260, 20)
	]);
	assert.equal(collapsed.length, 1);
	assert.equal(collapsed[0]!.top, 260);
});

test('a single-column page puts everything in one lane', () => {
	const out = expandSpanningLanes([block('a', -1, 0, 10), block('b', 0, 20, 10)], 1);
	assert.deepEqual(out.map(b => b.column), [0, 0]);
});

test('laneOf picks the column with the most overlap', () => {
	const bands = [{ left: 50, right: 250 }, { left: 320, right: 520 }];
	assert.equal(laneOf(50, 250, bands, 600), 0);
	assert.equal(laneOf(320, 520, bands, 600), 1);
	assert.equal(laneOf(0, 100, [], 600), 0, 'no bands means one lane');
});

// ---- type size --------------------------------------------------------------

test('font size matches the source exactly (译文字号与原文一致)', () => {
	const px = 1.5; // page pixels per PDF point
	const body = translatedFontSize(9.5, px, 9.5);
	const heading = translatedFontSize(16, px, 9.5);
	const finePrint = translatedFontSize(6.5, px, 9.5);
	assert.ok(Math.abs(body - 9.5 * px) < 0.01, '1:1, no fudge factor');
	assert.ok(Math.abs(heading - 16 * px) < 0.01);
	assert.ok(Math.abs(finePrint - 6.5 * px) < 0.01, 'fine print stays fine print');
	assert.ok(heading > body * 1.5, 'hierarchy survives');
});

test('font size falls back to the body size when a block has none', () => {
	assert.ok(translatedFontSize(0, 1.5, 10) > 0);
	assert.ok(translatedFontSize(0, 1.5, 0) > 0);
});

test('font size is clamped only at degenerate extremes', () => {
	assert.ok(translatedFontSize(1, 0.2, 1) >= 5, 'never invisible');
	assert.ok(translatedFontSize(90, 4, 10) <= 48, 'never absurd');
});

test('estimateCjkCapacity scales with the rectangle and never returns absurd budgets', async () => {
	const { estimateCjkCapacity } = await import('../../src/ui/strictPageReplacement');
	// A 240×120px box at 12px type ≈ 20 cols × 8 rows ≈ 152 chars.
	const cap = estimateCjkCapacity(240, 120, 12);
	assert.ok(cap >= 120 && cap <= 170, `got ${cap}`);
	assert.ok(estimateCjkCapacity(240, 240, 12) > cap, 'taller box → bigger budget');
	assert.equal(estimateCjkCapacity(0, 100, 12), 8, 'degenerate boxes floor at 8');
});
