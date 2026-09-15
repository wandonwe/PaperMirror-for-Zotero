import type { SourceBlock } from '../types/models';
import type { CorpusPageRecord } from './corpusJsonl';
import { fnv1a64 } from '../cache/cacheSchema';

export function pageContentKey(blocks: SourceBlock[], translations: Map<string,string>): string {
 return fnv1a64(JSON.stringify([blocks,[...translations].sort(([a],[b])=>a.localeCompare(b))]));
}
export interface ArchiveIO { write(page:number,text:string):Promise<void>; read(page:number):Promise<string>; close():Promise<void> }
/** Disk-backed, immutable page records. Memory retains only keys and pending writes.
 * The JSON copy is made before any await, so eviction cannot mutate an export. */
export class PageArchive {
 private pending=new Map<number,Promise<void>>();
 private keys=new Map<number,string>();
 private ready=new Set<number>();
 private closed=false;
 constructor(private io:ArchiveIO) {}
 put(page:number,key:string,record:CorpusPageRecord,placement=false):void {
  if(this.closed || (!placement && this.keys.get(page)===key && (this.ready.has(page)||this.pending.has(page)))) return;
  const text=JSON.stringify({key,record});
  this.keys.set(page,key);this.ready.delete(page);
  const previous=this.pending.get(page)??Promise.resolve();
  const task=previous.catch(()=>{}).then(()=>this.io.write(page,text)).then(()=>{this.ready.add(page);},()=>{this.ready.delete(page);});
  this.pending.set(page,task);
  void task.then(()=>{if(this.pending.get(page)===task)this.pending.delete(page);});
 }
 async get(page:number,key?:string):Promise<CorpusPageRecord|null> {
  if(this.closed || (key!==undefined && this.keys.get(page)!==key)) return null;
  // New writes may arrive while we wait; always await the actual tail.
  while(this.pending.has(page)) await this.pending.get(page);
  if(this.closed || !this.ready.has(page) || (key!==undefined&&this.keys.get(page)!==key)) return null;
  try {
   const saved=JSON.parse(await this.io.read(page)) as {key:string;record:CorpusPageRecord};
   return !this.closed && saved.key===this.keys.get(page) && (key===undefined||key===saved.key) ? saved.record : null;
  } catch {return null;}
 }
 async close():Promise<void> {
  this.closed=true;await Promise.all([...this.pending.values()]);this.keys.clear();this.ready.clear();await this.io.close().catch(()=>{});
 }
}
export function temporaryPageArchive():PageArchive {
 let dir:string|undefined;
 const directory=async():Promise<string>=>{
  if(!dir)dir=PathUtils.join((PathUtils as unknown as {tempDir:string}).tempDir,`papermirror-pages-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await IOUtils.makeDirectory(dir,{ignoreExisting:true});return dir;
 };
 return new PageArchive({
  async write(page,text){const d=await directory();const path=PathUtils.join(d,`${page}.json`);await IOUtils.writeUTF8(path,text,{tmpPath:path+'.tmp'});},
  async read(page){if(!dir)throw Error('archive-not-created');return IOUtils.readUTF8(PathUtils.join(dir,`${page}.json`));},
  async close(){if(dir)await IOUtils.remove(dir,{recursive:true,ignoreAbsent:true});}
 });
}
