import fixture from '../fixtures/regression/stroke2026-e321.json';
import { buildBlocksFromSpans } from '../../src/reader/spanBlockBuilder';
import type { SpanItem } from '../../src/reader/spanBlockBuilder';
import { buildStrictPage } from '../../src/ui/strictPageReplacement';
export function checkAbbreviationTable():void {
 const blocks=buildBlocksFromSpans(fixture.items as SpanItem[],{pageIndex:5,pageWidth:585,pageHeight:783,includeReferences:true}).blocks;
 const cells=blocks.filter(b=>b.id.includes('-abbrev-') && b.translationMode==='translate');
 for(const scale of [.75,1.2]) {
  const canvas=document.createElement('canvas');canvas.width=585*scale;canvas.height=783*scale;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
  const translations=new Map(cells.map(b=>[b.id,b.tableCol===0?'缩写':b.tableRow===0?'含义':'对应缩写的中文释义']));
  const rendered=buildStrictPage(document,{pageIndex:5,blocks,translations,render:{canvas,viewportWidth:585*scale,viewportHeight:783*scale,scale,toViewport:(x,y)=>[x*scale,(783-y)*scale]}})!;
  document.body.append(rendered.element);const page=rendered.element as any;
  const pending=page.pmSettleStrict(true);const still=page.pmShrinkFit(pending.map((b:any)=>b.id));
  if(still.length || page.pmGeometryAudit().violations) throw Error('Glossary fit/audit failed '+JSON.stringify(still));
  for(const cell of cells) {
   const node=rendered.element.querySelector(`[data-pm-block="${cell.id}"]`) as HTMLElement;
   if(!node || node.style.visibility==='hidden' || node.textContent!==translations.get(cell.id)) throw Error('Glossary cell missing '+cell.id);
   const r=cell.tableContentRectPdf!;
   const left=parseFloat(node.style.left),top=parseFloat(node.style.top),width=parseFloat(node.style.width),height=parseFloat(node.style.height);
   if(left<r[0]*scale-1 || left+width>r[2]*scale+1 || top<(783-r[3])*scale-1 || top+height>(783-r[1])*scale+1) throw Error('Glossary crosses cell '+cell.id);
  }
  rendered.element.remove();
 }
}
