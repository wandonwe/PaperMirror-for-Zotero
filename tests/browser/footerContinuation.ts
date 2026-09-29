import f from '../fixtures/regression/bell2026-extraction.json';
import visual from '../fixtures/regression/bell2026-watermark.json';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {buildStrictPage,probeStrictPlacement} from '../../src/ui/strictPageReplacement';
export async function checkFooterContinuation(keep=false):Promise<void>{
 const page=f.pages[2]!;
 for(const scale of [1,1.2,1.6]){
 const im=new Image();im.src=visual.pages[2]!.image;await im.decode();
 const canvas=document.createElement('canvas');canvas.width=585*scale*2;canvas.height=783*scale*2;canvas.getContext('2d')!.drawImage(im,0,0,canvas.width,canvas.height);
 const blocks=finalizePageRegions(structureTableCells(buildBlocksFromSpans(page.items as any,{pageIndex:2,pageWidth:585,pageHeight:783,imageRectsPdf:[],includeReferences:true}).blocks,1,9.5,[],undefined,true,783),783);
 const body=blocks.find(b=>b.sourceText.startsWith('Event rates were higher'));
 if(!body || body.sourceText.includes('2026'))throw Error('Footer merged into body');
 const translations=new Map([[body.id,'随着狭窄特异性FFR-CT降低，事件发生率升高（表1）。狭窄特异性FFR-CT']]);
 const built=buildStrictPage(document,{pageIndex:2,blocks,translations,render:{canvas,scale,viewportWidth:585*scale,viewportHeight:783*scale,toViewport:(x,y)=>[x*scale,(783-y)*scale]}})!;
 document.body.append(built.element);const el=built.element as any;
 const pending=el.pmSettleStrict(true);el.pmRevert(el.pmShrinkFit(el.pmExpandFit(pending.map((b:any)=>b.id))));
 const probes=probeStrictPlacement(built.element,false)!;
 for(const [id,text] of translations){const probe=probes.find(p=>p.id===id);if(probe?.state!=='committed')throw Error(JSON.stringify({scale,id,probe}));if(built.element.querySelector(`[data-pm-block="${id}"]`)?.textContent!==text)throw Error('Clipped definition');}
 if(el.pmGeometryAudit().violations)throw Error('Glossary overlap');
 if(keep&&scale===1.6)built.element.id='footer-continuation';else built.element.remove();
 }
}
