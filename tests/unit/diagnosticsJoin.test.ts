import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPlacementOutcome } from '../../src/reader/diagnosticsJoin';

test('joinPlacementOutcome: 排版放弃的块 translated → unplaced + 原因 (审核 B-1)', () => {
	const pages = [
		{ page: 1, blocks: [
			{ id: 'page-0-region-0', state: 'translated' },
			{ id: 'page-0-region-1', state: 'translated' },
			{ id: 'page-0-region-2', state: 'preserved' }
		] },
		{ page: 2, blocks: [{ id: 'page-1-region-0', state: 'translated' }] }
	];
	const abandoned = new Map([[0, [{ id: 'page-0-region-1', reason: 'expand-ink/height' }]]]);
	const out = joinPlacementOutcome(pages, abandoned);
	assert.deepEqual(out[0]!.blocks![1], { id: 'page-0-region-1', state: 'unplaced', abandonReason: 'expand-ink/height' });
	assert.equal(out[0]!.blocks![0]!.state, 'translated', '未放弃的块不动');
	assert.equal(out[0]!.blocks![2]!.state, 'preserved', 'preserve 块不动');
	assert.strictEqual(out[1], pages[1], '没有放弃清单的页原对象返回');
});

test('joinPlacementOutcome: 段落拆分块 (region::pN) 按区域前缀归并', () => {
	const pages = [{ page: 3, blocks: [{ id: 'page-2-region-4', state: 'translated' }] }];
	const abandoned = new Map([[2, [
		{ id: 'page-2-region-4::p1', reason: 'no-room/height' },
		{ id: 'page-2-region-4::p0', reason: 'shrink-floor/width' }
	]]]);
	const out = joinPlacementOutcome(pages, abandoned);
	assert.equal(out[0]!.blocks![0]!.state, 'unplaced');
	assert.equal(out[0]!.blocks![0]!.abandonReason, 'no-room/height', '同区域保留第一条原因');
});

test('joinPlacementOutcome: 只在 state 为 translated 时改写', () => {
	const pages = [{ page: 1, blocks: [{ id: 'page-0-region-0', state: 'untranslated' }] }];
	const out = joinPlacementOutcome(pages, new Map([[0, [{ id: 'page-0-region-0', reason: 'compress' }]]]));
	assert.equal(out[0]!.blocks![0]!.state, 'untranslated');
});
