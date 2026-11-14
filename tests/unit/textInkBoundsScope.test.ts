import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextInkGuard } from '../../src/ui/textInkBounds';

// Zotero 10.0.9, Gecko 140, macOS, DPR 2, measured 2026-11-15.
// The all-size candidate reduced the two baseline estimates to one and
// allowed both headings at 12.67px; four-phase raster checks repeatedly lost
// one top-edge pixel. Keep 4.9's scope until that baseline ambiguity is solved.
const HEADINGS = [
 { glyph: '响', clipTop: 737.7000122070312, clipBottom: 750.3666839599609,
   rangeTop: 735.0333251953125, rangeBottom: 753.0333251953125,
   ascent: 10.498300170898437, descent: 1.238066609700521 },
 { glyph: '访', clipTop: 737.5333251953125, clipBottom: 750.1999816894531,
   rangeTop: 734.86669921875, rangeBottom: 752.86669921875,
   ascent: 10.498300170898437, descent: 1.3896657307942704 }
];

test('real Zotero tight headings retain the two-baseline guard when canvas and layout differ by only 1px', () => {
 for (const h of HEADINGS) {
  const text = { textContent: h.glyph, parentElement: {} };
  let consumed = false;
  const canvas = { font: '', textBaseline: '', measureText: () => ({
   fontBoundingBoxAscent: canvas.font.includes('256px') ? 272 : 14,
   fontBoundingBoxDescent: canvas.font.includes('256px') ? 88 : 5,
   actualBoundingBoxAscent: h.ascent, actualBoundingBoxDescent: h.descent
  }) };
  const doc = { createElementNS: () => ({ getContext: () => canvas }),
   createTreeWalker: () => ({ nextNode: () => { if (consumed) return null; consumed = true; return text; } }),
   createRange: () => ({ setStart: () => {}, setEnd: () => {}, getClientRects: () => [{ top: h.rangeTop, bottom: h.rangeBottom, left: 100, right: 112.41667, width: 12.41667 }] }),
   defaultView: { devicePixelRatio: 2, getComputedStyle: () => ({ fontStyle: 'normal', fontWeight: '600', fontSize: '12.67px', fontFamily: 'PingFang SC' }) }
  } as unknown as Document;
  const node = { getBoundingClientRect: () => ({ top: h.clipTop, bottom: h.clipBottom, left: 100, right: 300 }) } as unknown as HTMLElement;
  const guard = createTextInkGuard(doc);
  assert.equal(guard(node), false, h.glyph + ': all-size substitution would incorrectly accept the measured tight heading');
  assert.equal(guard.failure(node)!.topOverflow, .5);
  assert.equal(guard.failure(node)!.bottomOverflow, .5);
 }
});
