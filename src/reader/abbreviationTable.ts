import { auditTableOwnership } from './tableOwnership';
import type { SpanItem } from './spanBlockBuilder';
import type { SourceBlock } from '../types/models';
type Rect = [number, number, number, number];

/** Explicit paired headers plus repeated aligned short keys identify a glossary,
 * including two independent tables on the same page. Run before prose merging. */
export function extractAbbreviationTables(items: SpanItem[], pageIndex: number, pageWidth: number, pageHeight: number): { cells: SourceBlock[]; rest: SpanItem[] } {
 const continuation=items.some(i=>/^Abbreviation$/i.test(i.text.trim())) ? {cells:[],rest:items} : extractContinuation(items,pageIndex,pageWidth,pageHeight);
 if(continuation.cells.length) return continuation;
 const headers=items.filter(i=>/^Abbreviation$/i.test(i.text.trim())).sort((a,b)=>a.rect[0]-b.rect[0]);
 const spanIds=new Map(items.map((item,i)=>[item,`page-${pageIndex}-span-${i}`]));
 const used=new Set<SpanItem>(),cells:SourceBlock[]=[];
 const union=(xs:SpanItem[]):Rect=>[Math.min(...xs.map(i=>i.rect[0])),Math.min(...xs.map(i=>i.rect[1])),Math.max(...xs.map(i=>i.rect[2])),Math.max(...xs.map(i=>i.rect[3]))];
 for(let ti=0;ti<headers.length;ti++) {
  const head=headers[ti]!,font=head.fontSize||head.rect[3]-head.rect[1];
  const rightLimit=headers[ti+1]?.rect[0] ?? pageWidth;
  const meaning=items.find(i=>/^Meaning$/i.test(i.text.trim()) && Math.abs(i.rect[3]-head.rect[3])<font && i.rect[0]>head.rect[2] && i.rect[0]<rightLimit);
  if(!meaning) continue;
  const candidates=items.filter(i=>!used.has(i) && i.rect[0]>=head.rect[0]-font && i.rect[0]<meaning.rect[0]-font && i.rect[3]<head.rect[3]-font/2).sort((a,b)=>b.rect[3]-a.rect[3]);
  const rows:SpanItem[][]=[];
  for(const item of candidates) {
   const prev=rows[rows.length-1];
   if(prev && Math.abs(item.rect[3]-prev[0]!.rect[3])<font*.8) {prev.push(item);continue;}
   const text=item.text.trim();
   if(!/^[A-Za-z][A-Za-z0-9/-]{0,15}$/.test(text) || !/[A-Z]/.test(text) || (item.fontSize??font)>font*1.3) break;
   if((prev?prev[0]!.rect[3]:head.rect[3])-item.rect[3]>font*3.5) break;
   rows.push([item]);
  }
  if(rows.length<6) continue;
  const keys=[[head],...rows];
  const split=(Math.max(...keys.flatMap(r=>r.map(i=>i.rect[2])))+meaning.rect[0])/2;
  const entries=keys.map((key,r)=>{
   const box=union(key),top=r===0?box[3]+font*.4:(union(keys[r-1]!)[1]+box[3])/2;
   const bottom=r+1<keys.length?(box[1]+union(keys[r+1]!)[3])/2:box[1]-font*.4;
   // Vertical page furniture may have its centre inside a row; require
   // a horizontal text-sized box inside the row instead of centre-only ownership.
   const value=items.filter(i=>!used.has(i) && i.rect[3]-i.rect[1]<=font*1.8 && i.rect[1]>=bottom-font*.25 && i.rect[3]<=top+font*.25 && i.rect[0]>=split && i.rect[2]<rightLimit && (i.rect[1]+i.rect[3])/2<=top && (i.rect[1]+i.rect[3])/2>=bottom);
   return {key,value,top,bottom};
  });
  if(entries.some(e=>!e.value.length)) continue;
  const right=Math.min(rightLimit-font,Math.max(...entries.flatMap(e=>e.value.map(i=>i.rect[2])))+font*.4);
  for(let row=0;row<entries.length;row++) for(let col=0;col<2;col++) {
   const e=entries[row]!,parts=(col===0?e.key:e.value).slice().sort((a,b)=>Math.abs(a.rect[3]-b.rect[3])<font*.8?a.rect[0]-b.rect[0]:b.rect[3]-a.rect[3]);
   parts.forEach(i=>used.add(i));
   const rect=union(parts),text=parts.map(i=>i.text.trim()).join(col===0?'':' ');
   cells.push({id:`page-${pageIndex}-abbrev-${ti}-r${row}-c${col}`,pageIndex,order:cells.length,type:'paragraph',sourceText:text,fontSize:font,
    boundingBox:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},lineRectsPdf:[rect],
    tableRow:row,tableCol:col,tableGeometry:'inferred',tableId:`page-${pageIndex}-abbreviation-${ti}`,tableSource:'abbreviation',tableConfidence:'strong',memberIds:parts.map(p=>spanIds.get(p)!),tableContentRectPdf:[col===0?head.rect[0]-font*.4:split,e.bottom,col===0?split:right,e.top],
    translationMode:col===0 && row>0?'preserve':'translate',...(col===0 && row>0?{preserveReason:'defined-abbreviation' as const}:{})});
  }
 }
 const rest=items.filter(i=>!used.has(i));
 const source=(i:SpanItem)=>({id:spanIds.get(i)!,sourceText:i.text});
 if(auditTableOwnership(items.map(source),[...cells,...rest.map(source)]).length) return {cells:[],rest:items};
 return {cells,rest};
}

/** A headerless continuation needs six aligned acronym/value pairs near the
 * page top, with a persistent gutter and no missing definitions. */
function extractContinuation(items:SpanItem[],pageIndex:number,pageWidth:number,pageHeight:number):{cells:SourceBlock[];rest:SpanItem[]} {
 const keys=items.filter(i=>i.rect[0]<pageWidth*.4 && i.rect[3]>pageHeight*.72 && /^[a-z]?[A-Z][A-Z0-9/-]{1,14}$/.test(i.text.trim()));
 for(const seed of keys) {
  const font=seed.fontSize||9;
  const group=keys.filter(i=>Math.abs(i.rect[0]-seed.rect[0])<font*.4).sort((a,b)=>b.rect[3]-a.rect[3]);
  if(group.length<6 || group.some((i,n)=>n>0 && group[n-1]!.rect[1]-i.rect[3]>font*4))continue;
  const keyRight=Math.max(...group.map(i=>i.rect[2]));
  const first=items.filter(i=>i.rect[0]>keyRight+font*2 && i.rect[0]<pageWidth*.5 && Math.abs(i.rect[3]-group[0]!.rect[3])<font*.5).sort((a,b)=>a.rect[0]-b.rect[0])[0];
  if(!first)continue;
  const rows=group.map((key,n)=>{
   const bottom=group[n+1]?.rect[3] ?? key.rect[1]-font*.5;
   const value=items.filter(i=>i.rect[0]>=first.rect[0]-font*.3 && i.rect[2]<pageWidth*.5 && i.rect[3]<=key.rect[3]+font*.3 && i.rect[3]>bottom+font*.3 && Math.abs((i.fontSize||font)-font)<font*.2).sort((a,b)=>b.rect[3]-a.rect[3]||a.rect[0]-b.rect[0]);
   return {key,value};
  });
  if(rows.some(r=>!r.value.length || Math.abs(r.value[0]!.rect[3]-r.key.rect[3])>font*.5))continue;
  const used=new Set<SpanItem>(),cells:SourceBlock[]=[];
  rows.forEach((entry,row)=>{for(let col=0;col<2;col++) {
   const parts=col===0?[entry.key]:entry.value;parts.forEach(i=>used.add(i));
   const rect:[number,number,number,number]=[Math.min(...parts.map(i=>i.rect[0])),Math.min(...parts.map(i=>i.rect[1])),Math.max(...parts.map(i=>i.rect[2])),Math.max(...parts.map(i=>i.rect[3]))];
   cells.push({id:`page-${pageIndex}-continuation-r${row}-c${col}`,pageIndex,order:cells.length,type:'paragraph',sourceText:parts.map(i=>i.text.trim()).join(' '),fontSize:font,
    boundingBox:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},lineRectsPdf:parts.map(i=>i.rect),
    tableId:`page-${pageIndex}-continuation`,tableRow:row,tableCol:col,tableSource:'abbreviation',tableConfidence:'tentative',tableGeometry:'inferred',
    tableContentRectPdf:[rect[0],rect[1]-font*.1,col===0?first.rect[0]-font:pageWidth*.5-font,rect[3]+font*.1],translationMode:'translate'});
  }});
  return {cells,rest:items.filter(i=>!used.has(i))};
 }
 return {cells:[],rest:items};
}
