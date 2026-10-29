import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildBlocksFromSpans, removeDecorativeTextRules, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {finalizePageRegions} from '../../src/reader/pageRegions';
import {coalesceRegions} from '../../src/reader/regionCoalescer';
import {buildBlocks} from '../../src/reader/blockBuilder';
import type {PdfChar, SourceBlock} from '../../src/types/models';

const span = (text:string, x:number, top:number, width:number, size=9):SpanItem =>
 ({text,rect:[x,top-size,x+width,top],fontSize:size});

test('independent dotted text rules are excluded whether emitted as one run or many glyphs',()=>{
 const single=span('. '.repeat(80),35,710,505);
 const split=Array.from({length:40},(_,i)=>span('.',35+i*4,650,2));
 const body=span('Readable prose remains.',130,620,340);
 const items=[single,...split,body];
 assert.deepEqual(removeDecorativeTextRules(items),[body]);
 assert.equal(items.length,42,'extraction does not mutate original spans');
});

test('ordinary ellipses, decimal values, labelled leaders and missing-value table dashes remain text',()=>{
 const items=[span('An unfinished sentence ...',35,720,190),span('...',35,690,10),
  span('0.001',35,660,30),span('1.234',100,660,30),
  span('Section name',35,630,65),span('. '.repeat(35),105,630,270),span('12',380,630,15),
  span('— '.repeat(20),35,600,400),span('.'.repeat(20),35,570,12)];
 assert.deepEqual(removeDecorativeTextRules(items),items);
});

test('char extraction and JSON-restored blocks retain a hard dotted-rule boundary',()=>{
 const chars:PdfChar[]=[];
 for(const row of [span('The first independent section ends in a clause,',50,600,400),
  span('. '.repeat(80),50,588,500),
  span('the following section stays independent despite its lowercase start.',50,576,400)]) {
  [...row.text].forEach((c,i)=>chars.push({c,fontSize:9,fontName:'Body',
   rect:[row.rect[0]+i*(row.rect[2]-row.rect[0])/row.text.length,row.rect[1],row.rect[0]+(i+1)*(row.rect[2]-row.rect[0])/row.text.length,row.rect[3]],
   lineBreakAfter:i===row.text.length-1}));
 }
 const blocks=buildBlocks(chars,{pageIndex:29,pageWidth:600,pageHeight:800}).blocks;
 assert.equal(blocks.length,2);
 assert.ok(blocks.every(b=>b.layoutBarriersPdf?.length===1));
 const restored=JSON.parse(JSON.stringify(blocks)) as SourceBlock[];
 const coalesced=coalesceRegions(restored);
 assert.equal(coalesced.length,2,'archived geometry must still prevent a continuation merge');
 assert.ok(coalesced.every(b=>!b.sourceText.includes('. . .')));
});

for(const [factor,shift,pageIndex] of [[1,0,17],[1.35,27,38]] as const) {
 test(`dotted separators cannot weld structured labels into prose or join distinct sections (${factor}x)`,()=>{
  const make=(text:string,x:number,top:number,width:number,size=9):SpanItem=>
   span(text,x*factor+shift,top*factor,width*factor,size*factor);
  const items=[
   make('Purpose',40,703,42,9.5),
   make('First section describes a general research objective.',125,701,430),
   make('The second line continues within the value column.',125,689,430),
   make('Its final sentence closes the first section.',125,677,280),
   make('. '.repeat(140),40,669,515),
   make('Design and',40,660,48,9.5),make('outcomes',40,649.5,45,9.5),
   ...Array.from({length:8},(_,i)=>make(i===0?'Second section describes procedures and outcomes.':
    i===7?'The final method sentence ends here.':'Further methodological detail remains in this section.',125,658-i*12,i===7?302:430)),
   make('. '.repeat(140),40,565,515),
   make('Interpretation',40,556,60,9.5),
   make('Third section interprets the findings cautiously.',125,554,430),
   make('Future observations will test these conclusions.',125,542,390)
  ];
  const height=800*factor;
  const raw=buildBlocksFromSpans(items,{pageIndex,pageWidth:600*factor+shift,pageHeight:height}).blocks;
  const blocks=finalizePageRegions(structureTableCells(orderBlocksForReading(raw),pageIndex,9*factor),height);
  const method=blocks.find(b=>b.sourceText.startsWith('Second section'));
  const conclusion=blocks.find(b=>b.sourceText.startsWith('Third section'));
  assert.ok(method && conclusion,'method and interpretation remain independent replacement blocks');
  assert.notEqual(method.id,conclusion.id);
  assert.ok(!method.sourceText.includes('Third section'));
  for(const b of [method,conclusion]) {
   assert.ok(b.boundingBox!.x>=125*factor+shift-.1,'body cannot enter the label column');
   assert.ok(b.lineRectsPdf!.every(r=>r[0]>=125*factor+shift-.1));
  }
  for(const label of ['Purpose','Design and outcomes','Interpretation'])
   assert.ok(blocks.some(b=>b.sourceText===label),`label remains separate: ${label}`);
  assert.ok(blocks.every(b=>!b.sourceText.includes('. . .')),'decorative dots never enter translation text');
 });
}
