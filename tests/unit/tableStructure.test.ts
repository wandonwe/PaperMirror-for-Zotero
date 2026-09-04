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

// ---- 2.3.7 (基线 doc1 实证): 微小符号格直接归 data/preserve ------------------

test('tiny symbol-only cells (R², n=5, ±SD) are data — never sent to translation', () => {
	// 4 列结构: 表头 + 两行,c1/c2/c3 是微小符号格。
	const mk = (id: string, text: string, left: number, top: number, w = 40): CellMember => ({
		id, text, box: { left, top, width: w, height: 10 }
	});
	const members = [
		mk('h0', 'Group', 0, 0, 80), mk('h1', 'Value', 100, 0), mk('h2', 'Sig', 160, 0), mk('h3', 'Note', 220, 0),
		mk('a0', 'Treatment arm', 0, 20, 80), mk('a1', 'R²', 100, 20), mk('a2', 'n=5', 160, 20), mk('a3', 'good outcome', 220, 20),
		mk('b0', 'Control arm', 0, 40, 80), mk('b1', '±SD', 100, 40), mk('b2', 'p<.1', 160, 40), mk('b3', 'poor outcome', 220, 40)
	];
	const model = buildTableModel(0, 0, { left: 0, top: 0, width: 300, height: 60 }, members);
	const kindOf = (r: number, c: number) => model.cells.find(x => x.row === r && x.col === c)?.kind;
	assert.equal(kindOf(1, 1), 'data', 'R² 是符号格 → data');
	assert.equal(kindOf(1, 2), 'data', 'n=5 是符号格 → data');
	assert.equal(kindOf(2, 1), 'data', '±SD 是符号格 → data');
	// 真文本格不受影响。
	assert.equal(kindOf(1, 0), 'text', 'Treatment arm 仍是文本格');
	assert.equal(kindOf(1, 3), 'text', 'good outcome 仍是文本格');
});

// ---- 2.6.0 buildTextTableModel ---------------------------------------------

import { buildTextTableModel } from '../../src/reader/tableStructure';

function cm(id: string, text: string, left: number, top: number, width: number, height = 11): CellMember {
	return { id, text, box: { left, top, width, height }, fontSize: 8 };
}

test('buildTextTableModel: 多行文本格按行起点归行,不逐行碎格 (2.6.0)', () => {
	const region: Box = { left: 54, top: 100, width: 460, height: 120 };
	const members: CellMember[] = [];
	// 两行记录: 标签列 1 行,描述列 2 行 (第二行是折行,顶边不与任何行起点对齐)。
	for (let r = 0; r < 2; r++) {
		const y = 100 + r * 50;
		members.push(cm(`lab${r}`, `Label ${r}`, 54, y, 70));
		members.push(cm(`d1-${r}`, 'Images showing the iodine content of the', 150, y, 200));
		members.push(cm(`d2-${r}`, 'voxels in milligrams per milliliter', 150, y + 13, 195));
	}
	const model = buildTextTableModel(0, 0, region, members, 10);
	assert.equal(model.colCount, 2);
	assert.equal(model.rowCount, 2);
	const cell = model.cells.find(c => c.row === 0 && c.col === 1);
	assert.ok(cell);
	assert.equal(cell!.text, 'Images showing the iodine content of the voxels in milligrams per milliliter');
	assert.equal(cell!.kind, 'text');
});

test('buildTextTableModel: 全宽漏网行不焊死列带 (2.6.0, radiology2023-p11 根因)', () => {
	const region: Box = { left: 54, top: 100, width: 460, height: 160 };
	const members: CellMember[] = [];
	for (let r = 0; r < 3; r++) {
		const y = 100 + r * 40;
		members.push(cm(`a${r}`, `Agent ${r}`, 54, y, 60));
		members.push(cm(`b${r}`, 'Yes', 160, y, 20));
		members.push(cm(`c${r}`, 'Clinical availability today', 240, y, 130));
	}
	// 一条几乎全宽的漏网行 (跨列子标题/脚注碎行)。
	members.push(cm('wide', 'Spanning stray line across all columns of the region', 54, 230, 440));
	const model = buildTextTableModel(0, 0, region, members, 10);
	assert.equal(model.colCount, 3, 'the wide member must not weld the column bands');
	for (let r = 0; r < 3; r++) {
		const agent = model.cells.find(c => c.memberIds.includes(`a${r}`))!;
		const avail = model.cells.find(c => c.memberIds.includes(`b${r}`))!;
		assert.notEqual(agent.col, avail.col, `row ${r}: label and value in different columns`);
	}
});

test('buildTextTableModel: 连字符折行在格内接回', () => {
	const region: Box = { left: 54, top: 100, width: 300, height: 40 };
	const members = [
		cm('l1', 'assessed quanti-', 54, 100, 120),
		cm('l2', 'tatively today', 54, 113, 110),
		cm('x1', 'Label', 250, 100, 40),
		cm('x2', 'Other', 250, 130, 40)
	];
	const model = buildTextTableModel(0, 0, region, members, 10);
	const cell = model.cells.find(c => c.memberIds.includes('l1'))!;
	assert.equal(cell.text, 'assessed quantitatively today');
});

// ---- 2.7.2 批次 3 -----------------------------------------------------------

test('多行表头: 首个数字行之前的行都是表头,有词即 text (2.7.2, chen2023-p5/p8)', () => {
	const members: CellMember[] = [
		cell('h0-1', 120, 10, 60, 12, 'All Patients'),
		cell('h0-2', 200, 10, 60, 12, 'Patients with'),
		cell('h1-0', 40, 30, 60, 12, 'Characteristic'),
		cell('h1-1', 120, 30, 60, 12, '(n = 708)'),
		cell('h1-2', 200, 30, 60, 12, 'P Value'),
		cell('d0-0', 40, 50, 60, 12, 'Age (y)'),
		cell('d0-1', 120, 50, 60, 12, '61 ± 10'),
		cell('d0-2', 200, 50, 60, 12, '.06'),
		cell('d1-0', 40, 70, 60, 12, 'Male sex'),
		cell('d1-1', 120, 70, 60, 12, '412 (58)'),
		cell('d1-2', 200, 70, 60, 12, '.31'),
		cell('d2-0', 40, 90, 60, 12, 'Diabetes'),
		cell('d2-1', 120, 90, 60, 12, '120 (17)'),
		cell('d2-2', 200, 90, 60, 12, '<.001')
	];
	const model = buildTableModel(0, 1, region(40, 10, 220, 92), members);
	const kindOf = (row: number, col: number) => model.cells.find(c => c.row === row && c.col === col)?.kind;
	assert.equal(kindOf(1, 1), 'text', '第二行表头 "(n = 708)" 是文本');
	assert.equal(kindOf(1, 2), 'text', '第二行表头 "P Value" 是文本 (列强制不碰表头)');
	assert.equal(kindOf(2, 1), 'data');
	assert.equal(kindOf(2, 2), 'data');
});

test('列带不吞并邻带: 跨两列的成员并入左带但不把带拉宽到右列 (2.7.2, wu2026-p3)', () => {
	const members: CellMember[] = [
		cell('l0', 40, 10, 60, 12, 'Parameter'),
		cell('a0', 140, 10, 40, 12, 'PCD-CT'),
		cell('b0', 220, 10, 40, 12, 'EID-CT'),
		cell('l1', 40, 30, 60, 12, 'Scanner model'),
		cell('wide', 140, 30, 120, 12, 'NAEOTOM Alpha IQon Spectral'),
		cell('l2', 40, 50, 60, 12, 'Collimation'),
		cell('a2', 140, 50, 40, 12, '120×0.2'),
		cell('b2', 220, 50, 40, 12, '64×0.625'),
		cell('l3', 40, 70, 60, 12, 'Pitch'),
		cell('a3', 140, 70, 40, 12, '0.50'),
		cell('b3', 220, 70, 40, 12, '0.60')
	];
	const model = buildTableModel(0, 1, region(40, 10, 220, 72), members);
	assert.equal(model.colCount, 3, '三列不熔成两列');
	const colOf = (id: string) => model.cells.find(c => c.memberIds.includes(id))?.col;
	assert.equal(colOf('a2'), 1);
	assert.equal(colOf('b2'), 2);
	assert.equal(colOf('b3'), 2);
});

test('buildTextTableModel: 表头与首行只隔半个 em 时,跨列顶对齐仍切出首行 (2.7.2, radiology2023-p11)', () => {
	const region: Box = { left: 54, top: 100, width: 460, height: 80 };
	const em = 9;
	const members: CellMember[] = [
		cm('h0', 'Contrast Agent', 54, 100, 55),
		cm('h1', 'Advantages', 238, 100, 40),
		cm('h2', 'Publications', 491, 100, 43),
		// 首行,顶边距表头底边 5pt (0.55em) —— 组内间隙判不出行界。
		cm('r0a', 'Iodinated small', 54, 114, 54),
		cm('r0b', 'Clinical availability,', 238, 114, 68),
		cm('r0c', '68, 97', 491, 114, 22),
		// 悬挂缩进的折行 (左沿 +9),不构成行起点。
		cm('r0a2', 'molecules', 63, 125, 34),
		cm('r0b2', 'prior clinical use', 247, 125, 57),
		cm('r1a', 'Gadolinium', 54, 136, 43),
		cm('r1b', 'Clinical availability,', 238, 136, 68),
		cm('r1c', '83, 85', 491, 136, 22)
	];
	const model = buildTextTableModel(0, 0, region, members, em);
	assert.equal(model.rowCount, 3, '表头 / 首行 / 次行三行');
	const first = model.cells.find(c => c.row === 1 && c.col === 0);
	assert.equal(first?.text, 'Iodinated small molecules');
	const header = model.cells.find(c => c.row === 0 && c.col === 1);
	assert.equal(header?.text, 'Advantages');
});
