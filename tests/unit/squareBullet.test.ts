import test from 'node:test';
import {createHash} from 'node:crypto';
import inventory from '../fixtures/baseline/content-inventory.json';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/square-bullet-outline-cases.json';
import spans from '../fixtures/regression/bae2010-p2-essentials.spans.json';
import {squareBulletFromGlyphPath, hasSymbolCandidate, repairSymbolText, type GlyphPathCommand} from '../../src/reader/symbolFontSemantics';
import {embeddedSymbolRepairs} from '../../src/reader/embeddedFontSymbols';
import {cff, oneFont, font, source, ge, eq} from '../fixtures/regression/symbolFontFixture';
import {PDFDocument, PDFName} from 'pdf-lib';
import {getPageData, getTextContentItems, repairTextLayerSymbols, type ReaderLike} from '../../src/reader/zoteroReaderAdapter';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {coalesceRegions} from '../../src/reader/regionCoalescer';

const square=fixture.positive.commands;
const transform=(commands:readonly GlyphPathCommand[],scale:number,x:number,y:number):GlyphPathCommand[]=>commands.map(c=>({command:c.command,args:c.args.map((v,i)=>v*scale+(i%2?y:x))}));
const observe=(originalCharCode=110)=>({fontName:'TestFace',unicode:'n',originalCharCode});

test('actual Universal News glyph n is a filled square while ordinary Roman, italic and sans n remain letters',()=>{
 assert.equal(squareBulletFromGlyphPath(square),'▪');
 for(const ordinary of fixture.negative) assert.equal(squareBulletFromGlyphPath(ordinary.commands),undefined,ordinary.fontName);
 assert.equal(repairSymbolText('n Normal enhancement; n = 52',new Map()),'n Normal enhancement; n = 52');
});

test('solid square evidence survives units, translation, start vertex and winding',()=>{
 for(const scale of [.25,1,1000]) assert.equal(squareBulletFromGlyphPath(transform(square,scale,137.5,-24.25)),'▪');
 const points=square.slice(0,-1).map(c=>c.args).reverse();
 const reversed:GlyphPathCommand[]=points.map((args,i)=>({command:i?'lineTo':'moveTo',args}));
 reversed.push({command:'closePath',args:[]});
 assert.equal(squareBulletFromGlyphPath(reversed),'▪');
 assert.equal(squareBulletFromGlyphPath([...square.slice(0,-1),{command:'lineTo',args:square[0]!.args},square.at(-1)!]),'▪');
});

test('hollow squares, multiple components, wide rectangles, diamonds, bow ties and curved boxes are not bullets',()=>{
 const hollow=[...square,...transform(square,.6,.1,.1)];
 const wide=square.map(c=>({...c,args:c.args.map((v,i)=>i%2?v:v*2)}));
 const diamond=square.map(c=>({...c,args:c.args.flatMap((v,i,a)=>i%2?[]:[(v-a[i+1]!)*Math.SQRT1_2,(v+a[i+1]!)*Math.SQRT1_2])}));
 const bowtie=[square[0]!,square[2]!,square[1]!,square[3]!,square[4]!];
 const curved=square.map(c=>({...c,args:[...c.args]}));curved[1]={command:'bezierCurveTo',args:[.528,.2,.528,.4,.528,.588]};
 for(const path of [hollow,[...square,...transform(square,1,1,0)],wide,diamond,bowtie,curved,[],square.slice(0,-1)]) assert.equal(squareBulletFromGlyphPath(path),undefined);
});

test('only standalone n triggers optional glyph investigation, and repair requires a verified map',()=>{
 for(const s of ['n',' n ','n Use lower tube voltage','Sample n = 52','$20','¼ sample']) assert.equal(hasSymbolCandidate(s),true);
 for(const s of ['normal','enhancement','Correct ≥17.25%; P=.004; ordinary prose.']) assert.equal(hasSymbolCandidate(s),false);
 assert.equal(repairSymbolText('n Use lower voltage',new Map([['n','▪']])),'▪ Use lower voltage');
});

test('embedded Type1C WinAnsi n and explicit Differences recover a square from its actual outline',async()=>{
 const raw=cff([{name:'n',commands:square}]);
 for(const [code,encoding] of [[110,'WinAnsiEncoding'],[65,{Differences:[65,'n']}]] as const){
  const doc=await oneFont({raw,encoding:typeof encoding==='string'?encoding:{Differences:[...encoding.Differences]}});
  assert.equal((await embeddedSymbolRepairs(doc,0,[observe(code)])).get('TestFace')?.get('n'),'▪');
 }
 for(const ordinary of fixture.negative){
  const doc=await oneFont({raw:cff([{name:'n',commands:ordinary.commands}])});
  assert.equal((await embeddedSymbolRepairs(doc,0,[observe()])).size,0);
 }
});

async function adapterFixture(mixed=false,composite=false){
 const pdf=await PDFDocument.create(),p=pdf.addPage();
 const marker=font(pdf,{name:'MarkerFace',raw:cff([{name:'n',commands:square},{name:'dollar',commands:ge},{name:'onequarter',commands:eq}])});
 const ordinary=font(pdf,{name:'OrdinaryFace',raw:cff([{name:'n',commands:fixture.negative[0]!.commands}])});
 p.node.set(PDFName.of('Resources'),pdf.context.obj({Font:{Marker:marker,Ordinary:ordinary}}));
 const bytes=await source(pdf),raw=[{str:'n',fontName:'marker',width:5,transform:[8.8,0,0,8.8,90,446]},
  {str:'Normal enhancement; n = 52',fontName:'ordinary',width:100,transform:[8.8,0,0,8.8,100,446]}];
 const glyph={unicode:'n',originalCharCode:110};
 const ops={fnArray:mixed?[37,44,37,44]:[37,44],argsArray:mixed?[['marker',8.8],[[glyph]],['ordinary',8.8],[[glyph]]]:[['marker',8.8],[[glyph]]]};
 if(composite){
  raw.push({str:'$17; P¼.02',fontName:'marker',width:100,transform:[8.8,0,0,8.8,100,420]});
  ops.fnArray.push(37,44);ops.argsArray.push(['marker',8.8],[[{unicode:'$',originalCharCode:36},{unicode:'¼',originalCharCode:188},{unicode:'nn',originalCharCode:111}]]);
 }
 const page={view:[0,0,612,792],getTextContent:async()=>({items:raw}),getOperatorList:async()=>ops,
  commonObjs:{get:(id:string)=>({name:id==='marker'?'MarkerFace':'OrdinaryFace'})}};
 const doc={getData:bytes.getData,getPage:async()=>page,getPageData:async()=>({chars:raw.map(i=>({c:i.str,u:i.str,fontName:i.fontName,rect:[90,446,95,455],fontSize:8.8})),viewBox:[0,0,612,792]})};
 const reader:ReaderLike={_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:doc}}}}};
 return{reader,raw};
}

test('source-font evidence reaches text content, reader chars and DOM without changing ordinary n',async()=>{
 const {reader,raw}=await adapterFixture(true),before=JSON.stringify(raw);
 assert.deepEqual((await getTextContentItems(reader,0))?.items.map(i=>i.text),['▪','Normal enhancement; n = 52']);
 assert.deepEqual((await getPageData(reader,0)).pageData.chars.map(i=>i.c),['▪','Normal enhancement; n = 52']);
 const dom={pageWidth:612,pageHeight:792,items:[{text:'n Item',rect:[90,446,200,455] as [number,number,number,number],fontName:'marker'},
  {text:'n = 52',rect:[90,426,200,435] as [number,number,number,number],fontName:'ordinary'}]};
 assert.deepEqual((await repairTextLayerSymbols(reader,0,dom))?.items.map(i=>i.text),['▪ Item','n = 52']);
 const unknown={...dom,items:dom.items.map(i=>({...i,fontName:'generic-css-font'}))};
 assert.deepEqual((await repairTextLayerSymbols(reader,0,unknown))?.items.map(i=>i.text),['n Item','n = 52'],'mixed original fonts prohibit global n replacement');
 assert.equal(JSON.stringify(raw),before);
});

test('five real Bae Essentials markers retain five independent list items and all prose after font repair',()=>{
 const items=spans.items.map(i=>({...i,rect:i.rect as [number,number,number,number],text:i.fontName==='g_d0_f4'?repairSymbolText(i.text,new Map([['n','▪']])):i.text}));
 const blocks=coalesceRegions(buildBlocksFromSpans(items,{pageIndex:1,pageWidth:spans.pageWidth,pageHeight:spans.pageHeight}).blocks);
 const bullets=blocks.filter(b=>b.sourceText.startsWith('▪'));
 assert.equal(bullets.length,5,JSON.stringify(blocks.map(b=>b.sourceText)));
 for(const text of ['Use of lower CT tube voltages','The most important patient','Injection duration is the most','Contrast material arrival time','We propose an empiric scheme']) assert.equal(bullets.filter(b=>b.sourceText.includes(text)).length,1,text);
 assert.ok(bullets.every(b=>(b.sourceText.match(/▪/g)??[]).length===1),'no item absorbs another marker');
 const chars=[...blocks.map(b=>b.sourceText).join('').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'')].sort().join('');
 assert.equal(createHash('sha256').update(chars).digest('hex'),inventory['bae2010-p2-essentials.spans.json'],'all original prose and numbers survive independently of block grouping');
});


test('ambiguous composite n glyphs block letter replacement without disabling proven relations',async()=>{
 const {reader}=await adapterFixture(false,true);
 assert.deepEqual((await getTextContentItems(reader,0))?.items.map(i=>i.text),['n','Normal enhancement; n = 52','≥17; P=.02']);
});
