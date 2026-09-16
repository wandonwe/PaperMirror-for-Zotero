import fixtures from '../fixtures/regression/real-translations.json';
import { buildStrictPage } from '../../src/ui/strictPageReplacement';
import { showUnplacedTranslations } from '../../src/ui/unplacedTranslations';
import type { SourceBlock } from '../../src/types/models';
export async function checkRealTranslations():Promise<unknown[]> {
 const gallery=document.createElement('div');gallery.id='real-translation-gallery';gallery.style.cssText='display:flex;flex-wrap:wrap;align-items:start;gap:16px';document.body.prepend(gallery);
 const outputs:unknown[]=[];
 for(const f of fixtures) {
  const img=new Image();await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(Error('fixture image missing'));img.src=(window as any).realTranslationImages[f.page];});
  for(const scale of [1,.75,1.0266666666666666]) {
   const canvas=document.createElement('canvas');canvas.width=f.width*scale;canvas.height=f.height*scale;canvas.getContext('2d')!.drawImage(img,0,0,canvas.width,canvas.height);
   const blocks=f.blocks as SourceBlock[], translations=new Map(f.translations.map(t=>[t.id,t.translatedText]));
   const built=buildStrictPage(document,{pageIndex:f.page-1,blocks,translations,imageRectsPdf:(f as any).imageRectsPdf,render:{canvas,viewportWidth:canvas.width,viewportHeight:canvas.height,scale,toViewport:(x,y)=>[(x-((f as any).offsetX??0))*scale,(f.height+((f as any).offsetY??0)-y)*scale]}})!;
   gallery.append(built.element);const p=built.element as any;
   const initial=p.pmSettleStrict(true),expanded=p.pmExpandFit(initial.map((b:any)=>b.id));
   const still=p.pmShrinkFit(expanded);p.pmRevert(still);p.pmGeometryAudit();
   if(f.page===19) {
    const middle=built.element.querySelector('[data-pm-block="page-18-region-1"]')!;
    const right=built.element.querySelector('[data-pm-block="page-18-region-2"]')!;
    const ink=right.querySelector('.pm-flow-piece') ?? right;
    if(ink.getBoundingClientRect().left-middle.getBoundingClientRect().right<11*scale-1)
     throw Error('Bae p50: old footer contaminated the inter-column gutter');
   }
   const finalAudit=p.pmGeometryAudit();if(finalAudit.violations)throw Error('Real translation overlaps after audit on page '+f.page);
   const minimum=(f as any).minimumCommitted ?? (f.page===35?30:f.page===40?15:f.page===27?10:38);
   if(p.pmStats().committed<minimum)throw Error('Real translation placement regressed on page '+f.page+' at '+scale+' '+JSON.stringify({stats:p.pmStats(),abandoned:p.pmAbandoned()}));
   const abandoned=p.pmAbandoned() as {id:string;reason:string}[];
   const nodes=Array.from(built.element.querySelectorAll('[data-pm-block]')) as HTMLElement[];
   // Every actual service response is either fully retained in its rendering node
   // or accounted for by an explicit preserve/placement reason (never silently lost).
   for(const [id,text] of translations) {
    const block=blocks.find(b=>b.id===id);if(!block||block.translationMode==='preserve')continue;
    const node=nodes.find(n=>n.getAttribute('data-pm-block')===id);
    const parts=nodes.filter(n=>n.getAttribute('data-pm-block')?.startsWith(id+'::p'));
    if(!node && !parts.length && !abandoned.some(a=>a.id===id))throw Error('Unaccounted real translation '+id);
    if(parts.length && parts.map(n=>n.textContent).join('').replace(/\s/g,'')!==text.replace(/⟦\/?(?:b|i|sup|sub)⟧/g,'').replace(/\s/g,''))throw Error('Split translation lost text '+id);
    if(node && node.textContent!==text.replace(/⟦\/?(?:b|i|sup|sub)⟧/g,''))throw Error('Real translation text changed '+id);
   }
   const rows=abandoned.flatMap(a=>{const block=blocks.find(b=>b.id===a.id),text=translations.get(a.id);return block&&text&&a.reason!=='echo'?[{source:block.sourceText,translation:text,reason:a.reason}]:[];});
   if(rows.length){
    if(!showUnplacedTranslations(document,rows,f.page))throw Error('Unplaced entry missing');
    const panel=document.getElementById('pm-unplaced-translations')!;
    for(const row of rows)if(!panel.textContent?.includes(row.translation))throw Error('Unplaced viewer truncated text');
    panel.querySelector('button')!.click();if(document.getElementById('pm-unplaced-translations'))throw Error('Unplaced viewer did not close');
   }
   outputs.push({page:f.page,scale,stats:p.pmStats(),unplaced:abandoned.filter(a=>a.reason!=='echo').map(a=>a.id)});
   if(scale!==1)built.element.remove();
  }
 }
 return outputs;
}
