import fixture from '../fixtures/regression/bell2026-watermark.json';
import {buildStrictPage,probeStrictPlacement} from '../../src/ui/strictPageReplacement';
import type {SourceBlock} from '../../src/types/models';
export async function checkWatermarkBackground(keep=false):Promise<void>{
 for(const p of fixture.pages.filter(p=>p.targets.length))for(const scale of [1,1.2]){
 const im=new Image();im.src=p.image;await im.decode();const canvas=document.createElement('canvas');canvas.width=p.view[2]!*scale*2;canvas.height=p.view[3]!*scale*2;canvas.getContext('2d')!.drawImage(im,0,0,canvas.width,canvas.height);
 const built=buildStrictPage(document,{pageIndex:p.page-1,blocks:p.blocks as SourceBlock[],translations:new Map(p.translations.map(t=>[t.id,t.translatedText])),imageRectsPdf:p.imageRects as [number,number,number,number][],render:{canvas,scale,viewportWidth:canvas.width/2,viewportHeight:canvas.height/2,toViewport:(x,y)=>[x*scale,(p.view[3]!-y)*scale]}})!;
 document.body.append(built.element);const el=built.element as any,pending=el.pmSettleStrict(true);el.pmRevert(el.pmShrinkFit(el.pmExpandFit(pending.map((b:any)=>b.id))));
 const probes=probeStrictPlacement(built.element,false)!;
 const failed=p.targets.filter(id=>{const group=probes.filter(b=>b.id===id||b.id.startsWith(id+'::p'));return !group.length||group.some(b=>b.state!=='committed');});
 console.log(JSON.stringify({page:p.page,scale,failed,probes:probes.filter(b=>failed.some(id=>b.id===id||b.id.startsWith(id+'::p')))}));
 if(keep&&scale===1)built.element.dataset.watermarkPage=String(p.page);else built.element.remove();
 const expected:Record<string,string[]>={'1:1.2':['page-0-region-8','page-0-region-9'],'6:1':['page-5-region-4'],'11:1':['page-10-region-26'],'11:1.2':['page-10-region-26']};
 if(JSON.stringify(failed)!==JSON.stringify(expected[p.page+':'+scale]??[]))throw Error('Unexpected watermark replay failure');
 for(const id of p.targets)if(!probes.some(b=>b.id===id||b.id.startsWith(id+'::p')))throw Error('Background still excluded a target');

 }
}
