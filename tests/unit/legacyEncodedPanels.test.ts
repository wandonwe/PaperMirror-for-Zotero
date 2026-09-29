import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/blankstein2009-encoded-panels.json';
import {PDFDocument,PDFName} from 'pdf-lib';
import {legacyFontEncodings,decodeLegacyText} from '../../src/reader/legacyTextEncoding';
import {removeCollapsedTextCopies} from '../../src/reader/collapsedTextCopies';
import {extractPanelTitles} from '../../src/reader/panelTitles';
import {extractAbbreviationTables,extractInlineDefinitions} from '../../src/reader/abbreviationTable';
import {textContentItemRect} from '../../src/reader/zoteroReaderAdapter';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {looksTranslated,translationRejectReason} from '../../src/translation/translationManager';
function page(n:number) {
 const f=fixture.pages.find(p=>p.page===n)!;
 const fonts=f.fonts as unknown as Record<string,{name:string;differences:Record<number,string>}>;
 const items=f.items.map(i=>({text:decodeLegacyText(i.str,fonts[i.fontName]!.name,fonts[i.fontName]!.differences),...textContentItemRect(i.transform,i.width)!}));
 return {...f,items};
}
const chars=(s:string)=>[...s.replace(/\s/g,'')].sort().join('');
test('legacy symbols require font AND glyph encoding evidence, never a global control replacement',()=>{
 assert.equal(decodeLegacyText('\x01','ABCDEF+MathematicalPi-One',{1:'H11350'}),'≥');
 assert.equal(decodeLegacyText('\x01','ABCDEF+Universal-GreekwithMathPi',{1:'H11006'}),'±');
 assert.equal(decodeLegacyText('\x01','MathematicalPi-Four',{1:'H11549'}),'=');
 assert.equal(decodeLegacyText('\x01','Unknown',{1:'H11350'}),'\x01');
 assert.equal(decodeLegacyText('\x01','MathematicalPi-One',{1:'unknown'}),'\x01');
 assert.equal(decodeLegacyText('¼ ± 2','MathematicalPi-One',{1:'H11350'}),'¼ ± 2');
 const p=page(9);assert.ok(!p.items.some(i=>/[\x00-\x08\ufffd]/.test(i.text)));
 const built=buildBlocksFromSpans(p.items,{pageIndex:8,pageWidth:p.width,pageHeight:p.height}).blocks.map(b=>b.sourceText).join(' ');
 assert.match(built,/stenosis ≥50%/);assert.match(built,/2\.8 ± 0\.8/);assert.match(built,/score ≥3/);
});
test('invalid character outputs cannot be accepted or restored as valid translations',()=>{
 for(const bad of ['狭窄程度\x01 50%','狭窄程度�50%']) {
  assert.equal(looksTranslated('stenosis ≥50%',bad,'zh-CN'),false);
  assert.equal(translationRejectReason('stenosis ≥50%',bad,'zh-CN'),'invalid-character');
 }
 assert.equal(looksTranslated('stenosis ≥50%','狭窄程度≥50%','zh-CN'),true);
});
test('inline abbreviation sidebar has ten separate entries and conserves every source character',()=>{
 const p=page(2),g=extractAbbreviationTables(p.items,1,p.width,p.height);
 assert.equal(g.cells.length,11);
 assert.equal(g.cells[0]!.sourceText,'CAD = coronary artery disease');
 assert.equal(g.cells[9]!.sourceText,'SPECT = single-photon emission computed tomography');
 assert.equal(chars([...g.cells.map(b=>b.sourceText),...g.rest.map(i=>i.text)].join('')),chars(p.items.map(i=>i.text).join('')));
 for(const b of g.cells.filter(b=>b.tableId)) {assert.equal(b.translationMode,'translate');assert.ok(b.tableContentRectPdf![2]<560);}
 assert.equal(extractAbbreviationTables(p.items.filter(i=>i.text!=='Abbreviations'),1,p.width,p.height).cells.length,0);
});
test('collapsed heading copies are removed, while repeated phrases in ordinary locations stay',()=>{
 const p=page(7),clean=removeCollapsedTextCopies(p.items);
 for(const text of ['Per Vessel and Per Patient Diagnostic','Diagnostic Accuracy of CTP With SPECT']) {
  assert.equal(p.items.filter(i=>i.text===text).length,2);
  assert.equal(clean.filter(i=>i.text===text).length,1);
 }
 const repeat:SpanItem[]=[{text:'A legitimate repeated long sentence.',fontSize:8,rect:[10,10,100,18]},{text:'A legitimate repeated long sentence.',fontSize:8,rect:[10,30,100,38]}];
 assert.deepEqual(removeCollapsedTextCopies(repeat),repeat);
});
test('two independently titled tables stay separate from each other and adjacent body text',()=>{
 const p=page(7),built=buildBlocksFromSpans(p.items,{pageIndex:6,pageWidth:p.width,pageHeight:p.height,includeReferences:true}).blocks;
 const cells=structureTableCells(built,6,10,[],undefined,true,p.height);
 const tableIds=new Set(cells.filter(b=>b.tableId).map(b=>b.tableId));assert.equal(tableIds.size,2);
 assert.ok(cells.filter(b=>b.tableId).every(b=>!b.sourceText.includes('CTA examinations')&&!b.sourceText.includes('radiation exposure')));
 for(const id of tableIds) {
  const group=cells.filter(b=>b.tableId===id);
  assert.ok(group.every(b=>b.boundingBox!.x+b.boundingBox!.width<300)||group.every(b=>b.boundingBox!.x>300));
 }
 const final=finalizePageRegions(cells,p.height),body=final.find(b=>b.sourceText.includes('Among the 34 CTA examinations'))!;
 assert.match(body.sourceText,/categorized as having severe CAD\. Diagnostic accuracy/);
 assert.match(body.sourceText,/12\.7 ± 4\.0 mSv/);
 const titles=final.filter(b=>b.sourceRegion?.id.includes('panel-title'));
 assert.equal(titles.length,4);
 assert.ok(titles.some(b=>b.sourceText==='Diagnostic Accuracy of CTP With SPECT as Reference Standard for All Subjects (n = 34)'));
 assert.equal(chars(built.map(b=>b.sourceText).join('').replace(/-/g,'')),chars(removeCollapsedTextCopies(p.items).map(i=>i.text).join('').replace(/-/g,'')));
});
test('colored figure badge and title get separate, non-overlapping source regions',()=>{
 const p=page(6),panels=extractPanelTitles(removeCollapsedTextCopies(p.items),5,p.height);
 assert.equal(panels.blocks.length,2);
 assert.equal(panels.blocks[0]!.sourceText,'Figure 3');
 assert.equal(panels.blocks[1]!.sourceText,'Radiation Exposure of Stress Cardiac CT Versus SPECT MPI');
 assert.ok(panels.blocks[0]!.boundingBox!.x+panels.blocks[0]!.boundingBox!.width<panels.blocks[1]!.boundingBox!.x);
});

test('font encoding fallback reads the PDF resource dictionary once per document',async()=>{
 const pdf=await PDFDocument.create(),p=pdf.addPage();
 const font=pdf.context.register(pdf.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'ABCDEF+MathematicalPi-One',Encoding:{Differences:[1,'H11350', 'H9262', 'H11349']}}));
 p.node.set(PDFName.of('Resources'),pdf.context.obj({Font:{F1:font}}));
 const data=await pdf.save();let reads=0;const doc={getData:async()=>{reads++;return data;}};
 const [a,b]=await Promise.all([legacyFontEncodings(doc,0),legacyFontEncodings(doc,0)]);
 assert.equal(reads,1);assert.deepEqual(a,b);
 assert.equal(decodeLegacyText('\x01 50%', 'ABCDEF+MathematicalPi-One',a.get('ABCDEF+MathematicalPi-One')!),'≥ 50%');
});


test('first-page footnote and body columns keep complete prose, without false headings',()=>{
 const p=page(1),built=buildBlocksFromSpans(p.items,{pageIndex:0,pageWidth:p.width,pageHeight:p.height}).blocks;
 const final=finalizePageRegions(built,p.height);
 const body=final.find(b=>b.sourceText.startsWith('Thus, invasive'))!;
 assert.equal(body.type,'paragraph');assert.equal(body.column,1);
 assert.match(body.sourceText,/photon emission computed tomography/);
 assert.match(body.sourceText,/patients\.$/);
 const intro=final.find(b=>b.sourceText.startsWith('Although cardiac computed'))!;
 assert.equal(intro.type,'paragraph');assert.match(intro.sourceText,/nonobstructive plaque\.$/);
 const affiliations=final.find(b=>b.sourceText.startsWith('From the *Cardiac'))!;
 assert.match(affiliations.sourceText,/Lown Cardiovascular/);assert.equal(affiliations.column,0);
 assert.ok(!affiliations.sourceText.includes('Thus, invasive'));
 assert.ok(!final.some(b=>/[\x00-\x08]/.test(b.sourceText)));
 assert.match(final.find(b=>b.sourceText.startsWith('Adenosine stress CT can'))!.sourceText,/coronary stenosis\.$/);
});
test('single-line table badge and hidden title copy are independent',()=>{
 const p=page(4),clean=removeCollapsedTextCopies(p.items);
 assert.equal(clean.filter(i=>i.text==='CT Perfusion Scan Parameters').length,1);
 const panels=extractPanelTitles(clean,3,p.height);
 assert.ok(panels.blocks.some(b=>b.sourceText==='Table 1'));
 assert.ok(panels.blocks.some(b=>b.sourceText==='CT Perfusion Scan Parameters'));
 const badge=panels.blocks.find(b=>b.sourceText==='Table 1')!,title=panels.blocks.find(b=>b.sourceText==='CT Perfusion Scan Parameters')!;
 assert.ok(badge.boundingBox!.x+badge.boundingBox!.width<title.boundingBox!.x);
 const built=buildBlocksFromSpans(p.items,{pageIndex:3,pageWidth:p.width,pageHeight:p.height}).blocks;
 const final=finalizePageRegions(structureTableCells(built,3,10,[],undefined,true,p.height),p.height);
 const painted=final.find(b=>b.sourceText==='Table 1')!;
 assert.equal(painted.sourceRegion?.kind,'caption');assert.equal(painted.tableId,undefined);
 assert.equal(final.filter(b=>b.sourceText==='CT Perfusion Scan Parameters').length,1);
});
test('production text-content adapter decodes foreign-realm PDF bytes with empty font metadata and an unavailable font',async()=>{
 const {runInNewContext}=await import('node:vm');
 const {getTextContentItems}=await import('../../src/reader/zoteroReaderAdapter');
 const pdf=await PDFDocument.create(),p=pdf.addPage();
 const font=pdf.context.register(pdf.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'ABCDEF+MathematicalPi-Four',Encoding:{Differences:[1,'H11549']}}));
 p.node.set(PDFName.of('Resources'),pdf.context.obj({Font:{F1:font}}));
 const bytes=await pdf.save();const foreign=runInNewContext('Uint8Array.from(bytes)',{bytes:Array.from(bytes)});
 const raw=[{str:'Unavailable',fontName:'missing',width:30,transform:[8,0,0,8,10,100]},{str:'\x01',fontName:'encoded',width:8,transform:[8,0,0,8,50,100]}];
 const doc={getData:async()=>foreign,getPage:async()=>({view:[0,0,612,792],getTextContent:async()=>({items:raw}),getOperatorList:async()=>({}),commonObjs:{get:(id:string)=>{if(id==='missing')throw Error('font unresolved');return {name:'ABCDEF+MathematicalPi-Four',differences:[]};}}})};
 const reader={_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument:doc}}}}};
 const result=await getTextContentItems(reader as never,0);
 assert.equal(result?.items[1]?.text,'=');
});

test('PDF font binding can resolve asynchronously after the operator list',async()=>{
 const {resolvedPdfFont}=await import('../../src/reader/legacyTextEncoding');
 const font={name:'MathematicalPi-Four'};
 const objects={get:(_id:string,callback?:(f:unknown)=>void)=>{if(!callback)throw Error('not resolved');setTimeout(()=>callback(font),5);}};
 assert.equal(await resolvedPdfFont(objects,'f'),font);
});
test('panel title ownership must not disable body column ordering',()=>{
 for(const n of [4,5]) {
  const p=page(n),built=buildBlocksFromSpans(p.items,{pageIndex:n-1,pageWidth:p.width,pageHeight:p.height}).blocks;
  const final=finalizePageRegions(structureTableCells(built,n-1,10,[],undefined,true,p.height),p.height);
  if(n===4) {
   assert.match(final.find(b=>b.sourceText.startsWith('INVASIVE ANGIOGRAPHY.'))!.sourceText,/stenosis of each coronary segment\./);
  } else {
   const tail=final.find(b=>b.sourceText.includes('The CTA analysis was performed'))!;
   assert.ok(final.some(b=>b.sourceText.includes('uninterpretable')));
   assert.ok(tail.sourceText.includes('Each segment was graded'));
   assert.ok(!tail.sourceText.includes('Matching of perfusion'));
  }
 }
});

test('aligned glossary rows survive an undecoded repeated legacy separator',()=>{
 const p=page(2),raw=p.items.map(i=>({...i,text:i.text==='='?'\x01':i.text}));
 const result=extractInlineDefinitions(raw,1,p.width,p.height);
 assert.equal(result.cells.length,11);
 assert.ok(result.cells.filter(b=>b.tableId).every(b=>/^[A-Z]+ = /.test(b.sourceText)));
 assert.ok(result.cells.every(b=>!b.sourceText.includes('\x01')));
 assert.equal(extractInlineDefinitions(raw.filter(i=>i.text!=='Abbreviations'),1,p.width,p.height).cells.length,0);
});

test('glossary heading is independent and absent from body masks',()=>{
 const p=page(2),built=buildBlocksFromSpans(p.items,{pageIndex:1,pageWidth:p.width,pageHeight:p.height}).blocks;
 const blocks=finalizePageRegions(structureTableCells(built,1,10,[],undefined,true,p.height),p.height);
 const heading=blocks.find(b=>b.sourceText==='Abbreviations and Acronyms')!;
 assert.ok(heading);assert.equal(heading.translationMode,'translate');
 assert.equal(heading.sourceRegion?.kind,'caption');
 const r=heading.sourceRegion!.boundsPdf;
 for(const b of blocks.filter(b=>b!==heading)) {
  assert.ok(!/Abbreviations|and Acronyms/.test(b.sourceText));
  for(const box of b.lineRectsPdf??[])assert.ok(Math.min(box[2],r[2])<=Math.max(box[0],r[0])||Math.min(box[3],r[3])<=Math.max(box[1],r[1]));
 }
});
