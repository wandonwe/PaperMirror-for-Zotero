import test from 'node:test';
import assert from 'node:assert/strict';
import { PageArchive, pageContentKey } from '../../src/export/pageArchive';
import type { CorpusPageRecord } from '../../src/export/corpusJsonl';
const record=():CorpusPageRecord=>({spans:null,blocks:[{id:'a',sourceText:'source'}],blocksSource:'archived',check:{structureMatch:'as-translated',blocksCompared:1},translations:[{id:'a',translatedText:'译文'}],translationSource:'archived'});
test('archive survives eviction, freezes content before awaits and serializes placement with its translation',async()=>{
 const disk=new Map<number,string>();
 const archive=new PageArchive({write:async(p,s)=>{await Promise.resolve();disk.set(p,s);},read:async p=>disk.get(p)!,close:async()=>{disk.clear();}});
 const r=record();archive.put(0,'one',r);r.blocks.length=0;r.translations![0]!.translatedText='mutated';
 const saved=await archive.get(0,'one');assert.equal(saved?.blocks.length,1);assert.equal(saved?.translations?.[0]?.translatedText,'译文');
 archive.put(0,'two',{...record(),probe:['new']},true);
 assert.equal(await archive.get(0,'one'),null);assert.deepEqual((await archive.get(0,'two'))?.probe,['new']);
 archive.put(0,'two',record());assert.deepEqual((await archive.get(0,'two'))?.probe,['new'],'repeat notification must not erase placement');
 await archive.close();assert.equal(await archive.get(0),null);assert.equal(disk.size,0);
});
test('archive write failures cannot serve a stale disk record as the new revision',async()=>{
 let disk='',fail=false;
 const a=new PageArchive({write:async(_p,s)=>{if(fail)throw Error();disk=s;},read:async()=>disk,close:async()=>{}});
 a.put(0,'old',record());await a.get(0);fail=true;a.put(0,'new',record());assert.equal(await a.get(0,'new'),null);
});
test('content identity changes for geometry as well as translated text',()=>{
 const blocks:any[]=[{id:'x',sourceText:'same',tableCol:0}];
 const key=pageContentKey(blocks,new Map([['x','译文']]));
 assert.notEqual(pageContentKey([{...blocks[0],tableCol:1}],new Map([['x','译文']])),key);
 assert.notEqual(pageContentKey(blocks,new Map([['x','新译文']])),key);
});

test('session corpus export reads the frozen archive after eviction and never attaches an old probe to live data',async()=>{
 const {ReaderSession}=await import('../../src/reader/readerSession');
 const session=Object.create(ReaderSession.prototype) as any;
 const state:any={pageIndex:0,blocks:[{id:'a',sourceText:'original',pageIndex:0,order:0,type:'paragraph'}],translations:new Map([['a','译文']])};
 session.manager={getPageState:()=>state,exportScope:()=>[]};session.pageSpans=()=>null;session.engineSelfCheck=async()=>({});
 session.placementProbe=new Map([[0,['stale']]]);session.pageArchive={get:async()=>null};
 const source=await session.corpusExportSource('3.3.0');const live=await source.readPage(0);
 state.blocks[0].sourceText='changed';assert.equal((live.blocks[0] as any).sourceText,'original');assert.equal(live.probe,undefined);
 const archived={...live,blocksSource:'archived',translationSource:'archived',probe:['coherent']};
 state.blocks=[];state.translations.clear();session.pageArchive={get:async()=>archived};
 session.extractor={extractPage:()=>{throw Error('must not re-extract');}};
 assert.deepEqual(await source.readPage(0),archived);
});
