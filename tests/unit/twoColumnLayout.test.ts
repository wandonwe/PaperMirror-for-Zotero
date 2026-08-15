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

import { detectColumns, type Rect } from '../../src/reader/paragraphHeuristics';

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

// ---- zebra-page regressions: interleaved stream order + bogus break flags ---

import { orderBlocksForReading } from '../../src/reader/readingOrder';
import { buildLines, buildParagraphs } from '../../src/reader/blockBuilder';
import type { PdfChar } from '../../src/types/models';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
import type { SourceBlock } from '../../src/types/models';

function colBlock(id: string, column: number, top: number, text: string): SourceBlock {
	const x1 = column === 0 ? LEFT_X : RIGHT_X;
	const x2 = column === 0 ? LEFT_RIGHT : RIGHT_RIGHT;
	return {
		id, pageIndex: 0, order: 0, type: 'paragraph', sourceText: text,
		boundingBox: { x: x1, y: top, width: x2 - x1, height: 11 },
		lineRectsPdf: [[x1, PAGE_H - top - 11, x2, PAGE_H - top]],
		fontSize: 10, column
	};
}

test('row-wise interleaved columns are re-ordered L-column-first, then R', () => {
	// Stream order L1 R1 L2 R2 L3 R3 — the zebra-page shape.
	const blocks = [
		colBlock('L1', 0, 100, 'left one continues and'),
		colBlock('R1', 1, 100, 'right one continues and'),
		colBlock('L2', 0, 113, 'left two continues and'),
		colBlock('R2', 1, 113, 'right two continues and'),
		colBlock('L3', 0, 126, 'left three ends here.'),
		colBlock('R3', 1, 126, 'right three ends here.')
	];
	const ordered = orderBlocksForReading(blocks);
	assert.deepEqual(ordered.map(b => b.id), ['L1', 'L2', 'L3', 'R1', 'R2', 'R3']);
});

test('after re-ordering, the coalescer rejoins the one-line shreds per column', () => {
	const blocks = [
		colBlock('L1', 0, 100, 'in predicting POPF. In view of the imbalance between the'),
		colBlock('R1', 1, 100, 'pancreatoduodenectomy patients underwent the open'),
		colBlock('L2', 0, 113, 'patients with and without POPF, we further used the'),
		colBlock('R2', 1, 113, 'procedure with pancreaticojejunostomy performed by'),
		colBlock('L3', 0, 126, 'F score to compare performance across both models.'),
		colBlock('R3', 1, 126, 'duct-to-mucosa anastomosis in every included case.')
	];
	const regions = coalesceRegions(orderBlocksForReading(blocks));
	assert.equal(regions.length, 2, 'one region per column, not six one-line shreds');
	assert.ok(regions[0]!.sourceText.includes('POPF, we further used'), 'left column rejoined in order');
	assert.ok(regions[1]!.sourceText.includes('anastomosis in every'), 'right column rejoined in order');
});

test('a mid-page full-width block separates bands and keeps its position', () => {
	const wide: SourceBlock = {
		id: 'W', pageIndex: 0, order: 0, type: 'caption', sourceText: 'Table 1: spanning caption',
		boundingBox: { x: LEFT_X, y: 120, width: RIGHT_RIGHT - LEFT_X, height: 12 },
		fontSize: 10, column: -1
	};
	const blocks = [
		colBlock('L1', 0, 100, 'above left'), colBlock('R1', 1, 100, 'above right'),
		wide,
		colBlock('L2', 0, 140, 'below left'), colBlock('R2', 1, 140, 'below right')
	];
	const ordered = orderBlocksForReading(blocks);
	assert.deepEqual(ordered.map(b => b.id), ['L1', 'R1', 'W', 'L2', 'R2']);
});

test('bogus per-line paragraphBreakAfter flags are ignored (geometry wins)', () => {
	// Every line carries the break flag — a real PDF pathology. The wrapped-line
	// geometry must override it so the paragraph survives as ONE block.
	const mkChar = (text: string, y: number, last: boolean): PdfChar[] =>
		[...text].map((c, i) => ({
			c, rect: [54 + i * 5.5, y, 54 + i * 5.5 + 5.5, y + 10] as [number, number, number, number],
			fontSize: 10, fontName: 'Body',
			lineBreakAfter: false,
			paragraphBreakAfter: i === text.length - 1 // EVERY line flagged
		} as PdfChar));
	const lines = [
		'The quick brown fox jumps over the lazy dog and',
		'continues running through the field toward the barn',
		'until it finally reaches the shaded resting place.',
		'Another line follows to reach the eight line minimum',
		'needed for the sanity check to consider the page and',
		'the flags statistically meaningless rather than real',
		'paragraph boundaries that a normal document carries',
		'somewhere in the middle of the extracted text flow.'
	];
	const cs = lines.flatMap((t, i) => mkChar(t, 700 - i * 12, i === lines.length - 1));
	const paras = buildParagraphs(cs, buildLines(cs), 612, 792);
	assert.equal(paras.length, 1, 'flags on every line are distrusted; geometry keeps one paragraph');
});

// ---------------------------------------------------------------------------
// 三栏首页 (Radiology State-of-the-Art 第 33 页形态): 三栏栏距比双栏窄, 一行
// 连字符悬垂几 pt 进栏距, 贪心链式列检测就把左中两栏"焊"成一条带 —— 列标注
// 塌掉, 规范阅读序失效, 左中两栏退化成逐行小块 (半翻半英), 而第三栏完好.
// ---------------------------------------------------------------------------

const COL_A: [number, number] = [70, 225];
const COL_B: [number, number] = [240, 395];
const COL_C: [number, number] = [410, 565];

function threeColumnPage(): SpanItem[] {
	const colTexts: Record<string, string[]> = {
		A: [
			'Since its advent, there have been',
			'continuing advances in computed',
			'tomographic technology that have',
			'provided us with many new chances',
			'to improve the image quality and',
			'our clinical practice every day.'
		],
		B: [
			'New technology, however, has now',
			'introduced new challenges in our',
			'practice and we must decide how',
			'best to standardize protocols and',
			'manage radiation dose while also',
			'keeping large image data sets.'
		],
		C: [
			'Iodine in a target organ or blood',
			'plasma causes greater absorption',
			'and scattering of x-ray radiation',
			'which results in an increase in',
			'attenuation and greater contrast',
			'enhancement on the final image.'
		]
	};
	const cols: Record<string, [number, number]> = { A: COL_A, B: COL_B, C: COL_C };
	const items: SpanItem[] = [];
	for (const key of ['A', 'B', 'C'] as const) {
		const [x, right] = cols[key]!;
		let y = 600;
		colTexts[key]!.forEach((text, i) => {
			// The welding rect: line 3 of column A hyphen-overhangs 11pt into the
			// 15pt gutter, leaving a 4pt gap to column B — under the 11pt chain
			// threshold, so the greedy pass fuses A and B.
			const r = key === 'A' && i === 2 ? 236 : right;
			items.push({ text, rect: [x, y - 10, r, y], fontSize: 10 });
			y -= 12;
		});
	}
	return items;
}

test('one hyphen-overhang rect cannot weld two columns into one band (三栏反焊接)', () => {
	const rects = threeColumnPage().map(i => i.rect);
	const bands = detectColumns(rects, PAGE_W, PAGE_H);
	assert.equal(bands.length, 3, `expected 3 bands, got ${JSON.stringify(bands)}`);
	// The protruding edge must not stretch band A across the gutter.
	assert.ok(bands[0]!.right < COL_B[0], `band A reaches into column B: ${JSON.stringify(bands[0])}`);
	assert.ok(bands[1]!.left >= COL_B[0] - 1 && bands[1]!.right <= COL_B[1] + 1);
});

test('three-column page with a welding rect still yields one paragraph per column', () => {
	const { blocks } = buildBlocksFromSpans(threeColumnPage(), {
		pageIndex: 0,
		pageHeight: PAGE_H,
		pageWidth: PAGE_W
	});
	const paragraphs = blocks.filter(b => b.type === 'paragraph');
	assert.equal(paragraphs.length, 3, paragraphs.map(p => p.sourceText).join(' || '));
	assert.ok(paragraphs[0]!.sourceText.startsWith('Since its advent'));
	assert.ok(paragraphs[0]!.sourceText.includes('every day.'));
	assert.ok(paragraphs[1]!.sourceText.startsWith('New technology'));
	assert.ok(paragraphs[2]!.sourceText.startsWith('Iodine in a target'));
	assert.deepEqual(paragraphs.map(p => p.column), [0, 1, 2]);
});

test('ordinary single- and two-column bands are NOT split by the coverage vote', () => {
	// A ragged-right references column: hanging indents + short final lines.
	// The interior low-coverage zones touch the band edges, so no split.
	const refs: Rect[] = [];
	let y = 600;
	for (let i = 0; i < 12; i++) {
		const first = i % 3 === 0;
		refs.push([first ? 54 : 66, y - 10, i % 3 === 2 ? 180 : 292, y]);
		y -= 12;
	}
	assert.equal(detectColumns(refs, PAGE_W, PAGE_H).length, 1);
	// The IEEE two-column body page keeps exactly two bands.
	const twoCol = bodyPage().map(i => i.rect);
	assert.equal(detectColumns(twoCol, PAGE_W, PAGE_H).length, 2);
});

test('orderBlocksForReading stamps readingIndex on every path (1.0.6)', () => {
	// Column page: canonical order gets 0..n-1 and mirrors `order`.
	const blocks: SourceBlock[] = [
		{ id: 'r0', pageIndex: 0, order: 0, type: 'paragraph', column: 1, sourceText: 'right top', boundingBox: { x: 320, y: 80, width: 220, height: 40 } },
		{ id: 'l0', pageIndex: 0, order: 1, type: 'paragraph', column: 0, sourceText: 'left top', boundingBox: { x: 40, y: 80, width: 220, height: 40 } },
		{ id: 'r1', pageIndex: 0, order: 2, type: 'paragraph', column: 1, sourceText: 'right bottom', boundingBox: { x: 320, y: 140, width: 220, height: 40 } },
		{ id: 'l1', pageIndex: 0, order: 3, type: 'paragraph', column: 0, sourceText: 'left bottom', boundingBox: { x: 40, y: 140, width: 220, height: 40 } }
	];
	const ordered = orderBlocksForReading(blocks);
	assert.deepEqual(ordered.map(b => b.readingIndex), [0, 1, 2, 3]);
	assert.deepEqual(ordered.map(b => b.id), ['l0', 'l1', 'r0', 'r1']);
	assert.ok(ordered.every((b, i) => b.order === i && b.readingIndex === i));
	// Degenerate path (no geometry): stream order IS the reading order, still stamped.
	const plain = orderBlocksForReading([
		{ id: 'a', pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'a' },
		{ id: 'b', pageIndex: 0, order: 1, type: 'paragraph', sourceText: 'b' }
	]);
	assert.deepEqual(plain.map(b => b.readingIndex), [0, 1]);
});
