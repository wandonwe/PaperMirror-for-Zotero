import f from '../fixtures/regression/haag2024-bottom-paragraphs.json';
import {buildStrictPage, probeStrictPlacement} from '../../src/ui/strictPageReplacement';
import type {SourceBlock} from '../../src/types/models';
export function checkBottomParagraphExpansion():void {
 for(const scale of [.88,1,1.2]) for(const pg of f.pages) for(const blocked of [false,true]) {
  const target=pg.page===4?'page-3-region-8':'page-4-region-1';
  const b=pg.blocks.find(b=>b.id===target)!;
  const canvas=document.createElement('canvas');canvas.width=f.width*scale;canvas.height=f.height*scale;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
  const edge=(b.boundingBox!.y+b.boundingBox!.height+(blocked?0:6))*scale;
  ctx.fillStyle='black';ctx.fillRect(b.boundingBox!.x*scale,edge,b.boundingBox!.width*scale,blocked?20*scale:scale);
  const built=buildStrictPage(document,{pageIndex:pg.page-1,blocks:pg.blocks as SourceBlock[],translations:new Map(pg.translations.map(t=>[t.id,t.translatedText])),render:{canvas,scale,viewportWidth:canvas.width,viewportHeight:canvas.height,toViewport:(x,y)=>[x*scale,(f.height-y)*scale]}})!;
  document.body.append(built.element);const p=built.element as any;
  const pending=p.pmSettleStrict(true);p.pmRevert(p.pmShrinkFit(p.pmExpandFit(pending.map((b:any)=>b.id))));
  const probe=probeStrictPlacement(built.element,false)!.find(b=>b.id===target)!;
  if(probe.bitmapSampled!==false)throw Error('Lightweight probe sampled pixels');
  if(blocked && pg.page===5) {
   if(probe.state!=='abandoned')throw Error('Expansion covered ink');
   if(!probe.abandonReason)throw Error('Missing placement failure');
  } else {
   if(probe.state!=='committed')throw Error(`Page ${pg.page} not placed at ${scale}`);
   if(probe.inkFailure)throw Error('Committed text retains stale failure');
   const node=built.element.querySelector(`[data-pm-block="${target}"]`) as HTMLElement;
   if(node.textContent!==pg.translations.find(t=>t.id===target)!.translatedText)throw Error('Translation was truncated');
   if(parseFloat(node.style.top)+parseFloat(node.style.height)>edge+.1 && !blocked)throw Error('Reached lower ink');
   if(Math.abs(parseFloat(node.style.width)-b.boundingBox!.width*scale)>.1)throw Error('Expanded horizontally');
  }
  if(p.pmGeometryAudit().violations)throw Error('Geometry violation');
  built.element.remove();
 }
}
