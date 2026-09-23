import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inkVerticalBounds, verticalInkFits } from '../../src/ui/textInkBounds';

const metrics = { fontBoundingBoxAscent: 18, fontBoundingBoxDescent: 6,
 actualBoundingBoxAscent: 15, actualBoundingBoxDescent: 4 };

test('font whitespace may overflow but actual glyph descenders must fit', () => {
 const ink = inkVerticalBounds({ top: -3, bottom: 21 }, metrics);
 assert.deepEqual(ink, { top: 0, bottom: 19 });
 assert.equal(verticalInkFits(ink, { top: 0, bottom: 18 }), false);
 assert.equal(verticalInkFits(ink, { top: 0, bottom: 19 }), true);
});

test('blank font descent alone does not reject a short CJK heading', () => {
 const ink = inkVerticalBounds({ top: -3, bottom: 21 }, { ...metrics, actualBoundingBoxDescent: 1 });
 assert.equal(verticalInkFits(ink, { top: 0, bottom: 18 }), true);
});

test('top accents and bottom strokes are both protected', () => {
 assert.equal(verticalInkFits({ top: -0.5, bottom: 10 }, { top: 0, bottom: 20 }), false);
 assert.equal(verticalInkFits({ top: 1, bottom: 20.5 }, { top: 0, bottom: 20 }), false);
});

test('missing or inconsistent font metrics use conservative DOM bounds', () => {
 const rect = { top: -2, bottom: 23 };
 assert.deepEqual(inkVerticalBounds(rect, undefined), rect);
 assert.deepEqual(inkVerticalBounds(rect, { ...metrics, fontBoundingBoxAscent: NaN }), rect);
 assert.deepEqual(inkVerticalBounds(rect, { ...metrics, fontBoundingBoxDescent: 40 }), rect);
});

test('boundary inspection uses each glyph metrics instead of the whole wrapped paragraph', async()=>{
 const {createTextInkGuard}=await import('../../src/ui/textInkBounds');
 const makeDoc=(clipBottom:number, firstAscent=15)=>{
  const text={textContent:'Aé',parentElement:{}};let consumed=false,start=0,end=2;
  const rects=[{top:-3,bottom:21,width:8},{top:9,bottom:33,width:8}];
  const ctx={font:'',textBaseline:'',measureText:(value:string)=>({fontBoundingBoxAscent:18,fontBoundingBoxDescent:6,
   actualBoundingBoxAscent:value==='A'?firstAscent:20,actualBoundingBoxDescent:value==='A'?0:4})};
  const doc={createElementNS:()=>({getContext:()=>ctx}),createTreeWalker:()=>({nextNode:()=>{if(consumed)return null;consumed=true;return text;}}),
   createRange:()=>({setStart:(_n:unknown,x:number)=>{start=x;},setEnd:(_n:unknown,x:number)=>{end=x;},selectNodeContents:()=>{start=0;end=2;},getClientRects:()=>rects.slice(start,end)}),
   defaultView:{getComputedStyle:()=>({fontStyle:'normal',fontWeight:'400',fontSize:'20px',fontFamily:'test'})}};
  return {doc:doc as unknown as Document,node:{getBoundingClientRect:()=>({top:0,bottom:clipBottom})} as unknown as HTMLElement};
 };
 const valid=makeDoc(31);assert.equal(createTextInkGuard(valid.doc)(valid.node),true,'later accent must not inflate first line ink');
 const bottomClipped=makeDoc(30);assert.equal(createTextInkGuard(bottomClipped.doc)(bottomClipped.node),false);
 const topClipped=makeDoc(31,19);assert.equal(createTextInkGuard(topClipped.doc)(topClipped.node),false);
});


test('top inset stays inside the clip and rolls back when text no longer fits', async () => {
 const {insetTextInk}=await import('../../src/ui/textInkBounds');
 const node={style:{paddingTop:'',boxSizing:''}} as unknown as HTMLElement;
 let overflow=0.4;
 const guard=Object.assign(()=>true,{failure:()=>({offset:0,topOverflow:overflow,bottomOverflow:0,rectTop:-overflow,rectBottom:8,clipHeight:10,font:'8px test',metricsAvailable:true})});
 assert.equal(insetTextInk(node,guard,4,()=>true),true);
 assert.equal(node.style.paddingTop,'0.43px');
 node.style.paddingTop='';node.style.boxSizing='';
 assert.equal(insetTextInk(node,guard,4,()=>false),false);
 assert.equal(node.style.paddingTop,'');assert.equal(node.style.boxSizing,'');
 overflow=5;assert.equal(insetTextInk(node,guard,4,()=>true),false);
 overflow=0;assert.equal(insetTextInk(node,guard,4,()=>true),false);
 overflow=0.4;
 const clipped=Object.assign(()=>false,{failure:guard.failure});
 assert.equal(insetTextInk(node,clipped,4,()=>true),false);
 assert.equal(node.style.paddingTop,'');
});
