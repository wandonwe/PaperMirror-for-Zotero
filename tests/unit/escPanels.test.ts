import {test} from 'node:test';import assert from 'node:assert/strict';
import f from '../fixtures/regression/esc2024-p8-panels.json';
import {buildBlocksFromSpans,type SpanItem} from '../../src/reader/spanBlockBuilder';
import {borderGrids,type Segment} from '../../src/reader/tableBorders';
import {structureTableCells} from '../../src/reader/tableStructure';
import {coalesceRegions} from '../../src/reader/regionCoalescer';
const grids=borderGrids(f.segments as Segment[],{pageHeight:f.pageHeight});
const build=()=>buildBlocksFromSpans(f.items as SpanItem[],{pageIndex:7,pageWidth:f.pageWidth,pageHeight:f.pageHeight,grids,includeReferences:true}).blocks;
test('ESC headerless glossary preserves eight exact acronym-definition pairs',()=>{
 const cells=build().filter(b=>b.tableId==='page-7-continuation');assert.equal(cells.length,16);
 const expected=['TWILIGHT','vFFR','VKA','VSA','VTE','WARRIOR','WOMEN','X-ECG'];
 expected.forEach((key,row)=>assert.equal(cells.find(b=>b.tableRow===row && b.tableCol===0)!.sourceText,key));
 assert.match(cells.find(b=>b.tableRow===5 && b.tableCol===1)!.sourceText,/Women’s IschemiA Trial.*Disease$/);
 assert.equal(cells.find(b=>b.tableRow===7 && b.tableCol===1)!.sourceText,'Exercise ECG testing');
});
test('ESC coarse panel frame cannot weld different recommendation columns',()=>{
 const before=build();const after=coalesceRegions(structureTableCells(before,7,9,[],grids,true,f.pageHeight));
 const cells=after.filter(b=>b.tableId?.includes('gridparts'));assert.equal(cells.length,16);
 for(const key of ['Class I','Class II','Class IIa','Class IIb','Class III','Definition','Wording to use','Is not recommended'])assert.equal(cells.filter(b=>b.sourceText===key).length,1);
 assert.ok(!cells.some(b=>b.sourceText.includes('Class I') && b.sourceText.includes('Evidence')));
 const chars=(s:string)=>[...s.replace(/\s/g,'')].sort().join('');
 assert.equal(chars(after.map(b=>b.sourceText).join('')),chars(before.map(b=>b.sourceText).join('')));
});

test('ESC production span geometry retains cell identities before table reconstruction',()=>{
 const blocks=build();
 for(const text of ['Class I','Class IIa','Class IIb','Class III','Should be considered','May be considered','Is recommended or is indicated']) {
  assert.equal(blocks.filter(b=>b.sourceText===text).length,1,text);
 }
});

test('same-row large text stays separate after changing page, words and geometry',()=>{
 for(const scale of [0.8,1.25]) {
  const items=(f.items as SpanItem[]).map(i=>({...i,text:i.text.replace(/Class/g,'Level').replace('Should be considered','Consider this option').replace('May be considered','Optional treatment'),fontSize:(i.fontSize ?? 9)*scale,rect:i.rect.map((v,n)=>v*scale+(n%2===0?17:23)) as SpanItem['rect']}));
  const blocks=buildBlocksFromSpans(items,{pageIndex:42,pageWidth:f.pageWidth*scale+34,pageHeight:f.pageHeight*scale+46,includeReferences:true}).blocks;
  for(const text of ['Level I','Level IIa','Level IIb','Consider this option','Optional treatment'])assert.equal(blocks.filter(b=>b.sourceText===text).length,1,text);
 }
});
