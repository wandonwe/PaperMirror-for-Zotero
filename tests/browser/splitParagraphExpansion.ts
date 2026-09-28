import f from '../fixtures/regression/koch2021-p2-placement.json';
import {buildStrictPage} from '../../src/ui/strictPageReplacement';
import type {SourceBlock} from '../../src/types/models';
export function checkSplitParagraphExpansion():void {
 for(const scale of [1,1.2,1.5]) for(const constrained of [false,true]) {
  const canvas=document.createElement('canvas');canvas.width=f.width*scale;canvas.height=f.height*scale;const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
  const built=buildStrictPage(document,{pageIndex:1,blocks:(f.blocks as SourceBlock[]).map(b=>constrained && b.id==='page-1-region-4' ? {...b,sourceRegion:{...b.sourceRegion!,boundsPdf:[304.7243,465.390782,538.52443475,487.152432]}}:b),translations:new Map(f.translations.map(t=>[t.id,t.translatedText])),render:{canvas,scale,viewportWidth:canvas.width,viewportHeight:canvas.height,toViewport:(x,y)=>[x*scale,(f.height-y)*scale]}})!;
  document.body.append(built.element);const p=built.element as any;
  const pending=p.pmSettleStrict(true);p.pmRevert(p.pmShrinkFit(p.pmExpandFit(pending.map((b:any)=>b.id))));
  const node=built.element.querySelector('[data-pm-block="page-1-region-4::p0"]') as HTMLElement;
  const heading=built.element.querySelector('[data-pm-block="page-1-region-4::p1"]') as HTMLElement;
  if(constrained) {
   if(node.style.visibility!=='hidden')throw Error('Expansion escaped source band');
   built.element.remove();continue;
  }
  if(node.style.visibility==='hidden' || node.textContent!=='这项前瞻性体模研究无需机构审查委员会的任何批准。')throw Error('Short methods paragraph not placed at '+scale);
  if(node.getBoundingClientRect().bottom>heading.getBoundingClientRect().top-2)throw Error('Paragraph crossed next heading');
  if(p.pmGeometryAudit().violations)throw Error('Split paragraph overlap');
  built.element.remove();
 }
}
