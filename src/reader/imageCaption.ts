import type { Rect } from './figureBarriers';
import { insideObstacle } from './figureBarriers';
import type { SourceBlock } from '../types/models';

/** A caption is still text when its publisher placed it inside a composite image. */
export function imageCaptionRegions(lines: {text:string;rect:Rect;fontSize:number}[], images:Rect[]):Rect[] {
 const sorted=[...lines].sort((a,b)=>b.rect[3]-a.rect[3] || a.rect[0]-b.rect[0]);
 const regions:Rect[]=[];
 for(let i=0;i<sorted.length;i++) {
  const head=sorted[i]!;
  if(!/^(?:fig(?:ure)?\.?\s*\d+[a-z]?\s*[:.]?|图\s*\d+)/i.test(head.text.trim()) || !insideObstacle(head.rect,images)) continue;
  const group=[head];let previous=head;
  for(let j=i+1;j<sorted.length;j++) {
   const line=sorted[j]!;
   if(previous.rect[1]-line.rect[3]>head.fontSize*1.5) break;
   if(line.rect[3]>=previous.rect[3]-head.fontSize*0.5) continue;
   if(Math.abs(line.rect[0]-head.rect[0])>head.fontSize*2 || Math.abs(line.fontSize-head.fontSize)>head.fontSize*0.3) continue;
   if(!insideObstacle(line.rect,images)) break;
   group.push(line);previous=line;
  }
  if(group.length<2 || group.map(l=>l.text).join(' ').length<100) continue;
  regions.push([Math.min(...group.map(l=>l.rect[0])),Math.min(...group.map(l=>l.rect[1])),Math.max(...group.map(l=>l.rect[2])),Math.max(...group.map(l=>l.rect[3]))]);
 }
 return regions;
}
export function withinCaption(rect:Rect, regions:Rect[]):boolean {
 return regions.some(r=>rect[0]>=r[0]-0.1 && rect[1]>=r[1]-0.1 && rect[2]<=r[2]+0.1 && rect[3]<=r[3]+0.1);
}
export function markImageCaptions(blocks:SourceBlock[], regions:Rect[]):void {
 for(const region of regions) {
  const members=blocks.filter(b=>b.lineRectsPdf?.length && b.lineRectsPdf.every(l=>withinCaption(l as Rect,[region])))
   .sort((a,b)=>Math.max(...b.lineRectsPdf!.map(l=>l[3]!))-Math.max(...a.lineRectsPdf!.map(l=>l[3]!)));
  const head=members[0];if(!head?.boundingBox) continue;
  const pageHeight=head.boundingBox.y+Math.max(...head.lineRectsPdf!.map(l=>l[3]!));
  const text=members.map(b=>b.sourceText).join(' ');
  const lines=members.flatMap(b=>b.lineRectsPdf!);
  head.sourceText=text;head.lineRectsPdf=lines;head.type='caption';head.imageTextRegionPdf=region;
  head.boundingBox={x:region[0],y:pageHeight-region[3],width:region[2]-region[0],height:region[3]-region[1]};
  head.memberIds=members.flatMap(b=>b.memberIds ?? [b.id]);
  head.styleRuns=members.flatMap(b=>b.styleRuns ?? []);
  for(const member of members.slice(1)) { const at=blocks.indexOf(member);if(at>=0) blocks.splice(at,1); }
 }
}
