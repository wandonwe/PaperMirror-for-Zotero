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
