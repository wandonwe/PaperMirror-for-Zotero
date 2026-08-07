import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildBlocksFromSpans,
	groupIntoLines,
	groupIntoParagraphs,
	lineText,
	type SpanItem
} from '../../src/reader/spanBlockBuilder';

const PAGE_HEIGHT = 792;

/** One text run. PDF coordinates: y grows upward, rect = [x1, y1, x2, y2]. */
function span(text: string, x: number, baselineTop: number, width: number, size = 10): SpanItem {
	return { text, rect: [x, baselineTop - size, x + width, baselineTop], fontSize: size };
}

/** A run of lines in one column, top to bottom. */
function lines(texts: string[], x: number, topY: number, size = 10, leading = 12, width = 200): SpanItem[] {
	return texts.map((t, i) => span(t, x, topY - i * leading, width, size));
}

// ---- line grouping ----------------------------------------------------------

test('runs on the same baseline become one line, ordered left to right', () => {
	const items = [
		span('world', 150, 700, 40),
		span('hello', 100, 700, 40)
	];
	const grouped = groupIntoLines(items);
	assert.equal(grouped.length, 1);
	assert.equal(lineText(grouped[0]!), 'hello world');
});

test('runs far apart horizontally are different lines (two columns)', () => {
	const items = [
		span('left column text', 50, 700, 200),
		span('right column text', 320, 700, 200)
	];
	assert.equal(groupIntoLines(items).length, 2);
});

test('lines come back in reading order, top to bottom', () => {
	const grouped = groupIntoLines(lines(['first', 'second', 'third'], 50, 700));
	assert.deepEqual(grouped.map(lineText), ['first', 'second', 'third']);
});

test('blank and malformed runs are ignored', () => {
	const items: SpanItem[] = [
		span('   ', 50, 700, 20),
		{ text: 'bad', rect: [0, NaN, 10, 10] },
		span('real', 50, 688, 40)
	];
	const grouped = groupIntoLines(items);
	assert.equal(grouped.length, 1);
	assert.equal(lineText(grouped[0]!), 'real');
});

// ---- word joining -----------------------------------------------------------

test('a gap between runs inserts a space', () => {
	const line = groupIntoLines([span('alpha', 100, 700, 30), span('beta', 136, 700, 25)])[0]!;
	assert.equal(lineText(line), 'alpha beta');
});

test('adjacent runs are joined without a space (split glyph run)', () => {
	const line = groupIntoLines([span('trans', 100, 700, 30), span('lation', 130, 700, 30)])[0]!;
	assert.equal(lineText(line), 'translation');
});

test('CJK runs are never separated by a space', () => {
	const line = groupIntoLines([span('神经', 100, 700, 22), span('网络', 124, 700, 22)])[0]!;
	assert.equal(lineText(line), '神经网络');
});

// ---- paragraph grouping -----------------------------------------------------

test('tightly spaced lines form one paragraph', () => {
	const paragraphs = groupIntoParagraphs(groupIntoLines(lines(['a a a', 'b b b', 'c c c'], 50, 700)));
	assert.equal(paragraphs.length, 1);
	assert.equal(paragraphs[0]!.length, 3);
});

test('a large vertical gap starts a new paragraph', () => {
	const first = lines(['a a a', 'b b b'], 50, 700);
	const second = lines(['c c c'], 50, 640); // ~48pt below -> big gap
	const paragraphs = groupIntoParagraphs(groupIntoLines([...first, ...second]));
	assert.equal(paragraphs.length, 2);
});

test('an indented first line starts a new paragraph', () => {
	const body = lines(['a a a', 'b b b'], 50, 700);
	const indented = lines(['c c c'], 62, 676); // +12pt indent, normal leading
	const paragraphs = groupIntoParagraphs(groupIntoLines([...body, ...indented]));
	assert.equal(paragraphs.length, 2);
});

test('a font-size jump starts a new paragraph (heading vs body)', () => {
	const heading = lines(['Introduction'], 50, 700, 16);
	const body = lines(['a a a', 'b b b'], 50, 682, 10);
	const paragraphs = groupIntoParagraphs(groupIntoLines([...heading, ...body]));
	assert.equal(paragraphs.length, 2);
	assert.equal(lineText(paragraphs[0]![0]!), 'Introduction');
});

test('moving to the next column starts a new paragraph', () => {
	const left = lines(['a a a', 'b b b'], 50, 200);
	const right = lines(['c c c'], 320, 700);
	const paragraphs = groupIntoParagraphs(groupIntoLines([...left, ...right]));
	assert.equal(paragraphs.length, 2);
});

// ---- block construction -----------------------------------------------------

test('blocks carry page-relative geometry and per-line rects for the overlay', () => {
	const items = lines(['first line here', 'second line here'], 50, 700);
	const { blocks } = buildBlocksFromSpans(items, { pageIndex: 3, pageHeight: PAGE_HEIGHT });
	assert.equal(blocks.length, 1);
	const block = blocks[0]!;
	assert.equal(block.pageIndex, 3);
	assert.equal(block.id, 'page-3-block-0');
	assert.equal(block.sourceText, 'first line here second line here');
	// lineRectsPdf is what the on-page overlay needs — one rect per source line
	assert.equal(block.lineRectsPdf?.length, 2);
	// boundingBox is top-left origin (y flipped from PDF space)
	assert.ok(block.boundingBox!.y > 0 && block.boundingBox!.y < PAGE_HEIGHT);
	assert.ok(block.boundingBox!.height >= 12);
});

test('a large short line is classified as a title, a numbered one as a heading', () => {
	const title = lines(['Attention Is All You Need'], 50, 740, 20);
	const heading = lines(['3. Model Architecture'], 50, 700, 11);
	const body = lines(['x x x x', 'y y y y', 'z z z z'], 50, 660, 10);
	const { blocks } = buildBlocksFromSpans([...title, ...heading, ...body], {
		pageIndex: 0,
		pageHeight: PAGE_HEIGHT
	});
	assert.equal(blocks[0]!.type, 'title');
	assert.equal(blocks[1]!.type, 'heading');
	assert.equal(blocks[2]!.type, 'paragraph');
});

test('figure and table captions are classified, not treated as body text', () => {
	const fig = lines(['Figure 2: overall architecture.'], 50, 700, 9);
	const tab = lines(['Table 1: results on WMT14.'], 50, 660, 9);
	const { blocks } = buildBlocksFromSpans([...fig, ...tab], { pageIndex: 0, pageHeight: PAGE_HEIGHT });
	assert.equal(blocks[0]!.type, 'caption');
	assert.equal(blocks[1]!.type, 'table');
});

test('references are dropped by default and kept when requested', () => {
	const heading = lines(['References'], 50, 700, 11);
	const entry = lines(['[1] Vaswani et al. Attention is all you need. 2017.'], 50, 676, 9);
	const items = [...heading, ...entry];

	const dropped = buildBlocksFromSpans(items, { pageIndex: 0, pageHeight: PAGE_HEIGHT });
	assert.equal(dropped.referencesStarted, true);
	assert.ok(!dropped.blocks.some(b => b.sourceText.includes('Vaswani')));

	const kept = buildBlocksFromSpans(items, {
		pageIndex: 0,
		pageHeight: PAGE_HEIGHT,
		includeReferences: true
	});
	assert.ok(kept.blocks.some(b => b.sourceText.includes('Vaswani')));
	assert.ok(kept.blocks.every(b => b.isReference));
});

test('referencesAlreadyStarted carries across pages', () => {
	const entry = lines(['[7] Some trailing reference entry.'], 50, 700, 9);
	const result = buildBlocksFromSpans(entry, {
		pageIndex: 9,
		pageHeight: PAGE_HEIGHT,
		referencesAlreadyStarted: true
	});
	assert.deepEqual(result.blocks, []);
	assert.equal(result.referencesStarted, true);
});

test('empty input yields no blocks and does not throw', () => {
	const result = buildBlocksFromSpans([], { pageIndex: 0, pageHeight: PAGE_HEIGHT });
	assert.deepEqual(result.blocks, []);
	assert.equal(result.referencesStarted, false);
});

test('block order is sequential and ids are unique within a page', () => {
	const items = [
		...lines(['para one line one', 'para one line two'], 50, 700),
		...lines(['para two line one'], 50, 640)
	];
	const { blocks } = buildBlocksFromSpans(items, { pageIndex: 1, pageHeight: PAGE_HEIGHT });
	assert.equal(blocks.length, 2);
	assert.deepEqual(blocks.map(b => b.order), [0, 1]);
	assert.equal(new Set(blocks.map(b => b.id)).size, 2);
});
