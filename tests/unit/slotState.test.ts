/**
 * 整页对照槽状态机 (2.5.2) —— "往回翻译文消失"的根因回归。
 *
 * pumpRenders 只重排 slotState === 'empty' 或 slotDirty 的槽,而 slotDirty
 * 只在 manager 通知 done 时置位、已 done 的页永不再通知。所以任何被写成
 * 终态的结果就等于"这一页这辈子不会再重建"。'degraded' 必须自愈。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSlotState } from '../../src/ui/translationPane';

const NOW = 1_700_000_000_000;

test("'translated' 是终态,且清空降级预算", () => {
	const d = nextSlotState('translated', 2, NOW);
	assert.equal(d.state, 'translated');
	assert.equal(d.dirty, false);
	assert.equal(d.retryAt, 0);
	assert.equal(d.tries, 0, '成功一次就把预算还回去');
});

test("'original'(本就没有译文的页)是终态", () => {
	const d = nextSlotState('original', 0, NOW);
	assert.equal(d.state, 'original');
	assert.equal(d.dirty, false, '纯图/扫描页反复重建毫无意义');
	assert.equal(d.retryAt, 0);
});

test('false 保持 ghost 并退避重试', () => {
	const d = nextSlotState(false, 0, NOW);
	assert.equal(d.state, 'empty');
	assert.equal(d.retryAt, NOW + 2500);
});

test("'degraded' 画原文但必须排进重试 —— 绝不当终态", () => {
	const first = nextSlotState('degraded', 0, NOW);
	assert.equal(first.state, 'original', '先把原文画上,总比空白强');
	assert.equal(first.dirty, true, '这一条就是修复本体');
	assert.equal(first.retryAt, NOW + 1200);
	assert.equal(first.tries, 1);

	// 退避递增
	const second = nextSlotState('degraded', first.tries, NOW);
	assert.equal(second.dirty, true);
	assert.equal(second.retryAt, NOW + 2400);
	const third = nextSlotState('degraded', second.tries, NOW);
	assert.equal(third.dirty, true);
	assert.equal(third.retryAt, NOW + 3600);
});

test('确定性失败在 3 次后停手,不永久空转', () => {
	const d = nextSlotState('degraded', 3, NOW);
	assert.equal(d.state, 'original');
	assert.equal(d.dirty, false, '第 4 次不再排队');
	assert.equal(d.retryAt, 0);
	assert.equal(d.tries, 4);
});

test('一次降级后重建成功,预算复位', () => {
	const failed = nextSlotState('degraded', 0, NOW);
	const ok = nextSlotState('translated', failed.tries, NOW);
	assert.equal(ok.state, 'translated');
	assert.equal(ok.tries, 0);
});
