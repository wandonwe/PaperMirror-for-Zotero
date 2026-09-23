import f from '../fixtures/regression/gulati2021-e378.spans.json';
import translations from '../fixtures/regression/gulati2021-e378.translations.json';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {buildStrictPage} from '../../src/ui/strictPageReplacement';
export function checkDescriptiveTable():void {
 const blocks=buildBlocksFromSpans(f.items as SpanItem[],{pageIndex:10,pageWidth:f.pageWidth,pageHeight:f.pageHeight,includeReferences:true}).blocks.filter(b=>b.tableId?.includes('descriptive'));
 for(const scale of [0.8,1.2,2]) {
 const canvas=document.createElement('canvas');canvas.width=f.pageWidth*scale;canvas.height=f.pageHeight*scale;
 const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
 const built=buildStrictPage(document,{pageIndex:10,blocks,translations:new Map(blocks.map((b,i)=>[b.id,translations[i]!])),render:{canvas,scale,viewportWidth:f.pageWidth*scale,viewportHeight:f.pageHeight*scale,toViewport:(x,y)=>[x*scale,(f.pageHeight-y)*scale]}})!;
 document.body.append(built.element);const p=built.element as any;
 const pending=p.pmSettleStrict(true);const failed=p.pmShrinkFit(p.pmExpandFit(pending.map((b:any)=>b.id)));p.pmRevert(failed);
 if(failed.length)throw Error('Descriptive table unplaced '+scale+' '+JSON.stringify(p.pmProbe().filter((b:any)=>b.state!=='committed')));
 blocks.forEach((b,i)=>{const node=built.element.querySelector(`[data-pm-block="${b.id}"]`) as HTMLElement;if(!node || node.textContent!==translations[i] || node.style.visibility==='hidden')throw Error('Lost table cell '+b.id);});
 if(p.pmGeometryAudit().violations)throw Error('Descriptive table overlap');
 built.element.remove();
 }
}
