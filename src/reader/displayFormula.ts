import type { SpanItem } from './spanBlockBuilder';
import type { SourceBlock } from '../types/models';

// Some legacy PDF math fonts expose minus/brackets/equality as control codes
// and ¼. Separate these display equations BEFORE paragraph/column grouping.
// Ordinary prose (including sentences about formulas) is never a candidate.
const legacy = /[\u0001\u0012\u0013]/;
function mathFragment(item: SpanItem): boolean {
 const text = item.text.trim();
 if (!text || text.length > 120 || /[一-鿿.!?;:]/.test(text)) return false;
 const words = text.match(/[A-Za-z]+/g) ?? [];
 return words.every(w => w.length <= 2 || /^(Pri|Air|sin|cos|tan|log|exp|lim|max|min)$/i.test(w))
  && (legacy.test(text) || /[=¼+−∑∫√()]/.test(text) || words.length <= 3);
}

export function separateDisplayFormulas(items: SpanItem[], pageIndex: number, pageHeight: number): { rest: SpanItem[]; blocks: SourceBlock[] } {
 const candidates = items.filter(mathFragment), claimed = new Set<SpanItem>();
 const blocks: SourceBlock[] = [];
 for (const seed of candidates.filter(i => legacy.test(i.text))) {
  if (claimed.has(seed)) continue;
  const group = new Set([seed]);
  // Only local connected glyphs; never use a page-wide row envelope, which
  // could swallow a neighbouring column or an unrelated figure label.
  for (let changed = true; changed;) {
   changed = false;
   for (const item of candidates) {
    if (group.has(item) || claimed.has(item)) continue;
    const seedY = (seed.rect[1]+seed.rect[3])/2, itemY = (item.rect[1]+item.rect[3])/2;
    if (Math.abs(seedY-itemY) > 2.5*Math.max(seed.fontSize ?? 8,item.fontSize ?? 8)) continue;
    if ([...group].some(other => {
     const em = Math.max(item.fontSize ?? 8, other.fontSize ?? 8);
     const a = item.rect, b = other.rect;
     const dx = Math.max(0, a[0]-b[2], b[0]-a[2]);
     const dy = Math.max(0, a[1]-b[3], b[1]-a[3]);
     return dx <= em * 2 && dy <= em * 1.2;
    })) { group.add(item); changed = true; }
   }
  }
  const members = [...group].sort((a,b) => b.rect[3]-a.rect[3] || a.rect[0]-b.rect[0]);
  const text = members.map(i=>i.text).join(' ');
  // A broken bracket alone is insufficient evidence of a display equation.
  if (!/[=¼]/.test(text) || (text.match(/[=¼\u0001+−]/g) ?? []).length < 2) continue;
  const rect: [number,number,number,number] = [Math.min(...members.map(i=>i.rect[0])),Math.min(...members.map(i=>i.rect[1])),Math.max(...members.map(i=>i.rect[2])),Math.max(...members.map(i=>i.rect[3]))];
  members.forEach(i=>claimed.add(i));
  blocks.push({id:`page-${pageIndex}-formula-${blocks.length}`,pageIndex,order:blocks.length,type:'unknown',sourceText:text,
   translationMode:'preserve',preserveReason:'display-formula',lineRectsPdf:members.map(i=>[...i.rect]),
   fontSize:Math.max(...members.map(i=>i.fontSize ?? 8)),
   boundingBox:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]}});
 }
 return {rest:items.filter(i=>!claimed.has(i)),blocks};
}
