import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {coalesceRegions} from '../../src/reader/regionCoalescer';
function letters(text:string):string {
 return Array.from(text.normalize('NFKC').toLowerCase()).filter(c=>/[\p{L}\p{N}]/u.test(c)).sort().join('');
}
for(const page of [4,5]) test(`McCollough page ${page}: real exported statistics remain prose without losing content`,()=>{
 const dump=JSON.parse(readFileSync(`tests/fixtures/regression/mccollough2023-p${page}.json`,'utf8'));
 const source=buildBlocksFromSpans(dump.items,{pageIndex:page-1,pageHeight:dump.pageHeight,pageWidth:dump.pageWidth,includeReferences:true}).blocks;
 const structured=structureTableCells(orderBlocksForReading(source),page-1,10,[],undefined,true,dump.pageHeight);
 const blocks=orderBlocksForReading([...coalesceRegions(structured.filter(b=>b.translationMode===undefined),[]),...structured.filter(b=>b.translationMode!==undefined)]);
 assert.equal(letters(blocks.map(b=>b.sourceText).join('')),letters(source.map(b=>b.sourceText).join('')));
 assert.ok(blocks.some(b=>b.tableRow!==undefined),'real table survives');
 if(page===4) {
  const prose=blocks.find(b=>b.sourceText.includes('Bland'))!;
  assert.ok(prose);assert.equal(prose.tableRow,undefined);assert.notEqual(prose.translationMode,'preserve');
  const age=blocks.find(b=>b.sourceText==='Age (y)')!;
  assert.equal(age.tableGeometry,'inferred');assert.equal(age.tableRectPdf,undefined);
  assert.ok(age.tableContentRectPdf && age.tableContentRectPdf[2]-age.tableContentRectPdf[0]>age.boundingBox!.width);
 } else {
  assert.ok(!blocks.some(b=>b.translationMode==='preserve' && /\b(mean|median|range)\b/i.test(b.sourceText)));
 }
});
