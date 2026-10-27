import f from '../fixtures/regression/gori-acquisition-p4.spans.json';
import translations from '../fixtures/regression/gori-acquisition-p4.translations.json';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {isEcho,buildStrictPage} from '../../src/ui/strictPageReplacement';

export function checkTwoColumnTable(keepPreview = false, background?: HTMLImageElement): void {
 const raw = buildBlocksFromSpans(f.items as SpanItem[], {pageIndex:3,pageWidth:f.pageWidth,pageHeight:f.pageHeight,includeReferences:true}).blocks;
 const blocks = finalizePageRegions(structureTableCells(raw,3,8,[],[],true,f.pageHeight),f.pageHeight)
  .filter(b=>b.tableId?.includes('paired-description') || b.sourceText==='Table 1 Acquisition protocol');
 for (const scale of [.8,1.2,2]) {
  const canvas=document.createElement('canvas');canvas.width=Math.round(f.pageWidth*scale);canvas.height=Math.round(f.pageHeight*scale);
  const ctx=canvas.getContext('2d')!;
  if(background)ctx.drawImage(background,0,0,canvas.width,canvas.height);
  else {ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);}
  const translated=new Map(blocks.map(b=>[b.id,b.tableRow===undefined?translations.title:translations.rows[b.tableRow]![b.tableCol!]!]));
  const built=buildStrictPage(document,{pageIndex:3,blocks,translations:translated,
   render:{canvas,scale,viewportWidth:f.pageWidth*scale,viewportHeight:f.pageHeight*scale,toViewport:(x,y)=>[x*scale,(f.pageHeight-y)*scale]}})!;
  document.body.append(built.element);
  const page=built.element as any;
  const pending=page.pmSettleStrict(true);
  const failed=page.pmShrinkFit(page.pmExpandFit(pending.map((b:any)=>b.id)));
  page.pmRevert(failed);
  if(failed.length)throw Error('Paired table unplaced at '+scale+': '+JSON.stringify(page.pmProbe().filter((b:any)=>b.state!=='committed')));
  for(const b of blocks) {
   if(isEcho(b.sourceText,translated.get(b.id)!)) continue; // software identifiers remain original
   const node=built.element.querySelector(`[data-pm-block="${b.id}"]`) as HTMLElement;
   if(!node || node.textContent?.replace(/\s/g,'')!==translated.get(b.id)!.replace(/\s/g,'') || node.style.visibility==='hidden')throw Error('Lost paired cell '+b.id);
  }
  const audit=page.pmGeometryAudit();
  if(audit.violations || audit.adjusted || audit.reverted)throw Error('Paired table overlap '+JSON.stringify(audit));
  const probes=page.pmProbe();
  // Actual rendered boxes must also stay apart: geometry audit alone could
  // miss wrong semantic ownership, while text checks alone could miss overlap.
  for(let i=0;i<probes.length;i++)for(let j=i+1;j<probes.length;j++) {
   const a=probes[i],b=probes[j];
   const overlapX=Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left);
   const overlapY=Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top);
   if(overlapX>1 && overlapY>1)throw Error('Paired cells overlap '+a.id+' '+b.id);
  }
  if(keepPreview && scale===1.2) {built.element.style.margin='0 auto';(window as any).tablePreview=built.element;}
  else built.element.remove();
 }
}
