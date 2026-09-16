import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildBlocksFromSpans,groupIntoRows} from '../../src/reader/spanBlockBuilder';
import {captionOwnership} from '../../src/reader/captionOwnership';
import {coalesceRegions,canMergeCaption} from '../../src/reader/regionCoalescer';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {validatePageIR} from '../../src/ir/documentIR';
import type {SourceBlock} from '../../src/types/models';

test('Bae p4: own the entire Figure 3 caption before gutter splitting and body merging',()=>{
 const f=JSON.parse(readFileSync('tests/fixtures/regression/bae2010-p4.json','utf8'));
 const owned=captionOwnership(groupIntoRows(f.items),3,f.pageWidth);
 assert.equal(owned.length,1);
 const spans=owned.flatMap(o=>o.rows.flat());assert.equal(new Set(spans).size,spans.length);
 const blocks=buildBlocksFromSpans(f.items,{pageIndex:3,pageWidth:f.pageWidth,pageHeight:f.pageHeight,includeReferences:true}).blocks;
 const final=orderBlocksForReading([...coalesceRegions(orderBlocksForReading(blocks.filter(b=>b.translationMode===undefined))),...blocks.filter(b=>b.translationMode!==undefined)]);
 const caption=final.find(b=>b.sourceRegion)!;
 assert.ok(caption.sourceText.startsWith('Figure 3:'));
 assert.ok(caption.sourceText.includes('cardiovascular system, particularly the slow peripheral venous blood flow.'));
 assert.ok(caption.sourceText.endsWith('injection duration plus contrast material arrival time.'));
 assert.ok(!caption.sourceText.includes('more distal from the injection site'));
 assert.equal(caption.lineRectsPdf!.length,10);
 for(const prefix of ['more distal','transit time','rise followed']) {
  const b=final.find(b=>b.sourceText.startsWith(prefix))!;assert.ok(b,prefix);assert.ok(b.boundingBox!.width<159,prefix);
 }
 assert.deepEqual(validatePageIR({pageIndex:3,blocks:final}),[]);
 const outside:SourceBlock={...caption,id:'outside',sourceRegion:undefined,type:'paragraph',sourceText:'a misleading continuation',lineRectsPdf:[[141,280,300,286]]};
 assert.equal(canMergeCaption(caption,outside),false);
 const poisoned={...caption,lineRectsPdf:[...caption.lineRectsPdf!,[84,200,242,209] as [number,number,number,number]]};
 assert.ok(validatePageIR({pageIndex:3,blocks:[{...poisoned,readingIndex:0}]}).some(v=>v.invariant==='region-boundary'));
});

test('caption detector leaves an adjacent prose column unclaimed',()=>{
 const rows=Array.from({length:4},(_,i)=>[
  {text:i?'caption continuation':'Figure 1: caption',rect:[50,700-i*11,250,709-i*11] as [number,number,number,number],fontSize:9},
  {text:'other column',rect:[270,700-i*11,500,709-i*11] as [number,number,number,number],fontSize:9}
 ]);
 assert.equal(captionOwnership(rows,0,612).length,0);
});
