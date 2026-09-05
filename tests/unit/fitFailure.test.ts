import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitOverflow, fitFailureLabel } from '../../src/ui/strictPageReplacement';

test('fitOverflow: 与 ladderFits 同一套 1.5px 容差', () => {
	assert.equal(fitOverflow(100, 50, 100, 50), 'none');
	assert.equal(fitOverflow(101.4, 50, 100, 50), 'none', '1.5px 内是取整噪声');
	assert.equal(fitOverflow(102, 50, 100, 50), 'width');
	assert.equal(fitOverflow(100, 52, 100, 50), 'height');
	assert.equal(fitOverflow(102, 52, 100, 50), 'both');
});

test('fitFailureLabel: 紧凑枚举串,无文本', () => {
	assert.equal(fitFailureLabel({ stage: 'expand-ink', overflow: 'height' }), 'expand-ink/height');
	assert.equal(fitFailureLabel({ stage: 'compress' }), 'compress');
	assert.equal(fitFailureLabel(undefined), 'unknown');
	// 枚举串只含小写字母、连字符、斜杠 —— diagnosticsPrivacy 的口径。
	for (const s of ['expand-ink/height', 'shrink-floor/width', 'compress', 'audit/both']) {
		assert.match(s, /^[a-z-]+(\/[a-z]+)?$/);
	}
});

// ---- 2.7.3 批次 4 (D-1) ------------------------------------------------------

import { isTableCellBlock, bodyAnchorSizes, shrinkStepsFor, orderExpansions } from '../../src/ui/strictPageReplacement';
import { bodyAnchorPt } from '../../src/ui/pageLayout';

test('fitFailureLabel: 缩字到底 + 扩边被否决 → 带 veto 后缀 (2.7.3)', () => {
	assert.equal(fitFailureLabel({ stage: 'shrink-floor', overflow: 'none', veto: 'ink' }), 'shrink-floor/none+ink');
	assert.equal(fitFailureLabel({ stage: 'shrink-floor', overflow: 'height', veto: 'geometry' }), 'shrink-floor/height+geometry');
	assert.equal(fitFailureLabel({ stage: 'shrink-floor', overflow: 'height' }), 'shrink-floor/height');
	assert.match('shrink-floor/none+ink', /^[a-z-]+(\/[a-z]+)?(\+[a-z]+)?$/);
});

test('isTableCellBlock: id 形态或 tableRow 任一即单元格', () => {
	assert.equal(isTableCellBlock({ id: 'page-2-table-0-r1-c1' }), true);
	assert.equal(isTableCellBlock({ id: 'page-2-region-3', tableRow: 4 }), true);
	assert.equal(isTableCellBlock({ id: 'page-2-region-3' }), false);
});

test('页面基准字号不被表格单元格拖低 (2.7.3, jacc2020 Table 1 页实证)', () => {
	const blocks = [
		...Array.from({ length: 100 }, (_, i) => ({ id: `page-2-table-0-r${i}-c1`, type: 'paragraph', fontSize: 7 })),
		...Array.from({ length: 20 }, (_, i) => ({ id: `page-2-region-${i}`, type: 'paragraph', fontSize: 9.5 })),
		{ id: 'page-2-region-h', type: 'heading', fontSize: 11 }
	];
	const sizes = bodyAnchorSizes(blocks);
	assert.equal(sizes.length, 20, '只有正文段落进样本');
	assert.equal(bodyAnchorPt(sizes), 9.5);
	// 对照: 单元格混进样本时中位数落到 7pt —— 这就是整页正文变小的根因。
	assert.equal(bodyAnchorPt(blocks.filter(b => b.type === 'paragraph').map(b => b.fontSize)), 7);
});

test('shrinkStepsFor: 孤立块三档到 0.82,正文流仍两档', () => {
	assert.deepEqual(shrinkStepsFor('heading'), [0.94, 0.88, 0.82]);
	assert.deepEqual(shrinkStepsFor('caption'), [0.94, 0.88, 0.82]);
	assert.deepEqual(shrinkStepsFor('paragraph', { isTableCell: true }), [0.94, 0.88, 0.82]);
	assert.deepEqual(shrinkStepsFor('paragraph', { tinyLine: true }), [0.94, 0.88, 0.82]);
	assert.deepEqual(shrinkStepsFor('paragraph'), [0.94, 0.88]);
	assert.deepEqual(shrinkStepsFor('list'), [0.94, 0.88]);
});

test('orderExpansions: 底线组合按新占面积从小到大', () => {
	const ordered = orderExpansions([[130, 40], [100, 60], [130, 60]]);
	assert.deepEqual(ordered, [[130, 40], [100, 60], [130, 60]]);
	assert.deepEqual(orderExpansions([[130, 60], [100, 60], [130, 40]]), [[130, 40], [100, 60], [130, 60]]);
});
