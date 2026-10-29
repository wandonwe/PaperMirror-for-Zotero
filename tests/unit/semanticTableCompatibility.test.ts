import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {looksTabular,looksTabularSeed} from '../../src/reader/tableGuard';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';

test('raised numeric source content retains the existing table evidence without flattening displayed text',()=>{
 for(const [flat,raised] of [['Stress CMR6','Stress CMR⁶'],['χ2','χ²'],['Method A9','Method A⁹'],['x3','x³']]) {
  assert.equal(looksTabular(raised!),looksTabular(flat!));
  assert.equal(looksTabularSeed(raised!),looksTabularSeed(flat!));
 }
 assert.equal(looksTabularSeed('An ordinary prose label'),false);
});
for(const file of ['gulati2021-p21-p1','wu2026-p6'])test(`${file}: script semantics cannot remove or reassign table rows`,()=>{
 const path=`tests/fixtures/layout/${file}`;
 const fixture=JSON.parse(readFileSync(`${path}.spans.json`,'utf8'));
 const previous=JSON.parse(readFileSync(`${path}.snapshot.json`,'utf8'));
 const initial=buildBlocksFromSpans(fixture.items,{pageIndex:0,pageWidth:fixture.pageWidth,pageHeight:fixture.pageHeight,includeReferences:false,referencesAlreadyStarted:false,imageRectsPdf:[]});
 const blocks=finalizePageRegions(structureTableCells(orderBlocksForReading(initial.blocks),0,10),fixture.pageHeight);
 const current=blocks.map(block=>({type:block.type,column:block.column??null,readingIndex:block.readingIndex,
  ...(typeof block.tableRow==='number'?{tableRow:block.tableRow,tableCol:block.tableCol}:{}),
  ...(block.translationMode?{mode:block.translationMode}:{}),text:block.sourceText.replace(/\s+/g,' ').slice(0,40)}));
 // Only presentation-equivalent script glyphs differ from the reviewed
 // baseline. Addresses, reading order, translation policy and words stay exact.
 const canonical=(rows:any[])=>rows.map(row=>({...row,text:row.text.normalize('NFKC')}));
 assert.deepEqual(canonical(current),canonical(previous));
 assert.ok(blocks.some(block=>/[⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(block.sourceText)),'source literals keep superscripts; classification does not rewrite them');
});
