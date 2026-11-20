import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TranslationManager, type TranslationDeps} from '../../src/translation/translationManager';
import {writePage, cacheWriteStats, resetCacheWriteStats} from '../../src/cache/cacheManager';
import type {TranslatedBlock, TranslationResponse} from '../../src/types/models';

const deferred = <T>() => {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(r => {resolve=r;});
 return {promise,resolve};
};
function deps(overrides: Partial<TranslationDeps> = {}): TranslationDeps {
 return {extractPage:async pageIndex=>[{id:`b${pageIndex}`,pageIndex,order:0,type:'paragraph',sourceText:'An ordinary source paragraph for testing.'}],
  readCache:async()=>null,writeCache:async()=>true,
  translateRequest:async request=>({translations:request.blocks.map(b=>({id:b.id,translatedText:'Traduction complète.'}))}),
  getLanguages:()=>({source:'en',target:'fr'}),getDocumentTitle:()=>'',getGlossary:()=>[],useContext:()=>false,pageCount:()=>10,...overrides};
}
function manager(d:TranslationDeps) {
 return new TranslationManager(d,{onPageUpdate:()=>{}},{prefetch:false,retainLimit:1,maxConcurrent:2});
}
const key={attachmentKey:'a',fileHash:'f',pageIndex:0,sourceLanguage:'en',targetLanguage:'fr',provider:'p',model:'m',promptVersion:1,
 customPromptHash:'',glossaryHash:'',noTranslateHash:'',settingsHash:'',sourceTextHash:'s'};

test('actual cache disk failure is reported and the only in-memory translations survive retention', async()=>{
 const globals=globalThis as any;
 globals.Zotero={DataDirectory:{dir:'/data'}};
 globals.PathUtils={join:(...parts:string[])=>parts.join('/'),parent:(path:string)=>path.slice(0,path.lastIndexOf('/')),filename:(path:string)=>path.slice(path.lastIndexOf('/')+1)};
 globals.IOUtils={makeDirectory:async()=>{},writeJSON:async()=>{throw Error('disk full');},setPermissions:async()=>{}};
 resetCacheWriteStats();
 const m=manager(deps({writeCache:(pageIndex,_blocks,translations)=>writePage({...key,pageIndex},translations)}));
 try {
  for(let page=0;page<5;page++){await m.ensurePage(page,10);m.setCurrentPage(page);}
  assert.equal(cacheWriteStats().failures,5);
  const first=m.getPageState(0)!;
  assert.equal(first.status,'done','a cache failure does not fail successful translation');
  assert.equal(first.cached,false);
  assert.notEqual(first.evicted,true);
  assert.equal(first.translations.size,1);
 } finally {m.dispose();delete globals.Zotero;delete globals.PathUtils;delete globals.IOUtils;}
});

test('throwing cache adapters retain translations while confirmed successful writes allow eviction',async()=>{
 for(const success of [false,true]) {
  const m=manager(deps({writeCache:async()=>{if(!success)throw Error('write failure');return true;}}));
  try {
   for(let page=0;page<5;page++){await m.ensurePage(page,10);m.setCurrentPage(page);}
   const first=m.getPageState(0)!;
   assert.equal(first.cached,success);
   assert.equal(first.evicted===true,success);
   assert.equal(first.translations.size,success?0:1);
  } finally {m.dispose();}
 }
});

test('page refresh cancels an older paragraph retry before it can overwrite fresh translations or caches',async()=>{
 let phase:'initial'|'paragraph'|'fresh'='initial';
 const started=deferred<void>(), response=deferred<TranslationResponse>();
 let retrySignal:AbortSignal|undefined;
 let stored:TranslatedBlock[]=[];
 const updates:string[]=[];
 const m=new TranslationManager(deps({writeCache:async(_p,_b,t)=>{stored=t.map(x=>({...x}));return true;},
  translateRequest:async(request,signal)=>{
   if(phase==='paragraph'){retrySignal=signal;started.resolve();return response.promise;}
   return {translations:request.blocks.map(b=>({id:b.id,translatedText:phase==='fresh'?'Nouvelle traduction.':'Initiale traduction.'}))};
  }}),{onPageUpdate:s=>updates.push(s.translations.get('b0')??'')},{prefetch:false,maxConcurrent:2});
 try {
  await m.ensurePage(0,10);phase='paragraph';const retry=m.retranslateBlock(0,'b0');await started.promise;
  phase='fresh';const refresh=m.retranslatePage(0,'force');
  // Cancellation may unwind asynchronously; finish an abort-ignoring adapter
  // only after the refresh has had a chance to invalidate the old page state.
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  response.resolve({translations:[{id:'b0',translatedText:'Réponse ancienne.'}]});
  await refresh;
  assert.equal(await retry,false);
  assert.equal(retrySignal?.aborted,true);
  assert.equal(m.getPageState(0)?.translations.get('b0'),'Nouvelle traduction.');
  assert.equal(stored[0]?.translatedText,'Nouvelle traduction.');
  assert.ok(!updates.includes('Réponse ancienne.'));
 } finally {m.dispose();}
});

test('an old page-cache write cannot mark a newer paragraph replacement as durable',async()=>{
 const firstWrite=deferred<void>(), writeStarted=deferred<void>(), segmentWrite=deferred<void>();
 let writes=0, requests=0;
 const m=manager(deps({writeCache:async()=>{writes++;if(writes===1){writeStarted.resolve();await firstWrite.promise;}return true;},
  writeSegments:async()=>{await segmentWrite.promise;},
  translateRequest:async request=>({translations:request.blocks.map(b=>({id:b.id,translatedText:++requests===1?'Première traduction.':'Nouvelle traduction.'}))})}));
 try {
  const initial=m.ensurePage(0,10);await writeStarted.promise;
  const retry=m.retranslateBlock(0,'b0');
  for(let i=0;i<20 && m.getPageState(0)?.translations.get('b0')!=='Nouvelle traduction.';i++)await Promise.resolve();
  assert.equal(m.getPageState(0)?.translations.get('b0'),'Nouvelle traduction.');
  firstWrite.resolve();await initial;
  assert.equal(m.getPageState(0)?.cached,false,'old persisted text is not the new in-memory revision');
  segmentWrite.resolve();assert.equal(await retry,true);
  assert.equal(m.getPageState(0)?.cached,true);
 } finally {firstWrite.resolve();segmentWrite.resolve();m.dispose();}
});

test('older persistence cannot authorise eviction while a compressed replacement is pending or failed',async()=>{
 const initialWrite=deferred<void>(), initialStarted=deferred<void>();
 const compressedWrite=deferred<void>(), compressedStarted=deferred<void>();
 let writes=0,requests=0;
 const m=manager(deps({writeCache:async()=>{
  if(++writes===1){initialStarted.resolve();await initialWrite.promise;return true;}
  compressedStarted.resolve();await compressedWrite.promise;return false;
 },translateRequest:async request=>({translations:request.blocks.map(b=>({id:b.id,
  translatedText:++requests===1?'Initiale traduction beaucoup plus longue.':'Courte.'}))})}));
 try {
  const initial=m.ensurePage(0,10);await initialStarted.promise;
  const compression=m.compressBlocks(0,[{id:'b0',maxChars:10}]);await compressedStarted.promise;
  assert.equal(m.getPageState(0)?.translations.get('b0'),'Courte.');
  initialWrite.resolve();await initial;
  assert.equal(m.getPageState(0)?.cached,false,'older success cannot mark the pending replacement saved');
  compressedWrite.resolve();await compression;
  assert.equal(m.getPageState(0)?.cached,false,'failed compressed persistence keeps the only copy in memory');
 } finally {initialWrite.resolve();compressedWrite.resolve();m.dispose();}
});

test('5.0: provisional translations are shown and page-cached with a flag, never put in the segment store', async()=>{
 const pageRows:TranslatedBlock[][]=[];const segWrites:string[]=[];
 const m=manager(deps({
  writeCache:async(_p,_blocks,rows)=>{pageRows.push(rows);return true;},
  writeSegments:async(_p,entries)=>{segWrites.push(...entries.map(e=>e.translatedText));},
  translateRequest:async request=>({translations:request.blocks.map(b=>({id:b.id,translatedText:'Traduction par colonne.'})),provisionalIds:request.blocks.map(b=>b.id)})
 }));
 try {
  await m.ensurePage(0,10);
  const state=m.getPageState(0)!;
  assert.equal(state.translations.get('b0'),'Traduction par colonne.','临时译文照常显示');
  assert.equal(pageRows.length,1,'联网校验: 回访不再整页重付费 —— 页缓存写入');
  assert.ok(pageRows[0]!.every(r=>r.provisional===true),'带临时标记');
  assert.deepEqual(segWrites,[],'段落库不写');
 } finally {m.dispose();}
});

test('5.0: a cached provisional row is restored as provisional and stays out of the segment store', async()=>{
 const segWrites:string[]=[];
 const m=manager(deps({
  readCache:async()=>[{id:'b0',translatedText:'Traduction par colonne.',provisional:true}],
  writeSegments:async(_p,entries)=>{segWrites.push(...entries.map(e=>e.translatedText));},
  translateRequest:async()=>{throw new Error('a full cache hit must not request');}
 }));
 try {
  await m.ensurePage(0,10);
  const state=m.getPageState(0)!;
  assert.equal(state.translations.get('b0'),'Traduction par colonne.');
  assert.equal(state.provisional?.has('b0'),true);
  assert.deepEqual(segWrites,[]);
 } finally {m.dispose();}
});

test('5.0 审核: 临时标记挂在页状态上 —— 压缩重译的临时译文带标记进页缓存、不进段落库;单段重译拿到正式译文后撤销标记', async()=>{
 let pageWrites=0;const segWrites:string[]=[];let mode:'provisional'|'final'|'shortProv'='provisional';
 const m=manager(deps({
  writeCache:async()=>{pageWrites++;return true;},
  writeSegments:async(_p,entries)=>{segWrites.push(...entries.map(e=>e.translatedText));},
  translateRequest:async request=>{
   if(mode==='provisional')return {translations:request.blocks.map(b=>({id:b.id,translatedText:'Traduction par colonne, longue version.'})),provisionalIds:request.blocks.map(b=>b.id)};
   if(mode==='shortProv')return {translations:request.blocks.map(b=>({id:b.id,translatedText:'Courte colonne.'})),provisionalIds:request.blocks.map(b=>b.id)};
   return {translations:request.blocks.map(b=>({id:b.id,translatedText:'Traduction conjointe.'}))};
  }
 }));
 try {
  await m.ensurePage(0,10);
  const state=m.getPageState(0)!;
  assert.ok(state.provisional?.has('b0'));
  mode='shortProv';
  const shorter=await m.compressBlocks(0,[{id:'b0',maxChars:20}]);
  assert.equal(shorter.get('b0'),'Courte colonne.');
  assert.ok(pageWrites>=1,'压缩后的临时译文带标记写页缓存');
  assert.deepEqual(segWrites,[],'但不写段落库');
  const before=pageWrites;
  mode='final';
  assert.equal(await m.retranslateBlock(0,'b0'),true);
  assert.equal(state.provisional?.has('b0'),false,'拿到正式译文后撤销临时标记');
  assert.equal(pageWrites,before+1,'拿到正式译文后整页重写缓存');
  assert.deepEqual(segWrites,['Traduction conjointe.']);
 } finally {m.dispose();}
});
