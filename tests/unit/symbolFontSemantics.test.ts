import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/symbol-font-outline-cases.json';
import { relationFromGlyphPath, repairSymbolText, type GlyphPathCommand } from '../../src/reader/symbolFontSemantics';
import { PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import { cff, font, source } from '../fixtures/regression/symbolFontFixture';
import { getPageData, getTextContentItems, repairTextLayerSymbols, type ReaderLike, type TextLayerPage } from '../../src/reader/zoteroReaderAdapter';

type Point = [number, number];
const polygon = (points: Point[]): GlyphPathCommand[] => [
 {command:'moveTo',args:[...points[0]!]},
 ...points.slice(1).map(p => ({command:'lineTo',args:[...p]})),
 {command:'closePath',args:[]}
];
const rectangle = (x:number,y:number,w:number,h:number): GlyphPathCommand[] => polygon([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);
const equalBars = (): GlyphPathCommand[] => [...rectangle(.1,.2,.7,.04),...rectangle(.1,.5,.7,.04)];
const chevronPoints: Point[] = [[.8,.42],[.1,.64],[.1,.58],[.69,.39],[.1,.2],[.1,.14],[.8,.36]];
const greaterEqual = (): GlyphPathCommand[] => [...polygon(chevronPoints),...rectangle(.1,.03,.7,.04)];
function transform(path: readonly GlyphPathCommand[], point:(x:number,y:number)=>Point): GlyphPathCommand[] {
 return path.map(p => ({command:p.command,args:p.args.flatMap((n,i,a) => i%2 ? [] : point(n,a[i+1]!))}));
}
function reorderLinearContours(path: readonly GlyphPathCommand[]): GlyphPathCommand[] {
 const contours:Point[][]=[];
 for (const p of path) {
  if (p.command==='moveTo') contours.push([[p.args[0]!,p.args[1]!]]);
  else if (p.command==='lineTo') contours.at(-1)!.push([p.args[0]!,p.args[1]!]);
 }
 return contours.reverse().flatMap(points => {
  const rotated=[...points.slice(2),...points.slice(0,2)].reverse();
  return polygon(rotated);
 });
}
const copy = (path: readonly GlyphPathCommand[]): GlyphPathCommand[] => path.map(p => ({command:p.command,args:[...p.args]}));

for (const f of fixture.positive) {
 test(`actual source outline determines ${f.expected} despite printable Unicode ${f.rawUnicode}`, () => {
  assert.equal(relationFromGlyphPath(f.commands),f.expected);
  assert.equal(repairSymbolText(`${f.rawUnicode}17.25`,new Map([[f.rawUnicode,f.expected]])),`${f.expected}17.25`);
 });
}

for (const f of fixture.negative) {
 test(`real ordinary ${f.rawUnicode} glyph is not a mathematical relation`, () => {
  assert.equal(relationFromGlyphPath(f.commands),undefined);
 });
}

for (const scale of [.25,1,1000]) {
 test(`relation semantics survive units/position changes at scale ${scale}`, () => {
  const mapping=(x:number,y:number):Point=>[x*scale+137.25,y*scale-46.75];
  assert.equal(relationFromGlyphPath(transform(equalBars(),mapping)),'=');
  assert.equal(relationFromGlyphPath(transform(greaterEqual(),mapping)),'≥');
  assert.equal(relationFromGlyphPath(transform(greaterEqual(),(x,y)=>[-x*scale+137.25,y*scale-46.75])),'≤');
 });
}

test('contour order, start vertex and winding do not determine the relation', () => {
 assert.equal(relationFromGlyphPath(reorderLinearContours(equalBars())),'=');
 assert.equal(relationFromGlyphPath(reorderLinearContours(greaterEqual())),'≥');
 assert.equal(relationFromGlyphPath(reorderLinearContours(transform(greaterEqual(),(x,y)=>[-x,y]))),'≤');
});

test('actual rounded-cap equality is recognized without requiring rectangular corner commands', () => {
 const equality=fixture.positive.find(f=>f.expected==='=')!;
 assert.ok(equality.commands.some(p=>p.command==='bezierCurveTo'),'the real evidence contains curved caps');
 assert.equal(relationFromGlyphPath(equality.commands),'=');
});

test('a chevron without its lower relation bar remains an ordinary comparison glyph', () => {
 assert.equal(relationFromGlyphPath(polygon(chevronPoints)),undefined);
 assert.equal(relationFromGlyphPath(transform(polygon(chevronPoints),(x,y)=>[-x,y])),undefined);
});

test('double chevrons, three-bar equivalence and extra painted components are not accepted', () => {
 const doubled=[...greaterEqual(),...transform(polygon(chevronPoints),(x,y)=>[x+.8,y])];
 assert.equal(relationFromGlyphPath(doubled),undefined);
 assert.equal(relationFromGlyphPath([...equalBars(),...rectangle(.1,.8,.7,.04)]),undefined);
 assert.equal(relationFromGlyphPath([...equalBars(),...rectangle(.45,.8,.025,.025)]),undefined);
});

test('the added bar must be below the chevron, not above it', () => {
 assert.equal(relationFromGlyphPath(transform(greaterEqual(),(x,y)=>[x,1-y])),undefined);
});

test('vertical or diagonal strokes cannot masquerade as horizontal relations', () => {
 assert.equal(relationFromGlyphPath(transform(equalBars(),(x,y)=>[-y,x])),undefined);
 const c=Math.SQRT1_2;
 assert.equal(relationFromGlyphPath(transform(equalBars(),(x,y)=>[(x-y)*c,(x+y)*c])),undefined);
});

test('thick blocks, unequal spans and touching bars lack sufficient equality evidence', () => {
 assert.equal(relationFromGlyphPath([...rectangle(.1,0,.7,.35),...rectangle(.1,1,.7,.35)]),undefined);
 assert.equal(relationFromGlyphPath([...rectangle(.1,.2,.7,.04),...rectangle(.1,.5,.15,.04)]),undefined);
 assert.equal(relationFromGlyphPath([...rectangle(.1,.2,.7,.04),...rectangle(.1,.24,.7,.04)]),undefined);
});

test('control points that bulge far outside a thin bar must not be ignored', () => {
 const path=equalBars();
 path[1]={command:'bezierCurveTo',args:[.2,12,.6,12,.8,.2]};
 assert.equal(relationFromGlyphPath(path),undefined);
});

test('two thin approximately-equal waves are not straight equality bars',()=>{
 const wave:GlyphPathCommand[]=[{command:'moveTo',args:[.1,.2]},
  {command:'bezierCurveTo',args:[.3,.215,.6,.185,.8,.2]},
  {command:'lineTo',args:[.8,.22]},
  {command:'bezierCurveTo',args:[.6,.205,.3,.235,.1,.22]},
  {command:'closePath',args:[]}];
 for(const scale of [.25,1,1000]) {
  const approx=[...wave,...transform(wave,(x,y)=>[x,y+.2])];
  assert.equal(relationFromGlyphPath(transform(approx,(x,y)=>[x*scale,y*scale])),undefined);
 }
});

test('retraced zero-area contours cannot authorize a filled equality glyph',()=>{
 const retraced=polygon([[.1,.2],[.8,.2],[.8,.24],[.1,.24],[.8,.24],[.8,.2],[.1,.2]]);
 assert.equal(relationFromGlyphPath([...retraced,...transform(retraced,(x,y)=>[x,y+.3])]),undefined);
 assert.equal(relationFromGlyphPath([...equalBars().slice(0,5),...transform(retraced,(x,y)=>[x,y+.3])]),undefined);
});

test('empty, degenerate, unknown or non-finite path data never authorizes a repair', () => {
 const invalid:GlyphPathCommand[][]=[
  [],
  [{command:'moveTo',args:[0,0]}],
  [...polygon([[0,0],[1,0]]),...polygon([[0,.3],[1,.3]])],
  [{command:'lineTo',args:[1,1]}],
  [{command:'moveTo',args:[0,0]},{command:'A',args:[1,1,0,0,0,1,1]}],
  [{command:'moveTo',args:[0,0]},{command:'lineTo',args:[Number.NaN,1]}],
  [{command:'moveTo',args:[0,0]},{command:'lineTo',args:[1,Number.POSITIVE_INFINITY]}]
 ];
 for (const path of invalid) assert.equal(relationFromGlyphPath(path),undefined,JSON.stringify(path));
});

test('classification does not mutate source geometry retained for rendering', () => {
 const path=greaterEqual(),before=copy(path);
 assert.equal(relationFromGlyphPath(path),'≥');
 assert.deepEqual(path,before);
});

test('no font-backed map means legal costs, fractions and statistical-looking prose stay literal', () => {
 for (const text of ['Cost $250; use ¼ of the sample.','P ¼ .02; price $50%.','≥17.25%; P=.001; ±2; ≤9.']) {
  assert.equal(repairSymbolText(text,new Map()),text);
 }
});

test('only the attested candidate changes; the other printable character stays literal', () => {
 assert.equal(repairSymbolText('Cost $250; P¼.02',new Map([['¼','=']])),'Cost $250; P=.02');
 assert.equal(repairSymbolText('$17.25%; use ¼ sample',new Map([['$','≥']])),'≥17.25%; use ¼ sample');
});

test('repair follows glyph evidence rather than a hardcoded number, P marker or sentence context', () => {
 for (const raw of ['$0.5%','$ 17.25%','X$Y','$3.2e-4']) {
  assert.equal(repairSymbolText(raw,new Map([['$','≥']])),raw.replaceAll('$','≥'));
 }
 assert.equal(repairSymbolText('Q¼-2.7',new Map([['¼','=']])),'Q=-2.7');
 assert.equal(repairSymbolText('$9',new Map([['$','≤']])),'≤9');
});

test('repair state cannot leak from a mathematical font run to an ordinary font run', () => {
 const math=new Map([['$','≥'],['¼','=']]),ordinary=new Map<string,string>();
 assert.equal(repairSymbolText('$31%; P¼.004',math),'≥31%; P=.004');
 assert.equal(repairSymbolText('$31 and ¼ sample',ordinary),'$31 and ¼ sample');
 assert.equal(repairSymbolText('$31%; P¼.004',math),'≥31%; P=.004');
});

test('repair is idempotent and leaves already-correct Unicode, prose and the evidence map intact', () => {
 const repairs=new Map([['$','≥'],['¼','=']]),before=[...repairs];
 const result=repairSymbolText('CCTA $17.25%; P¼.004; ≥20%; x=2',repairs);
 assert.equal(result,'CCTA ≥17.25%; P=.004; ≥20%; x=2');
 assert.equal(repairSymbolText(result,repairs),result);
 assert.deepEqual([...repairs],before);
});

type TextItem = {str:string;fontName:string;width:number;transform:number[]};
type Glyph = {unicode:string;originalCharCode:number};
type Ops = {fnArray:number[];argsArray:unknown[][]};
const glyph = (unicode='$',originalCharCode=36): Glyph => ({unicode,originalCharCode});
const show = (fontId:string, unicode='$', originalCharCode=36): Ops => ({fnArray:[37,44],argsArray:[[fontId,8],[[glyph(unicode,originalCharCode)]]]});
const joinOps = (...parts:Ops[]): Ops => ({fnArray:parts.flatMap(p=>p.fnArray),argsArray:parts.flatMap(p=>p.argsArray)});
const textItem = (str:string,fontName='math',x=10):TextItem => ({str,fontName,width:40,transform:[8,0,0,8,x,100]});
const ordinaryGlyphs=fixture.negative.map(f=>({name:f.rawUnicode==='$'?'dollar':'onequarter',commands:f.commands}));

async function adapterFixture(options:{
 raw?:TextItem[]; chars?:unknown[]; ops?:Ops|null; mixed?:boolean; ordinaryOnly?:boolean;
 names?:Record<string,string>; getOperatorList?:()=>Promise<unknown>; missingData?:boolean; missingOperatorApi?:boolean;
}={}) {
 const pdf=await PDFDocument.create(),p=pdf.addPage();
 const math=font(pdf,{name:'MathFace',...(options.ordinaryOnly?{raw:cff(ordinaryGlyphs)}:{})});
 const fonts:Record<string,PDFRef>={Math:math};
 if(options.mixed)fonts.Ordinary=font(pdf,{name:'OrdinaryFace',raw:cff(ordinaryGlyphs)});
 p.node.set(PDFName.of('Resources'),pdf.context.obj({Font:fonts}));
 const bytes=await source(pdf),raw=options.raw??[textItem('$17.25%'),textItem('P¼.004','math',60)];
 const defaultOps=joinOps(show('math'),show('math','¼',188));
 let operatorReads=0;
 const getOperatorList=options.missingOperatorApi?undefined:async()=>{
  operatorReads++;
  if(options.getOperatorList)return options.getOperatorList();
  return options.ops===null?{}:options.ops??defaultOps;
 };
 const names=options.names??{math:'MathFace',ordinary:'OrdinaryFace'};
 const page={view:[0,0,612,792],getTextContent:async()=>({items:raw}),getOperatorList,
  commonObjs:{get:(id:string,callback?:(value:unknown)=>void)=>{const value=names[id]?{name:names[id]}:undefined;callback?.(value);return value;}}};
 const doc={...(options.missingData?{}:{getData:bytes.getData}),getPage:async()=>page,
  getPageData:async()=>({chars:options.chars??[],viewBox:[0,0,612,792],pageLabel:'synthetic'})};
 const OPS={save:10,restore:11,setGState:9,setFont:37,showText:44,showSpacedText:45,nextLineShowText:46,nextLineSetSpacingShowText:47,paintFormXObjectBegin:74,paintFormXObjectEnd:75};
 const reader:ReaderLike={_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:doc},pdfjsLib:{OPS}}}}};
 return {reader,raw,doc,operatorReads:()=>operatorReads,byteReads:bytes.reads};
}

const domPage=(text:string,fontName?:string):TextLayerPage=>({pageWidth:612,pageHeight:792,items:[{text,rect:[10,20,210,28],fontSize:8,...(fontName?{fontName}:{})}]});

test('production text-content path repairs a printable-only page with no control-byte trigger',async()=>{
 const f=await adapterFixture(),before=JSON.stringify(f.raw),result=await getTextContentItems(f.reader,0);
 assert.ok(result,'a valid page must not disappear while resolving optional glyph evidence');
 assert.deepEqual(result.items.map(i=>i.text),['≥17.25%','P=.004']);
 const unmodified=await adapterFixture({missingData:true}),baseline=await getTextContentItems(unmodified.reader,0);
 assert.deepEqual(result.items.map(i=>i.rect),baseline?.items.map(i=>i.rect),'font semantics must not alter the existing PDF geometry conversion');
 assert.deepEqual(result.items.map(i=>i.fontSize),[8,8]);
 assert.equal(result.fontRepair?.controlRuns,0);
 assert.equal(result.fontRepair?.symbolGlyphs,2);
 assert.equal(f.operatorReads(),1);
 assert.equal(f.byteReads(),1);
 assert.equal(JSON.stringify(f.raw),before,'source text and its geometry remain unmodified');
});

test('same page and same printable Unicode remain bound to the source font',async()=>{
 const raw=[textItem('$17.25%'),textItem('P¼.004','math',60),textItem('Cost $250','ordinary',120),textItem('Use ¼ sample','ordinary',180),textItem('≥3; P=.02','math',240)];
 const ops=joinOps(show('math'),show('math','¼',188),show('ordinary'),show('ordinary','¼',188));
 const f=await adapterFixture({raw,ops,mixed:true}),result=await getTextContentItems(f.reader,0);
 assert.deepEqual(result?.items.map(i=>i.text),['≥17.25%','P=.004','Cost $250','Use ¼ sample','≥3; P=.02']);
 assert.equal(result?.items.length,raw.length);
 assert.equal(result?.fontRepair?.symbolGlyphs,2);
});

test('missing source bytes, operator evidence or font identity never permits a contextual guess',async()=>{
 for(const options of [{missingData:true},{missingOperatorApi:true},{ops:null},{names:{}},{getOperatorList:async()=>{throw Error('synthetic worker unavailable');}}]) {
  const f=await adapterFixture(options),result=await getTextContentItems(f.reader,0);
  assert.ok(result,'optional evidence failure must preserve ordinary extraction');
  assert.deepEqual(result.items.map(i=>i.text),['$17.25%','P¼.004']);
 }
 const unknown=await adapterFixture({raw:[textItem('$17.25%; P¼.004','unknown')]}),result=await getTextContentItems(unknown.reader,0);
 assert.equal(result?.items[0]?.text,'$17.25%; P¼.004','an unknown item font cannot inherit the page-wide DOM fallback');
});

test('DOM fallback needs consistent proof for every drawing of each source Unicode',async()=>{
 const f=await adapterFixture(),page=domPage('Value $17.25%; P¼.004'),before=JSON.stringify(page);
 const result=await repairTextLayerSymbols(f.reader,0,page);
 assert.equal(result?.items[0]?.text,'Value ≥17.25%; P=.004');
 assert.deepEqual(result?.items[0]?.rect,page.items[0]?.rect);
 assert.equal(result?.items[0]?.fontSize,8);
 assert.equal(JSON.stringify(page),before,'DOM snapshot belongs to the caller');
 assert.equal((await repairTextLayerSymbols(f.reader,0,domPage('$8; P¼.03','generic-browser-css-font')))?.items[0]?.text,'≥8; P=.03');
});

test('mixed real costs and fractions block only the ambiguous DOM replacement',async()=>{
 const both=await adapterFixture({mixed:true,ops:joinOps(show('math'),show('math','¼',188),show('ordinary'),show('ordinary','¼',188))});
 assert.equal((await repairTextLayerSymbols(both.reader,0,domPage('Cost $250; criterion $17.25%; P¼.004; ¼ sample')))?.items[0]?.text,'Cost $250; criterion $17.25%; P¼.004; ¼ sample');
 assert.equal((await repairTextLayerSymbols(both.reader,0,domPage('$17.25%; P¼.004','math')))?.items[0]?.text,'≥17.25%; P=.004');
 assert.equal((await repairTextLayerSymbols(both.reader,0,domPage('$250; ¼ sample','ordinary')))?.items[0]?.text,'$250; ¼ sample');
 const dollarOnly=await adapterFixture({mixed:true,ops:joinOps(show('math'),show('math','¼',188),show('ordinary'))});
 assert.equal((await repairTextLayerSymbols(dollarOnly.reader,0,domPage('Cost $250; P¼.004')))?.items[0]?.text,'Cost $250; P=.004','one ambiguous candidate cannot erase independent proof for another glyph');
});

test('reader chars use original Unicode evidence for Zotero-expanded quarter glyphs',async()=>{
 const chars=[null,{c:'$',u:'$',fontName:'math',rect:[10,20,17,28],fontSize:8,spaceAfter:true},
  {c:'1⁄4',u:'¼',fontName:'MathFace',rect:[20,20,27,28],fontSize:8,lineBreakAfter:true},
  {c:'$',u:'$',fontName:'ordinary',rect:[30,20,37,28],fontSize:8},
  {c:'1⁄4',u:'¼',fontName:'OrdinaryFace',rect:[40,20,47,28],fontSize:8,paragraphBreakAfter:true},
  {c:'≥',u:'≥',fontName:'math',rect:[50,20,57,28],fontSize:8}];
 const before=JSON.stringify(chars),f=await adapterFixture({chars,mixed:true,ops:joinOps(show('math'),show('math','¼',188),show('ordinary'),show('ordinary','¼',188))});
 const result=await getPageData(f.reader,0);
 assert.deepEqual(result.pageData.chars.map(c=>c.c),['≥','=','$','1⁄4','≥']);
 assert.deepEqual(result.pageData.chars.map(c=>c.rect),chars.filter(Boolean).map(c=>(c as {rect:number[]}).rect));
 assert.equal(result.pageData.chars[0]?.spaceAfter,true);
 assert.equal(result.pageData.chars[1]?.lineBreakAfter,true);
 assert.equal(result.pageData.chars[3]?.paragraphBreakAfter,true);
 assert.equal(JSON.stringify(chars),before);
});

test('expanded fractions and unknown char fonts are preserved without reliable source evidence',async()=>{
 const chars=[{c:'1⁄4',u:'¼',rect:[0,0,8,8]},{c:'$',u:'$',fontName:'unknown',rect:[10,0,18,8]}];
 const missing=await adapterFixture({chars,ops:null});
 assert.deepEqual((await getPageData(missing.reader,0)).pageData.chars.map(c=>c.c),['1⁄4','$']);
 const mixed=await adapterFixture({chars,mixed:true,ops:joinOps(show('math'),show('math','¼',188),show('ordinary'),show('ordinary','¼',188))});
 assert.deepEqual((await getPageData(mixed.reader,0)).pageData.chars.map(c=>c.c),['1⁄4','$']);
});

test('operator font stack and all supported text showing forms preserve font isolation',async()=>{
 const ops:Ops={fnArray:[37,10,37,45,11,46,47],argsArray:[['math',8],[],['ordinary',8],[[12,glyph(),-3]],[],[[glyph()]],[1,2,[glyph('¼',188)]]]};
 const f=await adapterFixture({mixed:true,ops,raw:[textItem('$17.25%'),textItem('P¼.004'),textItem('Cost $250','ordinary')]});
 assert.deepEqual((await getTextContentItems(f.reader,0))?.items.map(i=>i.text),['≥17.25%','P=.004','Cost $250']);
 assert.equal((await repairTextLayerSymbols(f.reader,0,domPage('$250; P¼.004')))?.items[0]?.text,'$250; P=.004');
});

test('Font inside an ExtGState is a real font change and blocks an unsafe page-wide dollar vote',async()=>{
 const ops:Ops={fnArray:[37,44,9,44,37,44],argsArray:[['math',8],[[glyph()]],[[['Font',['ordinary',8]]]],[[glyph()]],['math',8],[[glyph('¼',188)]]]};
 const f=await adapterFixture({mixed:true,ops,raw:[textItem('$17.25%'),textItem('Cost $250','ordinary'),textItem('P¼.004')]});
 assert.deepEqual((await getTextContentItems(f.reader,0))?.items.map(i=>i.text),['≥17.25%','Cost $250','P=.004']);
 assert.equal((await repairTextLayerSymbols(f.reader,0,domPage('Cost $250; criterion $17.25%; P¼.004')))?.items[0]?.text,'Cost $250; criterion $17.25%; P=.004');
});

test('Form XObject begin/end restore the outer font before observing subsequent currency',async()=>{
 const ops:Ops={fnArray:[37,74,37,44,44,75,44],argsArray:[['ordinary',8],[[1,0,0,1,0,0],[0,0,100,100]],['math',8],[[glyph()]],[[glyph('¼',188)]],[],[[glyph()]]]};
 const f=await adapterFixture({mixed:true,ops,raw:[textItem('$17.25%'),textItem('Cost $250','ordinary'),textItem('P¼.004')]});
 assert.deepEqual((await getTextContentItems(f.reader,0))?.items.map(i=>i.text),['≥17.25%','Cost $250','P=.004']);
 assert.equal((await repairTextLayerSymbols(f.reader,0,domPage('Cost $250; criterion $17.25%; P¼.004')))?.items[0]?.text,'Cost $250; criterion $17.25%; P=.004');
});

test('source byte identity must be a finite in-range integer, never a coerced string or null',async()=>{
 for(const code of ['36',null,undefined,Number.NaN,Number.POSITIVE_INFINITY,36.5,-1,256]) {
  const ops:Ops={fnArray:[37,44],argsArray:[['math',8],[[{unicode:'$',originalCharCode:code}]]]};
  const f=await adapterFixture({ops});
  assert.equal((await getTextContentItems(f.reader,0))?.items[0]?.text,'$17.25%',`invalid original byte ${String(code)}`);
  assert.equal((await repairTextLayerSymbols(f.reader,0,domPage('Cost $250')))?.items[0]?.text,'Cost $250');
 }
});

test('malformed drawing data or a multi-character Unicode containing a candidate invalidate whole-page proof',async()=>{
 const malformedArgs:unknown[][]=[['not-an-array'],[[null]],[[{originalCharCode:36}]],[[Number.NaN]],[[{unicode:'$A',originalCharCode:36}]],[[{unicode:'¼\uFE0F',originalCharCode:188}]]];
 for(const args of malformedArgs) {
  const ops:Ops=joinOps(show('math'),show('math','¼',188),{fnArray:[44],argsArray:[args]});
  const f=await adapterFixture({ops}),result=await getTextContentItems(f.reader,0);
  assert.deepEqual(result?.items.map(i=>i.text),['$17.25%','P¼.004'],'a partially observed page cannot contribute trusted repair votes');
  assert.equal((await repairTextLayerSymbols(f.reader,0,domPage('$17.25%; P¼.004')))?.items[0]?.text,'$17.25%; P¼.004');
 }
});

test('source evidence is shared across paths but isolated between documents with the same font identity',async()=>{
 const chars=[{c:'1⁄4',u:'¼',fontName:'math',rect:[0,0,8,8]}];
 const math=await adapterFixture({chars});
 assert.equal((await getTextContentItems(math.reader,0))?.items[0]?.text,'≥17.25%');
 assert.equal((await getPageData(math.reader,0)).pageData.chars[0]?.c,'=');
 assert.equal((await repairTextLayerSymbols(math.reader,0,domPage('$12%; P¼.02')))?.items[0]?.text,'≥12%; P=.02');
 assert.equal(math.operatorReads(),1,'one complete source-evidence collection is reused across reader paths');
 assert.equal(math.byteReads(),1,'original PDF bytes are not reparsed for each path');
 const ordinary=await adapterFixture({ordinaryOnly:true,chars});
 assert.deepEqual((await getTextContentItems(ordinary.reader,0))?.items.map(i=>i.text),['$17.25%','P¼.004']);
 assert.equal((await getPageData(ordinary.reader,0)).pageData.chars[0]?.c,'1⁄4');
 assert.equal((await repairTextLayerSymbols(ordinary.reader,0,domPage('$12; ¼ sample')))?.items[0]?.text,'$12; ¼ sample');
 assert.equal((await repairTextLayerSymbols(math.reader,0,domPage('$12%; P¼.02')))?.items[0]?.text,'≥12%; P=.02');
});

test('DOM repair without candidates leaves snapshots untouched and makes no evidence request',async()=>{
 const f=await adapterFixture(),page=domPage('Correct ≥17.25%; P=.004; ordinary prose.');
 assert.equal(await repairTextLayerSymbols(f.reader,0,page),page);
 assert.equal(await repairTextLayerSymbols(f.reader,0,null),null);
 assert.equal(f.operatorReads(),0);
 assert.equal(f.byteReads(),0);
});
