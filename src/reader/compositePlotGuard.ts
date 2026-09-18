import type { SourceBlock } from '../types/models';

type Rect = [number, number, number, number];
const REASON = 'composite-plot-collapsed-rows';

/**
 * Forest plots can have an outer frame and axes but no per-study cell borders.
 * A border detector then welds many aligned study rows into one apparent cell.
 * Translation of that cell has no reliable row mapping: preserve the entire
 * panel, including its headers, numbers and coloured background. Do not guess
 * how a cached paragraph should be split back into study labels.
 */
export function preserveCollapsedPlotPanels(blocks: SourceBlock[]): SourceBlock[] {
 const groups = new Map<string, SourceBlock[]>();
 for (const block of blocks) {
  const id = block.tableId ?? block.id.match(/^(.*-table-\d+)-r\d+-c\d+$/)?.[1];
  if (!id) continue;
  const group = groups.get(id) ?? [];
  group.push(block);
  groups.set(id, group);
 }
 const protectedIds = new Set<string>();
 const panels: Rect[] = [];
 for (const group of groups.values()) {
  const text = group.map(b => b.sourceText).join(' ');
  const forestEvidence = /\bweight\b/i.test(text) && /\bCI\b|confidence\s+interval/i.test(text)
   && /(?:random|fixed)[ -]effects?|heterogeneity/i.test(text);
  const collapsed = group.some(b => {
   const studies = b.sourceText.match(/\b(?:19|20)\d{2}\b/g) ?? [];
   const rows: number[] = [];
   for (const r of b.lineRectsPdf ?? []) {
    const mid = (r[1] + r[3]) / 2;
    if (!rows.some(y => Math.abs(y - mid) <= Math.max(1, (b.fontSize ?? 10) * 0.35))) rows.push(mid);
   }
   return studies.length >= 3 && rows.length >= 4;
  });
  if (!forestEvidence || !collapsed) continue;
  const rects = group.flatMap(b => b.tableRectPdf ? [b.tableRectPdf] : b.lineRectsPdf ?? []);
  if (!rects.length) continue;
  panels.push([Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])),
   Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))]);
  group.forEach(b => protectedIds.add(b.id));
 }
 if (!panels.length) return blocks;
 return blocks.map(b => {
  // Also protect labels assigned to another inferred table inside this panel.
  const touchesPanel = (b.lineRectsPdf ?? []).some(r => panels.some(p =>
   Math.min(r[2], p[2]) - Math.max(r[0], p[0]) > 0.01
   && Math.min(r[3], p[3]) - Math.max(r[1], p[1]) > 0.01));
  // The central-illustration banner belongs to the same composite graphic;
  // retain its coloured strip too. Captions below the panel remain independent.
  const isBanner = /^centralillustration/i.test(b.sourceText.replace(/\s/g, ''))
   && (b.lineRectsPdf ?? []).some(r => panels.some(p => r[1] >= p[3] - 1
    && r[1] - p[3] <= (b.fontSize ?? 10) * 4
    && Math.min(r[2], p[2]) > Math.max(r[0], p[0])));
  if (!protectedIds.has(b.id) && !touchesPanel && !isBanner) return b;
  return { ...b, translationMode: 'preserve', preserveReason: REASON, tableStructureIssue: REASON };
 });
}
