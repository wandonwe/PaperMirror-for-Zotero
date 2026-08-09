import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPS, imageRectsFromOperatorList } from '../../src/reader/imageObstacles';

const OP = DEFAULT_OPS;

test('a painted image yields the transformed unit-square rectangle', () => {
	// transform: scale 200×150, translate to (60, 400); then paint.
	const fn = [OP.save, OP.transform, OP.paintImageXObject, OP.restore];
	const args = [null, [200, 0, 0, 150, 60, 400], ['img1'], null];
	const rects = imageRectsFromOperatorList(fn, args);
	assert.deepEqual(rects, [[60, 400, 260, 550]]);
});

test('save/restore isolates transforms; nested images use the composed matrix', () => {
	const fn = [
		OP.save,
		OP.transform,          // ×2 both axes
		OP.transform,          // then place a 100×50 image at (10, 20)
		OP.paintInlineImageXObject,
		OP.restore,
		OP.transform,          // after restore: identity again → 30×30 at (0,0)
		OP.paintImageXObject
	];
	const args = [
		null,
		[2, 0, 0, 2, 0, 0],
		[100, 0, 0, 50, 10, 20],
		['a'],
		null,
		[30, 0, 0, 30, 0, 0],
		['b']
	];
	const rects = imageRectsFromOperatorList(fn, args);
	// First: unit square → ×(100,50)+(10,20) → then ×2 → (20,40)-(220,140)
	assert.deepEqual(rects[0], [20, 40, 220, 140]);
	assert.deepEqual(rects[1], [0, 0, 30, 30]);
});

test('tiny images (inline bullets) are dropped; empty input is safe', () => {
	const fn = [OP.transform, OP.paintImageXObject];
	const args = [[6, 0, 0, 6, 100, 100], ['dot']];
	assert.deepEqual(imageRectsFromOperatorList(fn, args), []);
	assert.deepEqual(imageRectsFromOperatorList([], []), []);
});
