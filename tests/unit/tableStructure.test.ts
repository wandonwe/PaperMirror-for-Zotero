import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTableModel, type CellMember, type Box } from '../../src/reader/tableStructure';

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
