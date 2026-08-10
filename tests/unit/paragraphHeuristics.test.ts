import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	columnOf,
	detectColumns,
	detectGutters,
	dominantFontSize,
	endsSentence,
	joinFragments,
	looksLikeListStart,
	planMerges,
	reachesRightMargin,
	shouldBreak,
	startsContinuation,
	type Rect
} from '../../src/reader/paragraphHeuristics';

const PAGE_W = 612;

/** A two-column body row: one line in the left column, one in the right. */
function twoColumnRow(y: number): Rect[] {
	return [
		[54, y - 10, 292, y],
		[320, y - 10, 558, y]
	];
}

// ---- font size: the bug that cut sentences in half --------------------------

test('dominantFontSize ignores a superscript that would move the mean', () => {
	// 40 body glyphs at 10pt plus a 6pt superscript citation.
	const sizes = [...Array(40).fill(10), 6, 6];
	assert.equal(dominantFontSize(sizes), 10);
	// The mean would have been ~9.8 — a 2% wobble is fine, but a line of
	// mostly-small glyphs used to drag it far enough to trip a 20% "font
	// jump" break in the middle of a sentence.
	const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
	assert.ok(mean < 10);
});

test('dominantFontSize buckets near-identical sizes together', () => {
	assert.equal(dominantFontSize([9.96, 10.02, 9.98, 10.01, 16]), 10);
});

test('dominantFontSize breaks ties toward the larger size', () => {
	assert.equal(dominantFontSize([10, 16]), 16);
});

test('dominantFontSize tolerates empty and invalid input', () => {
	assert.equal(dominantFontSize([]), 0);
	assert.equal(dominantFontSize([NaN, 0, -3]), 0);
});

// ---- columns and gutters ----------------------------------------------------

test('detectColumns finds two columns and ignores the gutter', () => {
	const rects: Rect[] = [];
	for (let i = 0; i < 10; i++) {
		rects.push(...twoColumnRow(700 - i * 12));
	}
	const bands = detectColumns(rects, PAGE_W);
	assert.equal(bands.length, 2);
	assert.ok(bands[0]!.right < bands[1]!.left, 'the gutter separates them');
});

test('detectColumns is not fooled into merging by a full-width title', () => {
	const rects: Rect[] = [[54, 730, 558, 750]]; // spanning title
	for (let i = 0; i < 10; i++) {
		rects.push(...twoColumnRow(700 - i * 12));
	}
	assert.equal(detectColumns(rects, PAGE_W).length, 2);
});

test('a single-column page yields one band', () => {
	const rects: Rect[] = Array.from({ length: 8 }, (_, i) =>
		[72, 700 - i * 14 - 10, 540, 700 - i * 14] as Rect);
	assert.equal(detectColumns(rects, PAGE_W).length, 1);
});

test('columnOf assigns lines to their column and marks spanning lines -1', () => {
	const rects: Rect[] = [];
	for (let i = 0; i < 10; i++) {
		rects.push(...twoColumnRow(700 - i * 12));
	}
	const bands = detectColumns(rects, PAGE_W);
	assert.equal(columnOf([54, 600, 292, 610], bands, PAGE_W), 0);
	assert.equal(columnOf([320, 600, 558, 610], bands, PAGE_W), 1);
	assert.equal(columnOf([54, 730, 558, 750], bands, PAGE_W), -1);
});

test('detectGutters votes across rows and survives a spanning title', () => {
	const rows: Rect[][] = [[[54, 730, 558, 750]]]; // title covers the gutter
	for (let i = 0; i < 12; i++) {
		rows.push(twoColumnRow(700 - i * 12));
	}
	const gutters = detectGutters(rows, PAGE_W);
	assert.equal(gutters.length, 1);
	assert.ok(gutters[0]! > 292 && gutters[0]! < 320, 'gutter sits between the columns');
});

test('detectGutters reports nothing for a single-column page', () => {
	const rows: Rect[][] = Array.from({ length: 12 }, (_, i) =>
		[[72, 700 - i * 14 - 10, 540, 700 - i * 14] as Rect]);
	assert.deepEqual(detectGutters(rows, PAGE_W), []);
});

test('detectGutters abstains when there are too few rows to vote', () => {
	assert.deepEqual(detectGutters([twoColumnRow(700), twoColumnRow(688)], PAGE_W), []);
});

// ---- the wrapped-line guard -------------------------------------------------

test('reachesRightMargin recognises a wrapped line and a paragraph-final one', () => {
	assert.equal(reachesRightMargin([54, 600, 291, 610], 292, 10), true);
	assert.equal(reachesRightMargin([54, 600, 180, 610], 292, 10), false);
});

test('a wrapped line is never broken by line-spacing wobble', () => {
	// A tall inline formula inflated the measured gap on this line.
	assert.equal(shouldBreak({
		fontSize: 10, gap: 9, wrapped: true,
		newColumn: false, indented: false, fontJump: false, listStart: false
	}), false);
});

test('the same wobble after a SHORT line does end the paragraph', () => {
	assert.equal(shouldBreak({
		fontSize: 10, gap: 9, wrapped: false,
		newColumn: false, indented: false, fontJump: false, listStart: false
	}), true);
});

test('a genuine section gap breaks even after a wrapped line', () => {
	assert.equal(shouldBreak({
		fontSize: 10, gap: 22, wrapped: true,
		newColumn: false, indented: false, fontJump: false, listStart: false
	}), true);
});

test('indentation and font jumps are strong enough to break on their own', () => {
	const base = { fontSize: 10, gap: 2, wrapped: true, newColumn: false, listStart: false };
	assert.equal(shouldBreak({ ...base, indented: true, fontJump: false }), true);
	assert.equal(shouldBreak({ ...base, indented: false, fontJump: true }), true);
});

test('a new column always breaks', () => {
	assert.equal(shouldBreak({
		fontSize: 10, gap: -400, wrapped: true,
		newColumn: true, indented: false, fontJump: false, listStart: false
	}), true);
});

// ---- sentence / continuation detection --------------------------------------

test('endsSentence accepts terminal punctuation, including inside quotes', () => {
	assert.equal(endsSentence('This is done.'), true);
	assert.equal(endsSentence('这是结论。'), true);
	assert.equal(endsSentence('he said "stop."'), true);
	assert.equal(endsSentence('as shown in Figure 3'), false);
	assert.equal(endsSentence('reported by Smith et al'), false);
});

test('startsContinuation catches lowercase and dangling punctuation', () => {
	assert.equal(startsContinuation('and therefore the result'), true);
	assert.equal(startsContinuation(', which is expected'), true);
	assert.equal(startsContinuation('The next paragraph begins'), false);
	assert.equal(startsContinuation('3. Model Architecture'), false);
});

test('looksLikeListStart covers bullets, numbers and reference entries', () => {
	assert.equal(looksLikeListStart('[12] Vaswani et al.'), true);
	assert.equal(looksLikeListStart('• first item'), true);
	assert.equal(looksLikeListStart('(3) third condition'), true);
	assert.equal(looksLikeListStart('the third condition'), false);
});

// ---- the repair pass --------------------------------------------------------

test('planMerges rejoins a sentence split across two fragments', () => {
	const groups = planMerges([
		{ text: 'We evaluate the model on three benchmarks and', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10 },
		{ text: 'report the mean accuracy over five seeds.', column: 0, type: 'paragraph' }
	]);
	assert.deepEqual(groups, [[0, 1]]);
});

test('planMerges leaves a properly finished paragraph alone', () => {
	const groups = planMerges([
		{ text: 'We evaluate the model on three benchmarks.', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10 },
		{ text: 'report the mean accuracy over five seeds.', column: 0, type: 'paragraph' }
	]);
	assert.deepEqual(groups, [[0], [1]]);
});

test('planMerges refuses to merge across real whitespace', () => {
	// Same text as the merging case, but a section gap sits between them —
	// so this was a deliberate break, not an over-split.
	const groups = planMerges([
		{ text: 'We evaluate the model on three benchmarks and', column: 0, type: 'paragraph', gapAfter: 30, fontSize: 10 },
		{ text: 'report the mean accuracy over five seeds.', column: 0, type: 'paragraph' }
	]);
	assert.deepEqual(groups, [[0], [1]]);
});

test('planMerges never merges across a column, or into a heading or list item', () => {
	assert.deepEqual(planMerges([
		{ text: 'ends open and', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10 },
		{ text: 'continues here', column: 1, type: 'paragraph' }
	]), [[0], [1]]);
	assert.deepEqual(planMerges([
		{ text: 'ends open and', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10 },
		{ text: 'and so on', column: 0, type: 'heading' }
	]), [[0], [1]]);
	assert.deepEqual(planMerges([
		{ text: 'the following hold and', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10 },
		{ text: '[4] Vaswani et al.', column: 0, type: 'paragraph' }
	]), [[0], [1]]);
});

test('joinFragments de-hyphenates Latin words and never spaces CJK', () => {
	assert.equal(joinFragments('exam-', 'ple sentence'), 'example sentence');
	assert.equal(joinFragments('the model', 'was trained'), 'the model was trained');
	assert.equal(joinFragments('神经网络', '的训练'), '神经网络的训练');
	assert.equal(joinFragments('', 'only this'), 'only this');
});

test('a fragment ending in a comma rejoins even when the next starts uppercase', () => {
	const groups = planMerges([
		{ text: '在有显著心外膜阻塞的患者中，', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10 },
		{ text: 'CCTA可以通过确定疾病复杂性来帮助规划血运重建。', column: 0, type: 'paragraph' }
	]);
	assert.deepEqual(groups, [[0, 1]]);
});

test('a comma ending does not merge across real whitespace', () => {
	const groups = planMerges([
		{ text: '在有显著心外膜阻塞的患者中，', column: 0, type: 'paragraph', gapAfter: 40, fontSize: 10 },
		{ text: 'CCTA可以通过确定疾病复杂性来帮助规划血运重建。', column: 0, type: 'paragraph' }
	]);
	assert.deepEqual(groups, [[0], [1]]);
});

test('replacementFontSize: body-cluster minimum, drop caps and superscripts excluded', async () => {
	const { replacementFontSize } = await import('../../src/reader/paragraphHeuristics');
	// Body at 9.5/10, a 22pt drop cap, a 6pt superscript citation.
	assert.equal(replacementFontSize([22, 10, 9.5, 10, 9.5, 10, 6]), 9.5);
	// Superscript alone must not drag the paragraph down to 6.
	assert.ok(replacementFontSize([10, 10, 10, 6]) >= 10);
	// Uniform sizes pass through.
	assert.equal(replacementFontSize([10, 10, 10]), 10);
	assert.equal(replacementFontSize([]), 0);
});

test('planMerges uses geometry over the (unstable) column index when rects exist', () => {
	// Same physical column (x-ranges overlap) but the flaky detector flipped the
	// index between the two rows — they must STILL rejoin. This is the residual
	// "one English line mid-paragraph" bug on narrow two-column pages.
	assert.deepEqual(planMerges([
		{ text: 'PCCT-based models will be at', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10, rect: [54, 700, 292, 712] },
		{ text: 'least as robust, if not better, than', column: 1, type: 'paragraph', rect: [54, 686, 292, 698] }
	]), [[0, 1]]);
	// Different physical columns (disjoint x-ranges) never merge, even if the
	// index happens to agree.
	assert.deepEqual(planMerges([
		{ text: 'ends open and', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10, rect: [54, 700, 292, 712] },
		{ text: 'continues here', column: 0, type: 'paragraph', rect: [320, 700, 558, 712] }
	]), [[0], [1]]);
});

test('endsSentence: colon and semicolon do NOT end a sentence', async () => {
	const { endsSentence } = await import('../../src/reader/paragraphHeuristics');
	assert.equal(endsSentence('the modifications include the following:'), false);
	assert.equal(endsSentence('improved sharpness;'), false);
	assert.equal(endsSentence('This is done.'), true);
	assert.equal(endsSentence('Really?'), true);
	assert.equal(endsSentence('结论。'), true);
});

test('planMerges rejoins a fragment after a colon-ending line', () => {
	// Was blocked by the endsSentence/danglingEnd contradiction.
	assert.deepEqual(planMerges([
		{ text: 'the modifications include the following:', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 10, rect: [54, 700, 292, 712] },
		{ text: 'sharper kernels and thinner sections', column: 0, type: 'paragraph', rect: [54, 686, 292, 698] }
	]), [[0, 1]]);
});

test('joinLines de-hyphenates line-broken words across all four hyphens', async () => {
	const { joinLines } = await import('../../src/reader/paragraphHeuristics');
	// U+002D, U+00AD, U+2010, U+2011 — all rejoin when Latin on both sides.
	assert.equal(joinLines(['sen-', 'sory']), 'sensory');
	assert.equal(joinLines(['func­', 'tional']), 'functional');
	assert.equal(joinLines(['inter‐', 'est']), 'interest');
	assert.equal(joinLines(['non‑', 'linear']), 'nonlinear');
	// A numeric range keeps its hyphen (letter not on both sides).
	assert.equal(joinLines(['3-', '5 mg']), '3- 5 mg');
	// Ordinary wrap joins with a space; CJK joins without one.
	assert.equal(joinLines(['hello', 'world']), 'hello world');
	assert.equal(joinLines(['中文', '断行']), '中文断行');
});

test('ordered-list vs section-number classification', async () => {
	const { isOrderedListStart, isSectionNumberHeading } = await import('../../src/reader/paragraphHeuristics');
	// single-level numbers / parens → ordered list
	assert.equal(isOrderedListStart('1. First item'), true);
	assert.equal(isOrderedListStart('2) Second'), true);
	assert.equal(isOrderedListStart('10. Tenth'), true);
	assert.equal(isOrderedListStart('(3) Third'), true);
	// multi-level section numbers → NOT a list (they are headings)
	assert.equal(isOrderedListStart('1.1 Background'), false);
	assert.equal(isOrderedListStart('4.6.1 Results'), false);
	assert.equal(isSectionNumberHeading('1.1 Background'), true);
	assert.equal(isSectionNumberHeading('4.6.1 Results'), true);
	assert.equal(isSectionNumberHeading('3. Methods'), false);
});
