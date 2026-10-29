import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legendMaskLineBox } from '../../src/ui/strictPageReplacement';
import type { PixelBox } from '../../src/ui/translatedPageView';

const line: PixelBox = { left: 24.3, top: 50.25, width: 130.6, height: 9.7 };
const bottom = (box: PixelBox): number => box.top + box.height;

for (const ratio of [1, 1.25, 1.5, 2]) test(`legend vertical glyph padding rounds outward at bitmap ratio ${ratio}`, () => {
	const result = legendMaskLineBox(line, line, [], 1, ratio, 400)!;
	assert.ok(result);
	assert.ok(result.top <= line.top - 1);
	assert.ok(bottom(result) >= bottom(line) + 1);
	assert.ok(result.left >= line.left);
	assert.ok(result.left + result.width <= line.left + line.width);
	for (const edge of [result.left, result.left + result.width, result.top, bottom(result)]) assert.ok(Math.abs(edge * ratio - Math.round(edge * ratio)) < 1e-8);
});

test('top and bottom glyph bands do not depend on the whole-entry ink-only vertical box', () => {
	const tight = legendMaskLineBox(line, line, [], 1, 2, 400)!;
	const tallOwner = { ...line, top: 20, height: 100 };
	assert.deepEqual(legendMaskLineBox(line, tallOwner, [], 1, 2, 400), tight);
});

test('a minimum subpixel marker gap never grants horizontal padding outside the text owner', () => {
	for (const phase of [0, .25, .5, .75]) {
		const source = { ...line, left: 14.3 + phase };
		const result = legendMaskLineBox(source, source, [], 1, 2, 400)!;
		assert.ok(result.left >= source.left);
		assert.ok(result.left > source.left - .3);
	}
});

test('separated source neighbours leave enough whitespace for complete outward glyph bands', () => {
	const neighbours = [{ left: 20, top: 25, width: 180, height: 10 }, { left: 20, top: 75, width: 180, height: 10 }];
	const result = legendMaskLineBox(line, line, neighbours, 1, 2, 400)!;
	assert.deepEqual(result, legendMaskLineBox(line, line, [], 1, 2, 400));
	assert.ok(result.top > bottom(neighbours[0]!));
	assert.ok(bottom(result) < neighbours[1]!.top);
});

test('a source line immediately above returns no partial mask', () => {
	const neighbour = { left: 20, top: 40.05, width: 180, height: 10 };
	assert.equal(legendMaskLineBox(line, line, [neighbour], 1, 2, 400), null);
});

test('a source line immediately below returns no partial mask', () => {
	const neighbour = { left: 20, top: bottom(line) + .2, width: 180, height: 10 };
	assert.equal(legendMaskLineBox(line, line, [neighbour], 1, 2, 400), null);
});

test('overlapping foreign source evidence returns no mask instead of trimming a glyph edge', () => {
	const neighbour = { ...line, left: line.left + 15, top: line.top + 2 };
	assert.equal(legendMaskLineBox(line, line, [neighbour], 1, 2, 400), null);
});

test('a neighbour in a different horizontal panel does not constrain vertical padding', () => {
	const neighbour = { left: line.left + line.width + 8, top: line.top, width: 150, height: 30 };
	assert.deepEqual(legendMaskLineBox(line, line, [neighbour], 1, 2, 400), legendMaskLineBox(line, line, [], 1, 2, 400));
});

test('an insufficient fractional whitespace partition fails closed after pixel rounding', () => {
	const source = { left: 10, top: 50.01, width: 90, height: 10 };
	const neighbour = { left: 10, top: 36.5, width: 90, height: 10 };
	// Exact geometry admits padding to 49.01; outward rounding needs pixel 49.
	// The neighbouring partition starts at 48.255 and rounds inward to 48.5,
	// leaving a complete padded band in this case.
	assert.ok(legendMaskLineBox(source, source, [neighbour], 1, 2, 400));
	const close = { ...neighbour, top: 38.02 };
	assert.equal(legendMaskLineBox(source, source, [close], 1, 2, 400), null);
});

test('page edges clip only pixels that cannot exist outside the page', () => {
	const topLine = { ...line, top: .2 }, bottomLine = { ...line, top: 390.1 };
	assert.equal(legendMaskLineBox(topLine, topLine, [], 1, 2, 400)!.top, 0);
	assert.equal(bottom(legendMaskLineBox(bottomLine, bottomLine, [], 1, 2, 400)!), 400);
});

test('a degenerate horizontal owner cannot produce a partially covered entry', () => {
	const tiny = { ...line, left: 24.3, width: .1 };
	assert.equal(legendMaskLineBox(tiny, tiny, [], 1, 2, 400), null);
});

test('invalid or nonfinite bounds fail closed without mutating source geometry', () => {
	const before = JSON.stringify(line);
	for (const ratio of [0, -1, NaN, Infinity]) assert.equal(legendMaskLineBox(line, line, [], 1, ratio, 400), null);
	assert.equal(legendMaskLineBox({ ...line, top: NaN }, line, [], 1, 2, 400), null);
	assert.equal(legendMaskLineBox(line, line, [], -1, 2, 400), null);
	assert.equal(legendMaskLineBox(line, line, [], 1, 2, 0), null);
	assert.equal(JSON.stringify(line), before);
});
