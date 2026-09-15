import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBlocksFromSpans } from '../../src/reader/spanBlockBuilder';
import { borderGrids } from '../../src/reader/tableBorders';
import { structureTableCells } from '../../src/reader/tableStructure';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
const fixture=(name:string)=>JSON.parse(readFileSync(`tests/fixtures/regression/${name}.json`,'utf8'));

test('real Figure 3 caption survives image filtering as one complete block',()=>{
 const f=fixture('simohamed2021-p4');
 const blocks=buildBlocksFromSpans(f.items,{pageIndex:3,pageWidth:f.pageWidth,pageHeight:f.pageHeight,imageRectsPdf:f.images,includeReferences:true}).blocks;
 const captions=blocks.filter(b=>b.imageTextRegionPdf);
 assert.equal(captions.length,1);const caption=captions[0]!;
 assert.equal(caption.lineRectsPdf?.length,20);
 assert.match(caption.sourceText,/^Figure 3:/);assert.match(caption.sourceText,/minimal and maximal values\.$/);
 assert.equal(coalesceRegions(blocks,f.images).find(b=>b.imageTextRegionPdf)?.sourceText,caption.sourceText);
});
test('background cell gutters do not erase the five columns of Serruys table 2',()=>{
 const f=fixture('serruys2021-p8');const grids=borderGrids(f.segments,{pageHeight:f.pageHeight});
 assert.equal(grids.length,1);
 assert.ok(!grids[0]!.spans?.some(s=>s.row>=2 && s.colSpan>1),'collapsed fill edges still prove body column boundaries');
 const blocks=buildBlocksFromSpans(f.items,{pageIndex:7,pageWidth:f.pageWidth,pageHeight:f.pageHeight,grids,includeReferences:true}).blocks;
 const cells=structureTableCells(blocks,7,8,[],grids,true,f.pageHeight);
 for(const row of [1,2,3,4,5]) {
  const members=cells.filter(b=>b.tableRow===row);
  assert.deepEqual(members.map(b=>b.tableCol).sort(),[0,1,2,3,4]);
  assert.ok(members.every(b=>!b.tableColSpan || b.tableColSpan===1));
 }
 const crescent=cells.find(b=>b.tableRow===2 && b.tableCol===0)!;
 assert.equal(crescent.sourceText,'CRESCENT II, 2018 (60)');
 assert.match(cells.find(b=>b.tableRow===4 && b.tableCol===3)!.sourceText,/third-generation dual-source scanner/);
 // No source words can disappear when we change grid grouping.
 const chars=(text:string)=>[...text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'')].sort().join('');
 assert.equal(chars(cells.map(b=>b.sourceText).join('')),chars(blocks.map(b=>b.sourceText).join('')));
});

test('reference requests translate titles in both structured and plain recovery modes',async()=>{
 const {buildSystemPrompt}=await import('../../src/translation/promptBuilder');
 const request={sourceLanguage:'en',targetLanguage:'zh-CN',documentTitle:'T',previousContext:'',blocks:[{id:'r',type:'list' as const,text:'1. Smith A. A clinical study. Journal 2021;1:2.'}]};
 for(const plain of [false,true]) {
  assert.match(buildSystemPrompt({...request,plain,referenceContent:true}),/translate the article or book TITLE/);
  assert.doesNotMatch(buildSystemPrompt({...request,plain}),/translate the article or book TITLE/);
 }
});

test('grid partitioning retains isolated one-character symbols',()=>{
 const items=[{text:'Heading',rect:[0,90,30,100] as [number,number,number,number],fontSize:8},{text:'¼',rect:[5,65,10,73] as [number,number,number,number],fontSize:8},{text:'value',rect:[55,65,78,73] as [number,number,number,number],fontSize:8}];
 const grid={columns:[0,50,100],rows:[0,20,40],region:{left:0,top:0,width:100,height:40}};
 const blocks=buildBlocksFromSpans(items,{pageIndex:0,pageWidth:100,pageHeight:100,grid});
 assert.ok(blocks.blocks.some(b=>b.sourceText.includes('¼')));
});
