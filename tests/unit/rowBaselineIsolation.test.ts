import {test} from 'node:test';
import assert from 'node:assert/strict';
import gori from '../fixtures/regression/gori-acquisition-p4.spans.json';
import edges from '../fixtures/regression/gori-acquisition-p4.edges.json';
import fletcher from '../fixtures/layout/fletcher2024-p7.spans.json';
import gulati from '../fixtures/layout/gulati2021-p21-p1.spans.json';
import {buildBlocksFromSpans, groupIntoLines, groupIntoRows, lineText, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {borderGrids, type Segment} from '../../src/reader/tableBorders';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {validatePageIR} from '../../src/ir/documentIR';

const canonical = (text: string): string => text.replace(/\s+/g, '');
const expected = 'Thyroid nodules are referred for dedicated ultrasound when ≥1 cm or when imaging suggests high-risk morphology. Adrenal nodules ≥1 cm are referred for adrenal-protocol CT or magnetic resonance imaging and endocrine assessment.';

test('a larger heading in the other column cannot mix two source clauses before translation', () => {
 const grids = borderGrids(edges.segments as Segment[], {pageHeight: gori.pageHeight});
 for (const grid of [[], grids]) {
  const initial = buildBlocksFromSpans(gori.items as SpanItem[], {pageIndex: 3, pageWidth: gori.pageWidth,
   pageHeight: gori.pageHeight, includeReferences: true, grids: grid}).blocks;
  const blocks = finalizePageRegions(structureTableCells(orderBlocksForReading(initial), 3, 8, [], grid, true, gori.pageHeight), gori.pageHeight);
  assert.deepEqual(validatePageIR({pageIndex: 3, blocks}), []);
  const paragraph = blocks.find(b => b.sourceText.includes('Thyroid nodules'))!;
  assert.ok(canonical(paragraph.sourceText).includes(canonical(expected)), paragraph.sourceText);
  assert.ok(!paragraph.sourceText.includes('nodulesfor dedicated'));
 }
});

function synthetic(): SpanItem[] {
 const run = (text: string, rect: SpanItem['rect'], fontSize = 10): SpanItem => ({text, rect, fontSize});
 return [
  run('Sable specimens qualify', [20, 220, 250, 230]),
  run('for a dedicated assay when', [20, 208.8, 133, 218.8]),
  run('≥', [138, 208.8, 144, 218.8]),
  run('3 units or samples show', [144, 208.8, 250, 218.8]),
  run('high variance. Amber specimens', [20, 197.6, 183, 207.6]),
  run('≥', [188, 197.6, 194, 207.6]),
  run('4 units qualify for', [194, 197.6, 250, 207.6]),
  run('the alternate assay.', [20, 186.4, 250, 196.4]),
  run('Other heading', [278, 199.7, 390, 213.2], 13.5),
  run('Right column remains independent.', [278, 186.4, 490, 196.4])
 ];
}
const syntheticExpected = 'Sable specimens qualify for a dedicated assay when ≥3 units or samples show high variance. Amber specimens ≥4 units qualify for the alternate assay.';

test('clause order survives changed entities, page, scale, coordinates and base font size', () => {
 for (const scale of [.8, 1.4]) for (const bodySize of [8, 12]) {
  const factor = scale * bodySize / 10;
  const items = synthetic().map(i => ({...i, text: i.text.replace('Sable', 'Cobalt').replace('Amber', 'Ochre'),
   fontSize: i.fontSize! * factor, rect: i.rect.map((n, axis) => n * factor + (axis % 2 ? 31 : 17)) as SpanItem['rect']})).reverse();
  const blocks = buildBlocksFromSpans(items, {pageIndex: 37, pageWidth: 520 * factor + 34,
   pageHeight: 340 * factor + 62, includeReferences: true}).blocks;
  assert.ok(blocks.every(b => b.pageIndex === 37));
  const left = blocks.filter(b => b.lineRectsPdf?.every(r => r[2] < 270 * factor + 17));
  const joined = left.map(b => b.sourceText).join(' ');
  assert.ok(canonical(joined).includes(canonical(syntheticExpected.replace('Sable', 'Cobalt').replace('Amber', 'Ochre'))), joined);
  assert.ok(!left.some(b => /Other heading|Right column/.test(b.sourceText)));
 }
});

test('normal baseline rows and independently offset columns stay separate after line splitting', () => {
 const items = synthetic();
 const lines = groupIntoLines(items, 520, 340);
 const left = lines.filter(l => l.rect[2] < 270).map(lineText);
 assert.deepEqual(left, ['Sable specimens qualify', 'for a dedicated assay when ≥3 units or samples show',
  'high variance. Amber specimens ≥4 units qualify for', 'the alternate assay.']);
 assert.ok(lines.some(l => lineText(l) === 'Other heading'));
 assert.ok(lines.some(l => lineText(l) === 'Right column remains independent.'));
});

test('adjacent raised and lowered small scripts retain their original baseline association', () => {
 const body: SpanItem = {text: 'A base expression', rect: [20, 200, 140, 210], fontSize: 10};
 const raised: SpanItem = {text: '2', rect: [140, 205, 144, 211], fontSize: 6};
 const lowered: SpanItem = {text: 'CT', rect: [140, 197, 150, 203], fontSize: 6};
 const next: SpanItem = {text: 'A separate next line', rect: [20, 188, 160, 198], fontSize: 10};
 const rows = groupIntoRows([body, raised, lowered, next]);
 assert.equal(rows.length, 2);
 assert.ok(rows[0]!.includes(body) && rows[0]!.includes(raised) && rows[0]!.includes(lowered));
 assert.deepEqual(rows[1], [next]);
});

test('the real Fletcher caption keeps its first and second source lines in printed order', () => {
 const initial = buildBlocksFromSpans(fletcher.items as SpanItem[], {pageIndex: 0, pageWidth: fletcher.pageWidth,
  pageHeight: fletcher.pageHeight, includeReferences: false}).blocks;
 const blocks = finalizePageRegions(structureTableCells(orderBlocksForReading(initial), 0, 10), fletcher.pageHeight);
 const caption = blocks.find(b => b.sourceText.startsWith('Figure 6:'))!;
 assert.ok(caption.sourceText.startsWith('Figure 6: CT images in a 71-year-old female patient with metastatic thyroid cancer. (A) Axial photon-counting CT image (reconstruction kernel Qr56, 512 matrix)'), caption.sourceText);
});

test('overlapping page banners do not mix the first three guideline table baselines', () => {
 const rows = groupIntoRows(gulati.items as SpanItem[]);
 const heads = ['Exercise ECG', 'Abnormal ST changes on', 'resting ECG, digoxin, left'];
 const found = heads.map(text => rows.find(row => row.some(item => item.text === text))!);
 assert.ok(found.every(Boolean));
 assert.equal(new Set(found).size, 3);
 assert.ok(found[0]!.some(item => item.text === 'Stress Nuclear'));
 assert.ok(found[0]!.some(item => item.text === 'Stress Echocardiography'));
});
