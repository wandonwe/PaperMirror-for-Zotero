import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditPlacedBoxes, boxNewlyViolates, type AuditBox } from '../../src/ui/layoutSafety';
import type { PixelBox } from '../../src/ui/translatedPageView';

const box = (left: number, top: number, width: number, height: number): PixelBox => ({ left, top, width, height });
const placed = (id: string, original: PixelBox, current?: PixelBox): AuditBox =>
	({ id, box: current ?? { ...original }, originalBox: original });
const none = { images: [], preserved: [] };

// ---------------------------------------------------------------------------
// 2.2.3, 第三批 item4 · 提交前几何预校验 boxNewlyViolates —— 与 auditPlacedBoxes
// 同一套「新增侵入>容差」判据的单块闸,只是在揭示之前核验。
// ---------------------------------------------------------------------------

test('boxNewlyViolates: unexpanded box never violates (box === originalBox)', () => {
	// 与已提交邻居原本就紧贴/轻叠也不算 —— 新增侵入为 0,首屏原字号揭示不受影响。
	const self = placed('a', box(10, 60, 200, 50)); // touches b below
	const committed = [placed('b', box(10, 108, 200, 50))];
	assert.equal(boxNewlyViolates(self, committed, none, 600, 800), false);
});

test('boxNewlyViolates: expansion that newly overlaps a committed neighbour is caught', () => {
	// self 原盒 (10,10,200,50);向下扩到高 110 → 侵入已提交的 b。
	const self = placed('a', box(10, 10, 200, 50), box(10, 10, 200, 110));
	const committed = [placed('b', box(10, 105, 200, 50))];
	assert.equal(boxNewlyViolates(self, committed, none, 600, 800), true);
	// 未扩到 b 之前(高 90,底边 100 < 105)不违例。
	const shy = placed('a', box(10, 10, 200, 50), box(10, 10, 200, 90));
	assert.equal(boxNewlyViolates(shy, committed, none, 600, 800), false);
});

test('boxNewlyViolates: expansion onto an image or off the page is caught', () => {
	const img = box(230, 10, 100, 100);
	const ontoImg = placed('a', box(10, 10, 200, 50), box(10, 10, 300, 50)); // grows right into image
	assert.equal(boxNewlyViolates(ontoImg, [], { images: [img], preserved: [] }, 600, 800), true);
	const offPage = placed('a', box(500, 10, 80, 50), box(500, 10, 200, 50)); // right edge 700 > 600
	assert.equal(boxNewlyViolates(offPage, [], none, 600, 800), true);
});

test('boxNewlyViolates: expansion onto a preserved region (data cell) is caught, self-id skipped', () => {
	const keep = { id: 'cell', box: box(10, 105, 200, 40) };
	const self = placed('a', box(10, 10, 200, 50), box(10, 10, 200, 110));
	assert.equal(boxNewlyViolates(self, [], { images: [], preserved: [keep] }, 600, 800), true);
	// 一个块不会和「自己的 id」相撞(preserve 里若混入同 id 应跳过)。
	const selfKeep = { id: 'a', box: box(10, 105, 200, 40) };
	const shy = placed('a', box(10, 10, 200, 50)); // unexpanded
	assert.equal(boxNewlyViolates(shy, [], { images: [], preserved: [selfKeep] }, 600, 800), false);
});

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

// ---- P3 (2.0.10): 陈旧违例重验 ----------------------------------------------

test('violationStillPresent: offender 收缩后已消失的 overlap 不再成立', async () => {
	const { violationStillPresent } = await import('../../src/ui/layoutSafety');
	const a = { id: 'a', box: { left: 0, top: 0, width: 100, height: 120 }, originalBox: { left: 0, top: 0, width: 100, height: 60 } };
	const b = { id: 'b', box: { left: 0, top: 100, width: 100, height: 60 }, originalBox: { left: 0, top: 100, width: 100, height: 60 } };
	const v = { id: 'b', kind: 'overlap' as const, otherId: 'a', area: 2000 };
	// A 仍扩展着: b↔a 新增重叠 20px 高 → 成立。
	assert.equal(violationStillPresent(v, [a, b], { images: [], preserved: [] }, 1000, 1000), true);
	// A 已被处置收缩回原盒: 该条违例消失,b 不得再被处置。
	const aShrunk = { ...a, box: { ...a.originalBox } };
	assert.equal(violationStillPresent(v, [aShrunk, b], { images: [], preserved: [] }, 1000, 1000), false,
		'按陈旧快照处置会把只有靠扩展才放得下的 b 永久回退成英文');
	// counterpart 本轮已被整个回退 (不在 placed 里) → 同样不成立。
	assert.equal(violationStillPresent(v, [b], { images: [], preserved: [] }, 1000, 1000), false);
});

test('violationStillPresent: occludes-preserved 与 out-of-page 按当前盒重算', async () => {
	const { violationStillPresent } = await import('../../src/ui/layoutSafety');
	const p = { id: 'p', box: { left: 0, top: 0, width: 100, height: 150 }, originalBox: { left: 0, top: 0, width: 100, height: 60 } };
	const keep = { id: 'ink', box: { left: 0, top: 100, width: 100, height: 60 } };
	const vp = { id: 'p', kind: 'occludes-preserved' as const, otherId: 'ink', area: 5000 };
	assert.equal(violationStillPresent(vp, [p], { images: [], preserved: [keep] }, 1000, 1000), true);
	const pShrunk = { ...p, box: { ...p.originalBox } };
	assert.equal(violationStillPresent(vp, [pShrunk], { images: [], preserved: [keep] }, 1000, 1000), false);
	const off = { id: 'o', box: { left: 950, top: 0, width: 100, height: 50 }, originalBox: { left: 900, top: 0, width: 90, height: 50 } };
	const vo = { id: 'o', kind: 'out-of-page' as const, area: 2500 };
	assert.equal(violationStillPresent(vo, [off], { images: [], preserved: [] }, 1000, 1000), true);
});
