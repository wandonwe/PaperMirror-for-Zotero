import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTableRegions, looksTabular, type GuardItem } from '../../src/reader/tableGuard';

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

test('wide table: far-apart numeric columns sharing rows merge into ONE region', () => {
	// Two numeric columns with a ~150px gutter between them (far beyond the
	// old hOverlap tolerance), 5 aligned rows each. They are columns of one
	// table, not two blobs.
	const items: GuardItem[] = [];
	for (let row = 0; row < 5; row++) {
		items.push(item(`L${row}`, `${20 + row} ± 4`, 60, 200 + row * 16, 40));
		items.push(item(`R${row}`, `${30 + row} ± 5`, 260, 200 + row * 16, 40)); // gutter 60→260 = 160px
	}
	const { regions } = detectTableRegions(items, 10);
	assert.equal(regions.length, 1, 'aligned columns however wide the gutter are one table');
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
