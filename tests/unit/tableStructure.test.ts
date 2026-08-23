import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTableModel, structureTableCells, type CellMember, type Box } from '../../src/reader/tableStructure';
import type { SourceBlock } from '../../src/types/models';

function cell(id: string, left: number, top: number, width: number, height: number, text: string): CellMember {
	return { id, box: { left, top, width, height }, text };
}

const region = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

test('a 2-column prose table becomes text cells on a clean grid', () => {
	// Left column: short section labels. Right column: long recommendations.
	const members: CellMember[] = [
		cell('page-0-block-0', 40, 10, 120, 14, 'Section title'),
		cell('page-0-block-1', 200, 10, 300, 14, '2025 Recommendation'),
		cell('page-0-block-2', 40, 40, 120, 30, '2.3. Prehospital Assessment and Management'),
		cell('page-0-block-3', 200, 40, 300, 50, 'COR 2b. In pediatric patients with suspected stroke transported by ambulance, the usefulness of common adult stroke screening tools is uncertain.'),
		cell('page-0-block-4', 40, 110, 120, 30, '3.2. Initial, Vascular, and Multimodal Imaging Approaches'),
		cell('page-0-block-5', 200, 110, 300, 50, 'COR 2a. In pediatric patients with suspected AIS, emergent brain and vascular imaging with MRI/MRA of the cervical vessels is reasonable.')
	];
	const model = buildTableModel(0, 0, region(40, 10, 460, 150), members);
	assert.equal(model.colCount, 2, 'two columns inferred');
	assert.equal(model.rowCount, 3, 'header + two body rows');
	assert.ok(model.cells.every(c => c.kind === 'text'), 'all prose cells translate');
	// Stable per-cell ids on the grid.
	const ids = model.cells.map(c => c.id).sort();
	assert.ok(ids.includes('page-0-table-0-r0-c0'));
	assert.ok(ids.includes('page-0-table-0-r2-c1'));
	// Each cell maps back to exactly its source block.
	const c00 = model.cells.find(c => c.row === 0 && c.col === 0)!;
	assert.deepEqual(c00.memberIds, ['page-0-block-0']);
	assert.equal(c00.text, 'Section title');
});

test('a numeric data table keeps every value cell original', () => {
	const members: CellMember[] = [
		cell('t-0', 40, 10, 60, 12, 'Group'),
		cell('t-1', 120, 10, 60, 12, 'Mean'),
		cell('t-2', 200, 10, 60, 12, 'n (%)'),
		cell('t-3', 40, 30, 60, 12, 'A'),
		cell('t-4', 120, 30, 60, 12, '3.4 ± 1.2'),
		cell('t-5', 200, 30, 60, 12, '52 (34%)'),
		cell('t-6', 40, 50, 60, 12, 'B'),
		cell('t-7', 120, 50, 60, 12, '2.1 ± 0.9'),
		cell('t-8', 200, 50, 60, 12, '48 (31%)'),
		cell('t-9', 40, 70, 60, 12, 'C'),
		cell('t-10', 120, 70, 60, 12, '5.0 ± 2.2'),
		cell('t-11', 200, 70, 60, 12, '61 (40%)')
	];
	const model = buildTableModel(0, 1, region(40, 10, 220, 72), members);
	const dataCol1 = model.cells.filter(c => c.col === 1 && c.row > 0);
	const dataCol2 = model.cells.filter(c => c.col === 2 && c.row > 0);
	assert.ok(dataCol1.every(c => c.kind === 'data'), 'mean column stays original');
	assert.ok(dataCol2.every(c => c.kind === 'data'), 'n(%) column stays original');
});

test('a fragment stitched across columns is kept original, never translated', () => {
	const members: CellMember[] = [
		cell('n-0', 40, 10, 120, 14, 'Section'),
		cell('n-1', 200, 10, 200, 14, 'Recommendation'),
		cell('n-2', 40, 40, 120, 20, '4.7.5. Endovascular Thrombectomy'),
		cell('n-3', 200, 40, 200, 40, 'COR 2a. EVT can be effective in selected pediatric patients.'),
		// The extractor stitched a paragraph across BOTH columns:
		cell('span', 40, 90, 360, 30, 'In pediatric patients with acute neurological symptoms and salvageable brain tissue, EVT performed by experienced neurointerventionalists may be reasonable to improve functional outcomes.')
	];
	const model = buildTableModel(0, 0, region(40, 10, 360, 110), members);
	const spanning = model.cells.find(c => c.memberIds.includes('span'))!;
	assert.equal(spanning.kind, 'data', 'a cross-column fragment is never translated in place');
});

test('empty region yields an empty model', () => {
	const model = buildTableModel(0, 0, region(0, 0, 100, 100), []);
	assert.equal(model.cells.length, 0);
	assert.equal(model.rowCount, 0);
	assert.equal(model.colCount, 0);
});

test('a legitimately wide column (like "Key results") translates, not flagged data', () => {
	// 3 columns; the right column is much wider than the others (a long prose
	// "Key results" column). It clips no neighbour and must be a text cell.
	const members: CellMember[] = [
		cell('h-0', 40, 10, 90, 12, 'Task'),
		cell('h-1', 150, 10, 110, 12, 'Population'),
		cell('h-2', 280, 10, 300, 12, 'Key results'),
		cell('r1-0', 40, 30, 90, 12, 'Airways'),
		cell('r1-1', 150, 30, 110, 12, '29 human subjects'),
		cell('r1-2', 280, 30, 300, 40, 'Sharp reconstruction kernel and submillimeter section thickness improves visualization of bronchial divisions and pulmonary vessels.'),
		cell('r2-0', 40, 80, 90, 12, 'Lung'),
		cell('r2-1', 150, 80, 110, 12, '112 human subjects'),
		cell('r2-2', 280, 80, 300, 40, 'More precise depiction of ILD CT features at PCCT and reclassification of ILD patterns despite significant radiation dose reduction.')
	];
	const model = buildTableModel(0, 0, region(40, 10, 540, 110), members);
	const keyResults = model.cells.filter(c => c.col === 2);
	assert.ok(keyResults.length >= 2, 'the wide column has its own cells');
	assert.ok(keyResults.every(c => c.kind === 'text'), 'wide prose column translates, not kept English');
	// The "Task" prose column translates too.
	assert.ok(model.cells.filter(c => c.col === 0).every(c => c.kind === 'text'));
});

test('extraction-stage normalization emits stable cells and marks numeric cells preserve', () => {
	const raw: SourceBlock[] = [];
	for (let row = 0; row < 4; row++) {
		raw.push({ id: `label-${row}`, pageIndex: 2, order: raw.length, type: 'paragraph', sourceText: row === 0 ? 'Mortality' : `Clinical outcome ${row}`, boundingBox: { x: 40, y: 200 + row * 18, width: 150, height: 12 } });
		raw.push({ id: `value-${row}-a`, pageIndex: 2, order: raw.length, type: 'paragraph', sourceText: `${40 + row} ± 6`, boundingBox: { x: 200, y: 200 + row * 18, width: 60, height: 12 } });
		raw.push({ id: `value-${row}-b`, pageIndex: 2, order: raw.length, type: 'paragraph', sourceText: `${41 + row} ± 7`, boundingBox: { x: 270, y: 200 + row * 18, width: 60, height: 12 } });
	}
	const out = structureTableCells(raw, 2, 10);
	const stable = out.filter(block => block.id.startsWith('page-2-table-'));
	assert.ok(stable.length >= 4, 'raw table fragments become stable grid cells');
	assert.ok(stable.some(block => block.translationMode === 'preserve'), 'numeric cells remain original');
	assert.ok(stable.some(block => block.sourceText === 'Mortality' && block.translationMode === 'translate'), 'row label is translated in place');
	assert.ok(!out.some(block => block.id === 'value-0-a'), 'consumed raw fragments cannot also be translated');
});

test('cells inherit the PAGE column; the table column lives in tableCol (审核 P1)', () => {
	const raw: SourceBlock[] = [];
	for (let row = 0; row < 4; row++) {
		raw.push({ id: `label-${row}`, pageIndex: 3, order: raw.length, type: 'paragraph', column: 0, sourceText: row === 0 ? 'Mortality' : `Clinical outcome ${row}`, boundingBox: { x: 40, y: 200 + row * 18, width: 150, height: 12 } });
		raw.push({ id: `value-${row}-a`, pageIndex: 3, order: raw.length, type: 'paragraph', column: 0, sourceText: `${40 + row} ± 6`, boundingBox: { x: 200, y: 200 + row * 18, width: 60, height: 12 } });
		raw.push({ id: `value-${row}-b`, pageIndex: 3, order: raw.length, type: 'paragraph', column: 0, sourceText: `${41 + row} ± 7`, boundingBox: { x: 270, y: 200 + row * 18, width: 60, height: 12 } });
	}
	const out = structureTableCells(raw, 3, 10);
	const cells = out.filter(block => block.id.startsWith('page-3-table-'));
	assert.ok(cells.length >= 4);
	// All member fragments sat in page column 0 → every cell stays column 0;
	// a 3-column table must NOT fabricate page columns 1 and 2.
	assert.ok(cells.every(c => c.column === 0), JSON.stringify(cells.map(c => c.column)));
	assert.ok(cells.some(c => typeof c.tableCol === 'number' && c.tableCol > 0), 'table-internal column preserved in tableCol');
});

test('cells export tableRow alongside tableCol (1.0.6 — row was only in the id before)', () => {
	const raw: SourceBlock[] = [];
	for (let row = 0; row < 3; row++) {
		raw.push({ id: `l-${row}`, pageIndex: 0, order: raw.length, type: 'paragraph', column: 0, sourceText: row === 0 ? 'Outcome' : `Endpoint ${row}`, boundingBox: { x: 40, y: 100 + row * 18, width: 150, height: 12 } });
		raw.push({ id: `v-${row}`, pageIndex: 0, order: raw.length, type: 'paragraph', column: 0, sourceText: `${10 + row} ± 2`, boundingBox: { x: 200, y: 100 + row * 18, width: 60, height: 12 } });
	}
	const cells = structureTableCells(raw, 0, 10).filter(b => b.id.startsWith('page-0-table-'));
	assert.ok(cells.length >= 4);
	assert.ok(cells.every(c => typeof c.tableRow === 'number' && c.tableRow! >= 0), 'every cell carries tableRow');
	assert.ok(cells.some(c => c.tableRow! > 0), 'non-header rows numbered');
	// Field agrees with the id it used to hide in: page-0-table-<t>-r<row>-c<col>.
	for (const c of cells) {
		const m = /-r(\d+)-c(\d+)$/.exec(c.id)!;
		assert.equal(c.tableRow, Number(m[1]));
		assert.equal(c.tableCol, Number(m[2]));
	}
});
