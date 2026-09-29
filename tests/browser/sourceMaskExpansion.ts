import f from '../fixtures/regression/haag2024-bottom-paragraphs.json';
import bitmap from '../fixtures/regression/haag2024-p5-bitmap.json';
import {buildStrictPage, probeStrictPlacement} from '../../src/ui/strictPageReplacement';
import type {SourceBlock} from '../../src/types/models';
export async function checkSourceMaskExpansion():Promise<void> {
 const im=new Image();im.src=bitmap.image;await im.decode();
 for(const scale of [.88,1,1.08,1.2]) for(const blocked of [false,true]) {
  const pg=f.pages[1]!,target='page-4-region-1',b=pg.blocks.find(b=>b.id===target)!;
  const canvas=document.createElement('canvas');canvas.width=f.width*scale*2;canvas.height=f.height*scale*2;
  const ctx=canvas.getContext('2d')!;ctx.drawImage(im,0,0,canvas.width,canvas.height);
  // Just outside the existing one-pixel source mask: must still block growth.
  if(blocked){ctx.fillStyle='black';ctx.fillRect(b.boundingBox!.x*scale*2,(b.boundingBox!.y+b.boundingBox!.height)*scale*2+2.1,b.boundingBox!.width*scale*2,30);}
  const built=buildStrictPage(document,{pageIndex:4,blocks:pg.blocks as SourceBlock[],translations:new Map(pg.translations.map(t=>[t.id,t.translatedText])),render:{canvas,scale,viewportWidth:f.width*scale,viewportHeight:f.height*scale,toViewport:(x,y)=>[x*scale,(f.height-y)*scale]}})!;
  document.body.append(built.element);const p=built.element as any;
  const pending=p.pmSettleStrict(true);p.pmRevert(p.pmShrinkFit(p.pmExpandFit(pending.map((b:any)=>b.id))));
  const probe=probeStrictPlacement(built.element,false)!.find(b=>b.id===target)!;
  if(blocked){
   const node=built.element.querySelector(`[data-pm-block="${target}"]`) as HTMLElement;
   const inkTop=(b.boundingBox!.y+b.boundingBox!.height)*scale+1.05;
   if(probe.state==='committed' && parseFloat(node.style.top)+parseFloat(node.style.height)>inkTop)throw Error('Outside-mask ink was covered at '+scale);
   if(scale===1 && probe.state!=='abandoned')throw Error('Blocked expansion must be rejected');
  }
  else {
   if(probe.state!=='committed')throw Error('Real PDF bottom paragraph not placed at '+scale);
   const node=built.element.querySelector(`[data-pm-block="${target}"]`)!;
   if(node.textContent!==pg.translations.find(t=>t.id===target)!.translatedText)throw Error('Translation changed');
  }
  if(p.pmGeometryAudit().violations)throw Error('Unsafe geometry');
  built.element.remove();
 }
}
