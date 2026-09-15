import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {coalesceRegions} from '../../src/reader/regionCoalescer';
import {sourceFlowRegions} from '../../src/ui/layoutSafety';
function page(n:number) {
 const f=JSON.parse(readFileSync(`tests/fixtures/regression/bae2010-p${n}.json`,'utf8'));
 const blocks=buildBlocksFromSpans(f.items,{pageIndex:n-1,pageWidth:f.pageWidth,pageHeight:f.pageHeight,includeReferences:true}).blocks;
 return [...coalesceRegions(orderBlocksForReading(blocks.filter(b=>b.translationMode===undefined))),...blocks.filter(b=>b.translationMode!==undefined)];
}
test('Bae printed p40: full-width Figure 7 caption stays out of three body columns',()=>{
 const blocks=page(9),caption=blocks.find(b=>b.sourceText.startsWith('Figure 7:'))!;
 assert.ok(caption);
 assert.ok(caption.sourceText.includes('baseline cardiac output'));
 assert.ok(caption.sourceText.endsWith('hepatic parenchymal enhancement.'));
 assert.ok(caption.boundingBox!.height<45);
 for(const start of ['of peak hepatic','quate enhancement','available physiologic']) {
  const b=blocks.find(b=>b.sourceText.startsWith(start))!;
  assert.ok(b,start);assert.ok(b.boundingBox!.width<159,start);
  assert.ok(!b.sourceText.includes('radiology.rsna.org'));
 }
});
test('Bae printed p50: all three source columns keep their 12pt gutters',()=>{
 const blocks=page(19);
 const columns=['clinical images','first is beneficial','ment timing'].map(start=>blocks.find(b=>b.sourceText.startsWith(start))!);
 columns.forEach(b=>{assert.ok(b);assert.ok(b.boundingBox!.width<159);assert.ok(!b.sourceText.includes('radiology.rsna.org'));});
 for(let i=1;i<columns.length;i++)assert.ok(columns[i]!.boundingBox!.x-(columns[i-1]!.boundingBox!.x+columns[i-1]!.boundingBox!.width)>11);
});
test('retained old page state: an outdented footer cannot widen the body flow region',()=>{
 const f=JSON.parse(readFileSync('tests/fixtures/regression/bae2010-old-right-column.json','utf8'));
 const regions=sourceFlowRegions(f.map((r:number[])=>({left:r[0]!,top:783-r[3]!,width:r[2]!-r[0]!,height:r[3]!-r[1]!})),9);
 assert.ok(regions.length>=2);
 assert.ok(regions[0]!.left>=423.9);
 assert.ok(regions[0]!.width<159);
});
