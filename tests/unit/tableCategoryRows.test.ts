import {test} from 'node:test';
import assert from 'node:assert/strict';
import f from '../fixtures/regression/otosclerosis-table1-rows.json';
import {structureTableCells} from '../../src/reader/tableStructure';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import type {SourceBlock} from '../../src/types/models';
test('empty value cells do not join demographic category headings to preceding records',()=>{
 const out=structureTableCells(f.blocks as SourceBlock[],1,8.5,[],[],true,790.866);
 for(const name of ['Gender','Disease laterality','Surgical procedure','Age, Mean (range)','- Male','- Left side'])assert.equal(out.filter(b=>b.sourceText===name).length,1,name);
 const note=out.find(b=>b.sourceText==='Values are presented as number (percentage)');assert.ok(note);assert.ok(!note.tableId);
 const age=out.find(b=>b.sourceText==='Age, Mean (range)')!,value=out.find(b=>b.sourceText==='55.6 (23–76)')!;assert.equal(age.tableRow,value.tableRow);
});
test('a table caption after unfinished prose stays separate before translation',()=>{
 const xs=[{text:'The procedure has fewer complications and',rect:[50,500,290,510] as [number,number,number,number],fontSize:10},{text:'Table 7 Demographic and operative characteristics',rect:[50,486,290,494.5] as [number,number,number,number],fontSize:8.5}];
 const blocks=buildBlocksFromSpans(xs,{pageIndex:5,pageWidth:600,pageHeight:800,includeReferences:true}).blocks;
 assert.ok(blocks.some(b=>b.sourceText==='Table 7 Demographic and operative characteristics'));
 assert.ok(!blocks.some(b=>b.sourceText.includes('complications and Table')));
});
test('numeric table rows stay paired after translation-independent coordinate changes', () => {
 for (const scale of [0.8, 1, 1.5]) {
  const blocks = (f.blocks as SourceBlock[]).map((b,i) => ({...b,id:`sample-${i}`,boundingBox:{x:b.boundingBox!.x*scale,y:b.boundingBox!.y*scale,width:b.boundingBox!.width*scale,height:b.boundingBox!.height*scale},lineRectsPdf:b.lineRectsPdf?.map(r=>r.map(v=>v*scale) as [number,number,number,number]),fontSize:8.5*scale}));
  const out=structureTableCells(blocks,1,8.5*scale,[],[],true,790.866*scale);
  for(const value of blocks.filter(b=>b.boundingBox!.x>450*scale)) {
   const label=blocks.find(b=>b.boundingBox!.x<450*scale && Math.abs(b.boundingBox!.y-value.boundingBox.y)<scale);
   assert.ok(label);
   const cell=out.find(b=>b.sourceText===label.sourceText && Math.abs(b.boundingBox!.y-label.boundingBox.y)<scale);
   const numeric=out.find(b=>b.sourceText===value.sourceText && Math.abs(b.boundingBox!.y-value.boundingBox.y)<scale);
   assert.ok(cell,label.sourceText);assert.ok(numeric,value.sourceText);
   assert.equal(cell.tableRow,numeric.tableRow,label.sourceText);
  }
 }
});
