import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {SourceBlock} from '../../src/types/models';
import type {BorderGrid} from '../../src/reader/tableBorders';
import {structureTableCells} from '../../src/reader/tableStructure';
import {coalesceRegions} from '../../src/reader/regionCoalescer';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {buildContinuityContexts, pageContinuityNeeds} from '../../src/translation/sourceContinuity';
import {validatePageIR} from '../../src/ir/documentIR';
import {bodyAnchorSizes} from '../../src/ui/strictPageReplacement';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';

const pageHeight=800;
type Rect=[number,number,number,number];
function block(id:string,text:string,x:number,y:number,width=190,size=9,lines=2):SourceBlock {
 const lineRectsPdf:Rect[]=Array.from({length:lines},(_,i)=>
  [x,pageHeight-y-i*size*1.2-size,x+width,pageHeight-y-i*size*1.2]);
 return {id,pageIndex:2,order:0,type:'paragraph',sourceText:text,fontSize:size,column:0,
  lineRectsPdf,boundingBox:{x,y,width,height:(lines-1)*size*1.2+size}};
}
function legend(id:string,text:string,x:number,y:number,width=190,size=9,lines=2):SourceBlock {
 const b=block(id,text,x,y,width,size,lines),rs=b.lineRectsPdf!;
 b.sourceRegion={id:`legend-owner-${id}`,kind:'legend-item',evidence:'marker-aligned-lines',
  boundsPdf:[Math.min(...rs.map(r=>r[0])),Math.min(...rs.map(r=>r[1])),
   Math.max(...rs.map(r=>r[2])),Math.max(...rs.map(r=>r[3]))]};
 return b;
}
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const entries=():SourceBlock[]=>[
 legend('entry-a','Baseline estimate: score = 0.43',80,100),
 legend('entry-b','Combined estimate: score = 0.68',80,128,190,9,3),
 legend('entry-c','Adjusted estimate: score = 0.79',80,167),
 legend('entry-d','Adjusted combined estimate: score = 0.92',80,195,190,9,3)
];
function assertOwnersUnchanged(before:SourceBlock[],after:SourceBlock[]):void {
 for(const source of before) {
  const current=after.find(b=>b.sourceRegion?.id===source.sourceRegion?.id);
  assert.ok(current,`independent entry is retained: ${source.id}`);
  assert.equal(current.sourceText,source.sourceText);
  assert.deepEqual(current.sourceRegion,source.sourceRegion);
  assert.deepEqual(current.lineRectsPdf,source.lineRectsPdf);
  assert.deepEqual(current.boundingBox,source.boundingBox);
  assert.equal(current.tableId,undefined);
  assert.equal(current.tableRow,undefined);
  assert.equal(current.tableRectPdf,undefined);
 }
}

test('a decorative figure grid cannot absorb independently owned legend entries',()=>{
 const source=entries();
 const frame:BorderGrid={columns:[30,60,320],rows:[70,120,160,200,250],
  region:{left:30,top:70,width:290,height:180}};
 const structured=structureTableCells(clone(source),2,9,[],frame,true,pageHeight);
 assert.equal(structured.length,source.length);
 assertOwnersUnchanged(source,structured);
});

test('genuine data cells keep their slots while a neighbouring legend keeps its full source extent',()=>{
 const grid:BorderGrid={columns:[40,170,330],rows:[100,125,150],
  region:{left:40,top:100,width:290,height:50}};
 const data=[block('group-a','Control',44,104,100,9,1),block('value-a','32 ± 4',174,104,70,9,1),
  block('group-b','Treatment',44,129,100,9,1),block('value-b','41 ± 6',174,129,70,9,1)];
 const key=legend('outside-key','Independent estimate and its uncertainty',44,146,270,9,2);
 const structured=structureTableCells([...clone(data),clone(key)],2,9,[],grid,true,pageHeight);
 const cells=structured.filter(b=>b.tableSource==='border');
 assert.equal(cells.length,4);
 assert.deepEqual(cells.map(b=>[b.tableRow,b.tableCol]),[[0,0],[0,1],[1,0],[1,1]]);
 assert.ok(cells.every(b=>!b.memberIds?.includes(key.id)));
 assertOwnersUnchanged([key],structured);
});

test('text-aligned neighbouring panels cannot reinterpret legend entries as inferred table rows',()=>{
 const left=entries(),right=entries().map((b,i)=>legend(`right-${i}`,b.sourceText,340,b.boundingBox!.y,190,9,b.lineRectsPdf!.length));
 const source=[...left,...right];
 const structured=structureTableCells(clone(source),2,9,[],undefined,true,pageHeight);
 assertOwnersUnchanged(source,structured);
 assert.equal(structured.length,8);
});

test('legend owners survive JSON, region coalescing, reading order and final page ownership',()=>{
 const source=entries();
 const roundTrip=clone(source);
 const coalesced=coalesceRegions(roundTrip);
 assert.equal(coalesced.length,4,'adjacent unfinished legend phrases remain four semantic items');
 const result=finalizePageRegions(orderBlocksForReading(coalesced),pageHeight);
 assertOwnersUnchanged(source,result);
 assert.deepEqual(validatePageIR({pageIndex:2,blocks:result}),[]);
 assert.equal(JSON.stringify(source),JSON.stringify(entries()),'source inputs stay immutable');
});

test('independent legend font sizes do not determine the body font anchor',()=>{
 const body=[block('body-a','A complete independent body paragraph.',50,500,250,10),
  block('body-b','The next body paragraph continues the argument.',50,535,250,10)];
 assert.deepEqual(bodyAnchorSizes([...entries(),...body]),[10,10]);
});

test('unfinished legend text never requests or supplies neighbouring-page sentence context',()=>{
 const a=legend('key-a','An estimate obtained before',80,100),
  b=legend('key-b','and/or another adjustment was applied.',80,128);
 assert.deepEqual(pageContinuityNeeds([a,b]),{previous:false,next:false});
 assert.equal(buildContinuityContexts([a,b]).size,0);
 const later={...clone(b),pageIndex:3};
 assert.equal(buildContinuityContexts([a],{next:[later]}).size,0);
 assert.equal(buildContinuityContexts([later],{previous:[a]}).size,0);
});

test('legend ownership leaves adjacent body reconstruction and negation continuity intact',()=>{
 const keys=entries();
 const a=block('body-a','All examinations were completed without complications (i.e. no failed',50,500,250,10,1),
  b=block('body-b','acquisitions or intolerance).',50,512,250,10,1);
 const context=buildContinuityContexts([a,b,...keys]);
 assert.deepEqual(context.get(a.id),{before:'',after:b.sourceText});
 assert.deepEqual(context.get(b.id),{before:a.sourceText,after:''});
 assert.ok(keys.every(k=>!context.has(k.id)));
 const finalized=finalizePageRegions(orderBlocksForReading([...keys,a,b]),pageHeight);
 const prose=finalized.filter(b=>b.sourceRegion?.kind==='body-column');
 assert.equal(prose.length,1);
 assert.equal(prose[0]!.sourceText,a.sourceText+' '+b.sourceText);
 assertOwnersUnchanged(keys,finalized);
});

test('IR still rejects a legend owner whose source line escapes its assigned rectangle',()=>{
 const key=legend('bad-owner','An independently anchored estimate',80,100);
 key.sourceRegion!.boundsPdf[0]+=10;
 const ordered=orderBlocksForReading([key]);
 assert.ok(validatePageIR({pageIndex:2,blocks:ordered}).some(v=>v.invariant==='region-boundary'));
});

test('IR rejects a legend whose marker-owned role was overwritten by a table cell',()=>{
 for(const changed of [{tableId:'other-table'},{tableRow:0,tableCol:0},{type:'caption' as const}]) {
  const key={...legend('changed-role','A marker-owned independent estimate',80,100),...changed};
  const violations=validatePageIR({pageIndex:2,blocks:orderBlocksForReading([key])});
  assert.ok(violations.some(v=>v.invariant==='region-role'),JSON.stringify(changed));
 }
});

test('IR rejects a legend owner that no longer carries explicit marker alignment evidence',()=>{
 const key=legend('missing-evidence','A marker-owned independent estimate',80,100);
 key.sourceRegion!.evidence='column-geometry';
 const violations=validatePageIR({pageIndex:2,blocks:orderBlocksForReading([key])});
 assert.ok(violations.some(v=>v.invariant==='region-role'));
});

test('real paired legends leave the complete five-metric body units in canonical column order',()=>{
 const fixture=JSON.parse(readFileSync('tests/fixtures/regression/kitagawa-legend-p8.spans.json','utf8')) as {
  pageIndex:number;pageWidth:number;pageHeight:number;items:SpanItem[];segments:Rect[]
 };
 const raw=buildBlocksFromSpans(fixture.items,{pageIndex:fixture.pageIndex,pageWidth:fixture.pageWidth,
  pageHeight:fixture.pageHeight,legendSegmentsPdf:fixture.segments,imageRectsPdf:[]});
 const blocks=finalizePageRegions(structureTableCells(orderBlocksForReading(raw.blocks),fixture.pageIndex,9),fixture.pageHeight);
 assert.equal(blocks.filter(b=>b.sourceRegion?.kind==='legend-item').length,8);
 const left=blocks.find(b=>b.sourceText.includes('The sensitivity, specificity,'));
 assert.ok(left);
 for(const text of ['positive and negative predictive values, and accuracy','93%','36%','58%','85%','64%'])
  assert.ok(left.sourceText.includes(text),`five-metric source unit must retain ${text}`);
 const right=blocks.find(b=>b.sourceText.startsWith('(95% CI: 61%-82%)'));
 assert.ok(right);
 for(const text of ['Continuous net reclassification improvement','integrated discrimination improvement','0.039','0.192'])
  assert.ok(right.sourceText.includes(text),`right source unit must retain ${text}`);
 assert.equal(left.column,0);
 assert.equal(right.column,1);
 assert.ok(blocks.indexOf(left)<blocks.indexOf(right));
 assert.deepEqual(validatePageIR({pageIndex:fixture.pageIndex,blocks}),[]);
});
