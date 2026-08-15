import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPlacedBoxes, type AuditBox } from '../../src/ui/layoutSafety';
import type { PixelBox } from '../../src/ui/translatedPageView';

const box = (left: number, top: number, width: number, height: number): PixelBox => ({ left, top, width, height });
const placed = (id: string, original: PixelBox, current?: PixelBox): AuditBox =>
	({ id, box: current ?? { ...original }, originalBox: original });
const none = { images: [], preserved: [] };

test('clean page: unexpanded boxes report nothing', () => {
	const out = auditPlacedBoxes([
		placed('a', box(10, 10, 200, 50)),
		placed('b', box(10, 70, 200, 50))
	], none, 600, 800);
	assert.deepEqual(out, []);
});

test('two blocks expanding into the same whitespace → overlap blamed on the bigger expander', () => {
	// a expanded down 40px into the gap; b expanded up… b cannot expand up, so
	// model the real case: a expands down INTO b's expanded-down box region.
	const a = placed('a', box(10, 10, 200, 50), box(10, 10, 200, 100)); // +50 down
	const b = placed('b', box(10, 105, 200, 50), box(10, 105, 200, 60)); // +10 down
	const out = auditPlacedBoxes([a, b], none, 600, 800);
	assert.equal(out.length, 1);
	assert.equal(out[0]!.kind, 'overlap');
	assert.equal(out[0]!.id, 'a', 'blamed on the box that grew more');
	assert.equal(out[0]!.otherId, 'b');
});

test('pre-existing source overlap is NOT a violation (new-intrusion-only rule)', () => {
	// Original geometry already overlaps by 10px of height — common in real
	// line rects. Boxes unchanged → no violation despite the absolute overlap.
	const out = auditPlacedBoxes([
		placed('a', box(10, 10, 200, 60)),
		placed('b', box(10, 60, 200, 50))
	], none, 600, 800);
	assert.deepEqual(out, []);
});

test('expansion covering an image or a preserved cell is flagged', () => {
	const img = box(220, 10, 100, 100);
	const overImage = auditPlacedBoxes(
		[placed('a', box(10, 10, 200, 50), box(10, 10, 320, 50))],
		{ images: [img], preserved: [] }, 600, 800);
	assert.ok(overImage.some(v => v.kind === 'occludes-image' && v.id === 'a'), JSON.stringify(overImage));

	const keep = { id: 'cell', box: box(10, 70, 200, 30) };
	const overCell = auditPlacedBoxes(
		[placed('a', box(10, 10, 200, 50), box(10, 10, 200, 95))],
		{ images: [], preserved: [keep] }, 600, 800);
	assert.ok(overCell.some(v => v.kind === 'occludes-preserved' && v.otherId === 'cell'), JSON.stringify(overCell));
});

test('out-of-page growth is flagged; rounding noise is not', () => {
	const out = auditPlacedBoxes(
		[placed('a', box(10, 700, 200, 80), box(10, 700, 200, 140))], // bottom 840 > 800
		none, 600, 800);
	assert.ok(out.some(v => v.kind === 'out-of-page' && v.id === 'a'));
	const noise = auditPlacedBoxes(
		[placed('b', box(10, 10, 200, 50), box(10, 10, 200.4, 50.4))],
		none, 600, 800);
	assert.deepEqual(noise, []);
});

test('violations sorted most-severe first', () => {
	const a = placed('a', box(10, 10, 100, 50), box(10, 10, 100, 120));  // huge overlap with b
	const b = placed('b', box(10, 70, 100, 50));
	const c = placed('c', box(300, 10, 100, 50), box(300, 10, 100, 78)); // small overlap with d
	const d = placed('d', box(300, 75, 100, 50));
	const out = auditPlacedBoxes([a, b, c, d], none, 600, 800);
	assert.equal(out.length, 2);
	assert.equal(out[0]!.id, 'a');
	assert.ok(out[0]!.area > out[1]!.area);
});
