import type {SourceBlock} from '../types/models';
import {obstacleBetween} from './figureBarriers';

type Rect=[number,number,number,number];
interface AnchorPair {left:SourceBlock;right:SourceBlock;}

function usableRect(r:Rect):boolean {
 return r.every(Number.isFinite) && r[2]>r[0] && r[3]>r[1];
}
function lines(b:SourceBlock):Rect[] {return (b.lineRectsPdf??[]).filter(usableRect);}
function bounds(b:SourceBlock):Rect|undefined {
 const rs=lines(b);
 return rs.length?[Math.min(...rs.map(r=>r[0])),Math.min(...rs.map(r=>r[1])),Math.max(...rs.map(r=>r[2])),Math.max(...rs.map(r=>r[3]))]:undefined;
}
function body(b:SourceBlock):boolean {
 return (b.type==='paragraph'||b.type==='list') && b.translationMode!=='preserve'
  && !b.isReference && b.tableId===undefined && b.tableRow===undefined && b.tableCol===undefined
  && !b.imageTextRegionPdf && !b.preserveReason
  && (!b.sourceRegion || b.sourceRegion.kind==='body-column')
  && Number.isFinite(b.fontSize) && (b.fontSize??0)>0 && !!bounds(b);
}
function sameSize(a:SourceBlock,b:SourceBlock):boolean {
 const x=a.fontSize!,y=b.fontSize!;
 return Math.abs(x-y)<=Math.min(x,y)*0.16;
}
function trustedAnchor(b:SourceBlock):boolean {
 const r=bounds(b);
 return body(b) && typeof b.column==='number' && b.column>=0 && !!r
  && r[2]-r[0]>=b.fontSize!*8
  && (b.sourceText.match(/\p{L}{2,}/gu)?.length??0)>=3;
}
function pairFor(a:SourceBlock,b:SourceBlock):AnchorPair|undefined {
 if(a.pageIndex!==b.pageIndex || a.column===b.column || !sameSize(a,b))return;
 const ra=bounds(a)!,rb=bounds(b)!;
 const [left,right]=ra[0]<rb[0]?[a,b]:[b,a];
 const l=bounds(left)!,r=bounds(right)!,em=Math.min(a.fontSize!,b.fontSize!);
 const w1=l[2]-l[0],w2=r[2]-r[0],gap=r[0]-l[2];
 // Two independently stamped, substantial body columns must coexist at this
 // height. A lone column or distant sidebar cannot repair a spanning stamp.
 if(gap<em*0.5 || gap>Math.min(w1,w2)*0.5 || Math.min(w1,w2)/Math.max(w1,w2)<0.7)return;
 if(Math.min(l[3],r[3])-Math.max(l[1],r[1])<em*0.5)return;
 return {left,right};
}
function fitsColumn(candidate:SourceBlock,anchor:SourceBlock):boolean {
 if(!sameSize(candidate,anchor))return false;
 const c=bounds(candidate)!,a=bounds(anchor)!,slack=anchor.fontSize!*0.5;
 return c[0]>=a[0]-slack && c[2]<=a[2]+slack
  && c[2]-c[0]<=(a[2]-a[0])*1.1;
}
function nearby(candidate:SourceBlock,anchor:SourceBlock,barriers:Rect[]):boolean {
 const em=Math.min(candidate.fontSize!,anchor.fontSize!);
 return lines(candidate).some(c=>lines(anchor).some(a=>{
  const gap=Math.max(c[1]-a[3],a[1]-c[3],0);
  const upper=c[1]>=a[1]?c:a,lower=upper===c?a:c;
  // Drawn horizontal rules can be thinner than the image-barrier helper's
  // four-point coverage threshold. They still provide an explicit boundary.
  const thinRule=barriers.some(o=>usableRect(o) && o[3]-o[1]<4
   && Math.min(o[2],c[2])-Math.max(o[0],c[0])>=Math.min(6,(c[2]-c[0])*0.5)
   && Math.min(o[2],a[2])-Math.max(o[0],a[0])>=Math.min(6,(a[2]-a[0])*0.5)
   && Math.min(upper[1],o[3])>Math.max(lower[3],o[1]));
  return gap<=em*3 && !thinRule && !obstacleBetween(c,a,barriers);
 }));
}

/** Repair only narrow, locally supported body fragments incorrectly stamped
 * full-width by a page-wide column vote (for example prose below a large plot).
 * Geometry, text and identity stay intact. This does not join across columns;
 * it lets the existing same-column reconstruction see its true neighbours.
 * Unknown fragments require an adjacent, existing anchor in a verified pair;
 * repaired fragments never become evidence for further repairs. */
export function repairBodyColumnOwnership(blocks:SourceBlock[],obstacles:Rect[]=[]):SourceBlock[] {
 const anchors=blocks.filter(trustedAnchor),pairs:AnchorPair[]=[];
 for(let i=0;i<anchors.length;i++)for(let j=i+1;j<anchors.length;j++) {
  const pair=pairFor(anchors[i]!,anchors[j]!);if(pair)pairs.push(pair);
 }
 if(!pairs.length)return blocks;
 let changed=false;
 const result=blocks.map(candidate=>{
  if(candidate.column!==-1 || candidate.sourceRegion || !body(candidate))return candidate;
  const owners=new Set<number>();
  for(const pair of pairs) {
   if(pair.left.pageIndex!==candidate.pageIndex)continue;
   const fits=[pair.left,pair.right].filter(anchor=>fitsColumn(candidate,anchor));
   if(fits.length!==1)continue;
   const anchor=fits[0]!,l=bounds(pair.left)!,r=bounds(pair.right)!;
   const barriers=blocks.filter(b=>b!==candidate && b!==anchor && b.pageIndex===candidate.pageIndex)
    .filter(b=>b.type==='caption'||b.type==='table'||b.type==='heading'||b.type==='title'
     || !!b.tableId || (b.column===-1 && !!bounds(b) && bounds(b)![0]<=l[2] && bounds(b)![2]>=r[0]))
    .flatMap(b=>lines(b));
   if(nearby(candidate,anchor,[...obstacles,...barriers,...(candidate.layoutBarriersPdf??[]),...(anchor.layoutBarriersPdf??[])]))owners.add(anchor.column!);
  }
  if(owners.size!==1)return candidate;
  changed=true;return {...candidate,column:[...owners][0]!};
 });
 return changed?result:blocks;
}
