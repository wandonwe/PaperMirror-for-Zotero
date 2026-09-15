import test from 'node:test';
import assert from 'node:assert/strict';
import { pageTables, auditTableModel } from '../../src/ir/tableModel';
import { semanticBoundary } from '../../src/reader/semanticBoundary';
import { extractAbbreviationTables } from '../../src/reader/abbreviationTable';
import fixture from '../fixtures/regression/stroke2026-e321.json';
import type { SpanItem } from '../../src/reader/spanBlockBuilder';

test('table model is a shared ordered view with evidence, and catches switched columns',()=>{
 const {cells}=extractAbbreviationTables(fixture.items as SpanItem[],5,585,783);
 assert.deepEqual(auditTableModel(cells),[]);
 assert.equal(pageTables(cells)[0]?.evidence,'paired-headers');
 const a=cells.find(c=>c.tableRow===1&&c.tableCol===0)!,b=cells.find(c=>c.tableId===a.tableId&&c.tableRow===1&&c.tableCol===1)!;
 const broken=cells.map(c=>c===a?{...a,tableContentRectPdf:b.tableContentRectPdf}:c===b?{...b,tableContentRectPdf:a.tableContentRectPdf}:c);
 assert.ok(auditTableModel(broken).some(s=>s.startsWith('table-column-order:')));
});
test('semantic boundaries separate section headings and endorsement from credentialed byline',()=>{
 for(const [a,b] of [['Endorsed by the society.','Guideline Writing Group'],['Guideline Writing Group','Shyam Prabhakaran, MD'],['Last paragraph.','References']]) assert.equal(semanticBoundary(a!,b!),true);
 assert.equal(semanticBoundary('Author contributions: Study design,','X.Y., J. Zhang; analysis, Z.Y.'),false);
 assert.equal(semanticBoundary('The finding was associated with','improved outcomes in both groups.'),false);
});

test('rejection diagnostics distinguish echo, truncation and success without exposing text',async()=>{
 const {translationRejectReason}=await import('../../src/translation/translationManager');
 const s='The treatment was associated with a significant improvement in clinical outcomes and the observed benefit remained consistent across all groups.';
 assert.equal(translationRejectReason(s,s,'zh-CN'),'echo');
 assert.equal(translationRejectReason(s.repeat(5),'好','zh-CN'),'truncated');
 assert.equal(translationRejectReason('Document Title','文档标题','zh-CN'),null);
});

test('completed page notifications do not rebuild an unchanged rendered page, but changed text does',async()=>{
 const {TranslationPane}=await import('../../src/ui/translationPane');
 const pane=Object.create(TranslationPane.prototype) as any;
 pane.viewKind='page';pane.finalPageKeys=new Map();pane.slotState=['translated'];pane.slotDirty=[false];pane.slotRenderedRevision=[];
 let refreshes=0;pane.refreshPage=()=>{refreshes++;};
 const state:any={pageIndex:0,status:'done',translationRevision:1,blocks:[{id:'a',sourceText:'Body',pageIndex:0,order:0,type:'paragraph'}],translations:new Map([['a','正文']])};
 pane.renderPage(state);pane.renderPage(state);assert.equal(refreshes,1);
 state.translations.set('a','新正文');state.translationRevision++;pane.renderPage(state);assert.equal(refreshes,2);
 pane.slotState[0]='empty';pane.renderPage(state);assert.equal(refreshes,3,'evicted slot must render again');
});

test('mixed byline/prose paragraphs validate independently without permitting an echoed prose paragraph',async()=>{
 const {looksTranslated}=await import('../../src/translation/translationManager');
 const author='John A. Smith, Maria García, Wei Zhang, and Pierre Dubois';
 const prose='The measurement protocol was applied to every cohort in the study and the resulting attenuation values were subsequently normalized against baseline scans acquired before contrast injection.';
 assert.equal(looksTranslated(author+'\n\n'+prose,author+'\n\n'+'该测量方案应用于研究中的每个队列，随后将所得衰减值对比注射对比剂前采集的基线扫描进行归一化。','zh-CN'),true);
 assert.equal(looksTranslated(author+'\n\n'+prose,author+'\n\n'+prose,'zh-CN'),false);
});
test('structure cache is bounded, input-version keyed, and immune to caller mutation',async()=>{
 const {StructureCache}=await import('../../src/reader/structureCache');
 const c=new StructureCache(2);const a:any[]=[{id:'a',sourceText:'original'}];c.put('v1:page1',a);a[0].sourceText='changed';
 assert.equal(c.get('v1:page1')?.[0]?.sourceText,'original');assert.equal(c.get('v2:page1'),null);
 c.get('v1:page1')![0]!.sourceText='also changed';assert.equal(c.get('v1:page1')?.[0]?.sourceText,'original');
 c.put('v1:page2',a);c.put('v1:page3',a);assert.equal(c.get('v1:page1'),null);
 const tiny=new StructureCache(2,4);tiny.put('a',a);assert.equal(tiny.get('a'),null);
});

test('measurement cache invalidates for text, geometry and font loading, and never caches detached nodes',async()=>{
 const {RenderMeasurementCache}=await import('../../src/ui/measurementCache');
 const events:Record<string,()=>void>={};const doc:any={fonts:{status:'loaded',addEventListener:(n:string,fn:()=>void)=>events[n]=fn},defaultView:{getComputedStyle:()=>({font:'10px serif'})}};
 const node:any={ownerDocument:doc,isConnected:true,style:{cssText:'width:100px'}};const cache=new RenderMeasurementCache();let reads=0;const read=()=>{reads++;return {width:100,height:20};};
 cache.measure(node,'one',read);cache.measure(node,'one',read);assert.equal(reads,1);
 cache.measure(node,'two',read);assert.equal(reads,2);node.style.cssText='width:50px';cache.measure(node,'two',read);assert.equal(reads,3);
 events.loadingdone!();cache.measure(node,'two',read);assert.equal(reads,4);
 node.isConnected=false;cache.measure(node,'two',read);cache.measure(node,'two',read);assert.equal(reads,6);
});

test('saved translations belong to the PDF page used for their visual background',async()=>{
 const {default:pages}=await import('../fixtures/regression/real-translations.json');
 const normalized=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
 for(const page of pages){
  const original=normalized(page.originalPdfText);
  const snippets=page.blocks.map(b=>normalized(b.sourceText)).filter(s=>s.length>=40).map(s=>s.slice(0,40));
  assert.ok(snippets.filter(s=>original.includes(s)).length/snippets.length>=.75,`wrong PDF background: ${page.origin}, page ${page.page}`);
 }
});

test('extractor coalesces concurrent work, reuses stable structure and invalidates changed options',async()=>{
 const {TextExtractor}=await import('../../src/reader/textExtractor');const {StructureCache}=await import('../../src/reader/structureCache');
 const x=Object.create(TextExtractor.prototype) as any;x.structureCache=new StructureCache();x.extracting=new Map();x.inputsByPage=new Map();x.pathByPage=new Map();x.phasesByPage=new Map();
 let option=false,calls=0;
 x.currentExtractInputs=()=>({includeReferences:option});
 x.extractPageUncached=async(page:number)=>{calls++;await Promise.resolve();x.pathByPage.set(page,'text-content');return [{id:'a',sourceText:'original',pageIndex:page,order:0,type:'paragraph'}];};
 const [a,b]=await Promise.all([x.extractPage(0),x.extractPage(0)]);assert.equal(calls,1);a[0].sourceText='mutated';assert.equal(b[0].sourceText,'original');
 assert.equal((await x.extractPage(0))[0].sourceText,'original');assert.equal(calls,1);
 option=true;await x.extractPage(0);assert.equal(calls,2);
 x.extractPageUncached=async(page:number)=>{calls++;x.pathByPage.set(page,'text-layer');return [{id:'dom',sourceText:'unstable'}];};
 await x.extractPage(1);await x.extractPage(1);assert.equal(calls,4,'DOM-derived structure must not be cached');
});
