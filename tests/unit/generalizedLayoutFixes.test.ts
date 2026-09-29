import test from 'node:test';
import assert from 'node:assert/strict';
import {extractAbbreviationTables} from '../../src/reader/abbreviationTable';
import {isFaintPageBackground} from '../../src/reader/imageObstacles';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {finalizePageRegions} from '../../src/reader/pageRegions';

test('unrelated glossary vocabulary preserves row ownership after scaling and moving pages',()=>{
 for(const scale of [.75,1,1.5])for(const pageIndex of [0,6,24]){
  const item=(text:string,x:number,y:number,w:number,fontSize=10):SpanItem=>({text,fontSize:fontSize*scale,rect:[(x+80)*scale,(y+30)*scale,(x+80+w)*scale,(y+30+fontSize)*scale]});
  const keys=['API','CPU','GPU','RAM','SSD','USB'],defs=['application interface','central processor','graphics processor','random access memory','solid state storage','serial connection'];
  const items=[item('Abbreviations and Acronyms',30,600,300,13),...keys.flatMap((k,i)=>[item(k,30,575-i*30,35),item(defs[i]!,110,575-i*30,170)]),item('Neighbouring prose stays separate.',360,560,200)];
  const {cells,rest}=extractAbbreviationTables(items,pageIndex,800*scale,900*scale);
  assert.deepEqual(cells.filter(c=>c.tableCol===0).map(c=>c.sourceText),keys);
  assert.deepEqual(cells.filter(c=>c.tableCol===1).map(c=>c.sourceText),defs);
  assert.equal(rest.length,1);assert.match(rest[0]!.text,/Neighbouring/);
 }
});
test('synthetic grayscale background is classified by pixels rather than image identity',()=>{
 const pixels=Array.from({length:3000},(_,i)=>i<300?210:255);
 for(const rect of [[20,200,320,350],[100,400,700,700]] as [number,number,number,number][]){
  assert.equal(isFaintPageBackground(pixels,3,rect,true,true),true);
  assert.equal(isFaintPageBackground(pixels,3,rect,false,true),false);
  assert.equal(isFaintPageBackground(pixels,3,rect,true,false),false);
 }
});
test('unrelated bottom continuation excludes publication dates on different pages and sizes',()=>{
 for(const scale of [.8,1,1.5])for(const pageIndex of [1,8,33]){
  const item=(text:string,x:number,y:number,w:number,size:number):SpanItem=>({text,fontSize:size*scale,rect:[x*scale,y*scale,(x+w)*scale,(y+size)*scale]});
  const blocks=finalizePageRegions(buildBlocksFromSpans([
   item('The instrument measured a higher signal',300,59,230,10),
   item('under the following experimental conditions',300,47,230,10),
   item('September 29, 2026',450,22,80,8)
  ],{pageIndex,pageWidth:600*scale,pageHeight:800*scale,includeReferences:true}).blocks,800*scale);
  const body=blocks.filter(b=>b.sourceText.includes('instrument')||b.sourceText.includes('experimental'));
  assert.ok(body.length);assert.ok(body.every(b=>b.translationMode!=='preserve'&&!b.sourceText.includes('2026')));
  assert.equal(blocks.find(b=>b.sourceText==='September 29, 2026')?.translationMode,'preserve');
 }
});
