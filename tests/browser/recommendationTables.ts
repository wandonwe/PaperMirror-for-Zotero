import p20 from '../fixtures/regression/stroke2026-p20.json';
import p35 from '../fixtures/regression/stroke2026-p35.json';
import p46 from '../fixtures/regression/stroke2026-p46.json';
import { borderGrids, type Segment } from '../../src/reader/tableBorders';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { structureTableCells } from '../../src/reader/tableStructure';
import { buildStrictPage } from '../../src/ui/strictPageReplacement';
export function checkRecommendationTables():void {
 const cases=[
  {f:p20,key:'vendors should support',text:'6. 医疗机构、政府支付方和供应商应支持远程医疗/远程卒中资源和系统的使用，以确保在各种环境下为AIS患者提供每天24小时、每周7天的服务与照护。'},
  {f:p35,key:'BP should be maintained',text:'7. IVT治疗后至少前24小时，血压应维持在180/105 mm Hg以下。11–13'},
  {f:p46,key:'IV streptokinase',text:'6. 对于距最后正常时间6小时内符合条件的AIS患者，不应静脉给予链激酶，因为它不能提高90天功能独立率，并与早期死亡率增加相关。8'}
 ];
 for(const {f,key,text} of cases) {
  const grids=borderGrids(f.segments as Segment[],{pageHeight:f.pageHeight});
  const source=buildBlocksFromSpans(f.items as SpanItem[],{pageIndex:0,pageWidth:f.pageWidth,pageHeight:f.pageHeight,grids,includeReferences:true}).blocks;
  const blocks=structureTableCells(source,0,10,[],grids,true,f.pageHeight),cell=blocks.find(b=>b.sourceText.includes(key))!;
  if(!cell.tableRectPdf) throw Error('Recommendation lacks cell bounds');
  for(const scale of [.75,1.2]) {
   const canvas=document.createElement('canvas');canvas.width=f.pageWidth*scale;canvas.height=f.pageHeight*scale;
   const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
   const rendered=buildStrictPage(document,{pageIndex:0,blocks,translations:new Map([[cell.id,text]]),render:{canvas,viewportWidth:f.pageWidth*scale,viewportHeight:f.pageHeight*scale,scale,toViewport:(x,y)=>[x*scale,(f.pageHeight-y)*scale]}})!;
   document.body.append(rendered.element);const page=rendered.element as any;
   const initial=page.pmSettleStrict(true);const still=page.pmShrinkFit(initial.map((b:any)=>b.id));
   const node=rendered.element.querySelector(`[data-pm-block="${cell.id}"]`) as HTMLElement;
   if(still.length||!node||node.style.visibility==='hidden'||node.textContent!==text||page.pmGeometryAudit().violations) throw Error('Recommendation did not fit completely: '+key);
   const [l,b,r,t]=cell.tableRectPdf,rect=node.getBoundingClientRect(),parent=rendered.element.getBoundingClientRect();
   if(rect.left-parent.left<l*scale-1||rect.right-parent.left>r*scale+1||rect.top-parent.top<(f.pageHeight-t)*scale-1||rect.bottom-parent.top>(f.pageHeight-b)*scale+1) throw Error('Recommendation crossed cell: '+key);
   rendered.element.remove();
  }
 }
}
