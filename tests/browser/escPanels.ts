import f from '../fixtures/regression/esc2024-p8-panels.json';
import {buildBlocksFromSpans,type SpanItem} from '../../src/reader/spanBlockBuilder';
import {borderGrids,type Segment} from '../../src/reader/tableBorders';
import {coalesceRegions} from '../../src/reader/regionCoalescer';
import {structureTableCells} from '../../src/reader/tableStructure';
import {buildStrictPage} from '../../src/ui/strictPageReplacement';
import {localPaper} from '../../src/ui/translatedPageView';
export async function checkEscPanels(imageUrl:string):Promise<void> {
 const img=new Image();img.src=imageUrl;await img.decode();
 const grids=borderGrids(f.segments as Segment[],{pageHeight:f.pageHeight});
 const input=buildBlocksFromSpans(f.items as SpanItem[],{pageIndex:7,pageWidth:f.pageWidth,pageHeight:f.pageHeight,grids,includeReferences:true}).blocks;
 const all=coalesceRegions(structureTableCells(input,7,9,[],grids,true,f.pageHeight));
 const blocks=all.filter(b=>b.tableId?.includes('gridparts'));
 const glossary=all.filter(b=>b.tableId==='page-7-continuation');
 const wording=['定义','推荐措辞','I类','推荐或适用','证据和／或普遍共识表明，某项治疗或操作有益、有用且有效。','II类','对于某项治疗或操作的有用性或疗效，证据相互矛盾，或存在意见分歧。','证据或意见倾向于有用或有效。','IIa类','应考虑','IIb类','证据或意见尚不足以充分证实有用性或疗效。','可考虑','III类','证据或普遍共识表明，某项治疗或操作无用或无效，某些情况下可能有害。','不推荐'];
 if(blocks.length!==wording.length)throw Error('Bad panel count');
 const glossaryText=['替格瑞洛联合阿司匹林或单药用于高危冠脉介入术后患者试验','血管分数血流储备','维生素K拮抗剂','血管痉挛性心绞痛','静脉血栓栓塞','女性非阻塞性冠状动脉疾病减少事件缺血试验','女性缺血评估最佳方法试验','运动心电图试验'];
 const sources=["Definition", "Wording to use", "Class I", "Is recommended or is indicated", "Evidence and/or general agreement that a given treatment or procedure is beneficial, useful, effective.", "Class II", "Conflicting evidence and/or a divergence of opinion about the usefulness/ efficacy of the given treatment or procedure.", "Weight of evidence/opinion is in favour of usefulness/efficacy.", "Class IIa", "Should be considered", "Class IIb", "Usefulness/efficacy is less well established by evidence/opinion.", "May be considered", "Class III", "Evidence or general agreement that the given treatment or procedure is not useful/effective, and in some cases may be harmful.", "Is not recommended"];
 const bySource=new Map(sources.map((source,i)=>[source,wording[i]!]));
 const translations=new Map(blocks.map(b=>{const text=bySource.get(b.sourceText);if(!text)throw Error("Unknown cell: "+b.sourceText);return [b.id,text];}));
 for(const b of glossary)translations.set(b.id,b.tableCol===0?b.sourceText:glossaryText[b.tableRow!]!);
 for(const scale of [1.0666666667,1.5]) {
 const canvas=document.createElement('canvas');canvas.width=f.pageWidth*scale;canvas.height=f.pageHeight*scale;canvas.getContext('2d')!.drawImage(img,0,0,canvas.width,canvas.height);
 const built=buildStrictPage(document,{pageIndex:7,blocks:[...blocks,...glossary],translations,render:{canvas,scale,viewportWidth:f.pageWidth*scale,viewportHeight:f.pageHeight*scale,toViewport:(x,y)=>[x*scale,(f.pageHeight-y)*scale]}})!;
 document.body.append(built.element);const p=built.element as any;const pending=p.pmSettleStrict(true);const failed=p.pmShrinkFit(p.pmExpandFit(pending.map((b:any)=>b.id)));p.pmRevert(failed);
 if(failed.length)throw Error('Panels failed '+JSON.stringify(p.pmProbe().filter((b:any)=>b.state!=='committed')));
 if(p.pmGeometryAudit().violations)throw Error('Panel overlap');
 }
 // White page margins must not win over a coloured line interior.
 const c=document.createElement('canvas');c.width=100;c.height=40;const ctx=c.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,100,40);ctx.fillStyle='rgb(80,190,140)';ctx.fillRect(10,10,80,20);ctx.fillStyle='black';ctx.fillRect(20,16,30,3);
 if(localPaper(ctx,{left:10,top:10,width:80,height:20},1,'white',true)!=='rgb(80, 190, 140)')throw Error('Lost panel background');
}
