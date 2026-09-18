import type {SourceBlock,SourceRegion} from '../types/models';
import {tableCellBounds} from '../ir/tableModel';
import {coalesceRegions} from './regionCoalescer';
import {orderBlocksForReading} from './readingOrder';
type Rect=[number,number,number,number];
function union(rects:Rect[]):Rect {
 return [Math.min(...rects.map(r=>r[0])),Math.min(...rects.map(r=>r[1])),Math.max(...rects.map(r=>r[2])),Math.max(...rects.map(r=>r[3]))];
}
function valid(r:Rect|undefined):r is Rect {return !!r && r.every(Number.isFinite) && r[2]>r[0] && r[3]>r[1];}
function bounds(b:SourceBlock):Rect|undefined {
 const rects=(b.lineRectsPdf??[]).filter(valid);return rects.length?union(rects):undefined;
}
/** Attach ownership without changing text, translation policy or table geometry. */
export function assignPageRegions(blocks:SourceBlock[],pageHeight:number):SourceBlock[] {
 const result=blocks.map(b=>({...b}));
 const body=new Map<string,SourceBlock[]>();
 const barriers=result.filter(b=>b.type==='caption' || b.tableId || b.column===-1).flatMap(b=>{const r=bounds(b);return r?[r]:[];});
 for(const b of result) {
  const cell=tableCellBounds(b),r=bounds(b);
  if(b.tableId && b.tableRow!==undefined && b.tableCol!==undefined && valid(cell)) {
   b.sourceRegion={id:`page-${b.pageIndex}-cell-${b.tableId}-${b.tableRow}-${b.tableCol}`,kind:'table-cell',boundsPdf:[...cell],evidence:'table-model'};continue;
  }
  if(b.sourceRegion || !r)continue;
  const atMargin=!!b.boundingBox && (b.boundingBox.y<pageHeight*.1 || b.boundingBox.y>pageHeight*.88);
  if(b.preserveReason==='running-head' || (atMargin && (b.preserveReason==='marks' || /^(?:[\w.-]+\.(?:org|com|edu)\b|Radiology:\s*Volume\b)/i.test(b.sourceText.trim())))) {
   b.sourceRegion={id:`page-${b.pageIndex}-furniture-${b.id}`,kind:'page-furniture',boundsPdf:r,evidence:'page-margin'};continue;
  }
  if(b.type==='caption') {
   b.sourceRegion={id:`page-${b.pageIndex}-caption-${b.id}`,kind:'caption',boundsPdf:r,evidence:'caption-continuation'};continue;
  }
  if((b.type==='paragraph' || b.type==='list') && (b.column??-1)>=0 && !b.tableId) {
   // A spanning region divides a column into independent vertical sections.
   const band=barriers.map((cut,i)=>cut[1]>=r[3]-.5 && Math.min(cut[2],r[2])>Math.max(cut[0],r[0])?i:-1).filter(i=>i>=0).join('.');
   const key=`page-${b.pageIndex}-column-${b.column}-band-${band||'top'}`;
   const group=body.get(key)??[];group.push(b);body.set(key,group);
  }
 }
 for(const [id,group] of body) {
  const area=union(group.map(b=>bounds(b)!));
  // Include a small amount of real whitespace beneath the band's last source
  // line. Ink-only bounds would reject ordinary one-line notes after translation.
  const floor=result.filter(b=>!group.includes(b)).map(bounds).filter(valid)
   .filter(r=>r[3]<=area[1] && Math.min(r[2],area[2])>Math.max(r[0],area[0]))
   .reduce((y,r)=>Math.max(y,r[3]+3),0);
  area[1]=Math.min(area[1],Math.max(floor,area[1]-24));
  const region:SourceRegion={id,kind:'body-column',boundsPdf:area,evidence:'column-geometry'};
  for(const b of group)b.sourceRegion={...region,boundsPdf:[...region.boundsPdf]};
 }
 return result;
}
/** Shared stage for char, text-content and text-layer extraction paths. */
export function finalizePageRegions(blocks:SourceBlock[],pageHeight:number,obstacles:Rect[]=[]):SourceBlock[] {
 const protectedBlocks=blocks.filter(b=>b.translationMode!==undefined);
 // Keep the established line/shard reconstruction before assigning body owners.
 // Premature column ownership freezes provisional column=-1 fragments and breaks
 // legitimate full-width paragraphs. Explicit parser caption owners remain guarded.
 const formulas=protectedBlocks.filter(b=>b.preserveReason==='display-formula').flatMap(b=>b.lineRectsPdf ?? []);
 const prose=coalesceRegions(blocks.filter(b=>b.translationMode===undefined),[...obstacles,...formulas]);
 return assignPageRegions(orderBlocksForReading([...prose,...protectedBlocks]),pageHeight);
}
