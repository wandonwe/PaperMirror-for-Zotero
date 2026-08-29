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
