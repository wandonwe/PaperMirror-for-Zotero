import { buildBlocksFromSpans } from '../../src/reader/spanBlockBuilder';
import { buildStrictPage, captionBackgroundIsClear } from '../../src/ui/strictPageReplacement';
import fixture from '../fixtures/regression/simohamed2021-p4.json';
import type { SpanItem } from '../../src/reader/spanBlockBuilder';

export async function checkImageCaption():Promise<void> {
 const image=new Image();image.src=(window as any).captionFixtureImage;await image.decode();
 const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
 const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);
 const blocks=buildBlocksFromSpans(fixture.items as SpanItem[],{pageIndex:3,pageWidth:594,pageHeight:783,imageRectsPdf:fixture.images as any,includeReferences:true}).blocks;
 const caption=blocks.find(b=>b.imageTextRegionPdf)!;
 const translated='图3：注射金纳米颗粒前和注射后两天的动脉粥样硬化兔主动脉光子计数CT图像。'.repeat(12);
 const rendered=buildStrictPage(document,{pageIndex:3,blocks,translations:new Map([[caption.id,translated]]),imageRectsPdf:fixture.images as any,render:{canvas,viewportWidth:594,viewportHeight:783,scale:1,toViewport:(x,y)=>[x,783-y]}})!;
 document.body.append(rendered.element);
 const page=rendered.element as any;const initial=page.pmSettleStrict(true);page.pmShrinkFit(initial.map((b:any)=>b.id));
 const node=rendered.element.querySelector(`[data-pm-block="${caption.id}"]`) as HTMLElement;
 if(!node || node.style.visibility==='hidden' || node.textContent!==translated) throw Error('real Figure 3 caption did not commit completely');
 if(page.pmGeometryAudit().violations) throw Error('caption invaded protected figure');
 const mask=rendered.element.querySelector('.pm-repage-mask') as HTMLCanvasElement;
 const mc=mask.getContext('2d')!;
 // Left-hand graph remains unmasked; caption area is visibly replaced.
 if(mc.getImageData(200*2,400*2,1,1).data[3]!==0) throw Error('caption mask covered graph');
 const b=caption.boundingBox!;const zone=mc.getImageData(Math.floor(b.x*2),Math.floor(b.y*2),Math.floor(b.width*2),Math.floor(b.height*2)).data;
 if(!zone.some((v,i)=>i%4===3 && v>0)) throw Error('caption mask is empty');
 // Metadata cannot authorize replacement on dark photographic pixels.
 const photo=document.createElement('canvas');photo.width=200;photo.height=100;const pc=photo.getContext('2d')!;pc.fillStyle='#333';pc.fillRect(0,0,200,100);
 if(captionBackgroundIsClear(pc,{left:0,top:0,width:180,height:90},[{left:0,top:0,width:160,height:15},{left:0,top:30,width:160,height:15}],1)) throw Error('photo was certified as paper');
 const darkCanvas=document.createElement('canvas');darkCanvas.width=canvas.width;darkCanvas.height=canvas.height;
 const dc=darkCanvas.getContext('2d')!;dc.drawImage(canvas,0,0);dc.fillStyle='#333';dc.fillRect(b.x*1.5,b.y*1.5,b.width*1.5,b.height*1.5);
 const rejected=buildStrictPage(document,{pageIndex:3,blocks,translations:new Map([[caption.id,translated]]),imageRectsPdf:fixture.images as any,render:{canvas:darkCanvas,viewportWidth:594,viewportHeight:783,scale:1,toViewport:(x,y)=>[x,783-y]}})!;
 document.body.append(rejected.element);(rejected.element as any).pmSettleStrict(true);
 const rejectedNode=rejected.element.querySelector(`[data-pm-block="${caption.id}"]`) as HTMLElement | null;
 if(rejectedNode && rejectedNode.style.visibility!=='hidden') throw Error('unverified photo caption was shown');
 rejected.element.remove();
 rendered.element.remove();
}
