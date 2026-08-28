import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	columnOf,
	detectColumns,
	detectGutters,
	detectGuttersBanded,
	bandedColumnStamp,
	dominantFontSize,
	endsSentence,
	joinFragments,
	looksLikeListStart,
	looksLikeListBlock,
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

// ---- 分带栏检测: 2-col body over 3-col references (2.5.10) -------------------

/** A page whose top half is a 2-column body (gutter ~306) and whose bottom
 *  half is a 3-column reference list (gutters ~211, ~412). The reference
 *  middle column sits on top of the body gutter, so a single page-wide vote
 *  cannot see the body gutter. y is PDF bottom-origin (larger = higher). */
function bodyOverRefsRows(): Rect[][] {
	const rows: Rect[][] = [];
	// 2-col body: y 760 → 420 (top half).
	for (let y = 760; y >= 420; y -= 12) {
		rows.push([[54, y - 10, 292, y], [320, y - 10, 558, y]]);
	}
	// 3-col references: y 380 → 40 (bottom half).
	for (let y = 380; y >= 40; y -= 10) {
		rows.push([[54, y - 8, 200, y], [220, y - 8, 398, y], [418, y - 8, 558, y]]);
	}
	return rows;
}

test('detectGuttersBanded finds body and reference gutters over their own y-spans', () => {
	const gutters = detectGuttersBanded(bodyOverRefsRows(), PAGE_W);
	const body = gutters.find(g => g.x > 292 && g.x < 320);
	const refLeft = gutters.find(g => g.x > 200 && g.x < 220);
	const refRight = gutters.find(g => g.x > 398 && g.x < 418);
	assert.ok(body, 'the 2-column body gutter is found');
	assert.ok(refLeft && refRight, 'both 3-column reference gutters are found');
	// The body gutter holds only over the top (body) band, not the references.
	assert.ok(body!.bottom > 380, `body gutter must not reach into the references: ${JSON.stringify(body)}`);
	// The reference gutters hold only over the bottom band.
	assert.ok(refLeft!.top < 420, 'reference gutter must not reach into the body');
});

test('bandedColumnStamp orders body columns before reference columns', () => {
	const stamp = bandedColumnStamp(bodyOverRefsRows(), PAGE_W, 792);
	assert.ok(stamp, 'a 2-col-over-3-col page activates the banded stamp');
	// Body left/right → 0/1; reference columns → a higher band (100+).
	assert.equal(stamp!([54, 600, 292, 610]), 0, 'body left column');
	assert.equal(stamp!([320, 600, 558, 610]), 1, 'body right column');
	assert.ok(stamp!([54, 200, 200, 208]) >= 100, 'reference column 1 sorts after the body');
	assert.ok(stamp!([220, 200, 398, 208]) > stamp!([54, 200, 200, 208]), 'reference columns keep left-to-right order');
	assert.ok(stamp!([418, 200, 558, 208]) > stamp!([220, 200, 398, 208]), 'reference column 3 last');
});

test('bandedColumnStamp stays null for a uniform two-column page', () => {
	const rows: Rect[][] = [];
	for (let y = 760; y >= 40; y -= 12) {
		rows.push([[54, y - 10, 292, y], [320, y - 10, 558, y]]);
	}
	assert.equal(bandedColumnStamp(rows, PAGE_W, 792), null);
});

test('bandedColumnStamp ignores a data table over a body (≥4 columns is not a prose regime)', () => {
	const rows: Rect[][] = [];
	// A 5-column table in the top band.
	for (let y = 760; y >= 440; y -= 12) {
		rows.push([
			[54, y - 10, 140, y], [160, y - 10, 250, y], [270, y - 10, 360, y],
			[380, y - 10, 470, y], [490, y - 10, 558, y]
		]);
	}
	// A 2-column body below.
	for (let y = 400; y >= 40; y -= 12) {
		rows.push([[54, y - 10, 292, y], [320, y - 10, 558, y]]);
	}
	assert.equal(bandedColumnStamp(rows, PAGE_W, 792), null);
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

// ---- 块级列表/目录判定 (2.4.4, MinerU __is_list_or_index_block) -------------

test('列表块 (a): 多个条目标记被黏成一块 → list,不再被并进正文段', () => {
	// groupIntoParagraphs 把整段参考文献黏成一个块时,只有第一行带 [1] ——
	// 逐行的 looksLikeListStart 看不见后面的条目,块级判据能。
	assert.equal(looksLikeListBlock([
		'[1] Smith J, Doe A. Photon-counting CT of the lumbar spine. Radiology. 2023;18:e1307.',
		'[2] Wang L, Chen H. Dual-energy imaging in oncology. Eur Radiol. 2022;32:441-450.',
		'[3] Horst M. Spectral reconstruction methods. J Med Phys. 2024;51:88-97.'
	]), true);
	// 项目符号列表同理。
	assert.equal(looksLikeListBlock([
		'• 首次采集使用标准剂量协议',
		'• 第二次采集降低至 50% 剂量',
		'• 两次采集间隔不超过 30 天'
	]), true);
});

test('列表块 (b): 目录引导点行 → list', () => {
	assert.equal(looksLikeListBlock([
		'1. Introduction ................................ 5',
		'2. Materials and Methods ................. 12',
		'3. Results ......................................... 24'
	]), true);
});

test('列表块 (c): ≥3 行各自以句末标点收尾 → list (MinerU 主判据)', () => {
	assert.equal(looksLikeListBlock([
		'All participants provided written informed consent.',
		'The study was approved by the institutional review board.',
		'No adverse events were recorded during follow-up.'
	]), true);
	// 分号收尾同样算条目。
	assert.equal(looksLikeListBlock([
		'纳入标准为年龄大于 18 岁;',
		'排除标准为既往接受过介入治疗;',
		'所有影像由两名放射科医师独立评估。'
	]), true);
});

test('列表块: 折行的散文段不误判 —— 除末行外都停在句子中间', () => {
	assert.equal(looksLikeListBlock([
		'Photon-counting detector CT enables spectral separation without the',
		'dose penalty of dual-source acquisition, which has limited the routine',
		'use of virtual noncalcium reconstructions in the lumbar spine.'
	]), false);
	assert.equal(looksLikeListBlock([
		'光子计数探测器 CT 能够在不增加辐射剂量的前提下完成能谱分离,这一点',
		'正是既往双源方案难以在腰椎常规检查中推广的原因所在,因而本研究',
		'重点评估其在椎间盘突出检出中的表现。'
	]), false);
});

test('列表块: ≥3 行的保守边界 —— 两行都以句号结尾在散文里很常见,不算', () => {
	// "…et al." / "…2019." 这类巧合在真散文里并不罕见,两行不足以定性。
	assert.equal(looksLikeListBlock([
		'The method was first described by Smith et al.',
		'A refined variant was published in 2019.'
	]), false);
	// 单行块没有「行分布」可言,交给逐行判据。
	assert.equal(looksLikeListBlock(['[1] Smith J. A single reference entry. Radiology. 2023.']), false);
	assert.equal(looksLikeListBlock([]), false);
});

test('planMerges 不把页面上方的块当作"下一段" —— 负间距也要拦 (2.5.5)', () => {
	// chen2023-p4/p10 实证: 阅读序把满幅块排在分栏块**之前**,于是「下一段」
	// 常常在页面上方几百点处。表 1 底下那条以逗号收尾的 Note 后面跟着页顶的
	// 页眉,gapAfter = −349 —— 原判据只拦「离得太远」,`-349 <= 10.8` 照样成立,
	// 两者被焊成一个纵跨整页的块:页眉混进正文,表格区域被撑到页顶,整张表
	// 塌成一块。
	assert.deepEqual(planMerges([
		{ text: 'Note.—Unless otherwise specified, data are numbers of patients, BMI = body mass index,', column: -1, type: 'paragraph', gapAfter: -349, fontSize: 9 },
		{ text: 'Radiomics Model to Identify Vulnerable Plaque and Predict Cardiovascular Events', column: 0, type: 'paragraph' }
	]), [[0], [1]], '往回跳的"下一段"从来不是被拆开的同一段');
});

test('planMerges 仍容忍上下标造成的轻微重叠 (2.5.5)', () => {
	// 负间距不是一律拒绝: 段落 rect 含上标时,下一段的顶边可能略高于本段底边。
	assert.deepEqual(planMerges([
		{ text: 'the interaction between FFR and CCTA was explored and', column: 0, type: 'paragraph', gapAfter: -2, fontSize: 10 },
		{ text: 'noncardiac deaths were treated as a competing event.', column: 0, type: 'paragraph' }
	]), [[0, 1]]);
});

test('版心左侧的页边内容自成一栏,右侧的不动 (2.5.6)', () => {
	// jacc-ccta2020-p1: 版心 110–452,页边音频摘要小栏在 x 24–99。原先兜底
	// 一律判 0 栏,小栏就与正文按 y 交错,把利益声明切成六块并夹在中间。
	const bands = [{ left: 110, right: 452 }];
	assert.equal(columnOf([24, 130, 99, 139], bands, 576), 1, '版心左侧 = 独立的一栏');
	assert.equal(columnOf([110, 130, 474, 139], bands, 576), 0, '版心之内照旧');
	// 只认左边: 右侧在语料里全是栏带没认全的表格单元格(chen2023-p5 的
	// P 值列在 510 开外,而栏带只到 485),判成页边内容会把整张表的阅读序打乱。
	assert.equal(columnOf([510, 130, 536, 139], bands, 576), 0, '版心右侧保持原兜底');
});

test('planMerges 把停在虚词上的碎片接回去 (2.5.7)', () => {
	// jacc-ccta2020-p1: 摘要末行被 shortLine 撕成独立块,前一块收在
	// 「…Published by Elsevier on behalf of the」—— 逗号判据看不见这种收尾,
	// 摘要于是断在半句话上。
	assert.deepEqual(planMerges([
		{ text: '(J Am Coll Cardiol 2020;76:1226–43) Published by Elsevier on behalf of the', column: 0, type: 'paragraph', gapAfter: 3, fontSize: 7.5 },
		{ text: 'American College of Cardiology Foundation.', column: 0, type: 'paragraph' }
	]), [[0, 1]]);
	// horst2024-p5: 停在连字符上同理。
	assert.deepEqual(planMerges([
		{ text: 'Noncontrast chest photon-', column: 0, type: 'paragraph', gapAfter: 2, fontSize: 8 },
		{ text: 'counting detector scans (Flash + ultrahigh resolution)', column: 0, type: 'paragraph' }
	]), [[0, 1]]);
});

test('planMerges 允许图注在断词连字符处接回下一段 (2.5.7)', () => {
	// bodyOnly 本来会挡住 caption + paragraph 的合并,可断词连字符是唯一无歧义
	// 的续接信号 —— horst2024-p5 的图 6 说明就断在 photon-/counting 之间。
	assert.deepEqual(planMerges([
		{ text: 'Figure 6: Noncontrast chest photon-', column: 0, type: 'caption', gapAfter: 2, fontSize: 8 },
		{ text: 'counting detector scans (Flash + ultrahigh resolution)', column: 0, type: 'paragraph' }
	]), [[0, 1]]);
	// 没有连字符时照旧不跨类型合并。
	assert.deepEqual(planMerges([
		{ text: 'Figure 6: Noncontrast chest scans and', column: 0, type: 'caption', gapAfter: 2, fontSize: 8 },
		{ text: 'the following body paragraph starts here', column: 0, type: 'paragraph' }
	]), [[0], [1]]);
});
