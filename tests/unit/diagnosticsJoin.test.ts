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

// ---- 3.1.6: 回声块 = 原文即译文,记 preserved/echo,不算未放回 ---------------
test('3.1.6:reason=echo 的块联表后是 preserved/echo,不是 unplaced', () => {
	const pages = [{ page: 21, blocks: [
		{ id: 'page-20-region-6', state: 'translated' },
		{ id: 'page-20-region-7', state: 'translated' }
	] }];
	const out = joinPlacementOutcome(pages, new Map([[20, [
		{ id: 'page-20-region-6', reason: 'echo' },
		{ id: 'page-20-region-7', reason: 'shrink-floor/height' }
	]]]));
	assert.deepEqual(out[0]!.blocks![0], { id: 'page-20-region-6', state: 'preserved', preserveReason: 'echo' });
	assert.deepEqual(out[0]!.blocks![1], { id: 'page-20-region-7', state: 'unplaced', abandonReason: 'shrink-floor/height' });
});

test('3.1.6:严格页在 too-small 门槛之前就把回声块放过 —— 原文留在页上即正确', async () => {
	const { isEcho } = await import('../../src/ui/strictPageReplacement');
	assert.equal(isEcho('P1/P2/P3/P4', 'P1/P2/P3/P4'), true);
	assert.equal(isEcho('P1/P2/P3/P4', 'p1 / p2 / p3 / p4'), true, '大小写、空白、标点不算差异');
	assert.equal(isEcho('ACS unlikely', 'ACS 不太可能'), false);
	const { readFileSync } = await import('node:fs');
	const { join } = await import('node:path');
	const src = readFileSync(join(process.cwd(), 'src/ui/strictPageReplacement.ts'), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const echo = src.indexOf("skipped.push({ id: block.id, reason: 'echo' })");
	const small = src.indexOf("skipped.push({ id: block.id, reason: 'too-small' })");
	assert.ok(echo > 0 && small > echo, '回声判定必须排在 too-small 之前,否则回声的短标签仍被计成放弃');
});
