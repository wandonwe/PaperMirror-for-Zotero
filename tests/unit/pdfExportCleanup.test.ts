import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderSession} from '../../src/reader/readerSession';
for(const failure of ['none','import','write','cleanup'] as const)test(`PDF staging file is cleaned on ${failure} outcome without changing success/failure`,async()=>{
 const g=globalThis as any, previous={io:g.IOUtils,paths:g.PathUtils,zotero:g.Zotero};
 const written:string[]=[],removed:string[]=[],phases:string[]=[];let imports=0;
 g.IOUtils={read:async()=>new Uint8Array([1]),
  write:async(path:string)=>{written.push(path);if(failure==='write')throw Error('partial write');},
  remove:async(path:string)=>{removed.push(path);if(failure==='cleanup')throw Error('cleanup unavailable');},setPermissions:async()=>{}};
 g.PathUtils={tempDir:'/tmp',join:(...parts:string[])=>parts.join('/')};
 g.Zotero={Attachments:{importFromFile:async()=>{imports++;if(failure==='import')throw Error('attachment import failed');}}};
 const session=Object.assign(Object.create(ReaderSession.prototype),{reader:{_item:{parentItemID:42,getFilePathAsync:async()=>'/data/paper.pdf'}},
  exportingPdf:false,setCapsuleCollapsed(){},pushExport(phase:string){phases.push(phase);},
  exportBuiltin:async()=>({monoBytes:new Uint8Array([2]),dualBytes:null})});
 try {
  await session.exportTranslatedPdf();assert.equal(written.length,1);assert.deepEqual(removed,written);
  assert.equal(imports,failure==='write'?0:1);assert.equal(phases.at(-1),failure==='import'||failure==='write'?'failed':'done');
  assert.equal(session.exportingPdf,false);
 } finally {g.IOUtils=previous.io;g.PathUtils=previous.paths;g.Zotero=previous.zotero;}
});
