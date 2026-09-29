import type {SpanItem} from './spanBlockBuilder';
/** Some publisher PDFs emit a collapsed copy of a multi-line heading before
 * its positioned glyphs. Remove only coincident groups whose every long run has
 * a nearby identical positioned copy. Repeated text elsewhere is legitimate. */
export function removeCollapsedTextCopies(items:SpanItem[]):SpanItem[] {
 const remove=new Set<SpanItem>();
 for(const seed of items) {
  if(seed.text.trim().length<20 || remove.has(seed))continue;
  const em=seed.fontSize||8;
  const same=items.filter(i=>i.text.trim().length>=20 && Math.abs(i.rect[0]-seed.rect[0])<.1 && Math.abs(i.rect[1]-seed.rect[1])<.1);
  if(new Set(same.map(i=>i.text)).size<2) {
   // A single-line title can also be painted once at the badge origin and
   // again at its actual title position. Require a numbered badge physically
   // overlapping the first copy; ordinary repeated text is not enough.
   const badge=items.find(i=>/^(?:Table|Figure)\s+\d+$/.test(i.text.trim())
    && i.rect[0]>=seed.rect[0] && i.rect[0]<seed.rect[0]+em
    && Math.abs(i.rect[3]-seed.rect[3])<em*.4);
   const copy=badge&&items.find(i=>i!==seed&&i.text===seed.text
    && Math.abs((i.fontSize||em)-em)<.1 && Math.abs(i.rect[3]-badge.rect[3])<.1
    && i.rect[0]>badge.rect[2]+em && i.rect[0]<badge.rect[2]+em*3);
   if(copy) remove.add(seed);
   continue;
  }
  const copies=same.map(i=>items.find(j=>!same.includes(j)&&j.text===i.text&&Math.abs((j.fontSize||8)-em)<.1
   && j.rect[0]>i.rect[0]+em && j.rect[0]-i.rect[0]<em*8 && Math.abs(j.rect[1]-i.rect[1])<em*3));
  if(copies.some(i=>!i))continue;
  same.forEach(i=>remove.add(i));
  // Small trailing runs (=, n, digits) belong to the duplicate only when the
  // exact same run also exists at the counterpart line's displacement.
  same.forEach((run,n)=>{
   const copy=copies[n]!,dx=copy.rect[0]-run.rect[0],dy=copy.rect[1]-run.rect[1];
   for(const tail of items) {
    if(tail.rect[0]<run.rect[2]-.1||tail.rect[0]>run.rect[2]+em*4||Math.abs(tail.rect[1]-run.rect[1])>em*.3)continue;
    if(items.some(other=>other!==tail&&other.text===tail.text&&Math.abs(other.rect[0]-tail.rect[0]-dx)<.15&&Math.abs(other.rect[1]-tail.rect[1]-dy)<.15))remove.add(tail);
   }
  });
 }
 return items.filter(i=>!remove.has(i));
}
