import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildBlocksFromSpans,
	groupIntoLines,
	groupIntoParagraphs,
	groupIntoRows,
	lineText,
	pageBodySize,
	type SpanItem
} from '../../src/reader/spanBlockBuilder';
import { detectColumns } from '../../src/reader/paragraphHeuristics';

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

test('front-matter-heavy cover page: 10pt body lines are NOT headings (Chen 2023)', () => {
	// bodySize is the MODE of line sizes, not the median. On a cover page the
	// 7pt affiliations + 8.5pt abstract outnumber the 10pt body lines, so the
	// median landed on 8.5 and every 10pt body line got ratio 1.176 ≥ 1.1 →
	// 'heading'. Per-line heading translation then failed en masse and the
	// translated page kept whole columns in English.
	const affil = lines(Array.from({ length: 9 }, (_, i) =>
		`Department of Radiology (Q.C., H.X.) and Cardiology, Hospital ${i}, City, Country;`
	), 50, 740, 7, 8.5, 460);
	const abstract = lines(Array.from({ length: 9 }, (_, i) =>
		`abstract line ${i} with a good number of words to look like the real block here`
	), 50, 640, 8.5, 10, 460);
	const body = lines(Array.from({ length: 10 }, (_, i) =>
		`Coronary CT angiography is now a first-line modality, body line ${i} here.`
	), 50, 500, 10, 12, 220);
	const { blocks } = buildBlocksFromSpans([...affil, ...abstract, ...body], {
		pageIndex: 0,
		pageHeight: PAGE_HEIGHT
	});
	for (const b of blocks) {
		assert.notEqual(b.type, 'heading', `body-size lines must not be headings: ${b.sourceText.slice(0, 40)}`);
	}
});

test('a drop cap does not crown its line: char-weighted size, no fake mid-column title', () => {
	// The welded drop-cap line has exactly TWO spans — "A" (25pt) + the body
	// text (10pt) — and a span-count vote ties, where ties-go-larger crowned
	// the drop cap: the line became a fake 25pt 'title' mid-column. One char
	// of 25pt vs fifty chars of 10pt is not a tie.
	const dropCap = span('A', 50, 476, 15, 25);
	const bodyTexts = Array.from({ length: 8 }, (_, i) => `cute coronary syndrome remains one of the leading, line ${i}`);
	const body = lines(bodyTexts, 65, 500, 10, 12, 220);
	const { blocks } = buildBlocksFromSpans([dropCap, ...body], {
		pageIndex: 0,
		pageHeight: PAGE_HEIGHT
	});
	for (const b of blocks) {
		assert.notEqual(b.type, 'title', `drop-cap weld must not be a title: ${b.sourceText.slice(0, 40)}`);
		assert.notEqual(b.type, 'heading', `drop-cap weld must not be a heading: ${b.sourceText.slice(0, 40)}`);
	}
});

test('figure and table captions are classified, not treated as body text', () => {
	const fig = lines(['Figure 2: overall architecture.'], 50, 700, 9);
	const tab = lines(['Table 1: results on WMT14.'], 50, 660, 9);
	const { blocks } = buildBlocksFromSpans([...fig, ...tab], { pageIndex: 0, pageHeight: PAGE_HEIGHT });
	assert.equal(blocks[0]!.type, 'caption');
	assert.equal(blocks[1]!.type, 'table');
});

test('references 默认保留为 preserve 块(纯几何,不译),打开开关则可译 (P2-5, 2.0.8)', () => {
	const heading = lines(['References'], 50, 700, 11);
	const entry = lines(['[1] Vaswani et al. Attention is all you need. 2017.'], 50, 676, 9);
	const items = [...heading, ...entry];

	const preserved = buildBlocksFromSpans(items, { pageIndex: 0, pageHeight: PAGE_HEIGHT });
	assert.equal(preserved.referencesStarted, true);
	// 旧行为是整块丢弃 —— inkObstacles 在默认配置下失明 (P2-5)。
	const ref = preserved.blocks.find(b => b.sourceText.includes('Vaswani'));
	assert.ok(ref, '条目保留为几何块');
	assert.equal(ref!.translationMode, 'preserve');
	assert.equal(ref!.isReference, true);
	assert.ok(ref!.lineRectsPdf?.length);

	const kept = buildBlocksFromSpans(items, {
		pageIndex: 0,
		pageHeight: PAGE_HEIGHT,
		includeReferences: true
	});
	const keptRef = kept.blocks.find(b => b.sourceText.includes('Vaswani'));
	assert.ok(keptRef && keptRef.translationMode === undefined, '打开开关时照常可译');
	assert.ok(kept.blocks.every(b => b.isReference));
});

test('referencesAlreadyStarted carries across pages', () => {
	const entry = lines(['[7] Some trailing reference entry.'], 50, 700, 9);
	const result = buildBlocksFromSpans(entry, {
		pageIndex: 9,
		pageHeight: PAGE_HEIGHT,
		referencesAlreadyStarted: true
	});
	// P2-5 (2.0.8): 后续页的条目同样保留为 preserve 几何块,不再是空数组。
	assert.equal(result.blocks.length, 1);
	assert.equal(result.blocks[0]!.translationMode, 'preserve');
	assert.equal(result.blocks[0]!.isReference, true);
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

// ---- 栏归属的已知缺陷 (2.4.9, 由 radiology-radiomics2023-p1 语料定位) --------
// 现状固化为测试:满幅前言压倒双栏正文时,detectColumns 只报 1 栏。
// 这一条**断言的是缺陷本身**,修好之后它会失败 —— 那正是提示去更新它。

test('满幅前言占多数时仍能分出双栏 (2.5.0 左缘聚类兜底; RSNA 封面页形态)', () => {
	// 40 行满幅前言(标题/作者/单位/摘要)+ 12 行双栏正文。真白槽在 x≈292–308。
	const items: SpanItem[] = [];
	for (let i = 0; i < 40; i++) {
		// 满幅行:宽度参差(段末行天然短),部分落在 0.62 全幅阈值之下 →
		// 混进投影,横跨白槽把两栏焊在一起。
		const right = i % 3 === 0 ? 341 : i % 3 === 1 ? 526 : 444;
		items.push(span(`front matter line ${i} spanning the full text block`, 72, 740 - i * 9, right - 72, 7));
	}
	for (let i = 0; i < 12; i++) {
		items.push(span(`left column body line ${i}`, 72, 300 - i * 12, 219));
		items.push(span(`right column body line ${i}`, 309, 300 - i * 12, 219));
	}
	const lines = groupIntoLines(items, 594, 783);
	const bands = detectColumns(lines.map(l => l.rect), 594, 783);
	// 2.5.0 之前这里只报 1 栏(贪心链条被前言的段末短行焊住);左缘聚类兜底修好了它。
	assert.equal(bands.length, 2, '40 行满幅前言压不倒 12 行双栏正文');
	assert.ok(bands[0]!.right < 300 && bands[1]!.left > 300, '白槽落在 291–309 之间');

	// 对照组 —— 这一条保证上面测的是**前言压倒**,而不是夹具本身就认不出栏:
	// 同样的 12 行双栏正文,去掉前言,栏归属完全正常。
	const bodyOnly = items.slice(40);
	const clean = detectColumns(groupIntoLines(bodyOnly, 594, 783).map(l => l.rect), 594, 783);
	assert.equal(clean.length, 2, '对照: 只有正文时正常识别出 2 栏');
	assert.ok(clean[0]!.right < 300 && clean[1]!.left > 300, '对照: 白槽落在 291–309');
});

// ---- 首字下沉 (2.5.1) -------------------------------------------------------

test('下沉首字并入第一行,而不是焊到第二行', () => {
	// Chen 2023 第 1 页真实坐标:大写 A 高 25.19pt,盒心 155.30 正好落在第二行
	// (顶 155.34) 的基线带里 —— 按中心配对就会产出「Acauses of morbidity…」。
	const cap: SpanItem = { text: 'A', rect: [71.96, 142.70, 87.14, 167.90], fontSize: 25 };
	const line1: SpanItem = { text: 'cute coronary syndrome remains one of the leading', rect: [89, 157.4, 290, 167.4], fontSize: 10 };
	const line2: SpanItem = { text: 'causes of morbidity and mortality globally', rect: [71.96, 145.3, 290, 155.3], fontSize: 10 };
	const rows = groupIntoRows([line2, cap, line1]);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0]!.map(i => i.text), ['A', 'cute coronary syndrome remains one of the leading']);
	assert.deepEqual(rows[1]!.map(i => i.text), ['causes of morbidity and mortality globally']);
});

test('下沉首字规则不影响上标与普通行', () => {
	// 上标标注比正文矮但不满足「≥18pt 的 1–2 字符大字母」判据,仍按中心配对并入本行。
	const body: SpanItem = { text: 'myocardial infarction', rect: [72, 600, 200, 610], fontSize: 10 };
	const sup: SpanItem = { text: '12', rect: [200, 605, 206, 610], fontSize: 5 };
	const rows = groupIntoRows([body, sup]);
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0]!.map(i => i.text), ['myocardial infarction', '12']);
});

// ---- 图表说明豁免元数据过滤 (2.5.4) ----------------------------------------

test('说明文字里出现医院/大学名,不得被当作者单位丢掉', () => {
	// chen2023-p3 实证: 这篇的队列名就是医院名,于是整段图注(连同全部缩写
	// 定义)被 looksLikeAffiliation 判成作者单位丢弃。caption 只由「Figure N」
	// 开头产生 —— 那是内容的自证。
	const caption = lines([
		'Figure 1: Study flowchart. Huaian set = Affiliated Huaian No. 1 People’s Hospital of',
		'Nanjing Medical University set; PUMCH set = Peking Union Medical College Hospital set.',
		'CCTA = coronary CT angiography, MACE = major adverse cardiac events, PCI = percutaneous.'
	], 48, 400, 8, 10, 490);
	// 正文若干行,让 bodySize 判成 10
	const body = lines([
		'In study 1, the area under the curve, accuracy, sensitivity, and specificity of the',
		'radiomic signature and anatomic plaque parameters were calculated for identifying',
		'vulnerable plaques, with intravascular US as the reference standard. The incremental',
		'value of the signature for vulnerable plaque discrimination beyond high-risk plaque',
		'and quantitative plaque parameters was assessed by comparing the characteristic curve.'
	], 48, 340, 10, 12, 490);
	const { blocks } = buildBlocksFromSpans([...caption, ...body], {
		pageIndex: 2, pageHeight: PAGE_HEIGHT, pageWidth: 594
	});
	const captionBlock = blocks.find(b => b.sourceText.startsWith('Figure 1:'));
	assert.ok(captionBlock, '图注必须留下来 —— 这是真·内容丢失,不是噪声过滤');
	assert.equal(captionBlock!.type, 'caption');
	assert.match(captionBlock!.sourceText, /PCI = percutaneous/, '整段都要在,不能只留头一行');
});

test('真正的作者单位块照旧丢弃', () => {
	// 对照组: 同样密集的机构名 + 逗号,但不以「Figure N」起头。
	const affiliation = lines([
		'From the Departments of Radiology (Q.C., H.X., G.X., X.Y.) and Cardiology (T.P., X.G.),',
		'Nanjing First Hospital, Nanjing Medical University, Nanjing, China; Department of',
		'Radiology, Peking Union Medical College Hospital, Chinese Academy of Medical Sciences.'
	], 48, 400, 8, 10, 490);
	const body = lines([
		'In study 1, the area under the curve, accuracy, sensitivity, and specificity of the',
		'radiomic signature and anatomic plaque parameters were calculated for identifying',
		'vulnerable plaques, with intravascular US as the reference standard. The incremental',
		'value of the signature for vulnerable plaque discrimination beyond high-risk plaque',
		'and quantitative plaque parameters was assessed by comparing the characteristic curve.'
	], 48, 340, 10, 12, 490);
	const { blocks } = buildBlocksFromSpans([...affiliation, ...body], {
		pageIndex: 2, pageHeight: PAGE_HEIGHT, pageWidth: 594
	});
	assert.equal(
		blocks.some(b => b.sourceText.includes('Departments of Radiology')),
		false,
		'豁免只给 caption/table,不能顺手把作者单位也放进来'
	);
});

// ---- 字号跳变的边界 (2.5.4) -------------------------------------------------

test('10pt 正文接 12pt 小节标题必须断段 —— 判据的边界正好卡在这一档', () => {
	// 原判据是 `> 0.2`,而 sizeOf 把字号按半点分桶,10→12 算出来恰好 0.2、
	// 不大于,于是期刊最常见的一档标题级差从来断不开段:chen2023-p3 的
	// "Results" 被焊在「…(version 4.1.1;www.R-project.org).」尾巴上。
	const body = lines([
		'performed using R software (version 4.1.1; www.R-project.org).'
	], 306, 144, 10, 12, 240);
	const heading = lines(['Results'], 306, 124, 12, 12, 32);
	const after = lines([
		'Details of the patient selection procedure are available in Appendix S6.',
		'Tables 1 and 2 summarize the patient demographic characteristics in the'
	], 306, 96, 10, 12, 240);
	const { blocks } = buildBlocksFromSpans([...body, ...heading, ...after], {
		pageIndex: 2, pageHeight: PAGE_HEIGHT, pageWidth: 594
	});
	const own = blocks.find(b => b.sourceText.trim() === 'Results');
	assert.ok(own, '"Results" 必须自成一块,而不是黏在上一段末尾');
	assert.equal(
		blocks.some(b => /www\.R-project\.org\)\.\s*Results/.test(b.sourceText)),
		false,
		'上一段不得把标题吞进去'
	);
});

// ---- 上下标归行 (2.5.4) -----------------------------------------------------

test('下标并入它所属的那一行,不再自成一行劈开段落', () => {
	// chen2023-p2 真实坐标: FFR 的下标 CT 高 4.9pt、字号 5,盒心离本行中心
	// 3.7、离下一行中心 5.8 —— 按自身高度 ±2.9 两边都够不着,于是自成一行,
	// 输出成了「MACE = major adverseCT cardiac events」。
	const lineA: SpanItem = { text: 'coronary CT angiography, FFR', rect: [53.9, 692.7, 155.4, 701.2], fontSize: 8.5 };
	const sub: SpanItem = { text: 'CT ', rect: [155.4, 690.8, 164.3, 695.7], fontSize: 5 };
	const tail: SpanItem = { text: '= CT-derived fractional flow reserve,', rect: [164.3, 692.7, 281.9, 701.2], fontSize: 8.5 };
	const lineB: SpanItem = { text: 'HR = hazard ratio, MACE = major adverse', rect: [53.9, 683.2, 281.9, 691.7], fontSize: 8.5 };
	const rows = groupIntoRows([lineA, sub, tail, lineB]);
	assert.equal(rows.length, 2, '下标不得自成一行');
	assert.deepEqual(
		rows[0]!.map(i => i.text),
		['coronary CT angiography, FFR', 'CT ', '= CT-derived fractional flow reserve,'],
		'下标属于它上面那一行,且位置在 FFR 之后'
	);
	assert.deepEqual(rows[1]!.map(i => i.text), ['HR = hazard ratio, MACE = major adverse']);
});

test('同字号的行内碎片仍按盒心配对 —— 不受上下标规则影响', () => {
	// aquino2023-p2 实证的反例: 「Exclusion criteria were (a) refusal to consent,
	// (b)」全是 10pt 同基线的碎片。若判据取「比行盒矮」,行盒一旦被高 glyph
	// 撑大,这些正常碎片就会走上宽松的重叠匹配,被下一行的文字污染。
	const a: SpanItem = { text: 'Exclusion criteria were', rect: [306, 724.73, 392.37, 734.73], fontSize: 10 };
	const b: SpanItem = { text: '(a)', rect: [395.45, 724.73, 406.09, 734.73], fontSize: 10 };
	const c: SpanItem = { text: 'refusal to consent,', rect: [409.17, 724.73, 478.92, 734.73], fontSize: 10 };
	const next: SpanItem = { text: 'tion to iodine-based contrast media, and', rect: [306, 712.73, 462.29, 722.73], fontSize: 10 };
	const rows = groupIntoRows([a, b, c, next]);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0]!.map(i => i.text), ['Exclusion criteria were', '(a)', 'refusal to consent,']);
	assert.deepEqual(rows[1]!.map(i => i.text), ['tion to iodine-based contrast media, and']);
});

// ---- 与正文同号的加粗小节标题 (2.5.5) --------------------------------------

test('同字号的小节标题被认出来 —— 文本层看不见 bold,只能靠排印形态', () => {
	// chen2023-p6 实证: 「Model Prognosis Assessment (Study 2)」是 10pt 加粗,
	// 与正文同号,classify 只看字号比就把它判成 paragraph,随后被区域合并吞进
	// 邻段,整节结构在译文页上消失(该页最终只剩 3 块)。
	// 段末那行本来就短(真实页面里是「result (Fig 4B).」),否则连断段都轮不到
	// 标题判据出场。
	const before = [
		...lines([
			'quantitative plaque parameters (AUC, 0.81; 95% CI: 0.75, 0.87; P < .001).',
			'The precision-recall curve showed a similar'
		], 48, 350, 10, 12, 240),
		span('result (Fig 4B).', 48, 326, 60, 10)
	];
	const heading = lines(['Model Prognosis Assessment (Study 2)'], 48, 302, 10, 12, 154);
	const after = lines([
		'Lesion characteristics.—Of the 1020 lesions in 708 patients, 438 were',
		'classified as RS positive and 582 as RS negative using the optimal value.'
	], 48, 280, 10, 12, 240);
	const { blocks } = buildBlocksFromSpans([...before, ...heading, ...after], {
		pageIndex: 5, pageHeight: PAGE_HEIGHT, pageWidth: 594
	});
	const h = blocks.find(b => b.sourceText.trim() === 'Model Prognosis Assessment (Study 2)');
	assert.ok(h, '标题必须自成一块');
	assert.equal(h!.type, 'heading', '判成 paragraph 就会被区域合并吞掉');
});

test('标题式判据不误伤作者行、表格行标签与被截断的碎片', () => {
	const { blocks } = buildBlocksFromSpans([
		// 作者行: 实词确实全大写,但带逗号 —— heading 是元数据过滤的豁免类型,
		// 误判会把作者名单放回正文。
		...lines(['Yi Ning Wang, MD, PhD'], 48, 700, 10, 12, 96),
		// 表格行标签: 实词没有全大写。
		...lines(['Clinical presentation'], 48, 660, 10, 12, 80),
		// 被版面截断的碎片: 停在虚词上,不是标题。
		...lines(['Dr. Valentin Fuster on'], 48, 620, 10, 12, 90),
		...lines([
			'All patients underwent thin-section CT with a standard protocol and the',
			'images were reconstructed at 0.6 mm section thickness for every case.'
		], 48, 580, 10, 12, 240)
	], { pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 594 });
	const typeOf = (needle: string): string | undefined =>
		blocks.find(b => b.sourceText.includes(needle))?.type;
	assert.notEqual(typeOf('Yi Ning Wang'), 'heading', '带逗号的作者行不是标题');
	assert.notEqual(typeOf('Clinical presentation'), 'heading', '实词没全大写,不是标题');
	assert.notEqual(typeOf('Valentin Fuster'), 'heading', '停在虚词上的碎片不是标题');
});

// ---- 小字号页面的分栏间距 (2.5.6) ------------------------------------------

test('6pt 脚注里 11pt 的间距要切开两栏 —— 下限 12 曾把它抬过头', () => {
	// jacc-ccta2020-p1 实证: 页边那条音频摘要小栏(x 24–99)与正文脚注
	// (x 110–)之间只有 11pt。1.6em 对 6pt 字是 9.6pt、足以切开,却被
	// `Math.max(fontSize * 1.6, 12)` 的下限抬到 12,于是那一行焊成一句:
	// 「Listen to this manuscript's Michael A. Wiener Cardiovascular Institute…」。
	const sidebar: SpanItem = { text: 'Listen to this manuscript’s', rect: [24, 133, 99, 139], fontSize: 6 };
	const body: SpanItem = { text: 'Michael A. Wiener Cardiovascular Institute, Marie-Josée and Henry R. Kravis Center', rect: [110, 133, 474, 139], fontSize: 6 };
	const lines = groupIntoLines([sidebar, body], 576);
	assert.equal(lines.length, 2, '两栏必须切开');
	assert.equal(lineText(lines[0]!).trim(), 'Listen to this manuscript’s');
});

test('两端对齐拉出的词距仍然不会被误切', () => {
	// 1.6em 对 6pt 字是 9.6pt,而两端对齐能拉出的词距约 0.6em(3.6pt)。
	const a: SpanItem = { text: 'and has been a consultant to Abbott Vascular,', rect: [110, 133, 300, 139], fontSize: 6 };
	const b: SpanItem = { text: 'Boston Scientific, CeloNova, Cook Medical', rect: [304, 133, 474, 139], fontSize: 6 };
	const lines = groupIntoLines([a, b], 576);
	assert.equal(lines.length, 1, '4pt 的词距不是栏边界');
});

// ---- 全页正文字号 (2.5.7) ---------------------------------------------------

test('前置信息字符数压过摘要时,正文字号取那档份量可观的更大字号', () => {
	// jacc-ccta2020-p1 实证: 6pt 的单位/利益声明占 57.8% 字符、27 行,7.5pt 的
	// 摘要只有 33.1% / 17 行 —— 按众数正文就是 6pt,于是页面上任何比 6pt 大的
	// 东西 ratio 都 ≥ 1.1: 摘要末行被撕下来当标题,摘要因此断在「on behalf of
	// the」,栏目条与副题也够上了 title 门槛。
	const frontMatter = lines(
		Array.from({ length: 27 }, (_, i) => `Department of Radiology, Institution ${i}, City, Country; and more disclosure text here`),
		48, 300, 6, 8, 400
	);
	const abstract = lines(
		Array.from({ length: 17 }, () => 'Evaluation of coronary artery disease using computed tomography has seen a shift'),
		48, 600, 7.5, 10, 400
	);
	const all = groupIntoLines([...frontMatter, ...abstract], 594);
	assert.equal(pageBodySize(all), 7.5, '小字是脚注,正文不会比脚注还小');
});

test('只有一行的字号档当不了正文 —— 否则标题会顶替正文', () => {
	// 反例的形状来自既有单测「a large short line is classified as a title」:
	// 25 字的 20pt 标题按字符数能压过三行 7 字的 10pt 正文。
	const title = lines(['Attention Is All You Need'], 50, 740, 20);
	const body = lines(['x x x x', 'y y y y', 'z z z z'], 50, 660, 10);
	const all = groupIntoLines([...title, ...body], 612);
	assert.equal(pageBodySize(all), 10);
});

test('普通版面不受影响: 正文既是众数又没有更大的成片字号', () => {
	const body = lines(
		Array.from({ length: 20 }, () => 'Coronary CT angiography is now a first-line noninvasive imaging modality'),
		48, 600, 10, 12, 400
	);
	const heading = lines(['Materials and Methods'], 48, 340, 12, 12, 120);
	const all = groupIntoLines([...body, ...heading], 594);
	assert.equal(pageBodySize(all), 10, '12pt 标题只占几个百分点,够不上 25%');
});

test('正文字号真的接到了 classify 上 —— 栏目条不再冒充标题', () => {
	// 端到端锁住接线: pageBodySize 若被换回按行数取众数,bodySize 掉回 6pt,
	// 9pt 的栏目条 ratio 变成 1.5、越过 title 的 1.35 门槛,一页于是冒出三个
	// title。正文取 7.5pt 时它是 1.2,老老实实落在 heading。
	const frontMatter = lines(
		Array.from({ length: 27 }, (_, i) => `Department of Radiology, Institution ${i}, City, Country; and further disclosure text`),
		48, 300, 6, 8, 400
	);
	const abstract = lines(
		Array.from({ length: 17 }, () => 'Evaluation of coronary artery disease using computed tomography has seen a shift'),
		48, 600, 7.5, 10, 400
	);
	const banner = lines(['THE PRESENT AND FUTURE'], 48, 700, 9, 12, 140);
	const { blocks } = buildBlocksFromSpans([...banner, ...abstract, ...frontMatter], {
		pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 576
	});
	const b = blocks.find(x => x.sourceText.trim() === 'THE PRESENT AND FUTURE');
	assert.ok(b, '栏目条必须还在');
	assert.equal(b!.type, 'heading', 'bodySize 判成 6pt 时它会变成 title');
});

test('标题折行按几何链合并成一个 title 块 (2.6.0, radiology2023/booz2019 实证)', () => {
	// 20pt 大标题两行: 第一行较窄 (columnOf 会判进第 0 栏),第二行全宽 (-1)
	// —— 阅读序把它们隔开,数组邻接靠不住,必须按几何链。
	const title = [
		span('Clinical Applications of Photon-counting CT:', 72, 739, 340, 20),
		span('A Review of Pioneer Studies and a Glimpse into the Future', 72, 716, 418, 20)
	];
	const body = lines(
		Array.from({ length: 12 }, () => 'CT systems equipped with photon-counting detectors have shown promise'),
		72, 600, 10, 12, 420
	);
	const { blocks } = buildBlocksFromSpans([...title, ...body], {
		pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 576
	});
	const titles = blocks.filter(b => b.type === 'title');
	assert.equal(titles.length, 1, `two title lines must merge into one block, got: ${titles.map(t => t.sourceText).join(' | ')}`);
	assert.ok(/^Clinical Applications of Photon-counting CT: A Review of Pioneer Studies/.test(titles[0]!.sourceText),
		`merged in visual order: ${titles[0]!.sourceText}`);
});

test('字号不同或相距过远的 title 块不合并 (期刊刊头 vs 文章标题)', () => {
	const masthead = [span('RADIOLOGY JOURNAL', 72, 770, 200, 14)];
	const title = [span('Clinical Applications of Photon-counting CT in Practice', 72, 700, 400, 20)];
	const body = lines(
		Array.from({ length: 12 }, () => 'CT systems equipped with photon-counting detectors have shown promise'),
		72, 600, 10, 12, 420
	);
	const { blocks } = buildBlocksFromSpans([...masthead, ...title, ...body], {
		pageIndex: 0, pageHeight: PAGE_HEIGHT, pageWidth: 576
	});
	const titleBlocks = blocks.filter(b => b.type === 'title');
	// 刊头可能被过滤或另判类型 —— 只要求文章标题没有把别的东西吞进来。
	const main = titleBlocks.find(b => b.sourceText.includes('Clinical Applications'));
	assert.ok(main);
	assert.ok(!main!.sourceText.includes('RADIOLOGY JOURNAL'), '不同字号/远距的块绝不合并');
});
