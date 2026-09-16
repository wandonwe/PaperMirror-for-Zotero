import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { borderGrids } from '../../src/reader/tableBorders';
import { structureTableCells } from '../../src/reader/tableStructure';
import { auditTableOwnership } from '../../src/reader/tableOwnership';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';
for(const [page,first,second] of [
 [20,'Health care institutions','vendors should support'],
 [35,'BP should be maintained','at least the first 24 hours'],
 [46,'In eligible patients with AIS within 6 hours','last known normal, IV streptokinase']
] as const) test(`stroke p${page}: adjacent recommendation lines cannot merge through another column`,()=>{
 const f=JSON.parse(readFileSync(`tests/fixtures/regression/stroke2026-p${page}.json`,'utf8'));
 const grids=borderGrids(f.segments,{pageHeight:f.pageHeight});
 assert.ok(grids.length>0);
 const source=buildBlocksFromSpans(f.items as SpanItem[],{pageIndex:page-1,pageWidth:f.pageWidth,pageHeight:f.pageHeight,grids,includeReferences:true}).blocks;
 const cells=structureTableCells(source,page-1,10,[],grids,true,f.pageHeight);
 const cell=cells.find(c=>c.sourceText.includes(first)&&c.sourceText.includes(second));
 assert.ok(cell,first+' / '+second);
 assert.equal(cell.tableSource,'border');
 assert.ok(cell.sourceText.indexOf(first)<cell.sourceText.indexOf(second),cell.sourceText);
 assert.deepEqual(auditTableOwnership(source,cells),[]);
});

test('side-by-side recommendation tables are independent border components',()=>{
 for(const [page,count] of [[20,1],[35,2],[37,2],[46,1]]) {
  const f=JSON.parse(readFileSync(`tests/fixtures/regression/stroke2026-p${page}.json`,'utf8'));
  const grids=borderGrids(f.segments,{pageHeight:f.pageHeight});
  assert.equal(grids.length,count);
  for(const g of grids) {assert.equal(g.columns.length-1,3);assert.ok(g.region.width<250);}
  if(count===2) assert.ok(Math.abs(grids[0]!.region.left-grids[1]!.region.left)>250);
 }
});
