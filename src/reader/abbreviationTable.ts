import { auditTableOwnership } from './tableOwnership';
import type { SpanItem } from './spanBlockBuilder';
import type { SourceBlock } from '../types/models';
type Rect = [number, number, number, number];

/** Explicit paired headers plus repeated aligned short keys identify a glossary,
 * including two independent tables on the same page. Run before prose merging. */
export function extractAbbreviationTables(items: SpanItem[], pageIndex: number, pageWidth: number, pageHeight: number): { cells: SourceBlock[]; rest: SpanItem[] } {
 const paired=extractTitledPairs(items,pageIndex,pageWidth,pageHeight);
 if(paired.cells.length)return paired;
 const inline=extractInlineDefinitions(items,pageIndex,pageWidth,pageHeight);
 if(inline.cells.length)return inline;
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

/** Sidebar glossary with inline "ACRONYM = definition" and wrapped definitions.
 * Treat each entry as one bounded row; its continuation can start below the key. */
export function extractInlineDefinitions(items:SpanItem[],pageIndex:number,pageWidth:number,pageHeight:number):{cells:SourceBlock[];rest:SpanItem[]} {
 for(const head of items.filter(i=>/^Abbreviations$/i.test(i.text.trim()))) {
  const em=head.fontSize||8, left=head.rect[0], right=Math.min(pageWidth,left+em*16);
  const separator=(text:string):boolean=>text.trim()==='=' || /^[\x01-\x08\x0b\x0c\x0e-\x1f]$/.test(text);
  const keys=items.filter(i=>/^[A-Z][A-Z0-9/-]{1,9}$/.test(i.text.trim())&&Math.abs(i.rect[0]-left)<em*.5&&i.rect[3]<head.rect[1]
   && items.some(j=>separator(j.text)&&Math.abs(j.rect[3]-i.rect[3])<em*.4&&j.rect[0]>=i.rect[2]-.1&&j.rect[0]-i.rect[2]<em*2)).sort((a,b)=>b.rect[3]-a.rect[3]);
  if(keys.length<6||keys.some((k,n)=>n>0&&keys[n-1]!.rect[1]-k.rect[3]>em*5))continue;
  // A legacy separator is accepted only with an explicit glossary header and
  // the same isolated glyph repeated in six or more aligned definitions.
  const markers=keys.map(k=>items.find(j=>separator(j.text)&&Math.abs(j.rect[3]-k.rect[3])<em*.4&&j.rect[0]>=k.rect[2]-.1&&j.rect[0]-k.rect[2]<em*2)!);
  if(new Set(markers.map(m=>m.text)).size!==1)continue;
  const used=new Set<SpanItem>(),cells:SourceBlock[]=[];
  for(let row=0;row<keys.length;row++) {
   const key=keys[row]!,font=key.fontSize||em;
   const bottom=keys[row+1] ? keys[row+1]!.rect[3]+font*.3 : key.rect[1]-font*3;
   const parts=items.filter(i=>i.rect[0]>=left-em*.5&&i.rect[2]<=right&&i.rect[3]<=key.rect[3]+font*.3&&i.rect[3]>bottom&&Math.abs((i.fontSize||font)-font)<font*.25)
    .sort((a,b)=>Math.abs(a.rect[3]-b.rect[3])<font*.4?a.rect[0]-b.rect[0]:b.rect[3]-a.rect[3]);
   if(!parts.includes(key)||parts.length<3)break;
   const rect:Rect=[Math.min(...parts.map(i=>i.rect[0])),Math.min(...parts.map(i=>i.rect[1])),Math.max(...parts.map(i=>i.rect[2])),Math.max(...parts.map(i=>i.rect[3]))];
   parts.forEach(i=>used.add(i));
   cells.push({id:`page-${pageIndex}-inline-abbrev-${row}`,pageIndex,order:row,type:'paragraph',sourceText:parts.map(i=>markers.includes(i)?'=':i.text.trim()).join(' '),fontSize:font,
    boundingBox:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},lineRectsPdf:parts.map(i=>i.rect),
    tableId:`page-${pageIndex}-inline-abbreviations`,tableRow:row,tableCol:0,tableSource:'abbreviation',tableConfidence:'strong',tableGeometry:'inferred',
    tableContentRectPdf:[rect[0],rect[1],rect[2],rect[3]],translationMode:'translate'});
  }
  if(cells.length===keys.length) {
   // The sidebar header belongs to the glossary, never to adjacent prose.
   // Reserve it only after the repeated aligned definitions certify this panel.
   const continuation=items.find(i=>/^and Acronyms$/i.test(i.text.trim())&&Math.abs(i.rect[0]-left)<em*.5&&i.rect[3]<head.rect[3]&&head.rect[1]-i.rect[3]<em*1.5);
   const heading=continuation?[head,continuation]:[head];heading.forEach(i=>used.add(i));
   const rect:Rect=[Math.min(...heading.map(i=>i.rect[0])),Math.min(...heading.map(i=>i.rect[1])),Math.max(...heading.map(i=>i.rect[2])),Math.max(...heading.map(i=>i.rect[3]))];
   cells.push({id:`page-${pageIndex}-inline-abbrev-heading`,pageIndex,order:cells.length,type:'heading',sourceText:heading.map(i=>i.text.trim()).join(' '),fontSize:em,translationMode:'translate',
    boundingBox:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},lineRectsPdf:heading.map(i=>i.rect),
    sourceRegion:{id:`page-${pageIndex}-abbreviation-heading`,kind:'caption',boundsPdf:rect,evidence:'label-aligned-lines'}});
   return {cells,rest:items.filter(i=>!used.has(i))};
  }
 }
 return {cells:[],rest:items};
}

/** Titled two-column glossaries have no "Meaning" header or equals sign.
 * Certify repeated key/value baselines; keep wrapped definitions with their key. */
function extractTitledPairs(items:SpanItem[],pageIndex:number,pageWidth:number,pageHeight:number):{cells:SourceBlock[];rest:SpanItem[]} {
 const ids=new Map(items.map((item,i)=>[item,`page-${pageIndex}-span-${i}`]));
 const used=new Set<SpanItem>(),cells:SourceBlock[]=[];
 const union=(parts:SpanItem[]):Rect=>[Math.min(...parts.map(i=>i.rect[0])),Math.min(...parts.map(i=>i.rect[1])),Math.max(...parts.map(i=>i.rect[2])),Math.max(...parts.map(i=>i.rect[3]))];
 for(const head of items.filter(i=>/^(?:Nonstandard\s+)?Abbreviations(?:\s+and\s+Acronyms)?$/i.test(i.text.trim()))) {
  const right=Math.min(pageWidth,head.rect[2]),left=head.rect[0];
  const keys=items.filter(i=>!used.has(i)&&/^[a-z]?[A-Z][A-Z0-9&/-]{1,19}$/.test(i.text.trim())&&Math.abs(i.rect[0]-left)<(i.fontSize||9)*.4&&i.rect[3]<head.rect[1]).sort((a,b)=>b.rect[3]-a.rect[3]);
  if(keys.length<6)continue;
  const font=keys[0]!.fontSize||9;
  if(head.rect[1]-keys[0]!.rect[3]>font*3)continue;
  const keyRight=Math.max(...keys.map(i=>i.rect[2]));
  const first=items.filter(i=>i.text.trim()&&i.rect[0]>keyRight+font*.5&&i.rect[2]<=right+font*.3&&Math.abs(i.rect[3]-keys[0]!.rect[3])<font*.4).sort((a,b)=>a.rect[0]-b.rect[0])[0];
  if(!first)continue;
  const rows=keys.map((key,n)=>{
   const bottom=keys[n+1]?keys[n+1]!.rect[3]+font*.35:key.rect[1]-font*2;
   const value=items.filter(i=>i.text.trim()&&!used.has(i)&&i.rect[0]>=first.rect[0]-font*.3&&i.rect[2]<=right+font*.3&&i.rect[3]<=key.rect[3]+font*.3&&i.rect[1]>=bottom&&Math.abs((i.fontSize||font)-font)<font*.25).sort((a,b)=>Math.abs(a.rect[3]-b.rect[3])<font*.4?a.rect[0]-b.rect[0]:b.rect[3]-a.rect[3]);
   return {key,value};
  });
  if(rows.some(r=>!r.value.length||Math.abs(r.value[0]!.rect[3]-r.key.rect[3])>font*.4||r.value.some((v,n)=>n>0&&r.value[n-1]!.rect[1]-v.rect[3]>font)))continue;
  const tableId=`page-${pageIndex}-paired-abbreviations-${cells.length}`;
  rows.forEach((row,n)=>{for(let col=0;col<2;col++){
   const parts=col===0?[row.key]:row.value,rect=union(parts);parts.forEach(i=>used.add(i));
   cells.push({id:`${tableId}-r${n}-c${col}`,pageIndex,order:cells.length,type:'paragraph',sourceText:parts.map(i=>i.text.trim()).join(' '),fontSize:font,
    boundingBox:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},lineRectsPdf:parts.map(i=>i.rect),memberIds:parts.map(i=>ids.get(i)!),
    tableId,tableRow:n,tableCol:col,tableSource:'abbreviation',tableConfidence:'strong',tableGeometry:'inferred',
    tableContentRectPdf:[rect[0],rect[1]-font*.1,col===0?first.rect[0]-font:right,rect[3]+font*.1],
    translationMode:col===0?'preserve':'translate',...(col===0?{preserveReason:'defined-abbreviation' as const}:{})});
  }});
  used.add(head);
  cells.push({id:`${tableId}-heading`,pageIndex,order:cells.length,type:'heading',sourceText:head.text,fontSize:head.fontSize,translationMode:'translate',memberIds:[ids.get(head)!],
   boundingBox:{x:left,y:pageHeight-head.rect[3],width:right-left,height:head.rect[3]-head.rect[1]},lineRectsPdf:[head.rect],
   sourceRegion:{id:`${tableId}-heading`,kind:'caption',boundsPdf:head.rect,evidence:'label-aligned-lines'}});
 }
 const rest=items.filter(i=>!used.has(i));
 const source=(i:SpanItem)=>({id:ids.get(i)!,sourceText:i.text});
 if(auditTableOwnership(items.map(source),[...cells,...rest.map(source)]).length)return {cells:[],rest:items};
 return {cells,rest};
}
