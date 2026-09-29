import test from 'node:test';import assert from 'node:assert/strict';
import {isFaintPageBackground,imageRectsFromOperatorList} from '../../src/reader/imageObstacles';
import pixels from '../fixtures/regression/faint-background-pixels.json';
const box:[number,number,number,number]=[100,300,460,465];
test('repeated faint background requires repetition, behind-text placement and large geometry',()=>{
 assert.ok(isFaintPageBackground(pixels,3,box,true,true));
 assert.equal(isFaintPageBackground(pixels,3,box,false,true),false);
 assert.equal(isFaintPageBackground(pixels,3,box,true,false),false);
 assert.equal(isFaintPageBackground(pixels,3,[0,0,40,20],true,true),false);
 assert.equal(isFaintPageBackground(Array(3000).fill(255),3,box,true,true),false);
 assert.equal(isFaintPageBackground(Array(3000).fill(80),3,box,true,true),false);
 assert.equal(isFaintPageBackground(Array.from({length:3000},(_,i)=>i%3===0?200:240),3,box,true,true),false);
});
test('ignoring an identified background keeps later figure obstacles and graphics state',()=>{
 const fn=[10,12,85,11,10,12,85,11],args=[[],[360,0,0,165,100,300],['background'],[],[],[200,0,0,200,50,400],['figure'],[]];
 assert.deepEqual(imageRectsFromOperatorList(fn,args,{},12,new Set([2])),[[50,400,250,600]]);
 assert.equal(imageRectsFromOperatorList(fn,args).length,2);
});

test('watermarked body text is extracted in full after removing only background obstacles',async()=>{
 const {default:fixture}=await import('../fixtures/regression/bell2026-extraction.json');
 const {buildBlocksFromSpans}=await import('../../src/reader/spanBlockBuilder');
 for(const page of fixture.pages){
  const blocks=buildBlocksFromSpans(page.items as any,{pageIndex:page.page-1,pageWidth:page.view[2]!,pageHeight:page.view[3]!,imageRectsPdf:page.imageRects as any,includeReferences:true}).blocks;
  const text=blocks.map(b=>b.sourceText).join(' ');
  if(page.page===3){
   assert.ok(text.includes('Total occlusions were categorized as FFR-CT ≤0.50'));
   assert.ok(text.includes('Deidentified participant data'));
   assert.ok(text.includes('digital hospital episode statistics'));
   assert.ok(text.includes('All statistical analyses were performed'));
  }
  assert.ok(blocks.length>0);
 }
});


test('PDF byte bridge does not depend on the content promise carrying parsed privileged objects',async()=>{
 const {PDFDocument,PDFName}=await import('pdf-lib');
 const {repeatedImageRefs}=await import('../../src/reader/legacyTextEncoding');
 const pdf=await PDFDocument.create();
 const image=pdf.context.register(pdf.context.stream(new Uint8Array([255]),{Type:'XObject',Subtype:'Image',Width:1,Height:1,BitsPerComponent:8,ColorSpace:'DeviceGray'}));
 for(let i=0;i<3;i++){const page=pdf.addPage();page.node.set(PDFName.of('Resources'),pdf.context.obj({XObject:{Im:image}}));}
 const bytes=await pdf.save();let calls=0;
 // Only the callback delivery is part of the cross-realm contract.
 const doc={getData:()=>{calls++;return {then:(callback:(data:Uint8Array)=>void)=>Promise.resolve(bytes).then(data=>{callback(data);})} as unknown as Promise<Uint8Array>;}};
 assert.deepEqual([...await repeatedImageRefs(doc)],[`${image.objectNumber}R`]);
 assert.deepEqual([...await repeatedImageRefs(doc)],[`${image.objectNumber}R`]);assert.equal(calls,1);
});

test('image obstacle classification waits for asynchronous image delivery and times out safely',async()=>{
 const {resolvedPdfImage}=await import('../../src/reader/zoteroReaderAdapter');
 const image={ref:'42R',width:100,height:100};
 const pending={get:(_id:string,callback?:(value:unknown)=>void)=>{if(!callback)throw Error('not resolved');setTimeout(()=>callback(image),10);}};
 assert.equal(await resolvedPdfImage(pending,'image',100),image);
 assert.equal(await resolvedPdfImage({get:()=>undefined},'missing',5),undefined);
 assert.equal(await resolvedPdfImage({get:()=>image},'ready',5),image);
});
