import fixture from '../fixtures/regression/kitagawa-legend-p8.spans.json';
import {extractLegendItems, type LegendOptions, type LegendRect, type LegendSpan} from '../../src/reader/legendItems';
import type {SourceBlock} from '../../src/types/models';
import {buildStrictPage, placementTally, probeStrictPlacement} from '../../src/ui/strictPageReplacement';

type Scenario = {name:string;items:LegendSpan[];options:LegendOptions};
type Marker = {segment:LegendRect;color:string};
export interface LegendMarkerMaskResult {
 scenarios:number;entries:number;markerPixelsChecked:number;glyphEdgePixelsChecked:number;boundaryFallbacks:number;scales:number[];phaseOffsets:number[];
}
const COLORS=['#5ca7d1','#ed634e','#424342','#686ba6'];
const bitmapScale=(w:number,h:number):number=>Math.max(1,Math.min(2,Math.sqrt(3_200_000/(w*h))));

/** Geometry is from the real PDF; colours below are controlled test paint.
 * Native acceptance separately checks the original document's actual bitmap.
 * The narrow-gap case uses the recogniser's minimum .03em positive gap, so a
 * fixed one-pixel mask padding cannot silently erase a nearby marker. */
function cases():Scenario[] {
 const near=(phase:number):Scenario=>{
  const items:LegendSpan[]=[],segments:LegendRect[]=[];
  for(let panel=0;panel<2;panel++)for(let index=0;index<4;index++) {
   const top=350-index*60,end=14+panel*280+phase,left=end+.03*10;
   items.push({text:`Independent series ${panel+1}.${index+1}`,rect:[left,top-10,left+180,top],fontSize:10});
   items.push({text:`Measured result = ${panel+1}.${index+1}`,rect:[left,top-22,left+150,top-12],fontSize:10});
   segments.push([end-12,top-5,end,top-5]);
  }
  return {name:`minimum-marker-text-gap-phase-${phase}`,items,options:{pageIndex:23,pageWidth:600,pageHeight:400,segments}};
 };
 return [{name:'real-source-geometry',items:fixture.items as LegendSpan[],options:fixture as unknown as LegendOptions},
  ...[0,.25,.5,.75].map(near)];
}
function markerFor(block:SourceBlock,segments:readonly LegendRect[]):LegendRect {
 const line=block.lineRectsPdf![0]!,em=block.fontSize!;
 const markers=segments.filter(s=>Math.abs(s[1]-s[3])<em*.001 && s[0]<s[2]
  && s[2]<line[0] && line[0]-s[2]<=em && s[2]-s[0]>=em*.5 && s[2]-s[0]<=em*2.75
  && s[1]>line[1]+em*.2 && s[1]<line[3]-em*.1);
 if(markers.length!==1)throw Error(`Expected a unique original marker for ${block.id}: ${markers.length}`);
 return markers[0]!;
}

/** Real DOM, font metrics, source canvas, strict placement and mask regression.
 * Every label must remain beside its source marker after settle, peek, revert
 * and whole-entry fallback; no colour recognition/repainting is being added.
 */
export function checkLegendMarkerMask():LegendMarkerMaskResult {
 const result:LegendMarkerMaskResult={scenarios:0,entries:0,markerPixelsChecked:0,glyphEdgePixelsChecked:0,boundaryFallbacks:0,scales:[.7,1,1.35],phaseOffsets:[0,.25,.5,.75]};
 for(const test of cases())for(const scale of result.scales)for(const failFirst of [false,true]) {
  const {blocks}=extractLegendItems(test.items,test.options);
  if(blocks.length!==8)throw Error(`${test.name}: eight independent entries required, got ${blocks.length}`);
  const {pageWidth:width,pageHeight:height}=test.options;
  const ratio=scale*bitmapScale(width*scale,height*scale);
  const source=document.createElement('canvas');
  source.width=Math.round(width*ratio);source.height=Math.round(height*ratio);
  const ctx=source.getContext('2d',{willReadFrequently:true})!;
  ctx.fillStyle='white';ctx.fillRect(0,0,source.width,source.height);
  ctx.scale(ratio,ratio);
  const markers:Marker[]=blocks.map((block,i)=>({segment:markerFor(block,test.options.segments),color:COLORS[i%4]!}));
  for(const {segment:s,color} of markers) {
   // A filled rectangle has no line-cap extension beyond the original edge.
   ctx.fillStyle=color;ctx.fillRect(s[0],height-s[1]-.4,s[2]-s[0],.8);
  }
  ctx.textBaseline='top';ctx.fillStyle='black';
  const glyphEdges:{id:string;left:number;top:number;width:number;height:number}[]=[];
  for(const block of blocks)for(const line of block.lineRectsPdf!) {
   const original=test.items.filter(i=>i.rect[0]>=line[0]-.01 && i.rect[2]<=line[2]+.01
    && i.rect[1]>=line[1]-.01 && i.rect[3]<=line[3]+.01).map(i=>i.text).join(' ');
   ctx.font=`${block.fontSize}px Arial`;
   ctx.fillText(original,line[0],height-line[3],line[2]-line[0]);
   // PDF advance rectangles need not enclose a font's antialiased ink. Put
   // controlled original glyph-edge strokes across both vertical boundaries,
   // independently of the platform font's convenient Canvas 'top' metrics.
   const edgeHeight=block.fontSize!*.09;
   for(const edge of [height-line[3],height-line[1]]) {
    const strip={id:block.id,left:line[0]+block.fontSize!*.7,top:edge-edgeHeight/2,width:block.fontSize!*1.3,height:edgeHeight};
    ctx.fillRect(strip.left,strip.top,strip.width,strip.height);glyphEdges.push(strip);
   }
  }
  const labels=blocks.map((block,index)=>{
   const value=block.sourceText.match(/(?:\d+\.\d+)\s*$/)?.[0]?.trim()??String(index+1);
   return `系列${index+1}：曲线下面积 = ${value}`;
  });
  if(failFirst)labels[0]='这项完整译文放不下时必须保留原文，不能移到其他颜色旁边。'.repeat(250);
  const translations=new Map(blocks.map((block,i)=>[block.id,labels[i]!]));
  const render={canvas:source,viewportWidth:width*scale,viewportHeight:height*scale,scale,
   toViewport:(x:number,y:number):[number,number]=>[x*scale,(height-y)*scale]};
  // Compare with the SAME renderer's zero-replacement copy. This includes
  // its opaque-paper compositing and rounded bitmap dimensions, rather than
  // mistaking source-alpha/resampling differences for a marker edit.
  const baseline=buildStrictPage(document,{pageIndex:test.options.pageIndex,blocks,translations:new Map(),render});
  if(!baseline)throw Error('Zero-replacement marker baseline did not build');
  const baselineCanvas=baseline.element.querySelector<HTMLCanvasElement>('.pm-repage-canvas')!;
  const original=baselineCanvas.getContext('2d')!.getImageData(0,0,baselineCanvas.width,baselineCanvas.height).data;
  const built=buildStrictPage(document,{pageIndex:test.options.pageIndex,blocks,translations,render});
  if(!built)throw Error(`${test.name}: strict page did not build`);
  document.body.append(built.element);
  try {
   const page=built.element as any;
   const unfit=page.pmSettleStrict(true) as {id:string}[];
   const still=page.pmShrinkFit(unfit.map(b=>b.id)) as string[];
   if(still.some(id=>!failFirst || id!==blocks[0]!.id))throw Error(`${test.name} ${scale}: a short legend did not fit: ${still.join(',')}`);
   if(failFirst && !still.includes(blocks[0]!.id))throw Error('Long first entry did not exercise complete-source fallback');
   page.pmRevert(still);
   const mask=built.element.querySelector<HTMLCanvasElement>('.pm-repage-mask')!;
   const base=built.element.querySelector<HTMLCanvasElement>('.pm-repage-canvas')!;
   if(base.width!==baselineCanvas.width || base.height!==baselineCanvas.height)throw Error('Marker bitmap differs from zero-replacement baseline dimensions');
   const copied=base.getContext('2d')!.getImageData(0,0,base.width,base.height).data;
   if(original.some((v,i)=>v!==copied[i]))throw Error('The original coloured bitmap was changed');
   const markerIntact=(marker:Marker,cover:Uint8ClampedArray):void=>{
    const s=marker.segment;
    const x0=Math.max(0,Math.floor(s[0]*ratio)),x1=Math.min(base.width,Math.ceil(s[2]*ratio));
    const y0=Math.max(0,Math.floor((height-s[1]-.4)*ratio)),y1=Math.min(base.height,Math.ceil((height-s[1]+.4)*ratio));
    let painted=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
     const i=(y*base.width+x)*4;
     // Include antialiasing at the marker tip, not only its solid centre.
     if(Math.max(255-original[i]!,255-original[i+1]!,255-original[i+2]!)<=20)continue;
     painted++;result.markerPixelsChecked++;
     if(cover[i+3]!==0)throw Error(`${test.name} scale=${scale}: marker pixel was masked at ${x},${y}, alpha=${cover[i+3]}`);
    }
    if(!painted)throw Error('Marker has no coloured source pixels');
   };
   const markersIntact=(originalIds:ReadonlySet<string>=new Set(failFirst?[blocks[0]!.id]:[])):void=>{
    const cover=mask.getContext('2d')!.getImageData(0,0,mask.width,mask.height).data;
    markers.forEach(marker=>markerIntact(marker,cover));
    for(const edge of glyphEdges) {
     const x0=Math.max(0,Math.floor(edge.left*ratio)),x1=Math.min(base.width,Math.ceil((edge.left+edge.width)*ratio));
     const y0=Math.max(0,Math.floor(edge.top*ratio)),y1=Math.min(base.height,Math.ceil((edge.top+edge.height)*ratio));
     let ink=0;
     for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
      const i=(y*base.width+x)*4;
      if(Math.max(255-original[i]!,255-original[i+1]!,255-original[i+2]!)<=20)continue;
      ink++;result.glyphEdgePixelsChecked++;
      const expected=originalIds.has(edge.id)?0:255;
      if(cover[i+3]!==expected)throw Error(`${test.name} scale=${scale}: original glyph edge ${edge.id} at ${x},${y} alpha=${cover[i+3]}, expected=${expected}`);
     }
     if(!ink)throw Error('Controlled source glyph edge has no ink');
    }
   };
   const checkPlacements=():void=>{
    const probes=probeStrictPlacement(built.element,false)!;
    for(const [index,block] of blocks.entries()) {
     const node=built.element.querySelector<HTMLElement>(`[data-pm-block="${block.id}"]`)!;
     const probe=probes.find(p=>p.id===block.id)!;
     if(!node || node.textContent!==labels[index])throw Error('Legend identity or complete translation was lost');
     if(node.hasAttribute('data-pm-annex') || node.hasAttribute('data-pm-flow'))throw Error('A legend moved to an unrelated flow or annex');
     const first=block.lineRectsPdf![0]!,area=block.sourceRegion!.boundsPdf;
     if(Math.abs(parseFloat(node.style.left)-area[0]*scale)>.03
      || Math.abs(parseFloat(node.style.top)-(height-first[3])*scale)>.03)throw Error('A translated legend moved away from its original marker');
     const bounds=node.getBoundingClientRect();
     if(Math.abs(bounds.width-(area[2]-area[0])*scale)>.1
      || Math.abs(bounds.height-(area[3]-area[1])*scale)>.1)throw Error('A translated legend expanded outside its source owner');
     if(failFirst && index===0) {
      if(probe.state!=='abandoned' || node.style.visibility!=='hidden')throw Error('Incomplete entry became visible');
     } else if(probe.state!=='committed' || node.style.visibility==='hidden' || (probe.measurement?.overflow!==undefined && probe.measurement.overflow!=='none'))throw Error(`Legend not committed without overflow: ${block.id}`);
    }
    if(page.pmGeometryAudit().violations)throw Error('Legend placement introduced an overlap');
    markersIntact();
   };
   checkPlacements();
   for(const block of blocks.filter((_,i)=>!failFirst || i>0)) {
    page.pmPeek([block.id],true);markersIntact(new Set([...(failFirst?[blocks[0]!.id]:[]),block.id]));
    page.pmPeek([block.id],false);checkPlacements();
   }
   // Whole-entry fallback must clear only its own text, retaining every marker
   // and the other seven independently committed labels.
   if(!failFirst) {
    page.pmRevert([blocks[0]!.id]);markersIntact(new Set([blocks[0]!.id]));
    const probe=probeStrictPlacement(built.element,false)!.find(p=>p.id===blocks[0]!.id)!;
    if(probe.state!=='abandoned')throw Error('Legend revert did not restore the original entry');
    for(const block of blocks.slice(1)) {
     const other=probeStrictPlacement(built.element,false)!.find(p=>p.id===block.id)!;
     if(other.state!=='committed')throw Error('Reverting one entry changed its neighbours');
    }
   }
   result.scenarios++;result.entries+=blocks.length;
  } finally {built.element.remove();baseline.element.remove();}
 }
 // Inadequate neighbouring whitespace must retain the COMPLETE first entry,
 // including when its first line was safe but a later line failed planning.
 // These two atomicity controls supplement, not replace, the original 30 cases.
 for(const side of ['above','below'] as const) {
  const test=cases()[1]!,{blocks}=extractLegendItems(test.items,test.options),first=blocks[0]!;
  const {pageHeight:height,pageWidth:width}=test.options,scale=1;
  const target=side==='above'?first.lineRectsPdf![0]!:first.lineRectsPdf!.at(-1)!;
  const rect:LegendRect=side==='above'?[target[0],target[3]+.2,target[2],target[3]+5.2]
   :[target[0],target[1]-5.2,target[2],target[1]-.2];
  const neighbour:SourceBlock={id:'preserved-neighbour',pageIndex:23,order:99,type:'paragraph',sourceText:'A neighbouring original line',
   lineRectsPdf:[rect],fontSize:5,column:0,translationMode:'preserve',preserveReason:'marks'};
  const source=document.createElement('canvas');source.width=width*2;source.height=height*2;
  const ctx=source.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,source.width,source.height);ctx.scale(2,2);
  ctx.fillStyle='black';for(const b of [...blocks,neighbour])for(const line of b.lineRectsPdf!)ctx.fillRect(line[0]+3,height-line[3]+2,Math.min(70,line[2]-line[0]-6),2);
  const built=buildStrictPage(document,{pageIndex:23,blocks:[...blocks,neighbour],translations:new Map(blocks.map((b,i)=>[b.id,`独立图例${i+1}`])),
   render:{canvas:source,viewportWidth:width,viewportHeight:height,scale,toViewport:(x,y)=>[x,height-y]}})!;
  document.body.append(built.element);
  try {
   const page=built.element as any;page.pmSettleStrict(true);
   if(!page.pmAbandoned().some((a:{id:string;reason:string})=>a.id===first.id&&a.reason==='legend-mask-boundary'))throw Error('Unsafe legend was not accounted for as a complete-source fallback');
   if(built.element.querySelector(`[data-pm-block="${first.id}"]`))throw Error('Unsafe legend acquired a partial replacement node');
   const stats=page.pmStats(),tally=placementTally(stats);
   if(stats.replaceable!==8 || stats.committed!==7 || stats.abandoned!==1 || stats.pending!==0
    || tally.kept!==1 || tally.phase!=='partial' || built.stats.abandoned!==1)throw Error('Unsafe legend disappeared from kept-original accounting');
   const mask=built.element.querySelector<HTMLCanvasElement>('.pm-repage-mask')!,cover=mask.getContext('2d')!.getImageData(0,0,mask.width,mask.height).data;
   const firstTop=height-first.sourceRegion!.boundsPdf[3]-2,firstBottom=height-first.sourceRegion!.boundsPdf[1]+2;
   for(let y=Math.max(0,Math.floor(firstTop*2));y<Math.min(mask.height,Math.ceil(firstBottom*2));y++)for(let x=Math.ceil(first.sourceRegion!.boundsPdf[0]*2);x<Math.floor(first.sourceRegion!.boundsPdf[2]*2);x++) {
    if(cover[(y*mask.width+x)*4+3]!==0)throw Error('Unsafe later line left a partial mask on its first entry');
   }
   for(const b of blocks.slice(1))if(probeStrictPlacement(built.element,false)!.find(p=>p.id===b.id)?.state!=='committed')throw Error('Unsafe entry affected another legend');
   result.boundaryFallbacks++;
  } finally {built.element.remove();}
 }
 return result;
}
