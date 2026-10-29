import {test} from 'node:test';
import assert from 'node:assert/strict';
import {technicalUnitIssue} from '../../src/translation/technicalUnits';
import {PlaceholderRegistry} from '../../src/translation/placeholderRegistry';
import {TranslationManager, looksTranslated, translationRejectReason, type TranslationDeps} from '../../src/translation/translationManager';

const source='Low-keV reconstructions improve contrast without changing the acquisition voltage of 110 kVp.';
function deps(overrides:Partial<TranslationDeps>={}):TranslationDeps {
 return {extractPage:async()=>[{id:'b',pageIndex:0,order:0,type:'paragraph',sourceText:source}],readCache:async()=>null,writeCache:async()=>true,
  translateRequest:async request=>({translations:request.blocks.map(b=>({id:b.id,translatedText:'低'+(b.text.match(/⟦PM\d+⟧/g)??[]).join('，')+'重建提高对比度，采集电压不变。'}))}),
  getLanguages:()=>({source:'en',target:'zh-CN'}),getDocumentTitle:()=>'',getGlossary:()=>[],useContext:()=>false,pageCount:()=>1,...overrides};
}
const correct=(masked:string)=>{const labels=masked.match(/⟦PM\d+⟧/g)??[];return `低${labels[0]}重建提高对比度，采集电压仍为110 ${labels[1]}。`;};

test('case-sensitive technical quantities never substitute energy, voltage or dose prefixes',()=>{
 for(const [s,t] of [['low-keV image','低kVp图像'],['90 kVp','90 keV'],['2 mGy','2 Gy'],['3 mSv','3 Sv'],['70 keV','70 KeV']]) {
  assert.equal(technicalUnitIssue(s!,t!),'technical-unit',s);
  assert.equal(looksTranslated(s!,t!,'fr'),false,s);
  assert.equal(translationRejectReason(s!,t!,'fr'),'technical-unit',s);
 }
 assert.equal(technicalUnitIssue('low-keV image','低keV图像'),null);
 assert.equal(technicalUnitIssue('6 mGy·cm','6 mGy cm'),null);
 assert.equal(technicalUnitIssue('6 mGy·cm','6 mGy/cm'),'technical-unit');
 assert.deepEqual(PlaceholderRegistry.protect('6 mGy · cm').entries.map(p=>p.original),['mGy · cm']);
 assert.equal(technicalUnitIssue('3 µSv','3 μSv'),null);
 assert.equal(technicalUnitIssue('keVibration and myGyroscope','任意普通文字'),null,'unit substrings inside words are not measurements');
});

test('units in mixed-quantity paragraphs retain both their counts and numeric associations',()=>{
 const s='Reconstruction used 45 keV and acquisition used 100 kVp; low-keV images were compared.';
 assert.equal(technicalUnitIssue(s,'45 kVp重建，100 keV采集，对比低keV图像。'),'technical-unit-value');
 assert.equal(technicalUnitIssue(s,'45 keV重建，100 kVp采集，对比低kVp图像。'),'technical-unit');
 assert.equal(technicalUnitIssue(s,'45 keV重建，100 kVp采集，对比低keV图像。'),null);
});

test('the existing registry signs each atomic unit and restores exact labels without guessing replacements',()=>{
 const reg=PlaceholderRegistry.protect(source);
 assert.deepEqual(reg.entries.map(p=>p.original),['keV','kVp']);
 assert.ok(!reg.text.includes('keV'));assert.ok(!reg.text.includes('kVp'));
 assert.equal(reg.ok(correct(reg.text)),true);
 const restored=reg.restore(correct(reg.text));
 assert.equal(technicalUnitIssue(source,restored),null);
 assert.equal(reg.ok('低kVp重建提高对比度，110 kVp采集。'),false);
 const collision=PlaceholderRegistry.protect('An existing ⟦PM6⟧ with low-keV images.');
 assert.equal(new Set(collision.entries.map(p=>p.token)).size,collision.entries.length);
 assert.equal(collision.restore(collision.text),'An existing ⟦PM6⟧ with low-keV images.');
});

test('wrong raw page/segment cache entries cannot bypass provider protection',async()=>{
 for(const cache of ['page','segment'] as const) {
  let requests=0;
  const d=deps({readCache:async()=>cache==='page'?[{id:'b',translatedText:'低kVp重建提高对比度，采集电压仍为110 kVp。'}]:null,
   readSegments:async(_page,hashes)=>cache==='segment'?new Map(hashes.map(h=>[h,'低kVp重建提高对比度，采集电压仍为110 kVp。'])):null,
   translateRequest:async request=>{requests++;return {translations:request.blocks.map(b=>({id:b.id,translatedText:correct(b.text)}))};}});
  const m=new TranslationManager(d,{onPageUpdate:()=>{}},{prefetch:false});
  try {await m.ensurePage(0,10);assert.equal(requests,1,cache);assert.equal(technicalUnitIssue(source,m.getPageState(0)!.translations.get('b')!),null);}
  finally{m.dispose();}
 }
});

test('raw responses and final plain recovery never accept a wrong unit, and retries remain bounded',async()=>{
 let requests=0,writes=0;
 const m=new TranslationManager(deps({writeCache:async()=>{writes++;return true;},translateRequest:async request=>{
  requests++;return {translations:request.blocks.map(b=>({id:b.id,translatedText:'低kVp重建提高对比度，采集电压仍为110 kVp。'}))};
 }}),{onPageUpdate:()=>{}},{prefetch:false,delayFn:async()=>{}});
 try {await m.ensurePage(0,10);assert.equal(m.getPageState(0)?.translations.size,0);assert.equal(writes,0);assert.match(m.getPageState(0)?.rejectReasons?.get('b')??'',/technical-unit/,'diagnostics expose the unit rejection');assert.ok(requests>1 && requests<12,`bounded requests: ${requests}`);}
 finally{m.dispose();}
});

test('manual retry and compression cannot replace a correct stored unit with a wrong raw unit',async()=>{
 let bad=false;
 const m=new TranslationManager(deps({translateRequest:async request=>({translations:request.blocks.map(b=>({id:b.id,
  translatedText:bad?'低kVp，110 kVp。':correct(b.text)}))})}),{onPageUpdate:()=>{}},{prefetch:false});
 try {
  await m.ensurePage(0,10);const original=m.getPageState(0)!.translations.get('b');bad=true;
  assert.equal(await m.retranslateBlock(0,'b'),false);
  assert.equal((await m.compressBlocks(0,[{id:'b',maxChars:20}])).size,0);
  assert.equal(m.getPageState(0)!.translations.get('b'),original);
 }finally{m.dispose();}
});

test('archived display snapshots discard incompatible units before they can appear as done',async()=>{
 const m=new TranslationManager(deps({restoreSnapshot:async()=>({pageIndex:0,status:'done',blocks:[{id:'b',pageIndex:0,order:0,type:'paragraph',sourceText:source}],
  translations:new Map([['b','低kVp重建，110 kVp采集。']]),cached:true})}),{onPageUpdate:()=>{}},{prefetch:false});
 try {const saved=await m.restoreForDisplay(0);assert.equal(saved?.status,'idle');assert.equal(saved?.cached,false);assert.equal(saved?.translations.size,0);}
 finally{m.dispose();}
});

test('numeric raised powers are protected whole and raw digit flattening fails every language gate',()=>{
 for(const literal of ['1024²','768²','512³','10⁻³','3.5²','1,024²','.5²','−3²','-.25³']) {
  const s=`The matrix or quantity was ${literal}.`;
  const reg=PlaceholderRegistry.protect(s);
  assert.ok(reg.entries.some(p=>p.original===literal),literal);
  assert.equal(reg.restore(reg.text),s);
  const flattened=s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,c=>'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c).toString()).replace(/⁻/g,'-');
  assert.equal(looksTranslated(s,flattened,'fr'),false,literal);
  assert.equal(translationRejectReason(s,flattened,'fr'),'numeric-power',literal);
 }
 // Bibliographic word superscripts are not inferred to be numeric powers.
 const citation=PlaceholderRegistry.protect('An evidence¹² citation and word² label.');
 assert.equal(citation.count,0);
 assert.equal(looksTranslated('A flat 5123 matrix.','矩阵5123。','fr'),true,'no guessing powers from flat digits');
});

test('power-flattened cache and final fallback cannot enter the accepted translation set',async()=>{
 const s='The reconstruction used a 512³ matrix for complete volume sampling.';
 const bad='重建使用5123矩阵完成体积采样。';let calls=0,writes=0;
 const m=new TranslationManager(deps({extractPage:async()=>[{id:'b',pageIndex:0,order:0,type:'paragraph',sourceText:s}],
  readCache:async()=>[{id:'b',translatedText:bad}],readSegments:async(_p,hashes)=>new Map(hashes.map(h=>[h,bad])),
  translateRequest:async request=>{calls++;return {translations:request.blocks.map(b=>({id:b.id,translatedText:bad}))};},
  writeCache:async()=>{writes++;return true;}}),{onPageUpdate:()=>{}},{prefetch:false,delayFn:async()=>{}});
 try {await m.ensurePage(0,10);assert.equal(m.getPageState(0)?.translations.size,0);assert.equal(writes,0);assert.match(m.getPageState(0)?.rejectReasons?.get('b')??'',/numeric-power/);assert.ok(calls>0&&calls<12);}
 finally {m.dispose();}
});


test('signed and leading-decimal numeric powers cannot lose their signs or decimal points',()=>{
 assert.equal(translationRejectReason('−3²','3²','fr'),'numeric-power');
 assert.equal(translationRejectReason('.5²','.52','fr'),'numeric-power');
 assert.equal(translationRejectReason('-.25³','.25³','fr'),'numeric-power');
 assert.equal(PlaceholderRegistry.protect('.5²').entries[0]?.original,'.5²');
 assert.equal(PlaceholderRegistry.protect('−3²').entries[0]?.original,'−3²');
});

test('measurement grouping and decimal formatting preserve exact values without tail or float rounding',()=>{
 for(const [source,target] of [['1000 keV','1,000 keV'],['1,000 keV','1000 keV'],['1.00e3 keV','1,000 keV'],
  ['6 mGy · cm','6 mGy·cm'],['6 mGy cm','6 mGy × cm']]) assert.equal(technicalUnitIssue(source!,target!),null);
 assert.equal(technicalUnitIssue('1,000 keV','0 keV'),'technical-unit-value');
 assert.equal(technicalUnitIssue('9007199254740993 keV','9007199254740992 keV'),'technical-unit-value');
});


test('space, NBSP and narrow-NBSP thousands groups are parsed whole, while unsupported groups never bind their tail',()=>{
 for(const separator of [' ','\u00a0','\u202f']) {
  assert.equal(technicalUnitIssue(`1${separator}000 keV`,'1000 keV'),null);
  assert.equal(technicalUnitIssue('1000 keV',`1${separator}000 keV`),null);
  assert.equal(technicalUnitIssue(`1${separator}000 keV`,'0 keV'),'technical-unit-value');
  assert.equal(technicalUnitIssue(`1${separator}00 keV`,'0 keV'),'technical-unit-value','unsupported grouping is never a trailing-zero value');
 }
 assert.equal(technicalUnitIssue('1\u2009000 keV','0 keV'),'technical-unit-value','unsupported thin-space format remains one literal, never a tail');
 assert.equal(technicalUnitIssue('1,00 keV','0 keV'),'technical-unit-value');
});


test('formatting markers cannot change literal or numeric unit validation',()=>{
 assert.equal(technicalUnitIssue('110 kVp','⟦b⟧110⟦/b⟧ kVp'),null);
 assert.equal(technicalUnitIssue('110 kVp','⟦b⟧110⟦/b⟧ keV'),'technical-unit');
 assert.equal(looksTranslated('The grid uses 512³ samples.','网格使用512⟦b⟧³⟦/b⟧个样本。','zh-CN'),true);
 assert.equal(looksTranslated('The grid uses 512³ samples.','网格使用512⟦b⟧3⟦/b⟧个样本。','zh-CN'),false);
});


test('known length units with explicit raised numeric powers are signed as complete unit labels',()=>{
 for(const label of ['mm²','cm³','m²','μm⁻²','µm⁻²','um³']) {
  const source=`The measured quantity was 0.4 ${label}.`;
  const reg=PlaceholderRegistry.protect(source);
  assert.ok(reg.entries.some(entry=>entry.original===label),label);
  assert.equal(reg.restore(reg.text),source);
  assert.equal(technicalUnitIssue(source,`测量值为0.4 ${label}。`),null,label);
  const flattened=label.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,c=>'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c).toString()).replace(/⁻/g,'-');
  assert.equal(technicalUnitIssue(source,`测量值为0.4 ${flattened}。`),'technical-unit',label);
  assert.equal(looksTranslated(source,`测量值为0.4 ${flattened}。`,'zh-CN'),false,label);
 }
 assert.equal(technicalUnitIssue('0.4 μm⁻²','0.4 µm⁻²'),null,'micro sign typography has the same physical unit');
 assert.equal(technicalUnitIssue('0.4 cm³','0.4 cm²'),'technical-unit');
});

test('length-power recognition neither invents powers from flat labels nor treats word citations as units',()=>{
 for(const source of ['word¹²','algorithm²','form²','cm2','mm3','m2','um2','Modelcm²','model_mm²','CM²','cm²Model']) {
  const reg=PlaceholderRegistry.protect(source);
  assert.equal(reg.count,0,source);
  assert.equal(technicalUnitIssue(source,'plain translated prose'),null,source);
 }
});

test('old unit-power cache entries and raw recovery cannot accept a flattened length exponent',async()=>{
 const s='The region area was 0.4 cm² for the measurement.';
 const bad='测量区域面积为0.4 cm2。';let writes=0,calls=0;
 const m=new TranslationManager(deps({extractPage:async()=>[{id:'b',pageIndex:0,order:0,type:'paragraph',sourceText:s}],
  readCache:async()=>[{id:'b',translatedText:bad}],readSegments:async(_p,hashes)=>new Map(hashes.map(h=>[h,bad])),
  translateRequest:async request=>{calls++;return {translations:request.blocks.map(b=>({id:b.id,translatedText:bad}))};},
  writeCache:async()=>{writes++;return true;}}),{onPageUpdate:()=>{}},{prefetch:false,delayFn:async()=>{}});
 try {await m.ensurePage(0,10);assert.equal(m.getPageState(0)?.translations.size,0);assert.equal(writes,0);
  assert.match(m.getPageState(0)?.rejectReasons?.get('b')??'',/technical-unit/);assert.ok(calls>0&&calls<12);}
 finally {m.dispose();}
});
