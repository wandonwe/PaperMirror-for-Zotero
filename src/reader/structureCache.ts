import type { SourceBlock } from '../types/models';
/** Bounded by both pages and serialized bytes. No mutable block arrays escape. */
export class StructureCache {
 private pages=new Map<string,string>();
 private bytes=0;
 constructor(private limit=8,private maxBytes=4*1024*1024){}
 get(key:string):SourceBlock[]|null {
  const text=this.pages.get(key);if(text===undefined)return null;
  this.pages.delete(key);this.pages.set(key,text);return JSON.parse(text) as SourceBlock[];
 }
 put(key:string,blocks:SourceBlock[]):void {
  const text=JSON.stringify(blocks),size=text.length*2;if(size>this.maxBytes)return;
  const previous=this.pages.get(key);if(previous)this.bytes-=previous.length*2;
  this.pages.delete(key);this.pages.set(key,text);this.bytes+=size;
  while(this.pages.size>this.limit||this.bytes>this.maxBytes){const first=this.pages.keys().next().value!;this.bytes-=this.pages.get(first)!.length*2;this.pages.delete(first);}
 }
}
