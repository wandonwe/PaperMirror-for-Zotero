import type { SourceBlock } from '../types/models';
import type { SpanItem } from './spanBlockBuilder';
import { joinLines } from './paragraphHeuristics';

type Rect = [number, number, number, number];
interface Line { items: SpanItem[]; rect: Rect; font: number }
interface Row { left: Line[]; right: Line[] }

const union = (items: SpanItem[]): Rect => [Math.min(...items.map(i => i.rect[0])),
 Math.min(...items.map(i => i.rect[1])), Math.max(...items.map(i => i.rect[2])), Math.max(...items.map(i => i.rect[3]))];
const itemFont = (item: SpanItem): number => item.fontSize || item.rect[3] - item.rect[1];
const fontOf = (items: SpanItem[]): number => {
 const weights = new Map<number, number>();
 for (const item of items) {
  const size = Math.round(itemFont(item) * 2) / 2;
  weights.set(size, (weights.get(size) || 0) + item.text.trim().length);
 }
 return [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] || 8;
};
function text(items: SpanItem[]): string {
 const sorted = items.slice().sort((a, b) => a.rect[0] - b.rect[0]);
 return sorted.reduce((out, item, index) => {
  const gap = index ? item.rect[0] - sorted[index - 1]!.rect[2] : 0;
  return out + (index && gap > itemFont(item) * .13 ? ' ' : '') + item.text.trim();
 }, '').trim();
}
const line = (items: SpanItem[]): Line => ({items, rect: union(items), font: fontOf(items)});
/** Group baselines independently of page gutters. The heading of the value
 * column may be centred, while the descriptions start far to its left. */
function linesOf(items: SpanItem[]): Line[] {
 const rows: SpanItem[][] = [];
 const usable = items.filter(i => i.text.trim() && i.rect.every(Number.isFinite)
  && !(i.text.trim().length > 1 && i.rect[3] - i.rect[1] > (i.rect[2] - i.rect[0]) * 3));
 for (const item of usable.slice().sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0])) {
  const height = item.rect[3] - item.rect[1];
  const row = rows.find(parts => {
   const box = union(parts), size = fontOf(parts);
   if (itemFont(item) < size * .8) return Math.min(box[3], item.rect[3]) - Math.max(box[1], item.rect[1]) >= height * .5;
   return Math.abs((box[1] + box[3]) / 2 - (item.rect[1] + item.rect[3]) / 2) < height * .6;
  });
  if (row) row.push(item); else rows.push([item]);
 }
 return rows.map(line).sort((a, b) => b.rect[3] - a.rect[3]);
}
const decorative = (item: SpanItem): boolean => /^[.·•…_–-]{8,}$/.test(item.text.replace(/\s/g, ''));
const captionStart = (value: string): boolean => /^Table\s+\d+\b(?:[.:]|\s|$)/i.test(value);
// Each header must be one text cluster. Several neighbouring column headings
// must never masquerade as a single long header in a two-column table.
const connectedHeader = (parts: SpanItem[], em: number): boolean => parts.every((item, index) =>
 index === 0 || item.rect[0] - parts[index - 1]!.rect[2] <= em * 1.6);
const labelText = (value: string): boolean => /[A-Za-z]/.test(value) && value.length <= 80
 && value.split(/\s+/).length <= 10 && !/[.!?;:]$/.test(value) && !/^\d/.test(value);

/** Recover label/description rows before general prose grouping joins them.
 * A caption, two headers, aligned labels, and repeated wrapped prose are all
 * required. This deliberately does not guess ordinary prose or numeric grids. */
export function extractTwoColumnTables(items: SpanItem[], pageIndex: number, pageHeight: number): {
 blocks: SourceBlock[]; used: Set<SpanItem>
} {
 const used = new Set<SpanItem>(), blocks: SourceBlock[] = [];
 const meaningful = items.filter(i => !decorative(i));
 const lines = linesOf(meaningful);
 for (const caption of lines) {
  if (caption.items.some(i => used.has(i)) || !captionStart(text(caption.items))) continue;
  const em = caption.font;
  const possibleHeaders = lines.filter(l => l.rect[3] < caption.rect[1]
   && caption.rect[1] - l.rect[3] < em * 4 && Math.abs(l.rect[0] - caption.rect[0]) < em * 2);
  for (const header of possibleHeaders) {
   const parts = header.items.slice().sort((a, b) => a.rect[0] - b.rect[0]);
   const gapIndex = parts.findIndex((p, i) => i > 0 && p.rect[0] - parts[i - 1]!.rect[2] > em * 4);
   if (gapIndex < 1) continue;
   const headerLeft = parts.slice(0, gapIndex), headerRight = parts.slice(gapIndex);
   if (!labelText(text(headerLeft)) || !labelText(text(headerRight))
    || !connectedHeader(headerLeft, header.font) || !connectedHeader(headerRight, header.font)) continue;
   const left = union(headerLeft)[0], bodyFont = header.font;
   const below = lines.filter(l => l.rect[3] < header.rect[1] && l.rect[0] >= left - bodyFont * .6);
   const first = below[0];
   if (!first || header.rect[1] - first.rect[3] > bodyFont * 3
    || Math.abs(first.rect[0] - left) > bodyFont * .4) continue;
   const firstParts = first.items.slice().sort((a, b) => a.rect[0] - b.rect[0]);
   const firstGap = firstParts.findIndex((p, i) => i > 0 && p.rect[0] - firstParts[i - 1]!.rect[2] > bodyFont * 1.2);
   if (firstGap < 1) continue;
   const firstLabel = firstParts.slice(0, firstGap), firstValue = firstParts.slice(firstGap);
   if (!labelText(text(firstLabel)) || text(firstValue).length < 25 || !/[A-Za-z]{4}/.test(text(firstValue))) continue;
   const rightStart = union(firstValue)[0];
   if (rightStart - left < bodyFont * 5 || rightStart - left > bodyFont * 24) continue;
   const split = rightStart - bodyFont * .45;
   const rows: Row[] = [];
   let previous = header;
   for (const candidate of below) {
    if (candidate.items.some(i => used.has(i)) || candidate.font < bodyFont * .86 || candidate.font > bodyFont * 1.14
     || previous.rect[1] - candidate.rect[3] > bodyFont * 2.5) break;
    const leftParts = candidate.items.filter(i => i.rect[2] <= split);
    const rightParts = candidate.items.filter(i => i.rect[0] >= split);
    // A full-width footnote or prose line is a boundary, never a table row.
    if (leftParts.length + rightParts.length !== candidate.items.length) break;
    if (leftParts.length) {
     const label = line(leftParts);
     if (!labelText(text(leftParts)) || label.rect[2] > rightStart - bodyFont * .6) break;
     if (Math.abs(label.rect[0] - left) <= bodyFont * .4) {
      if (!rightParts.length) break;
      rows.push({left: [label], right: [line(rightParts)]});
     } else {
      const current = rows[rows.length - 1];
      if (!current || label.rect[0] < left || label.rect[0] - left > bodyFont * 2.5) break;
      current.left.push(label);
      if (rightParts.length) current.right.push(line(rightParts));
     }
    } else {
     const current = rows[rows.length - 1];
     if (!current || !rightParts.length) break;
     current.right.push(line(rightParts));
    }
    previous = candidate;
   }
   if (rows.length < 4 || rows.filter(r => r.right.length >= 2).length < 2
    || rows.filter(r => /[A-Za-z]{4}/.test(joinLines(r.right.map(l => text(l.items))))).length < rows.length * .75) continue;
   const allParts = rows.flatMap(r => [...r.left, ...r.right].flatMap(l => l.items));
   const maxLabelRight = Math.max(...rows.flatMap(r => r.left.map(l => l.rect[2])));
   const minValueLeft = Math.min(...rows.flatMap(r => r.right.map(l => l.rect[0])));
   if (minValueLeft - maxLabelRight < bodyFont * .6) continue;
   const columnBoundary = (maxLabelRight + minValueLeft) / 2;
   const right = Math.max(...allParts.map(i => i.rect[2]), union(headerRight)[2]);
   if (right - rightStart < bodyFont * 12 || rightStart - left > (right - left) * .48) continue;
   const tableId = `page-${pageIndex}-paired-description-${blocks.length}`;
   const titleRect = caption.rect;
   blocks.push({id: `${tableId}-caption`, pageIndex, order: blocks.length, type: 'caption',
    sourceText: text(caption.items), fontSize: caption.font, lineRectsPdf: [titleRect],
    boundingBox: {x: titleRect[0], y: pageHeight - titleRect[3], width: titleRect[2] - titleRect[0], height: titleRect[3] - titleRect[1]},
    sourceRegion: {id: `${tableId}-caption`, kind: 'caption', boundsPdf: titleRect, evidence: 'label-aligned-lines'}, translationMode: 'translate'});
   caption.items.forEach(i => used.add(i));
   const entries: Row[] = [{left: [line(headerLeft)], right: [line(headerRight)]}, ...rows];
   for (let row = 0; row < entries.length; row++) {
    const entry = entries[row]!;
    const sourceTop = Math.max(...[...entry.left, ...entry.right].map(l => l.rect[3]));
    const sourceBottom = Math.min(...[...entry.left, ...entry.right].map(l => l.rect[1]));
    const next = entries[row + 1];
    const nextTop = next && Math.max(...[...next.left, ...next.right].map(l => l.rect[3]));
    const bottom = nextTop !== undefined ? (sourceBottom + nextTop) / 2 : sourceBottom - bodyFont * .2;
    const previousEntry = entries[row - 1];
    const previousBottom = previousEntry && Math.min(...[...previousEntry.left, ...previousEntry.right].map(l => l.rect[1]));
    const top = previousBottom !== undefined ? (previousBottom + sourceTop) / 2 : sourceTop + bodyFont * .2;
    for (let col = 0; col < 2; col++) {
     const own = col === 0 ? entry.left : entry.right;
     const parts = own.flatMap(l => l.items), rect = union(parts);
     parts.forEach(i => used.add(i));
     const bounds: Rect = [col === 0 ? left : columnBoundary, bottom, col === 0 ? columnBoundary : right, top];
     const id = `${tableId}-r${row}-c${col}`;
     blocks.push({id, pageIndex, order: blocks.length, type: 'paragraph', sourceText: joinLines(own.map(l => text(l.items))), fontSize: bodyFont,
      boundingBox: {x: rect[0], y: pageHeight - rect[3], width: rect[2] - rect[0], height: rect[3] - rect[1]}, lineRectsPdf: own.map(l => l.rect),
      tableId, tableRow: row, tableCol: col, tableGeometry: 'inferred', tableSource: 'text-alignment', tableConfidence: 'strong',
      tableContentRectPdf: bounds, translationMode: 'translate',
      sourceRegion: {id, kind: 'table-cell', boundsPdf: bounds, evidence: 'table-model'}});
    }
   }
   // Dotted table rules are drawing artefacts in the text layer. They belong
   // to the accepted table area but must not enter a translation request.
   const bottom = Math.min(...allParts.map(i => i.rect[1]));
   for (const item of items) if (decorative(item) && item.rect[0] >= left - bodyFont
    && item.rect[2] <= right + bodyFont && item.rect[3] < caption.rect[1] && item.rect[1] > bottom) used.add(item);
   break;
  }
 }
 return {blocks, used};
}
