import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/regression/bell2026-extraction.json';
import {extractAbbreviationTables} from '../../src/reader/abbreviationTable';
import {buildBlocksFromSpans} from '../../src/reader/spanBlockBuilder';
const page=fixture.pages[1]!;
const items=page.items as any;
test('titled paired glossary keeps nine acronym definitions separate through paragraph merging',()=>{
 const {cells,rest}=extractAbbreviationTables(items,1,585,783);
 const keys=cells.filter(c=>c.tableCol===0),values=cells.filter(c=>c.tableCol===1);
 assert.deepEqual(keys.map(c=>c.sourceText),['aHR','CAD','CAD-RADS','CCTA','FFR','FFR-CT','FISH&CHIPS','HR','MI']);
 assert.equal(values.length,9);
 assert.equal(values[0]!.sourceText,'adjusted hazard ratio');
 assert.equal(values[1]!.sourceText,'coronary artery disease');
 assert.equal(values[6]!.sourceText,'FFR-CT in Stable Heart Disease and Coronary Computed Tomography Angiography Helps/ Hinders Improved Patient Care and Societal Costs');
 assert.ok(keys.every(k=>k.translationMode==='preserve'));
 assert.ok(rest.some(i=>i.text.includes('To address these uncertainties')));
 const built=buildBlocksFromSpans(items,{pageIndex:1,pageWidth:585,pageHeight:783,imageRectsPdf:[],includeReferences:true}).blocks;
 assert.equal(built.filter(b=>b.tableCol===1&&b.tableSource==='abbreviation').length,9);
});
test('paired glossary requires a title, enough aligned keys, and every definition baseline',()=>{
 assert.equal(extractAbbreviationTables(items.filter((i:any)=>!i.text.includes('Nonstandard Abbreviations')),1,585,783).cells.length,0);
 assert.equal(extractAbbreviationTables(items.filter((i:any)=>i.text!=='adjusted hazard ratio'),1,585,783).cells.length,0);
});
test('paired glossary geometry works in another column and preserves neighbouring prose',()=>{
 const panel=items.filter((i:any)=>i.rect[0]>=59&&i.rect[2]<=274&&i.rect[1]>=60&&i.rect[3]<=287).map((i:any)=>({...i,rect:i.rect.map((v:number,n:number)=>v+(n%2===0?290:150))}));
 const found=extractAbbreviationTables(panel,4,900,1000);
 assert.equal(found.cells.filter(c=>c.tableCol===1).length,9);
});
