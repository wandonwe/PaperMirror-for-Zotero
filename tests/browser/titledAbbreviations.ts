import f from '../fixtures/regression/bell2026-extraction.json';
import visual from '../fixtures/regression/bell2026-watermark.json';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {buildStrictPage,probeStrictPlacement} from '../../src/ui/strictPageReplacement';
export async function checkTitledAbbreviations(keep=false):Promise<void>{
 const page=f.pages[1]!;
 for(const scale of [1,1.2,1.6]){
 const im=new Image();im.src=visual.pages[1]!.image;await im.decode();
 const canvas=document.createElement('canvas');canvas.width=585*scale*2;canvas.height=783*scale*2;canvas.getContext('2d')!.drawImage(im,0,0,canvas.width,canvas.height);
 const blocks=finalizePageRegions(structureTableCells(buildBlocksFromSpans(page.items as any,{pageIndex:1,pageWidth:585,pageHeight:783,imageRectsPdf:[],includeReferences:true}).blocks,1,9.5,[],undefined,true,783),783);
 const values=blocks.filter(b=>b.tableSource==='abbreviation'&&b.tableCol===1);
 if(values.length!==9)throw Error('Missing glossary pairs');
 const defs=['校正风险比','冠状动脉疾病','冠状动脉疾病报告与数据系统','冠状动脉计算机断层扫描血管造影','血流储备分数','计算机断层扫描血管造影衍生血流储备分数','稳定性心脏病患者的FFR-CT与冠状动脉CT血管造影：对患者护理及社会成本的影响','风险比','心肌梗死'];
 const translations=new Map(values.map((b,i)=>[b.id,defs[i]!]));
 const heading=blocks.find(b=>b.id.includes('paired-abbreviations')&&b.type==='heading');
 if(!heading)throw Error('Missing glossary heading');
 translations.set(heading.id,'非标准缩写与首字母缩略词');
 const built=buildStrictPage(document,{pageIndex:1,blocks,translations,render:{canvas,scale,viewportWidth:585*scale,viewportHeight:783*scale,toViewport:(x,y)=>[x*scale,(783-y)*scale]}})!;
 document.body.append(built.element);const el=built.element as any;
 const pending=el.pmSettleStrict(true);el.pmRevert(el.pmShrinkFit(el.pmExpandFit(pending.map((b:any)=>b.id))));
 const probes=probeStrictPlacement(built.element,false)!;
 for(const [id,text] of translations){const probe=probes.find(p=>p.id===id);if(probe?.state!=='committed')throw Error(JSON.stringify({scale,id,probe}));if(built.element.querySelector(`[data-pm-block="${id}"]`)?.textContent!==text)throw Error('Clipped definition');}
 if(el.pmGeometryAudit().violations)throw Error('Glossary overlap');
 if(keep&&scale===1.6)built.element.id='paired-glossary';else built.element.remove();
 }
}
