import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/bell2026-extraction.json';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {isFooterDate} from '../../src/reader/metaFilter';
test('Bell page 3 continuation remains translatable without footer date',()=>{
 const blocks=finalizePageRegions(buildBlocksFromSpans(fixture.pages[2]!.items as any,{pageIndex:2,pageWidth:585,pageHeight:783,imageRectsPdf:[],includeReferences:true}).blocks,783);
 const b=blocks.find(b=>b.sourceText.startsWith('Event rates were higher'))!;
 assert.ok(b);assert.notEqual(b.translationMode,'preserve');
 assert.ok(!b.sourceText.includes('2026'));assert.equal(b.lineRectsPdf?.length,2);
 const foot=blocks.find(b=>b.sourceText==='xxx xxx, 2026')!;
 assert.equal(foot?.translationMode,'preserve');assert.equal(foot.sourceRegion?.kind,'page-furniture');
});
test('footer date recognition requires date-only wording and bottom margin',()=>{
 for(const text of ['xxx xxx, 2026','September 29, 2026','29 September 2026','Jan. 1, 2025'])assert.ok(isFooterDate(text,[300,22,400,30],783),text);
 for(const text of ['Event rates were higher in 2026','xxx xxx, 2026 results','In September 2026'])assert.ok(!isFooterDate(text,[300,22,400,30],783));
 assert.ok(!isFooterDate('September 29, 2026',[300,300,400,310],783));
});
