import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextInkGuard, horizontalInkOverflow, insetSideInk, mayOverhangSide, paintedSideOverhang, SIDE_OVERSAMPLE, rasterClipBounds, rasterOverflowAllPhases, INK_BLEED_DEVICE_PX, RASTER_TIE_DEVICE_PX } from '../../src/ui/textInkBounds';

// Zotero 10.0.9, Gecko 140, macOS, DPR 2, measured 2026-11-15 on Bongartz 2015
// (random audit, pages 6 and 8) with scripts/zotero/ink-clip-check.js.

test('measured, not enabled: a superscript 0.03 device px inside a row boundary bleeds into the row above', () => {
 // Table cell: clip 859.4833..876.7833, glyph ⁸ range 855.8667..879.3667,
 // canvas font box 18+6, ink ascent 13.4851, descent -6.1325.
 const clipTop = 859.4833374023438, rect = { top: 855.86669921875 - clipTop, bottom: 855.86669921875 + 23.5 - clipTop };
 const clip = { top: 0, bottom: 17.300003051757812 };
 const metrics = { fontBoundingBoxAscent: 18, fontBoundingBoxDescent: 6, actualBoundingBoxAscent: 13.485066731770834, actualBoundingBoxDescent: -6.132533772786459 };
 const axis = { origin: clipTop, sign: 1 as const, ratio: 2 };
 // The outline model alone accepted it; the device lost one pixel at two phases.
 assert.deepEqual(rasterOverflowAllPhases(rect, metrics, clip, axis), { top: 0, bottom: 0 });
 const bled = rasterOverflowAllPhases(rect, metrics, clip, axis, INK_BLEED_DEVICE_PX)!;
 assert.equal(bled.top, 0.5); assert.equal(bled.bottom, 0);
 assert.ok(INK_BLEED_DEVICE_PX > 0.03, 'the measured case sat 0.03 device px inside the boundary');
});

test('measured, not enabled: near a rounding tie both device rows are kept', () => {
 // One-line title (Bae 2010 p22): the clip bottom lay 0.04 device px from a
 // half pixel at one phase and the whole bottom row was lost there.
 const axis = { origin: 0, sign: 1 as const, ratio: 2 };
 assert.deepEqual(rasterClipBounds({ top: 0, bottom: 12.23 }, axis), { top: 0, bottom: 12 });
 assert.deepEqual(rasterClipBounds({ top: 0, bottom: 12.23 }, axis, RASTER_TIE_DEVICE_PX), { top: 0, bottom: 12 });
 assert.deepEqual(rasterClipBounds({ top: 0, bottom: 12.26 }, axis), { top: 0, bottom: 12.5 });
 assert.deepEqual(rasterClipBounds({ top: 0, bottom: 12.26 }, axis, RASTER_TIE_DEVICE_PX), { top: 0, bottom: 12 });
 assert.deepEqual(rasterClipBounds({ top: 0.24, bottom: 12 }, axis, RASTER_TIE_DEVICE_PX), { top: 0.5, bottom: 12 });
});

test('side overflow is measured against the device-snapped clip', () => {
 // "j" at 19.23px starts a line at the clip's left edge; one device column of
 // its hook is painted left of the origin.
 assert.deepEqual(horizontalInkOverflow(1555 - 0.5, 1560.13, 1555, 2074.2, 2), { left: 0.5, right: 0 });
 assert.deepEqual(horizontalInkOverflow(1555.4, 1560.13, 1555, 2074.2, 2), { left: 0, right: 0 });
 // Less than a quarter of a device pixel outside stays invisible.
 assert.deepEqual(horizontalInkOverflow(1555 - 0.1, 1560.13, 1555, 2074.2, 2), { left: 0, right: 0 });
 // A third of a device pixel is what the Firefox gate saw lost.
 assert.ok(horizontalInkOverflow(1555 - 0.17, 1560.13, 1555, 2074.2, 2).left > 0);
 const over = horizontalInkOverflow(2070, 2074.2 + 0.5, 1555, 2074.2, 2);
 assert.equal(over.left, 0); assert.ok(Math.abs(over.right - 0.7) < 1e-6);
});

test('only glyphs that can leave their advance box are rasterised', () => {
 for (const g of ['j', 'f', 'A', '1', '(', '‡', 'é', 'β']) assert.equal(mayOverhangSide(g), true, g);
 for (const g of ['结', '对', '。', '（', '，', 'あ', '한', '：']) assert.equal(mayOverhangSide(g), false, g);
});

test('painted overhang counts whole device columns outside the advance box', () => {
 // 8 columns, origin at 3, advance ends at 6; ink in columns 2..6.
 const alpha = new Uint8Array(8 * 2); for (const x of [2, 3, 4, 5, 6]) alpha[8 + x] = 200;
 assert.deepEqual(paintedSideOverhang(alpha, 8, 2, 3, 6), { left: 1, right: 1 });
 alpha[8 + 1] = 100; // below half coverage: outside the outline
 assert.deepEqual(paintedSideOverhang(alpha, 8, 2, 3, 6), { left: 1, right: 1 });
 assert.deepEqual(paintedSideOverhang(new Uint8Array(16), 8, 2, 3, 6), { left: -Infinity, right: -Infinity });
 // Ink that starts inside the advance box reports a negative side.
 const inside = new Uint8Array(8 * 2); for (const x of [4, 5]) inside[x] = 200;
 assert.deepEqual(paintedSideOverhang(inside, 8, 2, 3, 7), { left: -1, right: -1 });
});

// A canvas double that paints `columns` device columns of ink left of the origin
// (the guard draws the glyph SIDE_OVERSAMPLE times larger).
function fixture(glyphLeft: number, columns: number, glyph = 'j') {
 const text = { textContent: glyph, parentElement: {} };
 const style: Record<string, string> = { paddingLeft: '', paddingRight: '', boxSizing: '' };
 const inset = (): number => parseFloat(style.paddingLeft || '0');
 const canvas = { font: '', textBaseline: '', fillStyle: '', width: 0, height: 0,
  measureText: () => ({ fontBoundingBoxAscent: 21, fontBoundingBoxDescent: 7, actualBoundingBoxAscent: 13.7, actualBoundingBoxDescent: 3.8, width: 5 }),
  setTransform: () => {}, fillText: () => {},
  getImageData: (_x: number, _y: number, w: number, h: number) => {
   const data = new Uint8ClampedArray(w * h * 4), pad = Math.ceil(19.23 * 2 * SIDE_OVERSAMPLE);
   for (let x = pad - columns * SIDE_OVERSAMPLE; x < pad + 8; x++) data[(w * 5 + x) * 4 + 3] = 255;
   return { data };
  } };
 const element = Object.assign(canvas, { getContext: () => canvas });
 const doc = { createElementNS: () => element,
  createTreeWalker: () => { let done = false; return { nextNode: () => { if (done) return null; done = true; return text; } }; },
  createRange: () => ({ setStart: () => {}, setEnd: () => {}, getClientRects: () => {
   const left = glyphLeft + inset(); return [{ top: 1346.1, bottom: 1373.6, left, right: left + 5, width: 5 }]; } }),
  defaultView: { devicePixelRatio: 2, getComputedStyle: () => ({ fontStyle: 'normal', fontWeight: '400', fontSize: '19.23px', fontFamily: 'PingFang SC' }) }
 } as unknown as Document;
 const node = { style, getBoundingClientRect: () => ({ top: 1291.6, bottom: 1395.43, left: 1555, right: 2074.2 }) } as unknown as HTMLElement;
 return { guard: createTextInkGuard(doc), node, style };
}

test('a line-start glyph painted over the left edge fails the guard and reports the side', () => {
 const { guard, node } = fixture(1555, 1);
 assert.equal(guard(node), false);
 const failure = guard.failure(node)!;
 assert.equal(failure.leftOverflow, 0.5); assert.equal(failure.rightOverflow, 0);
 assert.equal(failure.topOverflow, 0); assert.equal(failure.bottomOverflow, 0);
 assert.equal(failure.side!.glyph, 'j');
});

test('the same glyph away from the edge, one without overhang, and a CJK glyph pass', () => {
 const inside = fixture(1657.7, 1); assert.equal(inside.guard(inside.node), true);
 const flush = fixture(1555, 0); assert.equal(flush.guard(flush.node), true);
 const cjk = fixture(1555, 1, '结'); assert.equal(cjk.guard(cjk.node), true);
});

test('a side inset cures the overhang inside the same box and rolls back when the text no longer fits', () => {
 const ok = fixture(1555, 1);
 assert.equal(ok.guard(ok.node), false);
 assert.equal(insetSideInk(ok.node, ok.guard, 4.8, () => true), true);
 assert.equal(ok.style.paddingLeft, '0.52px'); assert.equal(ok.style.boxSizing, 'border-box');
 const tight = fixture(1555, 1);
 assert.equal(tight.guard(tight.node), false);
 assert.equal(insetSideInk(tight.node, tight.guard, 4.8, () => false), false);
 assert.equal(tight.style.paddingLeft, ''); assert.equal(tight.style.boxSizing, '');
 const large = fixture(1555, 12);
 assert.equal(large.guard(large.node), false);
 assert.equal(insetSideInk(large.node, large.guard, 4.8, () => true), false);
});

test('ink flush with a fractional box edge is cut when the clip snaps inward', () => {
 // Firefox gate, fixture page 22: reference entries in a box whose left edge
 // is fractional lost a faint column although no glyph hangs over.
 assert.ok(horizontalInkOverflow(1555.3, 1560, 1555.3, 2074.2, 2).left > 0, 'clip rounds up 0.4 device px past the ink');
 assert.deepEqual(horizontalInkOverflow(1555.4, 1560, 1555.4, 2074.2, 2), { left: 0, right: 0 });
 assert.deepEqual(horizontalInkOverflow(1555.2, 1560, 1555.2, 2074.2, 2), { left: 0, right: 0 });
 // Ink that starts half a device pixel inside is out of the clip's reach.
 assert.deepEqual(horizontalInkOverflow(1555.3 + 0.25, 1560, 1555.3, 2074.2, 2), { left: 0, right: 0 });
});
