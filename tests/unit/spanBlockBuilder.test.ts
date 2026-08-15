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

test('a title that wraps to three lines is still a title, not body', () => {
	// Regression: a 2×-body title spanning 3 lines was classed 'paragraph', so
	// the strict page rendered it at body size, un-bold — it read as missing.
	const title = lines([
		'Virtual Noncalcium Dual-Energy CT: Detection of',
		'Lumbar Disk Herniation in Comparison with Standard',
		'Gray-Scale CT'
	], 50, 740, 20, 22, 460);
	// Body must dominate so the page's body size resolves to 10 (as on a real
	// first page); a few lines would skew the ratio and mask the regression.
	const bodyTexts = Array.from({ length: 10 }, (_, i) => `body line ${i} with several words here to look real`);
	const body = lines(bodyTexts, 50, 560, 10, 12, 460);
	const { blocks } = buildBlocksFromSpans([...title, ...body], {
		pageIndex: 0,
		pageHeight: PAGE_HEIGHT
	});
	assert.equal(blocks[0]!.type, 'title');
	assert.equal(blocks[0]!.lineRectsPdf?.length, 3);
	assert.equal(blocks[1]!.type, 'paragraph');
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

test('isBareFigureLabel matches torn-off labels only', async () => {
	const { isBareFigureLabel } = await import('../../src/reader/spanBlockBuilder');
	assert.equal(isBareFigureLabel('Figure 6:'), true);
	assert.equal(isBareFigureLabel('Fig. 2.'), true);
	assert.equal(isBareFigureLabel('图 3'), true);
	assert.equal(isBareFigureLabel('Figure 6: Photon-counting detector design.'), false);
	assert.equal(isBareFigureLabel('Configure 6:'), false);
});

// ---- 1.2.0: a numeric table is held out of prose grouping and kept per-cell --

test('table rows are NOT welded into a prose wall — labels stay per-row', () => {
	// A compact 6-row table: a prose LABEL column + two far-apart numeric
	// columns. Before 1.2.0, groupIntoParagraphs glued the label column into one
	// multi-row block (the collapse). Now the table lines are held out and each
	// stays its own one-line block for the grid stage.
	const labels = [
		'Death at 90 days',
		'Symptomatic intracranial hemorrhage',
		'Early neurologic deterioration',
		'Parenchymal hematoma type 2',
		'Median infarct volume at 24 hr',
		'Reperfusion at 24 hr'
	];
	const items: SpanItem[] = [];
	let y = 600;
	for (const lab of labels) {
		items.push(span(lab, 48, y, 130, 8));       // label col (x48)
		items.push(span('13 (14)', 250, y, 34, 8));  // col A (x250)
		items.push(span('23 (26)', 330, y, 34, 8));  // col B (x330)
		y -= 14;
	}
	const { blocks } = buildBlocksFromSpans(items, {
		pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 567,
		includeReferences: false, referencesAlreadyStarted: false, imageRectsPdf: []
	});
	// No block may fuse two different row labels together (the collapse signature).
	const collapsed = blocks.find(b =>
		b.sourceText.includes('Death at 90 days') && b.sourceText.includes('Early neurologic'));
	assert.equal(collapsed, undefined, 'row labels must not be welded into one block');
	// Each label survives as its own block.
	for (const lab of labels) {
		assert.ok(blocks.some(b => b.sourceText.trim() === lab), `label kept per-row: "${lab}"`);
	}
	// And the numeric cells survive too (not merged away).
	assert.ok(blocks.filter(b => /^\d+ \(\d+\)$/.test(b.sourceText.trim())).length >= 6,
		'numeric cells preserved as their own blocks');
});

test('a prose-only page is unaffected by the table reorder', () => {
	// Two ordinary wrapped paragraphs, no numeric grid → detection finds nothing,
	// grouping behaves exactly as before (paragraphs merge across their lines).
	const items: SpanItem[] = [];
	const p1 = ['This study evaluated the diagnostic performance of the new',
		'imaging protocol across a heterogeneous cohort of patients with',
		'a range of clinical indications and disease severities overall.'];
	let y = 700;
	for (const line of p1) { items.push(span(line, 60, y, 240, 10)); y -= 12; }
	const { blocks } = buildBlocksFromSpans(items, {
		pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 612,
		includeReferences: false, referencesAlreadyStarted: false, imageRectsPdf: []
	});
	assert.equal(blocks.length, 1, 'the three wrapped lines stay one prose paragraph');
	assert.ok(blocks[0]!.sourceText.includes('This study') && blocks[0]!.sourceText.includes('overall'));
});

test('1.2.2 审核项: 排除参考文献时, 表格行不再绕过参考文献过滤', () => {
	// 与上一测试同样的 6 行网格, 但页面从参考文献区续页开始
	// (referencesAlreadyStarted) 且 includeReferences=false —— 引用年份/编号
	// 不得再以「表格单元格」的身份溜回翻译流。
	const labels = ['Death at 90 days', 'Symptomatic intracranial hemorrhage', 'Early neurologic deterioration',
		'Parenchymal hematoma type 2', 'Median infarct volume at 24 hr', 'Reperfusion at 24 hr'];
	const items: SpanItem[] = [];
	let y = 600;
	for (const lab of labels) {
		items.push(span(lab, 48, y, 130, 8));
		items.push(span('13 (14)', 250, y, 34, 8));
		items.push(span('23 (26)', 330, y, 34, 8));
		y -= 14;
	}
	const excluded = buildBlocksFromSpans(items, {
		pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 567,
		includeReferences: false, referencesAlreadyStarted: true, imageRectsPdf: []
	});
	assert.equal(excluded.blocks.length, 0, '排除参考文献时表格行一并排除');
	const included = buildBlocksFromSpans(items, {
		pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 567,
		includeReferences: true, referencesAlreadyStarted: true, imageRectsPdf: []
	});
	assert.ok(included.blocks.length >= 12, '包含参考文献时表格行照常提取');
});
