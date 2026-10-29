import {test} from 'node:test';
import assert from 'node:assert/strict';
import wu from '../fixtures/layout/wu2026-p6.spans.json';
import {crossesLineGutter, buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';

const weak = (x: number) => ({x, top: Infinity});

test('a two-point vote shift cannot use slack to cut the same ordinary word gap', () => {
 // Actual Wu p6: glyph runs end/start at 231.108/232.988 pt, font10.
 // Before attaching χ² the global gutter voted225; afterwards it voted227.
 for (const x of [225, 226, 227, 228, 229]) {
  assert.equal(crossesLineGutter(231.108, 232.988, weak(x), 6, 10), false);
 }
});

test('a real compact table gap and a genuine overhang still permit column splitting', () => {
 assert.equal(crossesLineGutter(231.108, 232.988, weak(232), 6, 10), true,
  'the gutter physically lies between two runs; no artificial minimum gap');
 assert.equal(crossesLineGutter(231.108, 237, weak(227), 6, 10), true,
  'a real horizontal gap can support the original overhang allowance');
 assert.equal(crossesLineGutter(234, 240, weak(227), 6, 10), false,
  'overhang still cannot exceed the existing slack limit');
 assert.equal(crossesLineGutter(231.108, 232.988, {x: 227, top: 500}, 6, 10), true,
  'a gutter with a matching vertical channel retains its established behaviour');
});

test('weak-gutter word-gap protection is invariant under coordinate shifts and zoom', () => {
 for (const scale of [.5, 1.5, 2]) for (const offset of [-31, 19]) {
  assert.equal(crossesLineGutter(231.108 * scale + offset, 232.988 * scale + offset,
   weak(227 * scale + offset), 6 * scale, 10 * scale), false);
  assert.equal(crossesLineGutter(231.108 * scale + offset, 232.988 * scale + offset,
   weak(232 * scale + offset), 6 * scale, 10 * scale), true);
 }
});

test('correctly anchored statistics do not fragment a real paragraph at the inferred gutter', () => {
 const initial = buildBlocksFromSpans(wu.items as SpanItem[], {pageIndex: 0, pageWidth: wu.pageWidth,
  pageHeight: wu.pageHeight, includeReferences: false, imageRectsPdf: []}).blocks;
 const blocks = finalizePageRegions(structureTableCells(orderBlocksForReading(initial), 0, 10), wu.pageHeight);
 const paragraph = blocks.find(b => b.sourceText.startsWith('edly improved sensitivity'));
 assert.ok(paragraph);
 assert.ok(paragraph.sourceText.includes('95% CI: 52.9%-84.7%); 20/28] compared to EID-CT[17.9% (95% CI: 6.8%-37.6%);'), paragraph.sourceText);
 assert.ok(!blocks.some(b => b.sourceText === '52.9%-84.7%);' || b.sourceText === '6.8%-37.6%);'));
 // The statistical source improvements remain intact; do not undo anchoring
 // merely to recover the old block count.
 assert.ok(blocks.some(b => b.sourceText.startsWith('χ² McNemar')));
 assert.ok(blocks.some(b => b.sourceText === '0.031*'));
});
