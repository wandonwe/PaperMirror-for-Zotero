import type { SourceBlock } from '../types/models';

/** Match actual source lines, avoiding gutters and neighbouring columns. */
export function sourceBlockAtPoint(blocks: SourceBlock[], x: number, y: number,
 toCss: (x: number, y: number) => [number, number]): SourceBlock | undefined {
 let best: SourceBlock | undefined;
 let smallest = Infinity;
 for (const block of blocks) {
  const rects = block.lineRectsPdf?.length ? block.lineRectsPdf
   : block.sourceRegion ? [block.sourceRegion.boundsPdf] : [];
  for (const rect of rects) {
   const a = toCss(rect[0], rect[1]), b = toCss(rect[2], rect[3]);
   const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]);
   const top = Math.min(a[1], b[1]), bottom = Math.max(a[1], b[1]);
   const area = (right - left) * (bottom - top);
   if (x >= left - 2 && x <= right + 2 && y >= top - 2 && y <= bottom + 2 && area < smallest) {
    best = block; smallest = area;
   }
  }
 }
 return best;
}
