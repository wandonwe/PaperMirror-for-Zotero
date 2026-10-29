import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structureTableCells } from '../../src/reader/tableStructure';
import { tableCellBounds } from '../../src/ir/tableModel';
import { auditTableOwnership } from '../../src/reader/tableOwnership';
import type { BorderGrid } from '../../src/reader/tableBorders';
import type { SourceBlock } from '../../src/types/models';

const pageHeight = 800;
function block(id: string, x: number, y: number, width: number, lines: number, text: string, type: SourceBlock['type'] = 'paragraph'): SourceBlock {
 const fontSize = 9;
 const lineRectsPdf = Array.from({ length: lines }, (_, i) =>
  [x, pageHeight - y - i * 11 - fontSize, x + (i ? width * .7 : width), pageHeight - y - i * 11] as [number, number, number, number]);
 return { id, pageIndex: 2, order: 0, type, sourceText: text,
  boundingBox: { x, y, width, height: (lines - 1) * 11 + fontSize }, lineRectsPdf, fontSize, translationMode: 'translate' };
}

const framedFigure: BorderGrid = {
 columns: [20, 50, 540], rows: [40, 250, 265, 280],
 region: { left: 20, top: 40, width: 520, height: 240 }
};

for (const lines of [2, 3]) {
 test(`${lines}-line figure captions keep all source lines outside decorative table ownership`, () => {
  const caption = block('caption', 52, 252, 470, lines,
   'Figure 17 Study groups and classification. Additional caption sentences continue below the frame.', 'caption');
  // No sourceRegion is required: classification already establishes this is
  // a caption. A short caption does not pass the 3-line zone detector.
  const result = structureTableCells([caption], 2, 9, [], framedFigure, true, pageHeight);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, caption.id);
  assert.equal(result[0]!.type, 'caption');
  assert.deepEqual(result[0]!.lineRectsPdf, caption.lineRectsPdf);
  assert.deepEqual(result[0]!.boundingBox, caption.boundingBox);
  assert.equal(tableCellBounds(result[0]!), undefined);
  assert.deepEqual(auditTableOwnership([caption], result), []);
 });
}

test('caption translation failure can retain the entire original caption without table clipping', () => {
 const caption = { ...block('caption-preserved', 52, 252, 470, 3,
  'Fig. 9. A complete original caption with three lines retained after translation fallback.', 'caption'),
  translationMode: 'preserve' as const };
 const result = structureTableCells([caption], 2, 9, [], framedFigure, true, pageHeight);
 assert.equal(result[0]!.translationMode, 'preserve');
 assert.equal(result[0]!.sourceText, caption.sourceText);
 assert.deepEqual(result[0]!.lineRectsPdf, caption.lineRectsPdf);
 assert.equal(result[0]!.tableRectPdf, undefined);
});

test('a caption is not consumed while genuine data cells inside the same grid keep their slots', () => {
 const grid: BorderGrid = { columns: [40, 170, 330], rows: [100, 125, 150],
  region: { left: 40, top: 100, width: 290, height: 50 } };
 const cells = [block('label-a', 44, 104, 100, 1, 'Control'), block('value-a', 174, 104, 70, 1, '32 ± 4'),
  block('label-b', 44, 129, 100, 1, 'Treatment'), block('value-b', 174, 129, 70, 1, '41 ± 6')];
 const caption = block('outside-caption', 44, 146, 270, 2, 'Figure 21. Independent explanatory caption.', 'caption');
 const result = structureTableCells([...cells, caption], 2, 9, [], grid, true, pageHeight);
 assert.equal(result.find(b => b.id === caption.id)?.type, 'caption');
 const dataCells = result.filter(b => b.tableSource === 'border');
 assert.equal(dataCells.length, 4);
 assert.deepEqual(dataCells.map(b => [b.tableRow, b.tableCol]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
 assert.equal(dataCells.filter(b => b.translationMode === 'preserve').length, 2);
 assert.ok(!dataCells.some(b => b.memberIds?.includes(caption.id)));
});

test('a framed picture cannot weld its title and distant notes into one tall text cell', () => {
 const grid: BorderGrid = { columns: [20, 50, 540], rows: [40, 440, 460],
  region: { left: 20, top: 40, width: 520, height: 420 } };
 const title = block('visual-title', 52, 52, 110, 1, 'Visual summary');
 const notes = block('visual-notes', 124, 416, 370, 2, 'Key terms: imaging, prevention, and follow-up.');
 const result = structureTableCells([title, notes], 2, 9, [], grid, true, pageHeight);
 assert.equal(result.length, 2);
 assert.ok(result.every(b => b.memberIds?.length === 1), 'independent source fragments stay independent');
 for (const original of [title, notes]) {
  const placed = result.find(b => b.memberIds?.includes(original.id))!;
  assert.equal(placed.sourceText, original.sourceText);
  assert.deepEqual(placed.boundingBox, original.boundingBox);
  const bounds = tableCellBounds(placed)!;
  assert.ok(bounds[3] - bounds[1] < 30, 'no text owner stretches through the picture');
 }
 assert.deepEqual(auditTableOwnership([title, notes], result), []);
});

test('a real tall cell with nearby paragraphs still uses its border geometry', () => {
 const grid: BorderGrid = { columns: [30, 200, 500], rows: [50, 150, 180],
  region: { left: 30, top: 50, width: 470, height: 130 } };
 const paragraphs = [block('paragraph-a', 210, 60, 250, 2, 'First recommendation paragraph.'),
  block('paragraph-b', 210, 102, 250, 2, 'Second recommendation paragraph.')];
 const result = structureTableCells(paragraphs, 2, 9, [], grid, true, pageHeight);
 assert.equal(result.length, 1);
 assert.equal(result[0]!.tableSource, 'border');
 assert.deepEqual(result[0]!.memberIds, paragraphs.map(b => b.id));
 assert.equal(result[0]!.boundingBox!.height, 100);
});

test('border-cell merging retains distinct member layout barriers through serialization', () => {
 const grid: BorderGrid = { columns: [30, 200, 500], rows: [50, 150, 180],
  region: { left: 30, top: 50, width: 470, height: 130 } };
 const shared: [number, number, number, number] = [30, 720, 500, 721];
 const extra: [number, number, number, number] = [30, 710, 500, 711];
 const first = { ...block('merge-a', 210, 60, 250, 2, 'First recommendation.'), layoutBarriersPdf: [shared] };
 const second = { ...block('merge-b', 210, 102, 250, 2, 'Second recommendation.'), layoutBarriersPdf: [shared, extra] };
 const [cell] = structureTableCells([first, second], 2, 9, [], grid, true, pageHeight);
 assert.deepEqual(cell!.memberIds, [first.id, second.id]);
 assert.deepEqual(cell!.layoutBarriersPdf, [shared, extra]);
 assert.deepEqual(JSON.parse(JSON.stringify(cell)).layoutBarriersPdf, [shared, extra]);
 assert.ok(!cell!.lineRectsPdf?.some(r => r.join(',') === shared.join(',')), 'rules are barriers, not source text ink');
});

test('inferred table cells retain their member layout barriers through serialization', () => {
 const barrier: [number, number, number, number] = [40, 520, 400, 521];
 const source: SourceBlock[] = [];
 for (let row = 0; row < 4; row++) {
  source.push({ ...block(`label-${row}`, 40, 200 + row * 18, 140, 1, row ? `Clinical outcome ${row}` : 'Mortality'),
   order: source.length, layoutBarriersPdf: [barrier] });
  source.push({ ...block(`number-a-${row}`, 200, 200 + row * 18, 50, 1, `${40 + row} ± 6`), order: source.length });
  source.push({ ...block(`number-b-${row}`, 270, 200 + row * 18, 50, 1, `${41 + row} ± 7`), order: source.length });
 }
 const cells = structureTableCells(source, 2, 9, [], undefined, true, pageHeight);
 const labels = cells.filter(b => b.memberIds?.some(id => id.startsWith('label-')));
 assert.equal(labels.length, 4);
 assert.ok(labels.every(b => b.tableSource === 'text-alignment'));
 assert.ok(labels.every(b => JSON.stringify(b.layoutBarriersPdf) === JSON.stringify([barrier])));
 assert.ok(JSON.parse(JSON.stringify(labels)).every((b: SourceBlock) => b.layoutBarriersPdf?.length === 1));
});

test('numbered table badges retain their anchor role even when their title region is a caption', () => {
 const source: SourceBlock[] = [];
 for (const [n, left] of [[7, 40], [12, 254]]) {
  const region: NonNullable<SourceBlock['sourceRegion']> = { id: `title-zone-${n}`, kind: 'caption',
   boundsPdf: [left!, 700, left! + 190, 712], evidence: 'label-aligned-lines' };
  source.push({ ...block(`badge-${n}`, left!, 90, 32, 1, `Table ${n}`, 'table'), sourceRegion: region });
  source.push({ ...block(`title-${n}`, left! + 40, 88, 150, 1, 'Independent diagnostic results', 'caption'), sourceRegion: region });
  for (let row = 0; row < 5; row++) {
   source.push(block(`label-${n}-${row}`, left!, 110 + row * 16, 80, 1, row ? `Outcome ${row}` : 'Outcome'));
   source.push(block(`value-a-${n}-${row}`, left! + 90, 110 + row * 16, 40, 1, `${70 + row} ± 5`));
   source.push(block(`value-b-${n}-${row}`, left! + 145, 110 + row * 16, 40, 1, `${60 + row} ± 6`));
  }
 }
 const result = structureTableCells(source, 2, 9, [], undefined, true, pageHeight);
 const tables = new Set(result.filter(b => b.tableId).map(b => b.tableId));
 assert.equal(tables.size, 2);
 for (const id of tables) {
  const cells = result.filter(b => b.tableId === id);
  assert.ok(cells.every(b => b.boundingBox!.x + b.boundingBox!.width < 250)
   || cells.every(b => b.boundingBox!.x > 250), 'each table owns only one panel');
 }
 for (const n of [7, 12]) {
  assert.equal(result.find(b => b.id === `badge-${n}`)?.tableId, undefined);
  assert.equal(result.find(b => b.id === `title-${n}`)?.tableId, undefined);
 }
});
