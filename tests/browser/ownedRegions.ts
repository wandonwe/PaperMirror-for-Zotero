import fixture from '../fixtures/regression/bae2010-p4.json';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {buildStrictPage} from '../../src/ui/strictPageReplacement';
export function checkOwnedRegions():void {
 const source=buildBlocksFromSpans(fixture.items as any,{pageIndex:3,pageWidth:fixture.pageWidth,pageHeight:fixture.pageHeight}).blocks.find(b=>b.sourceRegion)!;
 for(const scale of [1,.75,1.0266666667]) {
  const canvas=document.createElement('canvas');canvas.width=fixture.pageWidth*scale;canvas.height=fixture.pageHeight*scale;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
  // Deliberately overlong controlled text tests the owner boundary, not translation quality.
  const text='图注译文必须留在自己的区域内。'.repeat(300);
  const built=buildStrictPage(document,{pageIndex:3,blocks:[source],translations:new Map([[source.id,text]]),render:{canvas,viewportWidth:canvas.width,viewportHeight:canvas.height,scale,toViewport:(x,y)=>[x*scale,(fixture.pageHeight-y)*scale]}})!;
  document.body.append(built.element);const page=built.element as any;
  const node=built.element.querySelector('[data-pm-source-region]') as HTMLElement;
  if(!node)throw Error('Caption owner missing from render');
  const width=node.style.width,height=node.style.height;
  const unfit=page.pmSettleStrict(true);page.pmExpandFit(unfit.map((b:any)=>b.id));
  if(node.style.width!==width || node.style.height!==height)throw Error('Caption expanded outside its source region');
  if(node.textContent!==text)throw Error('Overlong owned translation was truncated');
  built.element.remove();
 }
}
