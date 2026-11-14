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


// 4.8: rows measured in Zotero 10.0.8 (Gecko 140, macOS, DPR 2) on canvas:
// [css font px, baseline phase in device px, ink ascent, ink descent (css px,
// max of 静停表), first inked device row, row after the last inked row].
const GECKO_RASTER = [[5.25, 0, 4.345, 0.5267, 41, 52], [5.25, 0.25, 4.345, 0.5267, 41, 52], [5.25, 0.5, 4.345, 0.5267, 42, 53], [5.25, 0.75, 4.345, 0.5267, 42, 53], [7, 0, 5.775, 0.7, 38, 52], [7, 0.25, 5.775, 0.7, 38, 52], [7, 0.5, 5.775, 0.7, 39, 53], [7, 0.75, 5.775, 0.7, 39, 53], [8, 0, 6.6, 0.8, 36, 52], [8, 0.25, 6.6, 0.8, 36, 52], [8, 0.5, 6.6, 0.8, 37, 53], [8, 0.75, 6.6, 0.8, 37, 53], [10.5, 0, 8.6625, 1.05, 32, 53], [10.5, 0.25, 8.6625, 1.05, 32, 53], [10.5, 0.5, 8.6625, 1.05, 33, 54], [10.5, 0.75, 8.6625, 1.05, 33, 54]] as const;

test('raster ink bounds reproduce every Gecko device row measured in Zotero', async () => {
 const { rasterInkBounds } = await import('../../src/ui/textInkBounds');
 for (const [px, phase, ascent, descent, firstRow, endRow] of GECKO_RASTER) {
  const ratio = 2, baseline = (50 + phase) / ratio, fontAscent = 1.2 * px, fontDescent = 0.3 * px;
  const rect = { top: baseline - fontAscent, bottom: baseline + fontDescent };
  const ink = rasterInkBounds(rect, { fontBoundingBoxAscent: fontAscent, fontBoundingBoxDescent: fontDescent,
   actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent }, { origin: 0, sign: 1, ratio })!;
  assert.deepEqual([ink.top * ratio, ink.bottom * ratio], [firstRow, endRow], `${px}px phase ${phase}`);
 }
});

test('exact outline touching the clip is rejected once its raster row crosses it', async () => {
 const { rasterInkBounds, rasterClipBounds, verticalInkFits } = await import('../../src/ui/textInkBounds');
 const axis = { origin: 100.1, sign: 1 as const, ratio: 2 };
 // The outline ends 0.1px inside the clip; the baseline rounds down onto the
 // next device row, the clip edge rounds up, and the last row is part-inked.
 const rect = { top: .2, bottom: 10.2 }, metrics = { fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2,
  actualBoundingBoxAscent: 6, actualBoundingBoxDescent: .7 };
 const outline = { top: 2.2, bottom: 8.9 }, clip = { top: 0, bottom: 9 };
 assert.equal(verticalInkFits(outline, clip), true, 'the 4.7 outline check accepted it');
 const ink = rasterInkBounds(rect, metrics, axis)!;
 assert.equal(verticalInkFits(ink, rasterClipBounds(clip, axis)), false);
 assert.equal(verticalInkFits(ink, rasterClipBounds({ top: 0, bottom: 10 }, axis)), true);
});

test('raster bounds follow quarter-turned pages and keep untrusted metrics conservative', async () => {
 const { rasterInkBounds, rasterClipBounds, deviceAxisFor } = await import('../../src/ui/textInkBounds');
 const metrics = { fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2, actualBoundingBoxAscent: 6.3, actualBoundingBoxDescent: 0.7 };
 const clientClip = { top: 10.3, bottom: 30.3, left: 5.1, right: 25.1 };
 for (const rotation of [0, 90, 180, 270]) {
  const axis = deviceAxisFor(clientClip, rotation, 2);
  const ink = rasterInkBounds({ top: 4, bottom: 14 }, metrics, axis)!;
  assert.ok(ink.top <= 12 - 6.3 + 1e-9 && ink.bottom >= 12 + 0.7 - 1e-9, 'never smaller than the outline at ' + rotation);
  assert.ok(ink.bottom - ink.top <= 7 + 1.5, 'at most one device pixel per side plus the baseline shift');
  const c = rasterClipBounds({ top: 0, bottom: 20 }, axis);
  assert.ok(Math.abs(c.top) <= .25 && Math.abs(c.bottom - 20) <= .25);
 }
 assert.equal(rasterInkBounds({ top: 0, bottom: 30 }, metrics, deviceAxisFor(clientClip, 0, 2)), undefined, 'inconsistent font box');
 assert.equal(rasterInkBounds({ top: 0, bottom: 10 }, undefined, deviceAxisFor(clientClip, 0, 2)), undefined);
});

test('half-pixel layout font boxes keep both baseline readings (Zotero heading)', async () => {
 const { rasterInkBounds } = await import('../../src/ui/textInkBounds');
 // 「响」 in a 15px bold heading, measured in Zotero: canvas font box 16+6,
 // layout range rect 21.5px. Its ink reached below the descent-anchored estimate.
 const rect = { top: 491.6166687011719, bottom: 513.1166687011719 };
 const metrics = { fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 6, actualBoundingBoxAscent: 12.465, actualBoundingBoxDescent: 1.47 };
 const ink = rasterInkBounds(rect, metrics, { origin: 0, sign: 1, ratio: 2 })!;
 assert.equal(ink.bottom, 509, 'ascent-anchored baseline 507.6167 → ink to device row 1018');
 assert.equal(ink.top, 494.5, 'descent-anchored baseline still bounds the top');
});

test('a placement must survive every sub-pixel scroll phase', async () => {
 const { rasterOverflowAllPhases } = await import('../../src/ui/textInkBounds');
 const metrics = { fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 6, actualBoundingBoxAscent: 12.465, actualBoundingBoxDescent: 1.47 };
 const axis = { origin: 490.81665, sign: 1 as const, ratio: 2 };
 // The Zotero heading: box 15px tall, layout rect relative to the clip top.
 const rect = { top: 491.6166687011719 - 493.81665, bottom: 513.1166687011719 - 493.81665 };
 const tight = rasterOverflowAllPhases(rect, metrics, { top: 0, bottom: 15 }, { ...axis, origin: 493.81665 })!;
 assert.ok(tight.bottom > 0, 'clipped at some scroll phase');
 assert.equal(tight.top, 0);
 const roomy = rasterOverflowAllPhases(rect, metrics, { top: 0, bottom: 16.5 }, { ...axis, origin: 493.81665 })!;
 assert.deepEqual(roomy, { top: 0, bottom: 0 }, 'one and a half extra pixels hold at every phase');
 assert.equal(rasterOverflowAllPhases(rect, undefined, { top: 0, bottom: 15 }, axis), undefined);
});

test('device font box reproduces every line box height measured in Zotero (4.9)', async () => {
 const { deviceFontBox } = await import('../../src/ui/textInkBounds');
 // PingFang SC at 256px on Gecko canvas: 272 ascent, 88 descent. Laid-out
 // heights were read from range rects in Zotero 10 at devicePixelRatio 2.
 const A = 272 / 256, D = 88 / 256;
 for (const [px, height] of [[5.25, 8], [7, 10], [9.6, 14], [10.5, 15.5], [12.2, 17.5], [15, 21.5]] as const) {
  const box = deviceFontBox(A * px, D * px, height, 2);
  assert.ok(box, `${px}px`);
  assert.ok(Math.abs(box!.ascent + box!.descent - height) < 1e-9);
  assert.equal(box!.ascent, Math.ceil(A * px * 2) / 2);
 }
 // 12.2px: canvas says 14+5=19, 1.5px above the 17.5px line box.
 assert.deepEqual(deviceFontBox(A * 12.2, D * 12.2, 17.5, 2), { ascent: 13, descent: 4.5 });
});

test('device font box is refused when layout is not on the device grid or does not match', async () => {
 const { deviceFontBox, inkVerticalBounds } = await import('../../src/ui/textInkBounds');
 assert.equal(deviceFontBox(6.1, 1.5, 7.602, 2), undefined, 'unrounded layout height');
 assert.equal(deviceFontBox(12.96, 4.19, 19, 2), undefined, 'different font box');
 assert.equal(deviceFontBox(NaN, 4, 17.5, 2), undefined);
 assert.equal(deviceFontBox(12.96, 4.19, 17.5, 0), undefined);
 // With the proven box the first line of a 12.2px paragraph is measured, not
 // replaced by its content box (top -1.07 would always "overflow").
 const rect = { top: -1.0667, bottom: 16.4333 };
 const canvas = { fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 5, actualBoundingBoxAscent: 9.8747, actualBoundingBoxDescent: 1.2267 };
 assert.equal(inkVerticalBounds(rect, canvas), rect, '4.8: inconsistent canvas box falls back');
 const ink = inkVerticalBounds(rect, { ...canvas, fontBoundingBoxAscent: 13, fontBoundingBoxDescent: 4.5 });
 assert.ok(ink.top > 2 && ink.top < 2.1 && ink.bottom > 13.1 && ink.bottom < 13.2);
});
