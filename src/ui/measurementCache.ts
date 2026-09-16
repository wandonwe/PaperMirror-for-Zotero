const fontEpochs=new WeakMap<Document,{value:number}>();
function fontEpoch(doc:Document):number {
 let epoch=fontEpochs.get(doc);
 if(!epoch){epoch={value:0};fontEpochs.set(doc,epoch);const saved=epoch;
  for(const name of ['loading','loadingdone','loadingerror'])doc.fonts?.addEventListener(name,()=>{saved.value++;});
 }
 return epoch.value;
}
/** Per-render cache: its lifetime already scopes renderer version and zoom.
 * Only attached nodes with loaded fonts qualify. Font loading invalidates keys. */
export class RenderMeasurementCache {
 private identities=new WeakMap<HTMLElement,number>();
 private nextId=0;
 private values=new Map<string,{width:number;height:number}>();
 measure(node:HTMLElement,text:string,read:()=>{width:number;height:number}):{width:number;height:number} {
  const doc=node.ownerDocument,epoch=fontEpoch(doc);
  if(!node.isConnected || doc.fonts?.status!=='loaded')return read();
  const style=doc.defaultView?.getComputedStyle(node);
  if(!this.identities.has(node))this.identities.set(node,++this.nextId);
  const key=JSON.stringify([this.identities.get(node),epoch,text,node.style.cssText,style?.font,style?.lineHeight,style?.letterSpacing,style?.whiteSpace,style?.wordBreak,style?.overflowWrap]);
  const cached=this.values.get(key);if(cached)return cached;
  const size=read();if(this.values.size>=256)this.values.delete(this.values.keys().next().value!);
  this.values.set(key,size);return size;
 }
}
