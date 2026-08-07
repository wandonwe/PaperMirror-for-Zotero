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
