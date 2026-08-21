import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectInkObstacleBlocks, overlapsImageInk, computeExpansionAllowance } from '../../src/ui/strictPageReplacement';
import { auditPlacedBoxes } from '../../src/ui/layoutSafety';

/**
 * P2-14 (2.0.4): 参考文献 / type==='table' 块被排除出替换流水线,但它们的
 * 原文墨迹仍在位图上 —— 它们必须作为遮挡物进入边界扩展与几何审计,否则
 * 扩展会把译文长进参考文献里叠印,审计也看不见。
 * P2-15 (2.0.4): 遮罩对图像硬裁剪 (mask∩image===0),文本盒准入必须服从
 * 同一条规则 —— 旧的 15% 容差带内"英文透出 + 中文叠印"。
 */

const rects = [[0, 0, 1, 1]]; // 任意非空 lineRectsPdf

test('selectInkObstacleBlocks 与 geometric 过滤严格互补', () => {
	const blocks = [
		{ id: 'ref', isReference: true, type: 'paragraph', lineRectsPdf: rects },
		{ id: 'tbl', isReference: false, type: 'table', lineRectsPdf: rects },
		{ id: 'body', isReference: false, type: 'paragraph', lineRectsPdf: rects },
		{ id: 'ref-no-geom', isReference: true, type: 'paragraph', lineRectsPdf: [] },
		{ id: 'cap', isReference: false, type: 'caption', lineRectsPdf: rects }
	];
	const picked = selectInkObstacleBlocks(blocks).map(b => b.id);
	assert.deepEqual(picked, ['ref', 'tbl'], '恰好是被 geometric 排除且有几何的块');
});

test('P2-14: 参考文献墨迹截断右向扩展(此前扩展对它失明)', () => {
	const box = { left: 100, top: 100, width: 200, height: 40 };
	const refInk = { left: 320, top: 90, width: 200, height: 300 }; // 紧邻右侧
	const without = computeExpansionAllowance(box, [], 1000, 1000, 12);
	const withRef = computeExpansionAllowance(box, [refInk], 1000, 1000, 12);
	assert.ok(without.right > 100, '无遮挡时右向有大量空白可扩');
	assert.ok(withRef.right <= 320 - (100 + 200) - 3 + 0.001, '扩展必须在参考文献近边前截断');
	assert.ok(withRef.right < without.right, '遮挡物确实收紧了扩展');
});

test('P2-14: 几何审计看得见压住参考文献墨迹的已提交块', () => {
	const originalBox = { left: 100, top: 100, width: 200, height: 40 };
	const grownBox = { left: 100, top: 100, width: 200, height: 120 }; // 下扩后
	const refInk = { id: 'ref-1', box: { left: 100, top: 150, width: 200, height: 60 } };
	const violations = auditPlacedBoxes(
		[{ id: 'blk', box: grownBox, originalBox }],
		{ images: [], preserved: [refInk] },
		1000, 1000
	);
	assert.equal(violations.length, 1);
	assert.equal(violations[0]!.kind, 'occludes-preserved');
	assert.equal(violations[0]!.otherId, 'ref-1');
	// 原盒没有压住时不报(added 相对 originalBox 计算,幂等)。
	const clean = auditPlacedBoxes(
		[{ id: 'blk', box: originalBox, originalBox }],
		{ images: [], preserved: [refInk] },
		1000, 1000
	);
	assert.equal(clean.length, 0);
});

test('P2-15: 图像准入阈值对齐遮罩硬裁剪 —— 旧 15% 容差带内的块现在被拒', () => {
	const box = { left: 0, top: 0, width: 100, height: 100 };
	// 10% 重叠: 旧阈值 (15%) 放行 → 遮罩 clearRect 抹掉图像区,英文透出,
	// 译文却覆盖整盒。新规则必须拒绝。
	const img10 = { left: 90, top: 0, width: 100, height: 100 };
	assert.equal(overlapsImageInk(box, [img10]), true, '10% 重叠必须拒绝准入');
	// 1% 重叠: 几何噪声容差内,放行。
	const img1 = { left: 99, top: 0, width: 100, height: 100 };
	assert.equal(overlapsImageInk(box, [img1]), false, '1% 噪声级重叠仍可准入');
	// 无重叠、零面积盒: 安全。
	assert.equal(overlapsImageInk(box, [{ left: 500, top: 500, width: 50, height: 50 }]), false);
	assert.equal(overlapsImageInk({ left: 0, top: 0, width: 0, height: 0 }, [img10]), false);
});
