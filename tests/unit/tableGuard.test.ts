import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTableRegions, looksTabular, looksTabularSeed, type GuardItem } from '../../src/reader/tableGuard';

function item(id: string, text: string, left: number, top: number, width = 60, height = 12, type = 'paragraph'): GuardItem {
	return { id, text, type, box: { left, top, width, height }, fontSize: 9 };
}

test('looksTabular: cells yes, prose no', () => {
	assert.equal(looksTabular('3.42 ± 1.18'), true);
	assert.equal(looksTabular('52 (48%)'), true);
	assert.equal(looksTabular('<0.001'), true);
	assert.equal(looksTabular('LVEF, %'), true);
	assert.equal(looksTabular('The results of this study are consistent with previous research on coronary imaging.'), false);
	assert.equal(looksTabular('Methods'), false);
});

test('looksTabular: author-initial lists are prose, not cells (1.2.0 false-table fix)', () => {
	// Period/comma-dense but DIGIT-FREE — a journal author-contribution line.
	// Without the digit gate these seeded false table clusters across the page.
	assert.equal(looksTabular('mental studies, A.H., H.P., C.J.W., J.K., S.L., S.N.G.; sta-'), false);
	assert.equal(looksTabular('A.H., A.U.H., T.d.B., S.N.G.'), false);
	assert.equal(looksTabular('S.N.G.'), false);
	// A genuine stat cell (has a digit) is still tabular.
	assert.equal(looksTabular('(SD, 0.22)'), true);
	assert.equal(looksTabular('3.4 ± 1.2 (n=52)'), true);
});

test('a grid of numeric cells becomes one protected region', () => {
	const items: GuardItem[] = [];
	// 4 rows × 3 columns of cells
	for (let row = 0; row < 4; row++) {
		for (let col = 0; col < 3; col++) {
			items.push(item(`c${row}-${col}`, `${row}.${col} ± 0.2`, 60 + col * 80, 200 + row * 18));
		}
	}
	// A prose paragraph far below must stay translatable.
	items.push(item('prose', 'This paragraph discusses the implications of the findings in considerable depth and detail.', 60, 600, 240, 40));
	const { excluded, regions } = detectTableRegions(items, 10);
	assert.equal(regions.length, 1);
	for (let row = 0; row < 4; row++) {
		for (let col = 0; col < 3; col++) {
			assert.ok(excluded.has(`c${row}-${col}`), `cell c${row}-${col} excluded`);
		}
	}
	assert.ok(!excluded.has('prose'), 'prose outside the table stays translatable');
});

test('prose-looking row labels inside the region are swallowed with it', () => {
	const items: GuardItem[] = [];
	for (let row = 0; row < 4; row++) {
		// A textual row label the cell test misses…
		items.push(item(`label${row}`, 'Left ventricular ejection fraction', 40, 200 + row * 18, 150));
		// …beside numeric cells that anchor the region.
		items.push(item(`v${row}a`, `${40 + row} ± 6`, 200, 200 + row * 18));
		items.push(item(`v${row}b`, `${41 + row} ± 7`, 270, 200 + row * 18));
	}
	const { excluded } = detectTableRegions(items, 10);
	for (let row = 0; row < 4; row++) {
		assert.ok(excluded.has(`label${row}`), `row label ${row} protected with its table`);
	}
});

test('a small cluster is only a table when a Table caption anchors it', () => {
	const loneCells = [
		item('a', '12 ± 3', 60, 200),
		item('b', '14 ± 2', 140, 200)
	];
	assert.equal(detectTableRegions(loneCells, 10).regions.length, 0, 'two stray cells alone are not a table');
	const withCaption = [
		...loneCells,
		item('cap', 'Table 2. Baseline characteristics', 60, 180, 220, 12, 'table')
	];
	assert.equal(detectTableRegions(withCaption, 10).regions.length, 1, 'a Table caption anchors them');
});

// ---- 1.2.0: wide grid — far-apart columns + a far-left label column ----------

test('wide table: far-apart numeric columns sharing rows merge into ONE region (gutter within cap)', () => {
	// Two numeric columns with a ~70px gutter (beyond the old hOverlap
	// tolerance, within the em*8 column-merge cap), 5 aligned rows each.
	const items: GuardItem[] = [];
	for (let row = 0; row < 5; row++) {
		items.push(item(`L${row}`, `${20 + row} ± 4`, 60, 200 + row * 16, 40));
		items.push(item(`R${row}`, `${30 + row} ± 5`, 170, 200 + row * 16, 40)); // gutter 100→170 = 70px ≤ em*8
	}
	const { regions } = detectTableRegions(items, 10);
	assert.equal(regions.length, 1, 'aligned columns with a table-scale gutter are one table');
});

test('1.2.2 收紧: 超过 em*8 间距的两个对齐数值簇不再并成一表', () => {
	// 行完全对齐、但槽宽 160px (> 10*8) —— 这是两个并排的独立小表/列表,
	// 不是一张表的相邻列。审核项: sharedRowCount 不再单独放行任意宽度。
	const items: GuardItem[] = [];
	for (let row = 0; row < 5; row++) {
		items.push(item(`L${row}`, `${20 + row} ± 4`, 60, 200 + row * 16, 40));
		items.push(item(`R${row}`, `${30 + row} ± 5`, 260, 200 + row * 16, 40)); // gutter 100→260 = 160px
	}
	const { regions } = detectTableRegions(items, 10);
	assert.equal(regions.length, 2, 'beyond-cap aligned clusters stay two regions');
});

test('1.2.2 收紧: 两个对齐数值簇之间隔着图片时不合并', () => {
	// 间距在 cap 之内、行也对齐,但槽里立着一张图 —— 图两侧的数字属于两个
	// 不同的东西 (双图各带坐标轴刻度的典型版式)。
	const items: GuardItem[] = [];
	for (let row = 0; row < 5; row++) {
		items.push(item(`L${row}`, `${20 + row} ± 4`, 60, 200 + row * 16, 40));
		items.push(item(`R${row}`, `${30 + row} ± 5`, 170, 200 + row * 16, 40));
	}
	const figure = { left: 110, top: 190, width: 50, height: 100 }; // 站在槽里
	const { regions } = detectTableRegions(items, 10, [figure]);
	assert.equal(regions.length, 2, 'an obstacle in the gutter keeps the clusters apart');
});

test('wide table: far-left prose label column aligned to numeric rows is swallowed', () => {
	const items: GuardItem[] = [];
	for (let row = 0; row < 5; row++) {
		// label far to the LEFT of the first numeric column (big gutter)
		items.push(item(`lab${row}`, 'Median infarct volume at 24 hr (IQR)', 40, 200 + row * 16, 150));
		items.push(item(`a${row}`, `${35 + row} (18-82)`, 300, 200 + row * 16, 44));
		items.push(item(`b${row}`, `${41 + row} (25-9)`, 380, 200 + row * 16, 44));
	}
	const { excluded } = detectTableRegions(items, 10);
	for (let row = 0; row < 5; row++) {
		assert.ok(excluded.has(`lab${row}`), `far-left row label ${row} captured with its table`);
	}
});

test('wide table: unrelated numeric line NOT sharing the table rows stays out', () => {
	const items: GuardItem[] = [];
	for (let row = 0; row < 5; row++) {
		items.push(item(`a${row}`, `${20 + row} ± 4`, 60, 200 + row * 16, 40));
		items.push(item(`b${row}`, `${30 + row} ± 5`, 130, 200 + row * 16, 40));
	}
	// A lone numeric fragment far below, on no table row.
	items.push(item('stray', '99 ± 9', 60, 520, 40));
	const { excluded, regions } = detectTableRegions(items, 10);
	assert.equal(regions.length, 1);
	assert.ok(!excluded.has('stray'), 'a numeric fragment off the table rows is not swallowed');
});

// ---- 2.5.11: 统计密集正文不再伪装成表格 (wu2026-p5 实证) --------------------

test('looksTabularSeed: stats-dense prose lines are NOT cluster seeds', () => {
	// Narrow two-column journal Results lines — symbol density passes the 30%
	// rule, but ≥3 ordinary lowercase words mark them as sentences.
	assert.equal(looksTabularSeed('overall image quality (ICC=0.934; 95% CI: 0.8980.957)'), false);
	assert.equal(looksTabularSeed('and sharpness (ICC=0.969; 95% CI: 0.9520.980), and'), false);
	assert.equal(looksTabularSeed('good agreement for noise assessment (ICC=0.886; 95%'), false);
	// Real cells keep seeding.
	assert.equal(looksTabularSeed('3.42 ± 1.18'), true);
	assert.equal(looksTabularSeed('3 [3,4]'), true);
	assert.equal(looksTabularSeed('* -10.078 <0.001'), true);
	assert.equal(looksTabularSeed('120×0.2'), true);
	// looksTabular itself is UNCHANGED for these — structureTableCells' cell
	// typing (data vs text) must keep its byte-identical semantics.
	assert.equal(looksTabular('overall image quality (ICC=0.934; 95% CI: 0.8980.957)'), true);
});

test('a stats paragraph beside a real table is not swept in as "row labels" (续行闸)', () => {
	const items: GuardItem[] = [];
	// A real 3×3 table: labels + numeric cells.
	const labels = ['Overall image quality', 'Sharpness', 'Noise'];
	for (let row = 0; row < 3; row++) {
		items.push(item(`lab${row}`, labels[row]!, 320, 200 + row * 16, 90));
		items.push(item(`a${row}`, `${3 + row} [3,4]`, 420, 200 + row * 16, 34));
		items.push(item(`b${row}`, `${5 + row} [4,5]`, 460, 200 + row * 16, 34));
		items.push(item(`c${row}`, `-1${row}.078 <0.001`, 500, 200 + row * 16, 50));
	}
	// The NEIGHBOURING text column's justified lines: same heights, right edge
	// ~1.5em from the table — continuation-shaped (lowercase start / hyphen end).
	items.push(item('prose0', 'aged between readers. Inter-reader agreement was quanti-', 60, 200, 245));
	items.push(item('prose1', 'tatively assessed as follows: for continuous variables', 60, 216, 245));
	const { excluded } = detectTableRegions(items, 10);
	assert.ok(!excluded.has('prose0'), 'lowercase-start body line must not be swept as a row label');
	assert.ok(!excluded.has('prose1'), 'continuation body line must not be swept as a row label');
	// The real table (cells + its labels) is still protected.
	for (let row = 0; row < 3; row++) {
		assert.ok(excluded.has(`a${row}`) && excluded.has(`b${row}`), 'numeric cells still excluded');
		assert.ok(excluded.has(`lab${row}`), 'real row labels still swept in');
	}
});

// ---- 2.6.0 标题锚定文本表 --------------------------------------------------

import { isTableCaptionAnchor } from '../../src/reader/tableGuard';

test('isTableCaptionAnchor: 标题形态锚定,正文指代不锚定 (2.6.0)', () => {
	assert.equal(isTableCaptionAnchor('Table 2: Spectral Reconstructions'), true);
	assert.equal(isTableCaptionAnchor('Table 4. Summary of Materials'), true);
	assert.equal(isTableCaptionAnchor('表 3: 系统特征'), true);
	// 正文里的指代 (行级 type 仍是 paragraph) 不锚。
	assert.equal(isTableCaptionAnchor('Table 3 lists the scanners currently available'), false);
	// 块级被 classify 标为 table 的无标点标题锚 (wu2026 形态)。
	assert.equal(isTableCaptionAnchor('Table 3 Quantitative assessment of image quality', 'table'), true);
});

/** 一张 3 列文本定义表: 标签列窄、描述列宽、行顶跨列对齐。 */
function textTableItems(): GuardItem[] {
	const items: GuardItem[] = [
		item('cap', 'Table 2: Definition of Terms Used in This Review', 54, 80, 300, 12, 'table')
	];
	const rows = [110, 150, 190, 230];
	rows.forEach((y, r) => {
		items.push(item(`lab${r}`, 'Iodine maps', 54, y, 70, 11));
		items.push(item(`d1-${r}`, 'Images showing the iodine content of the', 150, y, 170, 11));
		items.push(item(`d2-${r}`, 'voxels in milligrams per milliliter today', 150, y + 13, 168, 11));
		items.push(item(`b1-${r}`, 'Quantification of iodine concentration now', 340, y, 175, 11));
	});
	return items;
}

test('标题锚定: 无数字种子的文本表被收进 textRegions (2.6.0, radiology2023)', () => {
	const { excluded, regions, textRegions } = detectTableRegions(textTableItems(), 10);
	assert.equal(regions.length, 0, 'no numeric seeds — the old path finds nothing');
	assert.equal(textRegions.length, 1, 'the caption-anchored pass finds the text table');
	for (let r = 0; r < 4; r++) {
		assert.ok(excluded.has(`lab${r}`) && excluded.has(`d1-${r}`) && excluded.has(`b1-${r}`),
			`row ${r} cells excluded`);
	}
	assert.ok(!excluded.has('cap'), 'the caption itself stays a caption block');
});

test('标题锚定: 悬空标题下的双栏正文一个块也不收 (网格验收兜底)', () => {
	// "Table 2" 的表在下一页 —— 标题下是普通双栏正文: 每栏行宽 ≈ 半区宽,
	// 没有窄标签列,验收必须拒绝。
	const items: GuardItem[] = [
		item('cap', 'Table 2: Continued on the Next Page', 54, 80, 300, 12, 'table')
	];
	for (let r = 0; r < 6; r++) {
		items.push(item(`L${r}`, 'left column body prose line with many ordinary words here', 54, 110 + r * 13, 230, 11));
		items.push(item(`R${r}`, 'right column body prose line with many ordinary words too', 310, 110 + r * 13, 230, 11));
	}
	const { excluded, textRegions } = detectTableRegions(items, 10);
	assert.equal(textRegions.length, 0, 'two prose columns are not a text table');
	assert.equal(excluded.size, 0);
});

test('标题锚定: Note.— 脚注是墙,扫掠到它即止 (radiology2023-p11 列带焊死根因)', () => {
	const items = textTableItems();
	// 表尾全宽脚注行 (逐行看词数不足长散文阈值)。
	items.push(item('note', 'Note.CNR = contrast-to-noise ratio, FDA = U.S. Food', 54, 280, 460, 11));
	items.push(item('note2', 'and Drug Administration, PCCT = photon-counting CT', 54, 293, 440, 11));
	const { excluded, textRegions } = detectTableRegions(items, 10);
	assert.equal(textRegions.length, 1, 'the table above the footnote still detects');
	assert.ok(!excluded.has('note') && !excluded.has('note2'), 'footnote lines stay prose');
});

// ---- 2.7.2 批次 3: 表头向上扫掠 (C-1) ---------------------------------------

/** 4 行 × 3 列数值格,顶边 top,列距 80。 */
function numericGrid(items: GuardItem[], top: number, rows = 4): void {
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < 3; col++) {
			items.push(item(`c${row}-${col}`, `${row}.${col} ± 0.2`, 60 + col * 80, top + row * 18));
		}
	}
}

test('表头扫掠 (d): 区域顶边上方的短列头并入区域 (2.7.2, radiology2023-p3)', () => {
	const items: GuardItem[] = [];
	numericGrid(items, 200);
	// 两行堆叠列头,紧贴区域顶边之上 (gap 6pt / 24pt = 0.6em / 2.4em)。
	items.push(item('h1-0', 'Detector', 60, 176, 50), item('h1-1', 'Energy', 140, 176, 50), item('h1-2', 'FOV (cm)', 220, 176, 50));
	items.push(item('h0-0', 'Type', 60, 158, 50), item('h0-1', 'Thresholds', 140, 158, 50));
	// 远在上方 (4em) 的正文短行不收。
	items.push(item('far', 'Short line', 60, 120, 50));
	const { excluded } = detectTableRegions(items, 10);
	for (const id of ['h1-0', 'h1-1', 'h1-2', 'h0-0', 'h0-1']) {
		assert.ok(excluded.has(id), `${id} 并入表头`);
	}
	assert.ok(!excluded.has('far'), '4em 之外的短行不收');
});

test('表头扫掠: 句末标点收尾的正文末行、>6 词的行、x 中心在区域之外的块都不收', () => {
	const items: GuardItem[] = [];
	numericGrid(items, 200);
	items.push(item('sentence', 'reduced the dose.', 60, 176, 80));
	items.push(item('long', 'one two three four five six seven', 140, 176, 100));
	items.push(item('aside', 'Label', 400, 176, 40));
	const { excluded } = detectTableRegions(items, 10);
	assert.ok(!excluded.has('sentence'));
	assert.ok(!excluded.has('long'));
	assert.ok(!excluded.has('aside'));
});

test('表头扫掠天花板: "Table N" 标题之上的块一律不收 (wu2026-p6 脚注/上一张表)', () => {
	const items: GuardItem[] = [];
	numericGrid(items, 300);
	items.push(item('hdr', 'Sensitivity', 140, 282, 50));
	items.push(item('cap', 'Table 4 Comparison of polyp detection', 60, 266, 220, 12, 'table'));
	// 标题之上 (距列头 2em,天花板不在时会被扫掠链带走): 上一张表的脚注
	// (短、无句末标点、≤6 词)。
	items.push(item('foot', 'Data are means±SDs', 60, 250, 80));
	items.push(item('foot2', 'difference', 60, 234, 40));
	const { excluded } = detectTableRegions(items, 10);
	assert.ok(excluded.has('hdr'), '标题之下的列头照收');
	assert.ok(!excluded.has('foot'), '标题之上的脚注不收');
	assert.ok(!excluded.has('foot2'));
});

test('表头扫掠行伴: 同基线上有句子续行的孤词是标题续行,不是表头 (wu2026-p6 "size")', () => {
	const items: GuardItem[] = [];
	numericGrid(items, 300);
	items.push(item('hdr', 'Sensitivity', 140, 282, 50));
	// 标题第二行被分栏切成 "and PCD-CT stratified by polyp" + "size"。
	items.push(item('cont', 'and PCD-CT stratified by polyp', 60, 264, 110));
	items.push(item('size', 'size', 172, 264, 15));
	const { excluded } = detectTableRegions(items, 10);
	assert.ok(excluded.has('hdr'));
	assert.ok(!excluded.has('size'), '标题续行的孤词不进表');
	assert.ok(!excluded.has('cont'));
});
