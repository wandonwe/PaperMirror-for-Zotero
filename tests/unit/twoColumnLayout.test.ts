/**
 * End-to-end segmentation tests on realistic two-column paper geometry.
 * These are the regressions behind 「分段乱、句子被切碎」.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlocksFromSpans, groupIntoLines, lineText, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { distributeText, groupLineRects, splitSentences } from '../../src/reader/overlayLayout';

const PAGE_W = 612;
const PAGE_H = 792;
const SIZE = 9.5;
const LEADING = 11.5;

// IEEE-style two-column geometry: columns 54–292 and 320–558, gutter 28pt.
const LEFT_X = 54;
const LEFT_RIGHT = 292;
const RIGHT_X = 320;
const RIGHT_RIGHT = 558;

function span(text: string, x: number, top: number, right: number, size = SIZE): SpanItem {
	return { text, rect: [x, top - size, right, top], fontSize: size };
}

/** A justified column line: starts at the margin, ends at the right margin. */
function full(text: string, column: 'L' | 'R', top: number): SpanItem {
	return column === 'L'
		? span(text, LEFT_X, top, LEFT_RIGHT)
		: span(text, RIGHT_X, top, RIGHT_RIGHT);
}

/** A paragraph-final (short) line. */
function short(text: string, column: 'L' | 'R', top: number, width = 90): SpanItem {
	return column === 'L'
		? span(text, LEFT_X, top, LEFT_X + width)
		: span(text, RIGHT_X, top, RIGHT_X + width);
}

function bodyPage(): SpanItem[] {
	const items: SpanItem[] = [];
	let y = 700;
	// Left column: one 5-line paragraph, then a short final line.
	items.push(full('the transformer architecture relies entirely on', 'L', y));
	items.push(full('attention mechanisms to draw global dependencies', 'L', y -= LEADING));
	items.push(full('between input and output, dispensing with', 'L', y -= LEADING));
	items.push(full('recurrence and convolutions entirely and', 'L', y -= LEADING));
	items.push(short('achieving better results.', 'L', y -= LEADING));
	// New paragraph, first line indented.
	y -= LEADING;
	items.push(span('We propose a new simple network architecture', LEFT_X + 11, y, LEFT_RIGHT));
	items.push(full('based solely on attention mechanisms and show', 'L', y -= LEADING));
	items.push(short('that it trains faster.', 'L', y -= LEADING));

	// Right column at the same baselines — this is what used to get
	// concatenated with the left column into one scrambled line.
	y = 700;
	items.push(full('experiments on two machine translation tasks', 'R', y));
	items.push(full('show these models to be superior in quality', 'R', y -= LEADING));
	items.push(short('while being more parallelizable.', 'R', y -= LEADING));
	return items;
}

test('left and right columns are never merged into one line', () => {
	const lines = groupIntoLines(bodyPage(), PAGE_W);
	for (const line of lines) {
		const text = lineText(line);
		assert.ok(
			!(text.includes('transformer architecture') && text.includes('machine translation')),
			`a line spans the gutter: "${text}"`
		);
		// Every line stays inside one column.
		assert.ok(line.rect[2] <= LEFT_RIGHT + 1 || line.rect[0] >= RIGHT_X - 1,
			`line crosses the gutter: ${JSON.stringify(line.rect)}`);
	}
});

test('reading order is left column top-to-bottom, then right column', () => {
	const lines = groupIntoLines(bodyPage(), PAGE_W).map(lineText);
	const firstRight = lines.findIndex(t => t.startsWith('experiments on two'));
	const lastLeft = lines.map(t => t.startsWith('that it trains')).lastIndexOf(true);
	assert.ok(firstRight > lastLeft, 'the whole left column comes before the right one');
});

test('a wrapped sentence is not cut into pieces', () => {
	const { blocks } = buildBlocksFromSpans(bodyPage(), {
		pageIndex: 0, pageHeight: PAGE_H, pageWidth: PAGE_W
	});
	const opening = blocks.find(b => b.sourceText.startsWith('the transformer'));
	assert.ok(opening, 'the opening paragraph exists');
	// All five of its lines belong to ONE block, ending at the short line.
	assert.ok(opening!.sourceText.includes('dispensing with recurrence'),
		'the sentence survived the line wrap');
	assert.ok(opening!.sourceText.endsWith('achieving better results.'));
	assert.equal(opening!.lineRectsPdf?.length, 5);
});

test('an indented line still starts a new paragraph', () => {
	const { blocks } = buildBlocksFromSpans(bodyPage(), {
		pageIndex: 0, pageHeight: PAGE_H, pageWidth: PAGE_W
	});
	assert.ok(blocks.some(b => b.sourceText.startsWith('We propose a new simple')),
		'the indented paragraph is its own block');
});

test('the page yields three body paragraphs, not a dozen fragments', () => {
	const { blocks } = buildBlocksFromSpans(bodyPage(), {
		pageIndex: 0, pageHeight: PAGE_H, pageWidth: PAGE_W
	});
	assert.equal(blocks.length, 3);
	for (const block of blocks) {
		assert.ok(block.sourceText.length > 40, `fragment too short: "${block.sourceText}"`);
	}
});

test('a superscript citation does not split the line it sits on', () => {
	const items = bodyPage();
	// A 5.5pt superscript in the middle of the first line.
	items.push(span('12', LEFT_X + 150, 700 + 3, LEFT_X + 158, 5.5));
	const { blocks } = buildBlocksFromSpans(items, {
		pageIndex: 0, pageHeight: PAGE_H, pageWidth: PAGE_W
	});
	assert.equal(blocks.length, 3, 'the superscript did not create extra blocks');
});

// ---- overlay text distribution ---------------------------------------------

test('splitSentences keeps abbreviations and decimals intact', () => {
	assert.deepEqual(splitSentences('Reported by Smith et al. in 2020. Then it stopped.'),
		['Reported by Smith et al. in 2020.', 'Then it stopped.']);
	assert.deepEqual(splitSentences('准确率为 0.75。随后下降。'), ['准确率为 0.75。', '随后下降。']);
});

test('a paragraph spanning two columns splits at a sentence, not mid-clause', () => {
	// Bottom of the left column (2 lines) continuing at the top of the right (4).
	const rects = [
		[LEFT_X, 120, LEFT_RIGHT, 131], [LEFT_X, 108, LEFT_RIGHT, 119],
		[RIGHT_X, 700, RIGHT_RIGHT, 711], [RIGHT_X, 688, RIGHT_RIGHT, 699],
		[RIGHT_X, 676, RIGHT_RIGHT, 687], [RIGHT_X, 664, RIGHT_RIGHT, 675]
	] as [number, number, number, number][];
	const runs = groupLineRects(rects);
	assert.equal(runs.length, 2);
	const text = '我们在两个机器翻译任务上进行了实验。结果表明这些模型在质量上更优。同时它们的并行度更高，训练所需时间也显著更少。';
	const parts = distributeText(text, runs);
	assert.equal(parts.length, 2);
	// Neither part may end mid-sentence.
	assert.ok(/[。！？]$/.test(parts[0]!), `left part ends mid-sentence: "${parts[0]}"`);
	assert.ok(/[。！？]$/.test(parts[1]!));
	// Nothing is lost.
	assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('a single unbroken sentence still falls back to a safe character split', () => {
	const rects = [
		[LEFT_X, 120, LEFT_RIGHT, 131],
		[RIGHT_X, 700, RIGHT_RIGHT, 711]
	] as [number, number, number, number][];
	const runs = groupLineRects(rects);
	const text = 'a single very long clause with no terminal punctuation anywhere inside of it at all';
	const parts = distributeText(text, runs);
	assert.equal(parts.length, 2);
	assert.ok(parts.every(p => p.length > 0));
	// The split landed on a word boundary, not inside a word.
	assert.ok(text.replace(/\s+/g, ' ').includes(parts[0]!));
	assert.ok(text.replace(/\s+/g, ' ').includes(parts[1]!));
});

// ---- RSNA-page regression: centered footer must not bridge the columns ------

import { detectColumns } from '../../src/reader/paragraphHeuristics';

test('a centered page-bottom footer does not bridge the two columns', () => {
	// Real failure (RSNA reprint): "This copy is for personal use only…" is a
	// ~50%-width centered line at the very bottom — narrower than the 62%
	// full-width cutoff, sitting ACROSS the gutter. Fed into the projection it
	// chained left+footer+right into ONE band and the page read single-column.
	const rects: [number, number, number, number][] = [];
	for (let i = 0; i < 20; i++) {
		rects.push([54, 700 - i * 12, 292, 710 - i * 12]);   // left column
		rects.push([320, 700 - i * 12, 558, 710 - i * 12]);  // right column
	}
	rects.push([160, 20, 470, 30]); // centered footer inside the bottom 6% band
	const bands = detectColumns(rects, 612, 792);
	assert.equal(bands.length, 2, 'footer excluded → two columns survive');
});

test('a bare page number does not bridge the columns even mid-page-height', () => {
	const rects: [number, number, number, number][] = [];
	for (let i = 0; i < 10; i++) {
		rects.push([54, 700 - i * 12, 292, 710 - i * 12]);
		rects.push([320, 700 - i * 12, 558, 710 - i * 12]);
	}
	rects.push([300, 400, 312, 410]); // 12pt-wide scrap in the gutter (page num / eq num)
	const bands = detectColumns(rects, 612, 792);
	assert.equal(bands.length, 2, 'tiny rects are excluded from the projection');
});

test('band.left is the MEDIAN member left — one outdented bullet does not shift it', () => {
	const rects: [number, number, number, number][] = [];
	for (let i = 0; i < 9; i++) {
		rects.push([54, 700 - i * 12, 292, 710 - i * 12]);
	}
	rects.push([42, 580, 292, 590]); // one hanging-indent/bullet line, 12pt outdented
	const bands = detectColumns(rects, 612, 792);
	assert.equal(bands.length, 1);
	assert.equal(bands[0]!.left, 54, 'median left, not the outlier minimum');
});

test('sliver-only pages report NO columns instead of promoting the slivers', () => {
	const bands = detectColumns([[301, 400, 311, 410], [300, 300, 313, 310], [299, 200, 315, 210]], 612, 792);
	assert.equal(bands.length, 0);
});

test('text-layer path stamps column on emitted blocks', () => {
	const items: SpanItem[] = [];
	const mk = (x1: number, x2: number, top: number, text: string): SpanItem => ({
		text, rect: [x1, top - SIZE, x2, top], fontSize: SIZE
	});
	for (let i = 0; i < 6; i++) {
		items.push(mk(LEFT_X, LEFT_RIGHT, 700 - i * LEADING, `left line ${i} runs to the margin of col.`));
		items.push(mk(RIGHT_X, RIGHT_RIGHT, 700 - i * LEADING, `right line ${i} runs to the margin too.`));
	}
	const result = buildBlocksFromSpans(items, { pageIndex: 0, pageWidth: PAGE_W, pageHeight: PAGE_H, includeReferences: false });
	const cols = new Set(result.blocks.map(b => b.column));
	assert.ok(result.blocks.every(b => typeof b.column === 'number'), 'every block carries a column');
	assert.ok(cols.has(0) && cols.has(1), 'both columns are represented');
});

// ---- page-1 boilerplate: content-based removal, position-independent --------

import { isPublisherBoilerplateLine } from '../../src/reader/metaFilter';

test('isPublisherBoilerplateLine matches reprint/download notices, not prose', () => {
	assert.equal(isPublisherBoilerplateLine('This copy is for personal use only. To order copies, contact reprints@rsna.org'), true);
	assert.equal(isPublisherBoilerplateLine('Downloaded from ajronline.org by 1.2.3.4 on 08/10/26'), true);
	assert.equal(isPublisherBoilerplateLine('© RSNA 2024'), true);
	assert.equal(isPublisherBoilerplateLine('The operational efficiency of CT, combined with its spatial resolution.'), false);
	// a long prose paragraph QUOTING the phrase survives (length cap)
	assert.equal(isPublisherBoilerplateLine('x'.repeat(150) + ' this copy is for personal use only ' + 'y'.repeat(60)), false);
});

test('a MID-PAGE centered reprint notice does not bridge the columns (page-1 case)', () => {
	// Page 1: the notice sits near the abstract, far from the bottom furniture
	// band — position filters miss it; content filter must remove it.
	const items: SpanItem[] = [];
	const mk = (x1: number, x2: number, top: number, text: string): SpanItem => ({
		text, rect: [x1, top - SIZE, x2, top], fontSize: SIZE
	});
	for (let i = 0; i < 8; i++) {
		items.push(mk(LEFT_X, LEFT_RIGHT, 600 - i * LEADING, `left body line ${i} continues to the margin.`));
		items.push(mk(RIGHT_X, RIGHT_RIGHT, 600 - i * LEADING, `right body line ${i} continues to the margin.`));
	}
	// centered notice at mid page height (y≈640), spanning the gutter
	items.push(mk(150, 470, 640, 'This copy is for personal use only. To order copies, contact reprints@rsna.org'));
	const result = buildBlocksFromSpans(items, { pageIndex: 0, pageWidth: PAGE_W, pageHeight: PAGE_H, includeReferences: false });
	assert.ok(
		result.blocks.every(b => !/personal use only/i.test(b.sourceText)),
		'the notice never becomes a block'
	);
	const cols = new Set(result.blocks.map(b => b.column));
	assert.ok(cols.has(0) && cols.has(1), 'two columns survive the mid-page notice');
});
