import f from '../fixtures/regression/blankstein2009-encoded-panels.json';
import visual from '../fixtures/regression/blankstein2009-render.json';
import {decodeLegacyText} from '../../src/reader/legacyTextEncoding';
import {textContentItemRect} from '../../src/reader/zoteroReaderAdapter';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {buildStrictPage,probeStrictPlacement} from '../../src/ui/strictPageReplacement';
import type {SourceBlock} from '../../src/types/models';
export async function checkLegacyEncodedPanels(keep=false):Promise<void> {
 for(const n of [1,2,4,6,7,9]) for(const scale of [1,1.2]) {
  const p=f.pages.find(p=>p.page===n)!, im=new Image();im.src=visual.images[String(n) as keyof typeof visual.images];await im.decode();
  const canvas=document.createElement('canvas');canvas.width=p.width*scale*2;canvas.height=p.height*scale*2;canvas.getContext('2d')!.drawImage(im,0,0,canvas.width,canvas.height);
  let blocks:SourceBlock[],translations:Map<string,string>;
  if(n===9) {blocks=visual.page9.blocks as SourceBlock[];translations=new Map(visual.page9.translations.map(t=>[t.id,t.translatedText]));}
  else {
   const fonts=p.fonts as unknown as Record<string,{name:string;differences:Record<number,string>}>;
   const items=p.items.map(i=>({text:decodeLegacyText(i.str,fonts[i.fontName]!.name,fonts[i.fontName]!.differences),...textContentItemRect(i.transform,i.width)!}));
   // Replay the live legacy-font failure, not only correctly decoded fixtures.
   if(n===2)for(const item of items)if(item.text==='=')item.text='\x01';
   blocks=finalizePageRegions(structureTableCells(buildBlocksFromSpans(items,{pageIndex:n-1,pageWidth:p.width,pageHeight:p.height}).blocks,n-1,10,[],undefined,true,p.height),p.height);
   const wording:Record<string,string>={'Abbreviations and Acronyms':'缩写与首字母缩略词','Table 1':'表1','CT Perfusion Scan Parameters':'CT灌注扫描参数','Figure 2':'图2','Comprehensive Computed Tomography Protocol':'综合计算机断层扫描方案','Figure 3':'图3','Table 3':'表3','Table 4':'表4','Radiation Exposure of Stress Cardiac CT Versus SPECT MPI':'负荷心脏CT与SPECT MPI的辐射暴露','Per Vessel and Per Patient Diagnostic Accuracy of CT Perfusion and SPECT MPI':'CT灌注与SPECT MPI按血管和患者评估的诊断准确性','Diagnostic Accuracy of CTP With SPECT as Reference Standard for All Subjects (n = 34)':'以SPECT为参考标准的全部受试者CTP诊断准确性（n = 34）'};
   if(n===2) {
    const defs=['冠状动脉疾病','计算机断层扫描','CT血管成像','CT灌注成像','延迟强化','双源CT','最大预测心率','心肌灌注成像','磁共振成像','单光子发射计算机断层扫描'];
    blocks.filter(b=>b.tableSource==='abbreviation').forEach((b,i)=>wording[b.sourceText]=b.sourceText.split(' = ')[0]+' = '+defs[i]);
   }
   if(n===1) for(const b of blocks) {
    if(b.sourceText.startsWith('Although cardiac computed'))wording[b.sourceText]='尽管心脏计算机断层扫描（CT）检测冠状动脉疾病（CAD）的诊断准确性很高，但许多病变的生理意义尚不确定（1）。此外，钙化动脉粥样硬化斑块会降低区分显著狭窄与非阻塞性斑块的能力。';
    if(b.sourceText.startsWith('Thus, invasive'))wording[b.sourceText]='因此，有创血管造影或单光子发射计算机断层扫描（SPECT）、正电子发射断层扫描以及磁共振成像（MRI）等灌注成像方法，通常更适合准确识别这些患者的阻塞性或具有生理意义的疾病。';
   }
   translations=new Map(blocks.filter(b=>wording[b.sourceText]).map(b=>[b.id,wording[b.sourceText]!]));
   if(translations.size!==(n===1?2:n===2?11:n===6?2:4))throw Error('Missing independent panel titles');
  }
  const built=buildStrictPage(document,{pageIndex:n-1,blocks,translations,render:{canvas,scale,viewportWidth:p.width*scale,viewportHeight:p.height*scale,toViewport:(x,y)=>[(x-p.view[0]!)*scale,(p.view[3]!-y)*scale]}})!;
  document.body.append(built.element);const el=built.element as any;
  const pending=el.pmSettleStrict(true);el.pmRevert(el.pmShrinkFit(el.pmExpandFit(pending.map((b:any)=>b.id))));
  const probes=probeStrictPlacement(built.element,false)!;
  for(const [id,text] of translations) {
   const result=probes.find(p=>p.id===id);
   if(result?.state!=='committed')throw Error(JSON.stringify({page:n,scale,id,result}));
   const node=built.element.querySelector(`[data-pm-block="${id}"]`) as HTMLElement;
   if(node.textContent!==text)throw Error('Translation clipped or changed');
   if((/^(图|表)[1234]$/.test(text)||text==='缩写与首字母缩略词')&&node.style.color!=='rgb(238, 241, 245)')throw Error('Badge lost contrasting white text: '+node.style.color);
  }
  if(el.pmGeometryAudit().violations)throw Error('Panel geometry violation');
  if(keep&&scale===1.2)built.element.dataset.testPage=String(n);else built.element.remove();
 }
}


/** Exact archived translations that failed on the user's 4.2.2pre4 machine. */
export async function checkArchivedBlanksteinFailures(keep=false):Promise<void> {
 const previous=(await import('../fixtures/regression/blankstein2009-pre4-failures.json')).default;
 const sidebar=(await import('../fixtures/regression/blankstein2009-pre6-sidebar.json')).default;
 const archived={pages:[...previous.pages,...sidebar.pages]};
 for(const sample of archived.pages)for(const scale of [1,1.04,1.2]) {
  const p=f.pages.find(p=>p.page===sample.page)!,im=new Image();im.src=visual.images[String(sample.page) as keyof typeof visual.images];await im.decode();
  const canvas=document.createElement('canvas');canvas.width=p.width*scale*2;canvas.height=p.height*scale*2;canvas.getContext('2d')!.drawImage(im,0,0,canvas.width,canvas.height);
  const targets=sample.page===2?sample.translations.map(t=>t.id):sample.page===4?['page-3-region-6','page-3-region-14']:['page-4-region-3'];
  const translations=new Map(sample.translations.map(t=>[t.id,t.translatedText]));
  const built=buildStrictPage(document,{pageIndex:sample.page-1,blocks:sample.blocks as SourceBlock[],translations,render:{canvas,scale,viewportWidth:p.width*scale,viewportHeight:p.height*scale,toViewport:(x,y)=>[(x-p.view[0]!)*scale,(p.view[3]!-y)*scale]}})!;
  document.body.append(built.element);const el=built.element as any;
  const pending=el.pmSettleStrict(true);el.pmRevert(el.pmShrinkFit(el.pmExpandFit(pending.map((b:any)=>b.id))));
  const probes=probeStrictPlacement(built.element,false)!;
  for(const id of targets) {
   const probe=probes.find(p=>p.id===id);if(probe?.state!=='committed')throw Error(JSON.stringify({page:sample.page,scale,id,probe}));
   const text=built.element.querySelector(`[data-pm-block="${id}"]`)!.textContent;
   if(text!==translations.get(id))throw Error('Archived translation was clipped');
  }
  if(el.pmGeometryAudit().violations)throw Error('Archived page overlap');
  if(keep&&sample.page===2&&scale===1.04)built.element.dataset.archivedSidebar='true';else built.element.remove();
 }
}
