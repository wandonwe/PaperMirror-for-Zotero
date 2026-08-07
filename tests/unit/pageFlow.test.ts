import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	assignColumns,
	clearObstacles,
	inkToObstacles,
	planFlow,
	type FlowItem,
	type FlowObstacle
} from '../../src/ui/pageFlow';

const OPTIONS = { pageHeight: 1000, gap: 8, bottomMargin: 20 };

function item(id: string, sourceTop: number, naturalHeight: number, column = 0): FlowItem {
	return { id, column, left: 40, width: 250, sourceTop, naturalHeight };
}

test('shorter translations leave the page shape alone', () => {
	// Chinese is usually shorter: each block fits in less than its source space,
	// so nothing should move at all.
	const items = [item('a', 100, 60), item('b', 200, 50), item('c', 300, 40)];
	const placed = planFlow(items, [], OPTIONS);
	assert.deepEqual(placed.map(p => p.top), [100, 200, 300]);
	assert.ok(placed.every(p => !p.displaced));
});

test('a longer block pushes the ones below it down, never up', () => {
	const items = [item('a', 100, 160), item('b', 200, 50)];
	const placed = planFlow(items, [], OPTIONS);
	assert.equal(placed[0]!.top, 100);
	// a ends at 260, +8 gap → b starts at 268, not its source 200.
	assert.equal(placed[1]!.top, 268);
	assert.equal(placed[1]!.displaced, true);
});

test('a block never floats above its source position', () => {
	// Even with acres of space above it, 'b' stays where the paper put it.
	const items = [item('a', 100, 10), item('b', 500, 30)];
	const placed = planFlow(items, [], OPTIONS);
	assert.equal(placed[1]!.top, 500);
});

test('columns flow independently', () => {
	const items = [
		item('l1', 100, 300, 0),
		item('l2', 200, 40, 0),
		item('r1', 100, 40, 1),
		item('r2', 200, 40, 1)
	];
	const placed = planFlow(items, [], OPTIONS);
	const byId = new Map(placed.map(p => [p.id, p]));
	// The left column's overflow must not disturb the right column.
	assert.equal(byId.get('l2')!.top, 408);
	assert.equal(byId.get('r1')!.top, 100);
	assert.equal(byId.get('r2')!.top, 200);
});

test('the flow hops over a figure instead of printing on it', () => {
	const obstacles: FlowObstacle[] = [{ column: 0, top: 220, bottom: 480 }];
	const items = [item('a', 100, 90), item('b', 200, 60)];
	const placed = planFlow(items, obstacles, OPTIONS);
	assert.equal(placed[0]!.top, 100); // ends at 190, clear of the figure
	// b would start at 200 and run into the figure → pushed below it.
	assert.equal(placed[1]!.top, 480);
	assert.equal(placed[1]!.displaced, true);
});

test('running past the page bottom is reported, not silently clipped', () => {
	const items = [item('a', 900, 200)];
	const placed = planFlow(items, [], OPTIONS);
	assert.equal(placed[0]!.overflow, true);
});

test('clearObstacles settles below every overlapping span', () => {
	const obstacles: FlowObstacle[] = [
		{ column: 0, top: 100, bottom: 200 },
		{ column: 0, top: 210, bottom: 300 }
	];
	// Starting at 150 the box hits both spans in turn.
	assert.equal(clearObstacles(150, 40, obstacles), 300);
	// Starting below both, nothing moves.
	assert.equal(clearObstacles(400, 40, obstacles), 400);
	// A box that ends before the first span is untouched.
	assert.equal(clearObstacles(20, 40, obstacles), 20);
});

// ---- column assignment ------------------------------------------------------

test('a two-column page yields exactly two columns', () => {
	const rects = [
		{ left: 40, width: 250 },
		{ left: 42, width: 248 },
		{ left: 320, width: 250 },
		{ left: 322, width: 246 }
	];
	assert.deepEqual(assignColumns(rects), [0, 0, 1, 1]);
});

test('a full-width block does not merge the two columns', () => {
	const rects = [
		{ left: 40, width: 250 },
		{ left: 320, width: 250 },
		{ left: 40, width: 530 } // spans both — its own band
	];
	const columns = assignColumns(rects);
	assert.equal(columns[0], 0);
	assert.equal(columns[1], 1);
	assert.equal(columns[2], 2, 'a full-width banner is its own column, not column 0');
});

// ---- ink → obstacles --------------------------------------------------------

function grid(rows: number, cols: number, fill: (r: number, c: number) => boolean): boolean[][] {
	return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => fill(r, c)));
}

test('a block of ink becomes one obstacle span', () => {
	// Rows 4..7 inked in the left half.
	const ink = grid(12, 8, (r, c) => r >= 4 && r <= 7 && c < 4);
	const obstacles = inkToObstacles(ink, 10, [{ column: 0, fromCol: 0, toCol: 3 }]);
	assert.equal(obstacles.length, 1);
	assert.deepEqual(obstacles[0], { column: 0, top: 40, bottom: 80 });
});

test('ink outside the column range is ignored', () => {
	const ink = grid(12, 8, (r, c) => r >= 4 && r <= 7 && c >= 4);
	const obstacles = inkToObstacles(ink, 10, [{ column: 0, fromCol: 0, toCol: 3 }]);
	assert.equal(obstacles.length, 0);
});

test('a single inked row is a rule, not a figure', () => {
	const ink = grid(12, 8, (r, c) => r === 5 && c < 4);
	assert.equal(inkToObstacles(ink, 10, [{ column: 0, fromCol: 0, toCol: 3 }]).length, 0);
});

test('an obstacle running to the last row is still closed', () => {
	const ink = grid(6, 4, r => r >= 3);
	const obstacles = inkToObstacles(ink, 10, [{ column: 0, fromCol: 0, toCol: 3 }]);
	assert.equal(obstacles.length, 1);
	assert.equal(obstacles[0]!.bottom, 60);
});

// ---- global overlap resolution ---------------------------------------------

import { resolveOverlaps } from '../../src/ui/pageFlow';

test('blocks in different columns that share x are separated', () => {
	// The abbreviation-list case: a heading and a definition entry that the
	// column analysis put in different columns but which overlap on screen.
	const movable = [
		{ id: 'heading', left: 100, top: 200, width: 120, height: 30 },
		{ id: 'entry', left: 110, top: 210, width: 200, height: 40 }
	];
	const tops = resolveOverlaps(movable, [], 6, 1000);
	assert.equal(tops.get('heading'), 200);
	assert.equal(tops.get('entry'), 236, 'pushed below the heading it collided with');
});

test('a fixed block of untranslated original is never printed over', () => {
	// An affiliation list we deliberately left in English.
	const fixed = [{ left: 100, top: 300, width: 250, height: 120 }];
	const movable = [{ id: 'a', left: 100, top: 280, width: 250, height: 90 }];
	const tops = resolveOverlaps(movable, fixed, 6, 1000);
	assert.equal(tops.get('a'), 426, 'moved below the fixed original block');
});

test('columns that merely abut are left alone', () => {
	const movable = [
		{ id: 'l', left: 40, top: 200, width: 250, height: 100 },
		{ id: 'r', left: 300, top: 200, width: 250, height: 100 }
	];
	const tops = resolveOverlaps(movable, [], 6, 1000);
	assert.equal(tops.get('l'), 200);
	assert.equal(tops.get('r'), 200, 'a side-by-side column is not a collision');
});

test('a chain of collisions settles in order', () => {
	const movable = [
		{ id: 'a', left: 40, top: 100, width: 200, height: 100 },
		{ id: 'b', left: 45, top: 110, width: 200, height: 50 },
		{ id: 'c', left: 50, top: 120, width: 200, height: 50 }
	];
	const tops = resolveOverlaps(movable, [], 5, 1000);
	assert.equal(tops.get('a'), 100);
	assert.equal(tops.get('b'), 205);
	assert.equal(tops.get('c'), 260);
});

test('a block is never pushed off the bottom of the page', () => {
	const fixed = [{ left: 40, top: 100, width: 200, height: 800 }];
	const movable = [{ id: 'a', left: 40, top: 120, width: 200, height: 100 }];
	const tops = resolveOverlaps(movable, fixed, 6, 1000);
	assert.equal(tops.get('a'), 900, 'clamped to the last position that still shows it');
});
