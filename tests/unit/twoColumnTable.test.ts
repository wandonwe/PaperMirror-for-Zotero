import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/gori-acquisition-p4.spans.json';
import sixColumn from '../fixtures/layout/radiology2023-p11.spans.json';
import {extractTwoColumnTables} from '../../src/reader/twoColumnTable';
import type {SpanItem} from '../../src/reader/spanBlockBuilder';
const items = fixture.items as SpanItem[];
const extract = (xs: SpanItem[]) => extractTwoColumnTables(xs, 3, fixture.pageHeight);

test('acquisition protocol is a title, two headers and ten paired rows, with wrapped labels intact', () => {
 const {blocks, used} = extract(items);
 assert.equal(blocks.length, 23);
 assert.equal(blocks[0]!.sourceText, 'Table 1 Acquisition protocol');
 const rows = blocks.filter(b => b.tableCol === 0).map(b => b.sourceText);
 assert.deepEqual(rows, ['Section', 'Scanner', 'Patient positioning', 'Acquisition phases', 'Additional acquisition',
  'Contrast protocol', 'Iodine dose', 'Scan parameters', 'Image reconstruction', 'Spectral post-processing', 'Reconstruction software']);
 const value = (row: number) => blocks.find(b => b.tableRow === row && b.tableCol === 1)!;
 assert.match(value(1).sourceText, /^Dual-source photon-counting CT/);
 assert.ok(!value(1).sourceText.includes('Supine'));
 assert.match(value(2).sourceText, /^Supine/);
 assert.match(value(3).sourceText, /High-pitch thoraco-cervical sweep/);
 assert.ok(!value(3).sourceText.includes('Low-dose expiratory'));
 assert.match(value(5).sourceText, /Total for a 70-kg patient/);
 assert.ok(!value(5).sourceText.includes('33.6'));
 assert.match(value(6).sourceText, /33.6 g.*31.08 g/);
 assert.match(value(10).sourceText, /^ReconCT/);
 assert.ok(!blocks.some(b => b.sourceText.includes('BP, blood pressure')));
 assert.ok(used.has(items.find(i => /^\. \. \./.test(i.text))!));
 assert.ok(!blocks.some(b => /\. \. \./.test(b.sourceText)));
 for (let row = 0; row <= 10; row++) {
  const pair = blocks.filter(b => b.tableRow === row);
  assert.equal(pair.length, 2);
  assert.equal(pair[0]!.tableContentRectPdf![2], pair[1]!.tableContentRectPdf![0]);
  assert.equal(pair[0]!.tableContentRectPdf![1], pair[1]!.tableContentRectPdf![1]);
  assert.equal(pair[0]!.tableContentRectPdf![3], pair[1]!.tableContentRectPdf![3]);
  if (row < 10) assert.equal(pair[0]!.tableContentRectPdf![1], blocks.find(b => b.tableRow === row + 1)!.tableContentRectPdf![3]);
 }
 // Every non-decorative source fragment has exactly one translation owner.
 const sourceChars = [...used].filter(i => !/^\. \. \./.test(i.text)).reduce((n, i) => n + i.text.replace(/\s/g, '').length, 0);
 const outputChars = blocks.reduce((n, b) => n + b.sourceText.replace(/\s/g, '').length, 0);
 assert.equal(sourceChars, outputChars);
});

test('protocol extraction is stable under scale, translation, shuffled input and renamed labels', () => {
 for (const factor of [.7, 1.4]) {
  const moved = items.map(i => ({...i, text: i.text.replace('Table 1', 'Table 27.').replace('Scanner', 'Equipment'),
   fontSize: (i.fontSize || 8) * factor, rect: i.rect.map((v, n) => v * factor + (n % 2 ? 20 : 13)) as SpanItem['rect']})).reverse();
  const blocks = extractTwoColumnTables(moved, 8, fixture.pageHeight * factor + 40).blocks;
  assert.equal(blocks.length, 23);
  assert.ok(blocks.every(b => b.pageIndex === 8));
  assert.ok(blocks.some(b => b.sourceText === 'Equipment'));
 }
});

test('a caption, paired headers and repeated prose are all required', () => {
 assert.equal(extract(items.filter(i => !/^Table 1/.test(i.text))).blocks.length, 0);
 assert.equal(extract(items.filter(i => i.text !== 'Details')).blocks.length, 0);
 const onlyThree = items.filter(i => i.rect[3] > 560);
 assert.equal(extract(onlyThree).blocks.length, 0);
 const numeric = items.map(i => ({...i, text: i.rect[0] > 125 && i.rect[3] < 700 && i.rect[3] > 340 ? '12.5 (3.2)' : i.text}));
 assert.equal(extract(numeric).blocks.length, 0);
});


test('a real six-column contrast-material survey is left to the multi-column table extractor', () => {
 const result = extractTwoColumnTables(sixColumn.items as SpanItem[], 10, sixColumn.pageHeight);
 assert.equal(result.blocks.length, 0);
 assert.equal(result.used.size, 0);
});
