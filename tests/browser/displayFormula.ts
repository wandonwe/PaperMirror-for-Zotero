import fixture from '../fixtures/regression/zou-page3-real-translation.json';
import {buildStrictPage} from '../../src/ui/strictPageReplacement';
import type {SourceBlock} from '../../src/types/models';
export function checkDisplayFormula(): void {
 for(const scale of [0.75,1,1.7333333333,2]) {
  const canvas=document.createElement('canvas');canvas.width=595*scale;canvas.height=791*scale;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
  const built=buildStrictPage(document,{pageIndex:2,blocks:fixture.blocks as SourceBlock[],translations:new Map(fixture.translations.map(t=>[t.id,t.translatedText])),render:{canvas,scale,viewportWidth:canvas.width,viewportHeight:canvas.height,toViewport:(x,y)=>[x*scale,(791-y)*scale]}})!;
  document.body.append(built.element);const p=built.element as any;
  const pending=p.pmSettleStrict(true);const unfit=p.pmShrinkFit(p.pmExpandFit(pending.map((b:any)=>b.id)));
  p.pmRevert(unfit);p.pmGeometryAudit();
  const node=built.element.querySelector('[data-pm-block="page-2-region-0"]') as HTMLElement;
  if(node.style.visibility==='hidden' || node.textContent!==fixture.translations[0]!.translatedText) throw Error('Zou p3: existing full translation lost at '+scale);
  built.element.remove();
 }
}
