import {finalizePageRegions} from '../../src/reader/pageRegions';
import {structureTableCells} from '../../src/reader/tableStructure';
import test from 'node:test';
import assert from 'node:assert/strict';
import { separateDisplayFormulas } from '../../src/reader/displayFormula';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
const item=(text:string,x:number,y:number,w:number,fontSize=10):SpanItem=>({text,rect:[x,y,x+w,y+fontSize],fontSize});
const prose=[item('The estimated signal is subtracted from the measured data:',56,360,234),
 item('where Pri is the primary signal and Air is the reference air signal.',56,290,234)];
const math=[item('\u0012',90,334,10),item('\u0013',109,334,10),
 item('\u0001ln Pri ¼ \u0001ln T \u0001 CS ¼ \u0001ln T \u0001 ln 1 \u0001 CS',78,324,204,8),
 item('Air',99,314,11,7),item('Air',149,314,11,7)];
test('legacy display formula owns brackets and fraction denominators, never adjacent prose',()=>{
 const result=separateDisplayFormulas([...prose,...math],2,792);
 assert.equal(result.blocks.length,1);
 assert.deepEqual(result.rest,prose);
 assert.equal(result.blocks[0]!.preserveReason,'display-formula');
 assert.equal(result.blocks[0]!.lineRectsPdf!.length,math.length);
 assert.equal(result.rest.length+result.blocks[0]!.lineRectsPdf!.length,prose.length+math.length);
});
test('formula separation runs before paragraph grouping and survives region coalescing',()=>{
 const result=buildBlocksFromSpans([...prose,...math],{pageIndex:2,pageWidth:595,pageHeight:792});
 const blocks=finalizePageRegions(structureTableCells(result.blocks,2,10,[],null,false,792),792);
 const formula=blocks.find(b=>b.preserveReason==='display-formula')!;
 assert.ok(formula);
 const body=blocks.filter(b=>b.translationMode!=='preserve');
 assert.ok(body.some(b=>b.sourceText.includes('estimated signal')));
 assert.ok(body.some(b=>b.sourceText.startsWith('where Pri')));
 assert.ok(body.every(b=>!(b.sourceText.includes('estimated signal') && b.sourceText.includes('where Pri'))));
 assert.ok(body.every(b=>!/[\u0001\u0012\u0013]/.test(b.sourceText)));
});
test('ordinary formula explanations, labels and inline math remain translatable',()=>{
 const items=[item('The equation x = y + z describes the signal.',56,400,234),item('Air',56,360,20),item('\u0012',100,320,8),item('T = CS',56,200,80)];
 assert.deepEqual(separateDisplayFormulas(items,0,792).rest,items);
});
test('preserved paragraph cannot be absorbed into body by region coalescing',()=>{
 const blocks=prose.map((p,i)=>({id:String(i),pageIndex:0,order:i,type:'paragraph' as const,sourceText:p.text,lineRectsPdf:[p.rect],fontSize:10,...(i===1?{translationMode:'preserve' as const,preserveReason:'display-formula'}:{})}));
 assert.equal(coalesceRegions(blocks).length,2);
});
