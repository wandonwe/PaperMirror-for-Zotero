import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TextExtractor} from '../../src/reader/textExtractor';
import {extractLegendItems, type LegendSpan, type LegendRect} from '../../src/reader/legendItems';
import {validatePageIR} from '../../src/ir/documentIR';

const fixture = JSON.parse(readFileSync('tests/fixtures/regression/kitagawa-legend-p8.spans.json','utf8')) as {
 pageWidth:number;pageHeight:number;pageIndex:number;items:LegendSpan[];segments:LegendRect[];
};

function readerFixture(path:'chars'|'text-content',segments=fixture.segments) {
 const expected=extractLegendItems(fixture.items,{...fixture,segments});
 const claimed=new Set(fixture.items.filter(i=>!expected.rest.includes(i)));
 const items=path==='chars'?[...claimed]:fixture.items;
 const ops={fnArray:segments.flatMap(()=>[91,20]),
  argsArray:segments.flatMap(s=>[[[13,14],[...s]],[]])};
 let edgeReads=0, pathsReady=true;
 const pdfPage={view:[0,0,fixture.pageWidth,fixture.pageHeight],
  getTextContent:async()=>({items:items.map(i=>({str:i.text,width:i.rect[2]-i.rect[0],fontName:'body',
   transform:[i.fontSize,0,0,i.fontSize,i.rect[0],i.rect[1]+i.fontSize!*.22]}))}),
  getOperatorList:async()=>{edgeReads++;return pathsReady?ops:{};}};
 const pdfDocument={numPages:13,getPage:async()=>pdfPage,
  getPageData:async()=>{
   if(path==='text-content')throw Error('char stream unavailable');
   return {viewBox:pdfPage.view,chars:items.map(i=>({c:i.text,rect:i.rect,fontSize:i.fontSize,fontName:'body',lineBreakAfter:true}))};
  }};
 const reader={_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument}}}}};
 return {reader,reads:()=>edgeReads,expected,setPathsReady:(ready:boolean)=>{pathsReady=ready;}};
}

for(const path of ['chars','text-content'] as const) test(`actual ${path} extraction carries painted marker evidence into eight independent owners`,async()=>{
 const f=readerFixture(path),extractor=new TextExtractor(f.reader as never,{includeReferences:true});
 const blocks=await extractor.extractPage(fixture.pageIndex),legends=blocks.filter(b=>b.sourceRegion?.kind==='legend-item');
 assert.equal(legends.length,8);
 assert.deepEqual(legends.map(b=>b.sourceText).sort(),f.expected.blocks.map(b=>b.sourceText).sort());
 assert.ok(legends.every(b=>b.tableId===undefined && typeof b.column==='number'));
 assert.deepEqual(validatePageIR({pageIndex:fixture.pageIndex,blocks}),[]);
 const reads=f.reads();
 const cached=await extractor.extractPage(fixture.pageIndex);
 assert.deepEqual(cached,blocks);
 assert.equal(f.reads(),reads,'the same page must not request painted paths again for a cached structure');
});

test('missing painted-path evidence keeps the existing text-content extraction available',async()=>{
 const f=readerFixture('text-content',[]),extractor=new TextExtractor(f.reader as never,{includeReferences:true});
 const blocks=await extractor.extractPage(fixture.pageIndex);
 assert.ok(blocks.length>0);
 assert.equal(blocks.filter(b=>b.sourceRegion?.kind==='legend-item').length,0);
 assert.ok(blocks.some(b=>b.sourceText.includes('0.65') && b.sourceText.includes('0.85')),
  'an unavailable marker scan must not invent independent legend owners');
});

test('a late painted-path list can upgrade a previously merged legend on the next extraction',async()=>{
 const f=readerFixture('text-content'),extractor=new TextExtractor(f.reader as never,{includeReferences:true});
 f.setPathsReady(false);
 const before=await extractor.extractPage(fixture.pageIndex),reads=f.reads();
 assert.equal(before.filter(b=>b.sourceRegion?.kind==='legend-item').length,0);
 f.setPathsReady(true);
 const after=await extractor.extractPage(fixture.pageIndex);
 assert.equal(after.filter(b=>b.sourceRegion?.kind==='legend-item').length,8);
 assert.ok(f.reads()>reads,'transiently unavailable path evidence must be queried again');
 const completeReads=f.reads();
 await extractor.extractPage(fixture.pageIndex);
 assert.equal(f.reads(),completeReads,'a confirmed source structure is still cached');
});
