import type { SourceBlock } from '../types/models';

type Content = Pick<SourceBlock, 'id' | 'sourceText' | 'memberIds' | 'tableId' | 'tableRow' | 'tableCol' | 'tableRowSpan' | 'tableColSpan'>;
/** Content conservation is separate from visual overlap: a non-overlapping table
 * can still drop, duplicate or reassign a source fragment. */
export function auditTableOwnership(before: Content[], after: Content[]): string[] {
 const sources=new Map(before.map(b=>[b.id,b]));
 const counts=new Map<string,number>();
 const issues:string[]=[];
 const inventory=(s:string)=>[...s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'')].sort().join('');
 for(const cell of after) {
  const ids=sources.has(cell.id)?[cell.id]:(cell.memberIds??[]);
  for(const id of ids) {
   if(!sources.has(id)) {issues.push(`unknown-member:${cell.id}:${id}`);continue;}
   counts.set(id,(counts.get(id)??0)+1);
  }
  if(!ids.length) issues.push(`unowned-content:${cell.id}`);
  if(ids.every(id=>sources.has(id)) && inventory(cell.sourceText)!==inventory(ids.map(id=>sources.get(id)!.sourceText).join(''))) issues.push(`content-changed:${cell.id}`);
 }
 for(const id of sources.keys()) {
  const n=counts.get(id)??0;
  if(n!==1) issues.push(`${n===0?'missing-member':'duplicate-member'}:${id}`);
 }
 const tables=new Map<string,Content[]>();
 for(const c of after) if(c.tableId) {const list=tables.get(c.tableId)??[];list.push(c);tables.set(c.tableId,list);}
 for(const cells of tables.values()) {
  for(const c of cells) if(!Number.isInteger(c.tableRow)||!Number.isInteger(c.tableCol)||c.tableRow!<0||c.tableCol!<0
   || !Number.isInteger(c.tableRowSpan??1)||!Number.isInteger(c.tableColSpan??1)||(c.tableRowSpan??1)<1||(c.tableColSpan??1)<1) issues.push(`invalid-cell:${c.id}`);
  for(let i=0;i<cells.length;i++) for(let j=i+1;j<cells.length;j++) {
   const a=cells[i]!,b=cells[j]!;
   if(a.tableRow!<b.tableRow!+(b.tableRowSpan??1)&&b.tableRow!<a.tableRow!+(a.tableRowSpan??1)
    &&a.tableCol!<b.tableCol!+(b.tableColSpan??1)&&b.tableCol!<a.tableCol!+(a.tableColSpan??1)) issues.push(`duplicate-slot:${a.id}:${b.id}`);
  }
 }
 return issues;
}
