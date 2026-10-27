import {test} from 'node:test';
import assert from 'node:assert/strict';
import f from '../fixtures/regression/gori-acquisition-p4.spans.json';
import edges from '../fixtures/regression/gori-acquisition-p4.edges.json';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {borderGrids, type Segment, type BorderGrid} from '../../src/reader/tableBorders';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {validatePageIR} from '../../src/ir/documentIR';

const pairs = [
 ['Scanner', 'Dual-source photon-counting CT'], ['Patient positioning', 'Supine with arms'],
 ['Acquisition phases', 'Non-contrast CAC'], ['Additional acquisition', 'Low-dose expiratory scan'],
 ['Contrast protocol', 'Three-phase IV injection'], ['Iodine dose', '33.6'],
 ['Scan parameters', 'Tube potential'], ['Image reconstruction', 'Coronaries'],
 ['Spectral post-processing', 'VMI at 40 keV'], ['Reconstruction software', 'ReconCT']
] as const;
const grids = borderGrids(edges.segments as Segment[], {pageHeight: f.pageHeight});
// Match the reported coarse-grid failure too: ownership must survive an outer
// frame that carries no useful internal cell boundaries.
const outerFrame: BorderGrid = {columns:[37,128,400,553], rows:[59,80,100,200,300,420,486],
 region:{left:37,top:59,width:516,height:427}};
const inventory = (text: string) => [...text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'')].sort().join('');

test('real acquisition table keeps all ten label/value pairs through the complete extraction pipeline', () => {
 for (const grid of [[],grids,[outerFrame]]) {
  const initial = buildBlocksFromSpans(f.items as SpanItem[], {pageIndex:3,pageWidth:f.pageWidth,
   pageHeight:f.pageHeight,includeReferences:true,grids:grid}).blocks;
  const final = finalizePageRegions(structureTableCells(orderBlocksForReading(initial),3,8,[],grid,true,f.pageHeight),f.pageHeight);
  assert.deepEqual(validatePageIR({pageIndex:3,blocks:final}),[]);
  const table = final.filter(b=>b.tableId && b.sourceText !== 'Table 1 Acquisition protocol');
  assert.equal(table.length,22,'two headers and twenty body cells');
  for (const [label,prefix] of pairs) {
   const key=table.find(b=>b.sourceText === label);
   assert.ok(key, label);
   const value=table.find(b=>b.tableId===key.tableId && b.tableRow===key.tableRow && b.tableCol===1);
   assert.ok(value);
   assert.ok(value.sourceText.includes(prefix), `${label} must keep its own value`);
   assert.equal(key.tableCol,0);
   assert.ok(key.tableContentRectPdf![2] <= value.tableContentRectPdf![0]);
  }
  assert.equal(table.filter(b=>b.sourceText==='Section' || b.sourceText==='Details').length,2);
  assert.ok(final.some(b=>!b.tableId && b.sourceText.startsWith('BP, blood pressure')),'footnote remains separate');
  assert.ok(!table.some(b=>/^(?:\.\s*)+$/.test(b.sourceText)),'dot rule is decoration');
  assert.equal(inventory(final.map(b=>b.sourceText).join('')), inventory(f.items.filter(i=>!(i.text==='4' && (i.rect[3]!<f.pageHeight*.1 || i.rect[1]!>f.pageHeight*.9))).map(i=>i.text).join('')),
   'all content except the existing page-number filter is conserved exactly once');
 }
});
