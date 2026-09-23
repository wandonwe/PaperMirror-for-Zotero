import type {SpanLine, SpanItem} from './spanBlockBuilder';
import type {SourceBlock} from '../types/models';
import {joinLines} from './paragraphHeuristics';

/** Caption-anchored, single-column tables with repeated short category labels.
 * Recover paragraph boundaries BEFORE prose grouping consumes the whole table. */
export function extractDescriptiveTables(lines:SpanLine[], pageIndex:number, pageHeight:number): {blocks:SourceBlock[];used:Set<SpanItem>} {
 const used=new Set<SpanItem>(),blocks:SourceBlock[]=[];
 const text=(l:SpanLine)=>l.items.map(i=>i.text).join(' ').trim();
 for(const head of lines) {
  if(used.has(head.items[0]!) || !/^Table\s+\d+[.:]\s+\S/i.test(text(head))) continue;
  const width=head.rect[2]-head.rect[0], font=head.fontSize;
  if(width<font*15)continue;
  const below=lines.filter(l=>l!==head && l.rect[3]<head.rect[1] && l.rect[0]>=head.rect[0]-font*.3 && l.rect[2]<=head.rect[2]+font*.5)
   .sort((a,b)=>b.rect[3]-a.rect[3]);
  const groups:SpanLine[][]=[];
  let previous=head;
  for(const line of below) {
   if(used.has(line.items[0]!) || line.fontSize>font*1.05 || line.fontSize<font*.75 || previous.rect[1]-line.rect[3]>font*2.5)break;
   if(/^Table\s+\d+[.:]/i.test(text(line)) || /^[A-Z]{2,}\s+(?:indicates|denotes|means)\b/.test(text(line)))break;
   const last=groups[groups.length-1];
   if(last && previous.rect[1]-line.rect[3]<=line.fontSize*.5)last.push(line);else groups.push([line]);
   previous=line;
  }
  const label=(g:SpanLine[])=>g.length===1 && text(g[0]!).length<=50 && text(g[0]!).split(/\s+/).length<=6
   && /^[A-Z]/.test(text(g[0]!)) && !/[.!?;:]$/.test(text(g[0]!)) && g[0]!.rect[2]-g[0]!.rect[0]<width*.6;
  // Multiple label/description pairs are required: ordinary table captions
  // followed by continuous prose or numeric tables cannot qualify.
  if(groups.length<6 || !label(groups[0]!) || groups.filter(label).length<3)continue;
  if(groups.some((g,i)=>label(g) && (!groups[i+1] || label(groups[i+1]!) || text(groups[i+1]![0]!).length<55)))continue;
  const tableId=`page-${pageIndex}-descriptive-${blocks.length}`;
  const all=[[head],...groups];
  for(let row=0;row<all.length;row++) {
   const group=all[row]!,rect:[number,number,number,number]=[Math.min(...group.map(l=>l.rect[0])),Math.min(...group.map(l=>l.rect[1])),Math.max(...group.map(l=>l.rect[2])),Math.max(...group.map(l=>l.rect[3]))];
   group.forEach(l=>l.items.forEach(i=>used.add(i)));
   blocks.push({id:`${tableId}-r${row}-c0`,pageIndex,order:blocks.length,type:row===0?'table':'paragraph',sourceText:joinLines(group.map(text)),fontSize:group[0]!.fontSize,
    boundingBox:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},lineRectsPdf:group.map(l=>l.rect),
    tableId,tableRow:row,tableCol:0,tableGeometry:'inferred',tableSource:'text-alignment',tableConfidence:'tentative',
    tableContentRectPdf:[rect[0],rect[1]-Math.min(group[0]!.fontSize*.4,row+1<all.length?Math.max(0,(rect[1]-all[row+1]![0]!.rect[3])/2):group[0]!.fontSize*.4),head.rect[2],rect[3]+Math.min(group[0]!.fontSize*.4,row>0?Math.max(0,(all[row-1]![all[row-1]!.length-1]!.rect[1]-rect[3])/2):group[0]!.fontSize*.4)],translationMode:'translate'});
  }
 }
 return {blocks,used};
}
