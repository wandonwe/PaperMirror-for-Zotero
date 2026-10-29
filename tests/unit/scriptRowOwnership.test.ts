import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/gori-reconstruction-p6.spans.json';
import {buildBlocksFromSpans,groupIntoRows,type SpanItem} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {validatePageIR} from '../../src/ir/documentIR';

const sourceItems:SpanItem[]=fixture.items.map(({rect,...item})=>{
 assert.equal(rect.length,4);
 return {...item,rect:[rect[0]!,rect[1]!,rect[2]!,rect[3]!]};
});
const compact=(text:string)=>text.replace(/\s+/g,'');
const inventory=(text:string)=>[...text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'')].sort().join('');
function assertSpanOwnership(items:SpanItem[]):void {
 const rows=groupIntoRows(items),actual=rows.flat();
 assert.equal(actual.length,items.length,'every source object is assigned once');
 assert.equal(new Set(actual).size,items.length,'a script must not be duplicated in two rows');
 for(const item of items)assert.ok(actual.includes(item),'original span identities remain intact');
}
function pipeline(items:SpanItem[],pageIndex:number,pageWidth:number,pageHeight:number) {
 const built=buildBlocksFromSpans(items,{pageIndex,pageWidth,pageHeight,includeReferences:true,imageRectsPdf:[]});
 const blocks=finalizePageRegions(structureTableCells(orderBlocksForReading(built.blocks),pageIndex,9),pageHeight);
 assert.deepEqual(validatePageIR({pageIndex,blocks}),[]);
 assert.ok(blocks.every(block=>block.pageIndex===pageIndex));
 // The established block builder omits this one isolated printed page
 // number. Keep that explicit furniture exception separate from body scripts.
 const pageNumbers=items.filter(item=>/^\d{1,4}$/.test(item.text.trim()) && item.rect[1]>pageHeight*.9);
 assert.equal(pageNumbers.length,1);assert.equal(pageNumbers[0]!.text,String(fixture.page));
 const content=items.filter(item=>!pageNumbers.includes(item));
 assert.equal(inventory(blocks.map(block=>block.sourceText).join('')),inventory(content.map(item=>item.text).join('')),
  'the complete body/source inventory remains unchanged under script-equivalent normalization');
 return blocks;
}
function assertMethods(blocks:ReturnType<typeof pipeline>, values={coronary:'1024',thoracic:'768',mediastinal:'512',vessel:'coronary',middle:'mediastinal'}):void {
 const reconstruction=blocks.find(block=>block.sourceText.includes('data are reconstructed with 0.2-mm slices'))?.sourceText??'';
 assert.ok(compact(reconstruction).includes(compact(`0.1-mm intervals on a ${values.coronary}² matrix (Bv60 kernel)`)),reconstruction);
 assert.ok(compact(reconstruction).includes(compact(`0.2-mm spacing on a ${values.thoracic}² matrix`)),reconstruction);
 assert.ok(!/0\.1-mm2\s*intervals/.test(reconstruction),'the exponent cannot move to the preceding line');
 const methods=blocks.find(block=>block.sourceText.includes(`On ${values.vessel} images`))?.sourceText??'';
 const expected=`On ${values.vessel} images (0.2 × 0.1 mm, Bv60, ${values.coronary}²) and ${values.middle} images (1.00 × 0.7 mm, Bv60, ${values.mediastinal}²), circular ROIs of ∼0.4 cm² (≥100 pixels) were placed.`;
 assert.ok(compact(methods).includes(compact(expected)),methods);
 const all=blocks.map(block=>block.sourceText).join(' ');
 for(const value of [values.coronary,values.thoracic,values.mediastinal])
  assert.ok(!new RegExp(`\\b${value}2\\b`).test(all),`raised square must not become ${value}2`);
}

test('real reconstruction page keeps source matrix powers and ROI ownership through the complete pipeline',()=>{
 assertSpanOwnership(sourceItems);
 const originalTexts=sourceItems.map(item=>item.text);
 assertMethods(pipeline(sourceItems,5,fixture.pageWidth,fixture.pageHeight));
 assert.deepEqual(sourceItems.map(item=>item.text),originalTexts,'semantic materialisation never rewrites glyph objects');
});

test('reconstruction script ownership survives different values, terms, scale, offsets, page and input order',()=>{
 for(const change of [
  {scale:.7,dx:19,dy:27,page:31,reverse:true},
  {scale:1.4,dx:63,dy:42,page:47,reverse:false}
 ]) {
  const items=sourceItems.map(item=>({...item,
   text:item.text.replace(/1024/g,'2048').replace(/768/g,'384').replace(/512/g,'256')
    .replace(/Coronary/g,'Vascular').replace(/coronary/g,'vascular').replace(/mediastinal/g,'thoracic'),
   fontSize:item.fontSize!*change.scale,
   rect:item.rect.map((value,axis)=>value*change.scale+(axis%2===0?change.dx:change.dy)) as SpanItem['rect']
  }));
  if(change.reverse)items.reverse();
  assertSpanOwnership(items);
  assertMethods(pipeline(items,change.page,fixture.pageWidth*change.scale+change.dx*2,fixture.pageHeight*change.scale+change.dy*2),
   {coronary:'2048',thoracic:'384',mediastinal:'256',vessel:'vascular',middle:'thoracic'});
 }
});

const run=(text:string,x:number,y:number,width:number,fontSize:number):SpanItem=>({text,rect:[x,y,x+width,y+fontSize],fontSize});
test('a nested script chain resolves to its larger root and retains every original glyph',()=>{
 const base=run('x',20,200,12,12),sub=run('i',32,197,5,7),power=run('2',37,199,3,4),next=run('next normal baseline',20,182,130,12);
 for(const input of [[power,next,base,sub],[sub,base,next,power]]) {
  assertSpanOwnership(input);
  const rows=groupIntoRows(input),own=rows.find(row=>row.includes(base))!;
  assert.ok(own.includes(sub)&&own.includes(power));
  assert.deepEqual(rows.find(row=>row.includes(next)),[next]);
 }
});

test('the real CT subscript stays with FFR instead of moving into the following source clause',()=>{
 const base:SpanItem={text:'coronary CT angiography, FFR',rect:[53.9,692.7,155.4,701.2],fontSize:8.5};
 const sub:SpanItem={text:'CT ',rect:[155.4,690.8,164.3,695.7],fontSize:5};
 const tail:SpanItem={text:'= CT-derived fractional flow reserve,',rect:[164.3,692.7,281.9,701.2],fontSize:8.5};
 const next:SpanItem={text:'HR = hazard ratio, MACE = major adverse',rect:[53.9,683.2,281.9,691.7],fontSize:8.5};
 const items=[tail,next,sub,base];assertSpanOwnership(items);
 const rows=groupIntoRows(items),own=rows.find(row=>row.includes(base))!;
 assert.deepEqual(own.map(item=>item.text),[base.text,sub.text,tail.text]);
 assert.deepEqual(rows.find(row=>row.includes(next)),[next]);
});

test('a smaller-font prose sentence is not deferred as a script of a nearby heading',()=>{
 const heading=run('Larger heading',20,240,140,16);
 const first=run('A normal smaller-font sentence is still prose.',20,217,210,9);
 const second=run('Its next baseline remains a separate source row.',20,205,210,9);
 const items=[second,heading,first];assertSpanOwnership(items);
 const rows=groupIntoRows(items);
 assert.equal(rows.length,3);
 assert.deepEqual(rows.find(row=>row.includes(heading)),[heading]);
 assert.deepEqual(rows.find(row=>row.includes(first)),[first]);
 assert.deepEqual(rows.find(row=>row.includes(second)),[second]);
});
