import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPE_LADDER, estimateHeight, fontSizeBounds, MIN_READABLE_PX } from '../../src/reader/textFitter';
import { groupLineRects, type PdfRect } from '../../src/reader/overlayLayout';
import { isRunningHeadOrFoot, isMetadataBlock } from '../../src/reader/metaFilter';

// ---- the type ladder --------------------------------------------------------

test('the ladder relaxes leading before letter-spacing, and never loosens', () => {
	for (let i = 1; i < TYPE_LADDER.length; i++) {
		const prev = TYPE_LADDER[i - 1]!;
		const step = TYPE_LADDER[i]!;
		assert.ok(step.lineHeight <= prev.lineHeight, `rung ${i} loosened the leading`);
		assert.ok(step.letterSpacingEm <= prev.letterSpacingEm, `rung ${i} loosened the tracking`);
	}
	// The first rung is the comfortable default — nothing tightened yet.
	assert.equal(TYPE_LADDER[0]!.letterSpacingEm, 0);
});

test('walking the ladder buys real height back at the same font size', () => {
	const chars = 120;
	const size = 11;
	const width = 240;
	const loose = estimateHeight(chars, size, width, TYPE_LADDER[0]!);
	const tight = estimateHeight(chars, size, width, TYPE_LADDER[TYPE_LADDER.length - 1]!);
	assert.ok(tight < loose, 'the tightest rung should be shorter than the loosest');
	// It must be a meaningful saving, or the ladder is not worth the complexity.
	assert.ok(tight <= loose * 0.86, `expected ≥14% saving, got ${(1 - tight / loose) * 100}%`);
});

test('the ladder alone absorbs a one-line overshoot', () => {
	// A box holding exactly 5 lines of 11px text at default leading.
	const size = 11;
	const width = 240;
	const perLine = Math.floor(width / size);
	const boxHeight = 5 * size * TYPE_LADDER[0]!.lineHeight;
	// Six lines' worth of characters: the classic "one line too many".
	const chars = perLine * 6;
	assert.ok(estimateHeight(chars, size, width, TYPE_LADDER[0]!) > boxHeight);
	const tightest = estimateHeight(chars, size, width, TYPE_LADDER[TYPE_LADDER.length - 1]!);
	assert.ok(tightest <= boxHeight, 'tightening should fit it without shrinking the type');
});

test('the readable floor is never crossed by the size bounds', () => {
	const { min, max } = fontSizeBounds(9, 3, MIN_READABLE_PX);
	assert.equal(min, MIN_READABLE_PX);
	assert.ok(max >= min, 'max must not fall below the floor even in a tiny box');
});

// ---- per-line masking -------------------------------------------------------

test('a run keeps every source line rect, not just their union', () => {
	const lines: PdfRect[] = [
		[54, 700, 292, 712],
		[54, 686, 292, 698],
		// A short last line — this is the ragged tail a union mask would eat.
		[54, 672, 140, 684]
	];
	const runs = groupLineRects(lines);
	assert.equal(runs.length, 1);
	assert.equal(runs[0]!.lines.length, 3);
	assert.deepEqual(runs[0]!.lines[2], [54, 672, 140, 684]);
	// The union still spans the full column…
	assert.equal(runs[0]!.rect[2], 292);
	// …but the last line's own rect stops well short of it, so masking per
	// line leaves the page to the right of it untouched.
	assert.ok(runs[0]!.lines[2]![2] < runs[0]!.rect[2]);
});

test('a paragraph flowing across the gutter yields two runs, each with its own lines', () => {
	const lines: PdfRect[] = [
		[54, 120, 292, 132],
		[54, 106, 292, 118],
		[320, 700, 558, 712],
		[320, 686, 558, 698]
	];
	const runs = groupLineRects(lines);
	assert.equal(runs.length, 2);
	assert.equal(runs[0]!.lines.length, 2);
	assert.equal(runs[1]!.lines.length, 2);
	assert.ok(runs[1]!.lines.every(r => r[0] === 320));
});

// ---- running heads and feet -------------------------------------------------

test('the PLOS page foot is filtered', () => {
	// 612×792 page; the foot line sits ~30pt from the bottom.
	assert.equal(
		isRunningHeadOrFoot([54, 28, 558, 40], 792, 1, 'PLOS ONE | DOI:10.1371/journal.pone.0121631   March 17, 2015'),
		true
	);
	assert.equal(isRunningHeadOrFoot([520, 28, 558, 40], 792, 1, '1 / 13'), true);
	assert.equal(isRunningHeadOrFoot([300, 28, 312, 40], 792, 1, '7'), true);
});

test('the running head repeating the article title is filtered', () => {
	assert.equal(
		isRunningHeadOrFoot([300, 756, 558, 768], 792, 1, 'CT Perfusion with Acetazolamide Challenge'),
		true
	);
});

test('body text reaching into the band is kept', () => {
	const body = 'Thirty-two male Sprague-Dawley rats were evaluated. The rats were divided randomly into four groups, each of which received a different implantation schedule.';
	assert.equal(isRunningHeadOrFoot([54, 30, 292, 300], 792, 12, body), false);
	// A long single line in the band is not furniture either.
	assert.equal(isRunningHeadOrFoot([54, 30, 558, 42], 792, 1, body), false);
});

test('nothing outside the top/bottom band is ever a running head', () => {
	assert.equal(isRunningHeadOrFoot([54, 400, 292, 412], 792, 1, 'Short line mid-page'), false);
});

// ---- the two filters compose ------------------------------------------------

test('a page-foot DOI line is caught by either filter', () => {
	const text = 'PLOS ONE | DOI:10.1371/journal.pone.0121631   March 17, 2015';
	assert.equal(isMetadataBlock(text), true, 'DOI rule');
	assert.equal(isRunningHeadOrFoot([54, 28, 558, 40], 792, 1, text), true, 'geometry rule');
});

// ---- reading-order normalisation -------------------------------------------

test('a column handed back bottom-to-top is restored to reading order', () => {
	const topDown: PdfRect[] = [
		[54, 700, 292, 712],
		[54, 686, 292, 698],
		[54, 672, 292, 684],
		[54, 658, 292, 670]
	];
	const bottomUp = [...topDown].reverse();
	const runs = groupLineRects(bottomUp);
	// Without normalisation every line looks like an upward jump and becomes
	// its own run — the shredded-paragraph bug.
	assert.equal(runs.length, 1, 'reversed input must not shatter into one run per line');
	assert.equal(runs[0]!.lineCount, 4);
	// And it is genuinely in reading order now.
	assert.deepEqual(runs[0]!.lines[0], topDown[0]);
	assert.deepEqual(runs[0]!.lines[3], topDown[3]);
});

test('normalisation leaves a correctly ordered two-column flow alone', () => {
	const lines: PdfRect[] = [
		[54, 120, 292, 132],
		[54, 106, 292, 118],
		[320, 700, 558, 712],
		[320, 686, 558, 698]
	];
	const runs = groupLineRects(lines);
	assert.equal(runs.length, 2);
	assert.equal(runs[0]!.lines[0]![0], 54, 'left column still comes first');
});

test('a two-line block is never reordered on a coin flip', () => {
	const two: PdfRect[] = [[54, 700, 292, 712], [54, 686, 292, 698]];
	const runs = groupLineRects(two);
	assert.deepEqual(runs[0]!.lines[0], two[0]);
});
