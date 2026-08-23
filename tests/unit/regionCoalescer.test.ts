import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMerge, canMergeCaption, coalesceRegions, separatorBetween } from '../../src/reader/regionCoalescer';
import type { SourceBlock } from '../../src/types/models';

/** A body block occupying one or more stacked lines in a column. */
function block(
	id: string,
	text: string,
	options: {
		left?: number;
		width?: number;
		topY?: number;
		lines?: number;
		fontSize?: number;
		type?: SourceBlock['type'];
		isReference?: boolean;
	} = {}
): SourceBlock {
	const left = options.left ?? 54;
	const width = options.width ?? 240;
	const topY = options.topY ?? 700;
	const lines = options.lines ?? 1;
	const size = options.fontSize ?? 10;
	const lineRects: [number, number, number, number][] = [];
	for (let i = 0; i < lines; i++) {
		const y2 = topY - i * (size * 1.3);
		lineRects.push([left, y2 - size, left + width, y2]);
	}
	return {
		id,
		pageIndex: 0,
		order: 0,
		type: options.type ?? 'paragraph',
		sourceText: text,
		lineRectsPdf: lineRects,
		fontSize: size,
		isReference: options.isReference ?? false
	};
}

// ---- the shredded-abstract case ---------------------------------------------

test('one-line fragments of a paragraph coalesce into a single region', () => {
	// The Circ Cardiovasc Imaging abstract came through as one block per line;
	// each line translated in isolation reads as broken clauses.
	const fragments = [
		block('a', 'Background—Computed tomographic coronary angiography is a', { topY: 700 }),
		block('b', 'noninvasive imaging modality that permits identification', { topY: 687 }),
		block('c', 'and characterization of coronary plaques.', { topY: 674 })
	];
	const regions = coalesceRegions(fragments);
	assert.equal(regions.length, 1, 'three line fragments are ONE region');
	assert.equal(
		regions[0]!.sourceText,
		'Background—Computed tomographic coronary angiography is a noninvasive imaging modality that permits identification and characterization of coronary plaques.'
	);
	assert.equal(regions[0]!.lineRectsPdf!.length, 3, 'every source line rect is kept for masking');
	// One continuous paragraph → ONE paragraph group (nothing to split later).
	assert.equal(regions[0]!.regionParagraphs?.length, 1, 'a continuous paragraph is a single group');
});

// ---- regionParagraphs: per-paragraph geometry for split-back placement ------

test('structured region records one paragraph group per \\n\\n break, with its own line rects', () => {
	// Two sentence-final body blocks with a blank line between them = a paragraph
	// boundary (separatorBetween → "\n\n"). They still merge into one region for
	// translation, but each paragraph's geometry is kept so the renderer can
	// place the translated paragraphs back into their OWN boxes.
	const a = block('a', 'First paragraph ends here.', { topY: 700, lines: 2 });
	const b = block('b', 'Second paragraph begins now.', { topY: 671, lines: 2 });
	const regions = coalesceRegions([a, b]);
	assert.equal(regions.length, 1, 'both paragraphs are one region for translation');
	assert.equal(regions[0]!.sourceText, 'First paragraph ends here.\n\nSecond paragraph begins now.');
	const groups = regions[0]!.regionParagraphs;
	assert.equal(groups?.length, 2, 'two paragraph groups');
	assert.equal(groups![0]!.lineRectsPdf.length, 2, 'group 0 keeps paragraph a’s two line rects');
	assert.equal(groups![1]!.lineRectsPdf.length, 2, 'group 1 keeps paragraph b’s two line rects');
	// The groups partition the region’s rects exactly — no rect lost or shared.
	assert.equal(
		groups![0]!.lineRectsPdf.length + groups![1]!.lineRectsPdf.length,
		regions[0]!.lineRectsPdf!.length,
		'groups partition the region’s line rects'
	);
	assert.deepEqual(groups![0]!.lineRectsPdf, a.lineRectsPdf, 'group 0 = paragraph a geometry');
	assert.deepEqual(groups![1]!.lineRectsPdf, b.lineRectsPdf, 'group 1 = paragraph b geometry');
});

test('paragraph roles survive as paragraph breaks', () => {
	// Background ends a sentence; Methods starts a new role with visible
	// spacing → the region keeps "\n\n" between them.
	const a = block('a', 'Background—This is the background sentence.', { topY: 700, lines: 2 });
	const b = block('b', 'Methods and Results—Databases were searched for studies.', { topY: 665 });
	const regions = coalesceRegions([a, b]);
	assert.equal(regions.length, 1);
	assert.ok(
		regions[0]!.sourceText.includes('.\n\nMethods and Results—'),
		`expected a paragraph break before the role, got: ${JSON.stringify(regions[0]!.sourceText)}`
	);
});

test('a hyphenated line break joins without a space', () => {
	const a = block('a', 'identifica-', { topY: 700 });
	const b = block('b', 'tion of plaques.', { topY: 687 });
	const regions = coalesceRegions([a, b]);
	assert.equal(regions[0]!.sourceText, 'identification of plaques.');
});

// ---- boundaries that must NOT merge ----------------------------------------

test('a heading between paragraphs splits the region', () => {
	const blocks = [
		block('a', 'End of the introduction paragraph.', { topY: 700 }),
		block('h', 'Methods', { topY: 685, type: 'heading' }),
		block('b', 'First sentence of the methods.', { topY: 668 })
	];
	const regions = coalesceRegions(blocks);
	assert.equal(regions.length, 3, 'headings never merge into a region');
});

test('different columns never merge', () => {
	const left = block('a', 'Left column text continues here', { left: 54, topY: 700 });
	const right = block('b', 'Right column text continues here', { left: 320, topY: 690 });
	assert.equal(canMerge(left, right), false);
});

test('a large vertical gap is a region boundary', () => {
	const a = block('a', 'A paragraph that ends here.', { topY: 700 });
	const b = block('b', 'Something much further down the page.', { topY: 620 });
	assert.equal(canMerge(a, b), false);
});

test('a type-size jump is a region boundary', () => {
	const body = block('a', 'Body text at ten points continues', { topY: 700, fontSize: 10 });
	const caption = block('b', 'Tiny caption text under a figure', { topY: 687, fontSize: 7.5 });
	assert.equal(canMerge(body, caption), false);
});

test('references never merge', () => {
	const a = block('a', '1. Smith J. Some cited work. 2020.', { topY: 700, isReference: true });
	const b = block('b', '2. Jones K. Другая работа. 2021.', { topY: 687, isReference: true });
	assert.equal(canMerge(a, b), false);
});

test('regions respect the provider character cap', () => {
	const a = block('a', 'x'.repeat(2000), { topY: 700 });
	const b = block('b', 'y'.repeat(1000), { topY: 687 });
	assert.equal(canMerge(a, b), false, 'merging would exceed the request cap');
});

// ---- separators -------------------------------------------------------------

test('mid-sentence fragments join with a space; finished tight lines too', () => {
	const a = block('a', 'this fragment ends mid', { topY: 700 });
	const b = block('b', 'sentence and continues', { topY: 687 });
	assert.equal(separatorBetween(a, b), ' ');
	// Finished sentence but line-spacing only → still the same paragraph.
	const c = block('c', 'A complete sentence.', { topY: 700 });
	const d = block('d', 'The next line, tightly below.', { topY: 688 });
	assert.equal(separatorBetween(c, d), ' ');
});

// ---- shard absorption -------------------------------------------------------

test('a bare citation marker is absorbed into the previous region', () => {
	const a = block('a', 'Coronary inflammation predicts adverse outcomes in this cohort', { topY: 700 });
	const shard = block('b', '(5,6).', { topY: 687, width: 30, fontSize: 7 }); // superscript-ish size
	const regions = coalesceRegions([a, shard]);
	assert.equal(regions.length, 1, 'citation shard merged');
	assert.ok(regions[0]!.sourceText.endsWith('(5,6).'));
});

test('a torn-off lowercase continuation is absorbed despite a font mismatch', () => {
	const a = block('a', 'The attenuation of the polarized beam is measured after the', { topY: 700 });
	const shard = block('b', 'ated light is isolated in the detector.', { topY: 660, fontSize: 8 });
	const regions = coalesceRegions([a, shard]);
	assert.equal(regions.length, 1, 'continuation shard merged into its paragraph');
});

test('a shard with no adjacent body neighbour survives unmerged', () => {
	const h = block('h', 'Methods', { topY: 700, type: 'heading' });
	const shard = block('s', '(12).', { topY: 300, width: 26 });
	const regions = coalesceRegions([h, shard]);
	assert.equal(regions.length, 2, 'nothing eligible to absorb it — kept');
});

// ---- 语义段落组: long continuations, provenance, colon separators ------------

test('a LONG lowercase continuation fragment is absorbed — length is not a rejection criterion', () => {
	// The Radiology page-6 case: "least as robust, if not better, than…" is 70+
	// chars, starts lowercase, and is unmistakably the middle of a sentence.
	// The old ≤60-char cap left it as an independent English block inside a
	// Chinese paragraph.
	const regions = coalesceRegions([
		block('a', 'One should expect that PCCT-based models will be at', { topY: 700, fontSize: 10 }),
		block('b', 'least as robust, if not better, than CT-based algorithms given the many improvements that PCCT has to offer.', { topY: 685, fontSize: 8 })
	]);
	assert.equal(regions.length, 1, 'the long continuation joined its paragraph');
	assert.ok(regions[0]!.sourceText.includes('will be at least as robust'), 'sentence reads whole');
});

test('a merged region keeps memberIds provenance for every absorbed fragment', () => {
	const regions = coalesceRegions([
		block('a', 'Background—Computed tomographic coronary angiography is a', { topY: 700 }),
		block('b', 'noninvasive imaging modality that permits identification', { topY: 687 }),
		block('c', 'and characterization of coronary plaques.', { topY: 674 })
	]);
	assert.equal(regions.length, 1);
	assert.deepEqual(regions[0]!.memberIds, ['a', 'b', 'c'], 'source relationship preserved through the merge');
});

test('a colon at a fragment boundary does not become a paragraph break', () => {
	const a = block('a', 'the modifications include the following:', { topY: 700 });
	const b = block('b', 'sharper kernels and thinner sections.', { topY: 660 });
	assert.equal(separatorBetween(a, b), ' ', 'colon means the clause continues — a space, never \\n\\n');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.1.8 图注行碎片归位 (Horst 2024 第 4/5 页图注压印的真实几何)
// ─────────────────────────────────────────────────────────────────────────────

/** Horst 2024 第 5 页图 6 题注的真实几何: 内缩到 x=162, 8pt, 行距 ~10pt。 */
function captionLine(id: string, text: string, top: number, right = 541, type: SourceBlock['type'] = 'paragraph'): SourceBlock {
	return {
		id, pageIndex: 0, order: 0, type,
		sourceText: text,
		lineRectsPdf: [[161.9, top - 8, right, top]],
		fontSize: 8,
		column: -1,
		isReference: false
	};
}

test('caption 聚合: 被缩进硬断段切开的图注行碎片重新并成一块', () => {
	// 第 5 页图 6 的四块 (125 / 258 / 382 / 126 字符, y 304.9–372.9)。
	const blocks = [
		captionLine('c0', 'Figure 6: Images in a 7-year-old male child (same patient as in Figure 5) with shortness of breath. Noncontrast chest photon-', 372.9, 534, 'caption'),
		captionLine('c1', 'counting detector scans (Flash + ultrahigh resolution, 120 x 0.2, 120 kV; automatic exposure control image quality index [vendor', 362.9),
		captionLine('c2', 'term: Care keV IQ] level 29; pitch, 3.2) with reconstruction performed at 0.2 mm in (A) Bl60 kernel and QIR1, (B) Br60 kernel and', 352.9),
		captionLine('c3', 'CT dose index was 0.59 mGy and effective dose was 0.46 mSv. QIR is quantum iterative reconstruction from Siemens Healthineers.', 342.9)
	];
	const out = coalesceRegions(blocks, []);
	const captions = out.filter(b => b.type === 'caption');
	assert.equal(captions.length, 1, '一条图注必须是一块 —— 这正是压印的来源');
	assert.equal(out.length, 1, '没有碎片被剩下');
	const merged = captions[0]!;
	assert.ok(merged.sourceText.startsWith('Figure 6:'), '首块仍是宿主');
	assert.ok(merged.sourceText.includes('counting detector scans'), '第二行归位');
	assert.ok(merged.sourceText.includes('quantum iterative reconstruction'), '末行归位');
	assert.equal(merged.lineRectsPdf?.length, 4, '四行行盒全部保留 (排版按行盒走)');
	assert.deepEqual(merged.memberIds, ['c0', 'c1', 'c2', 'c3'], '来源可追溯');
});

test('caption 聚合: 碎片在阅读序里不相邻也要归位 (正文块插在中间)', () => {
	// 第 5 页的实况: 左栏正文 block-5 排在图注碎片之间。
	const body: SourceBlock = {
		id: 'body', pageIndex: 0, order: 0, type: 'paragraph',
		sourceText: '70 or 90 kV because the increased contrast of reduced tube potentials is realized with low-energy VMIs.',
		lineRectsPdf: [[48, 194, 288, 324]], fontSize: 10, column: 0, isReference: false
	};
	const out = coalesceRegions([
		captionLine('c0', 'Figure 6: Images in a 7-year-old male child with shortness of breath. Noncontrast chest photon-', 372.9, 534, 'caption'),
		captionLine('c1', 'counting detector scans (Flash + ultrahigh resolution, 120 x 0.2, 120 kV; automatic exposure control index [vendor', 362.9),
		body,
		captionLine('c2', 'term: Care keV IQ] level 29; pitch, 3.2) with reconstruction performed at 0.2 mm in (A) Bl60 kernel and QIR1.', 352.9)
	], []);
	const caption = out.find(b => b.type === 'caption')!;
	assert.ok(caption.sourceText.includes('counting detector scans'));
	assert.ok(caption.sourceText.includes('Care keV IQ'), '隔着正文块的碎片同样归位');
	const bodyOut = out.find(b => b.id.endsWith('region-1') || b.sourceText.startsWith('70 or 90 kV'))!;
	assert.ok(!bodyOut.sourceText.includes('counting detector scans'),
		'正文段落不得再被图注碎片污染 (旧行为: isShard + canAbsorb 把它吞进正文)');
});

test('caption 聚合不吞正文: 字号不同的下方正文段落必须留在外面', () => {
	// 期刊正文 10pt vs 图注 8pt —— 差 20%, 超过 16% 的闸。
	const caption = captionLine('cap', 'Figure 5: Images in a 7-year-old male child with shortness of breath who underwent noncontrast CT.', 187, 546, 'caption');
	const bodyBelow: SourceBlock = {
		id: 'body', pageIndex: 0, order: 0, type: 'paragraph',
		sourceText: 'from free-breathing examinations in young children, equivalent to modern dual-source EID CT examinations.',
		lineRectsPdf: [[161.9, 169, 546, 177]], fontSize: 10, column: -1, isReference: false
	};
	assert.equal(canMergeCaption(caption, bodyBelow), false, '字号跳变 = 版式边界');
	assert.equal(coalesceRegions([caption, bodyBelow], []).length, 2);
});

test('caption 聚合不吞正文: 横向跨出图注范围的块必须留在外面', () => {
	// 图注内缩到 x=162; 正文栏从 x=48 起排, 落在图注跨度之外。
	const caption = captionLine('cap', 'Figure 6: Images in a 7-year-old male child with shortness of breath. Noncontrast chest photon-', 372.9, 534, 'caption');
	const otherColumn: SourceBlock = {
		id: 'other', pageIndex: 0, order: 0, type: 'paragraph',
		sourceText: 'entially use 120 kV over 70 or 90 kV because the increased contrast of reduced tube potentials.',
		lineRectsPdf: [[48, 354.9, 288, 362.9]], fontSize: 8, column: -1, isReference: false
	};
	assert.equal(canMergeCaption(caption, otherColumn), false, '起点在图注左边 → 不是它的续行');
});

test('caption 聚合不跨图: 下一条 "Figure N" 题注不会被上一条吞掉', () => {
	const first = captionLine('c0', 'Figure 6: Images in a 7-year-old male child with shortness of breath. Noncontrast chest photon-', 372.9, 534, 'caption');
	const second = captionLine('c1', 'Figure 7: Coronal reformats in the same patient acquired at 120 kV with the Bl60 kernel.', 362.9);
	assert.equal(canMergeCaption(first, second), false);
	assert.equal(coalesceRegions([first, second], []).length, 2);
});

test('caption 聚合不跨图: 已写完句子的图注只接句中开头的续行', () => {
	const done = captionLine('c0', 'Figure 3: Axial chest CT in a 3-year-old child with cystic fibrosis.', 372.9, 534, 'caption');
	const newSentence = captionLine('c1', 'Some studies have highlighted improved spectral separation of multienergy imaging at 140 kV.', 362.9);
	const continuation = captionLine('c2', 'reconstructed with the Br44 kernel at a section thickness of 3 mm and QIR level 2.', 362.9);
	assert.equal(canMergeCaption(done, newSentence), false, '大写开头 = 图下方另起的正文');
	assert.equal(canMergeCaption(done, continuation), true, '小写开头 = 这条图注自己的续行');
});

test('caption 聚合有边界: 行距超过一行的量级就不是续行', () => {
	const caption = captionLine('c0', 'Figure 4: Free-breathing photon-counting detector CT scans without and with high-pitch mode', 573, 513, 'caption');
	const farBelow = captionLine('c1', 'mode in two children, each aged 3 years, with cystic fibrosis. The diaphragms are crisper.', 520);
	assert.equal(canMergeCaption(caption, farBelow), false, '53pt 的落差是段间距, 不是行距');
});
