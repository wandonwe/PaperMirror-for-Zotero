import type {SourceRegion} from '../types/models';
import type {SpanItem} from './spanBlockBuilder';
type Rect=[number,number,number,number];
export interface OwnedCaption {region:SourceRegion;rows:SpanItem[][];}
const label=/^(?:Figure|Fig\.?)\s*\d+[.:]/i;
const bare=/^(?:Figure|Fig\.?)\s*\d+[.:]$/i;
function box(row:SpanItem[]):Rect {
 return [Math.min(...row.map(i=>i.rect[0])),Math.min(...row.map(i=>i.rect[1])),Math.max(...row.map(i=>i.rect[2])),Math.max(...row.map(i=>i.rect[3]))];
}
/** Only claim uninterrupted aligned caption bands. Uncertain rows stay in the normal parser. */
export function captionOwnership(rows:SpanItem[][],pageIndex:number,pageWidth:number):OwnedCaption[] {
 const sorted=[...rows].sort((a,b)=>box(b)[3]-box(a)[3]);
 const found:OwnedCaption[]=[];
 for(let i=0;i<sorted.length;i++) {
  const first=sorted[i]!,bounds=box(first),size=first[0]!.fontSize ?? bounds[3]-bounds[1];
  if(!label.test(first.map(s=>s.text).join(' ').trim()) || bounds[2]-bounds[0]<pageWidth*.4 || size<=0)continue;
  const members:SpanItem[][]=[];
  let bottom=bounds[3];
  for(let j=i;j<sorted.length;j++) {
   const row=sorted[j]!,r=box(row);
   if(j>i && (label.test(row.map(s=>s.text).join(' ').trim()) || Math.abs(r[0]-bounds[0])>size
    || r[2]>bounds[2]+size || bottom-r[3]<-1 || bottom-r[3]>size*.8)) break;
   // A caption beside another column must not claim that column's text.
   if(row.some((item,k)=>Math.abs((item.fontSize ?? item.rect[3]-item.rect[1])-size)>size*.12
    || (k>0 && !(k===1 && bare.test(row[0]!.text.trim())) && item.rect[0]-row[k-1]!.rect[2]>size*1.05)))break;
   members.push(row);bottom=r[1];
  }
  if(members.length<3)continue;
  const rects=members.map(box);
  found.push({region:{id:`page-${pageIndex}-caption-zone-${found.length}`,kind:'caption',
   boundsPdf:[bounds[0],Math.min(...rects.map(r=>r[1])),Math.max(...rects.map(r=>r[2])),bounds[3]],evidence:'label-aligned-lines'},rows:members});
  i+=members.length-1;
 }
 return found;
}
