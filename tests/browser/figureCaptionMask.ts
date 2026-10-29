import {structureTableCells} from '../../src/reader/tableStructure';
import type {BorderGrid} from '../../src/reader/tableBorders';
import type {SourceBlock} from '../../src/types/models';
import {buildStrictPage, probeStrictPlacement} from '../../src/ui/strictPageReplacement';

type Box = {left:number;top:number;width:number;height:number};
const width=600, height=400;

/** Real DOM/font/canvas regression for a framed illustration whose apparent
 * last grid rows are only 13pt high. Classified captions must keep every source
 * line, including lines extending beyond that apparent cell. Sparse probe
 * samples alone cannot establish this: inspect every painted source-ink pixel.
 */
export function checkFigureCaptionMask():void {
 for(const lineCount of [2,3]) for(const scale of [.75,1,1.5]) for(const fail of [false,true]) {
  const image:Box={left:50,top:55,width:480,height:180};
  const frame:Box={left:30,top:40,width:530,height:260};
  const lines=Array.from({length:lineCount},(_,i)=>({left:52,top:252+i*11,width:i?330:470,height:9,
   text:i===0?'Figure 17. Independent study groups and category definitions.':
    i===1?'Additional explanation continues on the second source line.':'A third source line belongs to the same complete caption.'}));
  const caption:SourceBlock={id:'framed-illustration-caption',pageIndex:11,order:0,type:'caption',fontSize:9,
   sourceText:lines.map(l=>l.text).join(' '),translationMode:'translate',
   boundingBox:{x:52,y:252,width:470,height:(lineCount-1)*11+9},
   lineRectsPdf:lines.map(l=>[l.left,height-l.top-l.height,l.left+l.width,height-l.top])};
  // With two source lines, the first apparent cell owns only 13pt; with three,
  // the source centre falls in the following 13pt cell. Both are false owners.
  const apparentGrid:BorderGrid={columns:[30,50,560],rows:[40,250,263,276],
   region:{left:30,top:40,width:530,height:236}};
  const blocks=structureTableCells([caption],11,9,[],apparentGrid,true,height);
  const preserved=blocks.find(b=>b.id===caption.id);
  if(blocks.length!==1 || !preserved || preserved.type!=='caption' || preserved.tableRectPdf || preserved.tableId
   || JSON.stringify(preserved.lineRectsPdf)!==JSON.stringify(caption.lineRectsPdf))
   throw Error(`Figure caption was clipped to decorative grid: lines=${lineCount}, scale=${scale}`);

  const source=document.createElement('canvas');source.width=width*scale*2;source.height=height*scale*2;
  const ctx=source.getContext('2d')!;ctx.scale(scale*2,scale*2);
  ctx.fillStyle='white';ctx.fillRect(0,0,width,height);
  ctx.fillStyle='#db1b91';ctx.fillRect(frame.left,frame.top,frame.width,1);
  ctx.fillRect(frame.left,frame.top+frame.height-1,frame.width,1);
  ctx.fillRect(frame.left,frame.top,1,frame.height);ctx.fillRect(frame.left+frame.width-1,frame.top,1,frame.height);
  ctx.fillStyle='#14364c';ctx.fillRect(image.left,image.top,image.width,image.height);
  ctx.fillStyle='#a2d5b1';ctx.fillRect(image.left+25,image.top+25,170,110);
  ctx.fillStyle='#f7bb61';ctx.fillRect(image.left+220,image.top+45,190,80);
  ctx.font='9px Arial';ctx.textBaseline='top';ctx.fillStyle='black';
  for(const line of lines)ctx.fillText(line.text,line.left,line.top,line.width);

  const translated=fail?'无法放入的完整图注必须整体回退原文。'.repeat(250):'图示：研究分组与分类，各行说明完整保留。';
  const built=buildStrictPage(document,{pageIndex:11,blocks,translations:new Map([[caption.id,translated]]),
   imageRectsPdf:[[image.left,height-image.top-image.height,image.left+image.width,height-image.top]],
   render:{canvas:source,viewportWidth:width*scale,viewportHeight:height*scale,scale,
    toViewport:(x,y)=>[x*scale,(height-y)*scale]}});
  if(!built)throw Error('Figure caption page did not build');
  document.body.append(built.element);
  try {
   const page=built.element as any;
   const pending=page.pmSettleStrict(true);
   const still=page.pmShrinkFit(pending.map((b:{id:string})=>b.id)) as string[];
   if(fail) {
    if(!still.includes(caption.id))throw Error('Overlong caption did not exercise whole-caption fallback');
    page.pmRevert(still);
   } else if(still.length) throw Error('Short caption failed measured placement at '+scale);
   const node=built.element.querySelector<HTMLElement>(`[data-pm-block="${caption.id}"]`)!;
   const probe=probeStrictPlacement(built.element,false)!.find(p=>p.id===caption.id)!;
   if(!node || node.textContent!==translated)throw Error('Caption translation was truncated or discarded');
   const mask=built.element.querySelector<HTMLCanvasElement>('.pm-repage-mask')!;
   const base=built.element.querySelector<HTMLCanvasElement>('.pm-repage-canvas')!;
   const sample=(canvas:HTMLCanvasElement,b:Box):Uint8ClampedArray=>{
    const ratio=canvas.width/width;
    return canvas.getContext('2d')!.getImageData(Math.floor(b.left*ratio),Math.floor(b.top*ratio),
     Math.max(1,Math.floor(b.width*ratio)),Math.max(1,Math.floor(b.height*ratio))).data;
   };
   const assertClear=(b:Box,label:string):void=>{
    if(sample(mask,b).some((v,i)=>i%4===3 && v!==0))throw Error(`Caption mask erased ${label} at ${scale}`);
   };
   assertClear(image,'illustration pixels');
   for(const edge of [
    {left:frame.left,top:frame.top,width:frame.width,height:1},
    {left:frame.left,top:frame.top+frame.height-1,width:frame.width,height:1},
    {left:frame.left,top:frame.top,width:1,height:frame.height},
    {left:frame.left+frame.width-1,top:frame.top,width:1,height:frame.height}])assertClear(edge,'decorative frame');
   const originalPixels=source.getContext('2d')!.getImageData(0,0,source.width,source.height).data;
   const basePixels=base.getContext('2d')!.getImageData(0,0,base.width,base.height).data;
   if(base.width!==source.width || base.height!==source.height || originalPixels.some((v,i)=>v!==basePixels[i]))
    throw Error('Original bitmap was altered instead of using an atomic mask');
   if(fail) {
    if(probe.state!=='abandoned' || node.style.visibility!=='hidden')throw Error('An incomplete caption became visible');
    const allMask=mask.getContext('2d')!.getImageData(0,0,mask.width,mask.height).data;
    if(allMask.some((v,i)=>i%4===3 && v!==0))throw Error('Failed caption retained a partial mask');
   } else {
    if(probe.state!=='committed' || node.style.visibility==='hidden')throw Error('Complete caption was not committed');
    for(const line of lines) {
     const original=sample(source,line),cover=sample(mask,line);
     let ink=0;
     for(let i=0;i<original.length;i+=4)if(original[i]!<150 && original[i+1]!<150 && original[i+2]!<150 && original[i+3]!>0) {
      ink++;
      if(cover[i+3]!==255 || cover[i]!<240 || cover[i+1]!<240 || cover[i+2]!<240)
       throw Error(`Source caption ink survived: line=${lines.indexOf(line)+1}, lines=${lineCount}, scale=${scale}`);
     }
     if(!ink)throw Error('Caption line has no actual source ink to verify');
    }
    // The DOM retains the full translation and has real measured fragments.
    // Range rectangles include a font's em box, which may be taller than its
    // painted ink. Use independently measured canvas glyph metrics for the
    // vertical ink bounds rather than rejecting that harmless em-box overhang.
    const bounds=node.getBoundingClientRect();
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
    let textNode:Node|null,fragments=0;
    while((textNode=walker.nextNode())) {
     const style=getComputedStyle(textNode.parentElement!);
     ctx.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
     const metrics=ctx.measureText(textNode.textContent??'');
     if(!Number.isFinite(metrics.fontBoundingBoxAscent) || !Number.isFinite(metrics.actualBoundingBoxAscent))
      throw Error('Canvas glyph metrics unavailable for visible caption check');
     const range=document.createRange();range.selectNodeContents(textNode);
     for(const r of range.getClientRects())if(r.width && r.height) {
      fragments++;
      const baseline=r.top+metrics.fontBoundingBoxAscent;
      const inkTop=baseline-metrics.actualBoundingBoxAscent,inkBottom=baseline+metrics.actualBoundingBoxDescent;
      if(r.left<bounds.left-.1 || r.right>bounds.right+.1 || inkTop<bounds.top-.1 || inkBottom>bounds.bottom+.1)
       throw Error('Committed caption glyph ink escaped its visible clip');
     }
    }
    if(!fragments)throw Error('Committed caption has no visible measured text fragments');
   }
  } finally {built.element.remove();}
 }
}
