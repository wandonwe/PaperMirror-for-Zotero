import {test} from 'node:test';
import assert from 'node:assert/strict';
import f from '../fixtures/regression/gulati2021-e378.spans.json';
import {buildBlocksFromSpans,groupIntoLines, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {extractDescriptiveTables} from '../../src/reader/descriptiveTable';
const items=f.items as SpanItem[];
const extract=(xs:SpanItem[])=>extractDescriptiveTables(groupIntoLines(xs,f.pageWidth,f.pageHeight),10,f.pageHeight);
test('real e378 table 3 keeps its title, seven labels and thirteen descriptions separate',()=>{
 const result=extract(items);
 assert.equal(result.blocks.length,21);
 const labels=['Nature','Onset and duration','Location and radiation','Severity','Precipitating factors','Relieving factors','Associated symptoms'];
 for(const name of labels)assert.equal(result.blocks.filter(b=>b.sourceText===name).length,1);
 assert.ok(result.blocks[0]!.sourceText.startsWith('Table 3.'));
 assert.ok(!result.blocks.some(b=>b.sourceText.includes('ACS indicates')));
 assert.equal(result.blocks.reduce((n,b)=>n+b.lineRectsPdf!.length,0),39);
 for(let i=1;i<result.blocks.length;i++)assert.ok(result.blocks[i-1]!.tableContentRectPdf![1]>=result.blocks[i]!.tableContentRectPdf![3]);
 const built=buildBlocksFromSpans(items,{pageIndex:10,pageWidth:f.pageWidth,pageHeight:f.pageHeight,includeReferences:true}).blocks;
 assert.equal(built.filter(b=>b.tableId?.includes('descriptive')).length,21);
 assert.ok(!built.some(b=>b.sourceText.includes('Table 3.') && b.sourceText.includes('Associated symptoms')));
 // Every claimed source span is consumed exactly once; unrelated column remains.
 const normalize=(s:string)=>s.replace(/[-\s]/g,'');
 assert.equal(normalize(result.blocks.map(b=>b.sourceText).join('')),normalize([...result.used].map(i=>i.text).join('')));
 assert.ok(built.some(b=>b.sourceText.includes('Synopsis')));
});
test('without a table caption repeated category prose is not promoted to a table',()=>{
 assert.equal(extract(items.filter(i=>!/^Table 3/.test(i.text))).blocks.length,0);
});
test('short numeric rows and a single label are insufficient evidence',()=>{
 const lines=groupIntoLines(items,f.pageWidth,f.pageHeight);
 const first=lines.find(l=>l.items.some(i=>/^Table 3/.test(i.text)))!;
 const short=lines.filter(l=>l.rect[3]<=first.rect[3] && l.rect[1]>430 && l.rect[0]<285);
 assert.equal(extractDescriptiveTables(short,10,f.pageHeight).blocks.length,0);
});

test('descriptive table rules survive renamed content, page index, translation and scale',()=>{
 for(const scale of [0.8,1.25]) {
  const xs=items.map(i=>({...i,text:i.text.replace('Table 3.','Table 27.').replace('Nature','Pattern').replace('Severity','Intensity'),fontSize:(i.fontSize ?? 9)*scale,rect:i.rect.map((v,n)=>v*scale+(n%2===0?17:23)) as SpanItem['rect']}));
  const result=extractDescriptiveTables(groupIntoLines(xs,f.pageWidth*scale+34,f.pageHeight*scale+46),42,f.pageHeight*scale+46);
  assert.equal(result.blocks.length,21);
  assert.ok(result.blocks.every(b=>b.pageIndex===42));
  assert.ok(result.blocks.some(b=>b.sourceText==='Pattern'));
  assert.ok(result.blocks.some(b=>b.sourceText==='Intensity'));
 }
});
