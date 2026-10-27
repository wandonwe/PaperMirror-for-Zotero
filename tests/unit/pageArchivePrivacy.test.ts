import {test} from 'node:test';
import assert from 'node:assert/strict';
import {temporaryPageArchive} from '../../src/export/pageArchive';
import type {CorpusPageRecord} from '../../src/export/corpusJsonl';
const record:CorpusPageRecord={spans:null,blocks:[{id:'a',sourceText:'Unpublished original text'}],blocksSource:'archived',
 check:{structureMatch:'as-translated',blocksCompared:1},translations:[{id:'a',translatedText:'Private translation'}],translationSource:'archived'};
function setup(permissions:'supported'|'missing'|'throws') {
 const global=globalThis as any, oldIO=global.IOUtils, oldPaths=global.PathUtils;
 const events:Array<[string,string,number?]>=[], disk=new Map<string,string>();
 const io:any={makeDirectory:async(path:string)=>{events.push(['mkdir',path]);},
  writeUTF8:async(path:string,text:string)=>{events.push(['write',path]);disk.set(path,text);},
  readUTF8:async(path:string)=>disk.get(path),remove:async(path:string)=>{events.push(['remove',path]);disk.clear();}};
 if(permissions!=='missing')io.setPermissions=async(path:string,mode:number)=>{events.push(['chmod',path,mode]);if(permissions==='throws')throw Error('unsupported');};
 global.IOUtils=io;global.PathUtils={tempDir:'/tmp',join:(...parts:string[])=>parts.join('/')};
 return {events,disk,restore(){global.IOUtils=oldIO;global.PathUtils=oldPaths;}};
}
test('page text is written only after the archive directory is private; files and cleanup follow the same boundary',async()=>{
 const env=setup('supported'), archive=temporaryPageArchive();
 try {
  archive.put(0,'key',record);assert.equal((await archive.get(0,'key'))?.translations?.[0]?.translatedText,'Private translation');
  const writeIndex=env.events.findIndex(e=>e[0]==='write'), directory=env.events.find(e=>e[0]==='mkdir')![1];
  assert.ok(env.events.slice(0,writeIndex).some(e=>e[0]==='chmod' && e[1]===directory && e[2]===0o700));
  const file=env.events[writeIndex]![1];assert.ok(env.events.some(e=>e[0]==='chmod' && e[1]===file && e[2]===0o600));
  assert.ok(file.startsWith(directory+'/'));
  await archive.close();assert.equal(env.disk.size,0);assert.ok(env.events.some(e=>e[0]==='remove' && e[1]===directory));
 } finally {await archive.close();env.restore();}
});
for(const platform of ['missing','throws'] as const)test(`archive remains functional when POSIX permissions are ${platform}`,async()=>{
 const env=setup(platform), archive=temporaryPageArchive();
 try {archive.put(0,'key',record);assert.ok(await archive.get(0,'key'));}finally{await archive.close();env.restore();}
});
