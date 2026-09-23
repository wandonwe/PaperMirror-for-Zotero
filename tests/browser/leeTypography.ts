import fixtures from '../fixtures/regression/lee2020-placement.json';
import {buildStrictPage} from '../../src/ui/strictPageReplacement';
import type {SourceBlock} from '../../src/types/models';
/** Typography-only replay. The archive does not contain the page bitmap/image obstacles. */
export function checkLeeTypography():void {
 for(const f of fixtures) {
  const scale=f.page===3?1.2:1.0666666667;
  const canvas=document.createElement('canvas');canvas.width=612*scale;canvas.height=792*scale;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
  const translations=new Map(f.translations.map(t=>[t.id,t.translatedText]));
  const built=buildStrictPage(document,{pageIndex:f.page-1,blocks:f.blocks as SourceBlock[],translations,
   render:{canvas,scale,viewportWidth:canvas.width,viewportHeight:canvas.height,toViewport:(x,y)=>[x*scale,(792-y)*scale]}})!;
  document.body.append(built.element);const p=built.element as any;
  const pending=p.pmSettleStrict(true);p.pmRevert(p.pmShrinkFit(p.pmExpandFit(pending.map((b:any)=>b.id))));
  for(const id of f.page===3?['page-2-region-3','page-2-region-4']:['page-6-region-2']) {
   const node=built.element.querySelector(`[data-pm-block="${id}"]`) as HTMLElement;
   if(!node || node.style.visibility==='hidden' || node.textContent!==translations.get(id)) throw Error('Lee typography regression: '+id);
  }
  if(!p.pmProbe().every((r:any)=>r.measurement && Number.isFinite(r.measurement.fontPx))) throw Error('Missing font measurements');
  built.element.remove();
 }
}
