import type { SourceBlock } from '../types/models';

/** A view of the shared SourceBlock contract, never a second mutable structure. */
export function tableCellBounds(block: SourceBlock): [number, number, number, number] | undefined {
 return block.tableRectPdf ?? block.tableContentRectPdf;
}
export interface TableModel {
 id: string;
 source: SourceBlock['tableSource'];
 confidence: 'strong' | 'tentative';
 evidence: 'ruled-grid' | 'paired-headers' | 'text-alignment';
 cells: SourceBlock[];
}
export function pageTables(blocks: SourceBlock[]): TableModel[] {
 const tables = new Map<string, TableModel>();
 for (const b of blocks) {
  if (!b.tableId) continue;
  let table = tables.get(b.tableId);
  if (!table) {
   table = { id: b.tableId, source: b.tableSource, confidence: b.tableConfidence ?? 'tentative', evidence: b.tableSource === 'border' ? 'ruled-grid' : b.tableSource === 'abbreviation' ? 'paired-headers' : 'text-alignment', cells: [] };
   tables.set(b.tableId, table);
  }
  table.cells.push(b);
 }
 for (const t of tables.values()) t.cells.sort((a,b)=>(a.tableRow??0)-(b.tableRow??0)||(a.tableCol??0)-(b.tableCol??0));
 return [...tables.values()];
}
/** Structural correspondence in PDF coordinates, independent of font fitting. */
export function auditTableModel(blocks: SourceBlock[]): string[] {
 const issues: string[] = [];
 for (const table of pageTables(blocks)) {
  for (const c of table.cells) {
   const r = tableCellBounds(c);
   if (!c.tableSource || c.tableSource !== table.source) issues.push(`table-source:${c.id}`);
   if (!r || !r.every(Number.isFinite) || r[2]<=r[0] || r[3]<=r[1]) issues.push(`table-bounds:${c.id}`);
   if (!Number.isInteger(c.tableRow)||!Number.isInteger(c.tableCol)||(c.tableRow??-1)<0||(c.tableCol??-1)<0) issues.push(`table-address:${c.id}`);
  }
  for (let i=0;i<table.cells.length;i++) for (let j=i+1;j<table.cells.length;j++) {
   const a=table.cells[i]!,b=table.cells[j]!, ar=tableCellBounds(a),br=tableCellBounds(b);
   if (!ar || !br) continue;
   if (a.tableRow===b.tableRow && a.tableCol!<b.tableCol! && ar[0]>=br[2]) issues.push(`table-column-order:${a.id}:${b.id}`);
   if (a.tableCol===b.tableCol && a.tableRow!<b.tableRow! && ar[3]<=br[1]) issues.push(`table-row-order:${a.id}:${b.id}`);
  }
 }
 return issues;
}
