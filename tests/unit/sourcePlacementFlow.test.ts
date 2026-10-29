import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePlacementFlow } from '../../src/ui/layoutSafety';
import type { PixelBox } from '../../src/ui/translatedPageView';

const box = (left: number, top: number, width: number, height: number): PixelBox => ({ left, top, width, height });
const area = (a: PixelBox, b: PixelBox): number => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
 * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
const scaled = (b: PixelBox, scale: number): PixelBox => ({ left:b.left*scale, top:b.top*scale, width:b.width*scale, height:b.height*scale });

for (const scale of [.75, 1, 1.5]) {
 test(`a shared source line leaves exactly one safe continuation band at scale ${scale}`, () => {
  const region = scaled(box(60, 104, 140, 58), scale);
  const first = scaled(box(170, 104, 30, 10), scale);
  const continuation = scaled(box(60, 116, 140, 46), scale);
  const previousSource = scaled(box(60, 80, 140, 34), scale);
  const result = sourcePlacementFlow(region, [first, continuation], [previousSource], 10*scale, 4*scale);
  assert.deepEqual(result, [continuation], 'one surviving band is a placement constraint, not permission to reuse the source union box');
  assert.equal(result!.reduce((sum, band) => sum + area(band, previousSource), 0), 0);
  assert.equal(result![0]!.top, 116*scale);
 });
}

test('fully occupied space explicitly rejects placement rather than restoring its original rectangle', () => {
 const region = box(40, 60, 120, 40);
 assert.deepEqual(sourcePlacementFlow(region, [region], [{...region}], 10, 4), []);
});

test('a narrow leftover slit cannot authorize painting over the neighbouring source', () => {
 const region = box(40, 60, 120, 40);
 const obstacle = box(40, 60, 117, 40);
 assert.deepEqual(sourcePlacementFlow(region, [region], [obstacle], 10, 4), []);
});

test('an untouched rectangle does not unnecessarily constrain ordinary unequal-length source lines', () => {
 const region = box(40, 60, 120, 40);
 assert.equal(sourcePlacementFlow(region, [box(40, 60, 110, 10), box(40, 72, 75, 10)], [], 10, 4), undefined);
});

test('a source block in the next column does not force narrow flow or steal usable space', () => {
 const region = box(40, 60, 120, 40);
 assert.equal(sourcePlacementFlow(region, [region], [box(185, 60, 100, 40)], 10, 4), undefined);
});

test('an interior obstacle preserves all disjoint safe bands without overlap or ink intrusion', () => {
 const region = box(20, 30, 100, 80);
 const obstacle = box(50, 50, 30, 30);
 const result = sourcePlacementFlow(region, [region], [obstacle], 10, 4)!;
 assert.ok(result.length > 1);
 assert.equal(result.reduce((sum, band) => sum + band.width*band.height, 0), 7100);
 for (let i=0; i<result.length; i++) {
  assert.equal(area(result[i]!, obstacle), 0);
  for (let j=i+1; j<result.length; j++) assert.equal(area(result[i]!, result[j]!), 0);
 }
});
