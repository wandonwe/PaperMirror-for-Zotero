import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditTableOwnership } from '../../src/reader/tableOwnership';
import { structureTableCells } from '../../src/reader/tableStructure';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { orderBlocksForReading } from '../../src/reader/readingOrder';
import { extractAbbreviationTables } from '../../src/reader/abbreviationTable';
import fixture from '../fixtures/regression/stroke2026-e321.json';
import type { SourceBlock } from '../../src/types/models';
const sources=[{id:'a',sourceText:'Alpha 12'},{id:'b',sourceText:'Beta 34'}];
const cell={id:'cell',sourceText:'Alpha 12 Beta 34',memberIds:['a','b'],tableId:'t',tableRow:0,tableCol:0};
test('ownership rejects missing, repeated, foreign and changed source content',()=>{
 assert.deepEqual(auditTableOwnership(sources,[cell]),[]);
 for(const [after,code] of [
  [[{...cell,memberIds:['a']}],'missing-member:'],
  [[cell,{...cell,id:'second',tableRow:1}],'duplicate-member:'],
  [[{...cell,memberIds:['a','b','foreign']}],'unknown-member:'],
  [[{...cell,sourceText:'Alpha 12 Beta 35'}],'content-changed:']
 ] as const) assert.ok(auditTableOwnership(sources,after as any).some(i=>i.startsWith(code)),code);
});
test('merged cell spans cannot claim an already owned slot',()=>{
 const a={id:'ca',sourceText:'Alpha 12',memberIds:['a'],tableId:'t',tableRow:0,tableCol:0,tableColSpan:2};
 const b={id:'cb',sourceText:'Beta 34',memberIds:['b'],tableId:'t',tableRow:0,tableCol:1};
 assert.ok(auditTableOwnership(sources,[a,b]).some(i=>i.startsWith('duplicate-slot:')));
 assert.deepEqual(auditTableOwnership(sources,[a,{...b,tableRow:1}]),[]);
});
test('preassigned e321 cells survive arbitrary cell IDs and repeated structuring',()=>{
 const {cells}=extractAbbreviationTables(fixture.items as SpanItem[],5,585,783);
 const renamed=cells.map((c,i)=>({...c,id:`opaque-${i}`}));
 assert.deepEqual(structureTableCells(renamed,5,10,[],undefined,true,783),renamed);
});
test('invalid preassigned content is retained with an explicit audit reason',()=>{
 const blocks:SourceBlock[]=sources.map((s,i)=>({...s,pageIndex:0,order:i,type:'paragraph',tableId:'t',tableSource:'abbreviation',tableRow:0,tableCol:0,tableContentRectPdf:[0,0,20,10]}));
 const result=structureTableCells(blocks,0,10);
 assert.deepEqual(result.map(b=>b.sourceText),blocks.map(b=>b.sourceText));
 assert.ok(result.every(b=>b.tableStructureIssue?.includes('duplicate-slot:')));
});
test('wu2026 overlapping inferred regions use every original block once',()=>{
 const f=JSON.parse(readFileSync('tests/fixtures/layout/wu2026-p1.spans.json','utf8'));
 const source=orderBlocksForReading(buildBlocksFromSpans(f.items,{pageIndex:0,pageWidth:f.pageWidth,pageHeight:f.pageHeight,includeReferences:false}).blocks);
 const output=structureTableCells(source,0,10);
 assert.ok(output.some(b=>b.tableSource==='text-alignment'));
 assert.ok(output.every(b=>!b.tableStructureIssue));
 assert.deepEqual(auditTableOwnership(source,output),[]);
});

test('ownership failure remains in diagnostics after page content is released',async()=>{
 const {digestRows,diagnosticRows}=await import('../../src/translation/pageBlockDigest');
 const rows=diagnosticRows(digestRows({blocks:[{id:'a',pageIndex:0,order:0,type:'paragraph',sourceText:'Private source text',tableStructureIssue:'duplicate-member:a'}],translations:new Map()}));
 assert.equal(rows[0]?.tableStructureIssue,'duplicate-member:a');
 assert.equal(JSON.stringify(rows).includes('Private source text'),false);
});
