import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/stroke2026-e321.json';
import { buildBlocksFromSpans } from '../../src/reader/spanBlockBuilder';
import { structureTableCells } from '../../src/reader/tableStructure';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
import { extractAbbreviationTables } from '../../src/reader/abbreviationTable';
import type { SpanItem } from '../../src/reader/spanBlockBuilder';
const items=fixture.items as SpanItem[];
test('e321 abbreviation tables preserve independent row pairs through the pipeline',()=>{
 const result=buildBlocksFromSpans(items,{pageIndex:5,pageWidth:585,pageHeight:783,includeReferences:true});
 const structured=structureTableCells(result.blocks,5,10,[],undefined,true,783);
 const final=[...coalesceRegions(structured.filter(b=>b.translationMode===undefined)),...structured.filter(b=>b.translationMode!==undefined)];
 const cells=final.filter(b=>b.id.includes('-abbrev-'));
 assert.ok(cells.length>140,`only ${cells.length} cells`);
 for(const [key,value] of [['AF','atrial fibrillation'],['MCA','middle cerebral artery'],['GPC','graded compression stockings'],['GTN','glyceryl trinitrate'],['SpO2','oxygen saturation'],['LVO','large vessel occlusion']]) {
  const c=cells.find(b=>b.sourceText===key)!;assert.ok(c,key);
  const v=cells.find(b=>b.id===c.id.replace(/c0$/,'c1'))!;assert.equal(v.sourceText,value);
  assert.equal(c.translationMode,'preserve');assert.equal(v.translationMode,'translate');
 }
 assert.ok(final.some(b=>b.sourceText.includes('Every year in the United States')));
 const {cells:direct,rest}=extractAbbreviationTables(items,5,585,783);
 const chars=(s:string)=>[...s.replace(/\s/g,'')].sort().join('');
 assert.equal(chars([...direct.map(b=>b.sourceText),...rest.map(b=>b.text)].join('')),chars(items.map(b=>b.text).join('')));
});
test('a header alone does not turn ordinary prose into a glossary',()=>{
 const few=items.filter(i=>i.rect[3]>680);
 assert.equal(extractAbbreviationTables(few,5,585,783).cells.length,0);
});
