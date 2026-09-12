import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTasks, splitGroupResult } from '../../src/translation/providers/bingFree';

/**
 * 2.12.2: bing-free 的吞吐缺口来自**每个片段一次 HTTP 往返**。
 *
 * 证据(2.12.1 真机语料):google-free 走 batchPieces(),BATCH_CHAR_LIMIT 1600,
 * 一页约 2 次请求;bing-free 一页约 20 次,并发 3 → 约 7 轮 × 400ms ≈ 2.8s,
 * 与实测中位数吻合。两者的服务端单次延迟是同一量级,差的全是往返次数。
 *
 * 所以这里打包的是**请求**,不是放宽任何质量约束:送出去的文本逐字节不变,
 * 顺序不变,分组不跨块。唯一的新风险是"拆不回来",由 splitGroupResult 兜住。
 */

const T = (text: string): { text: string } => ({ text });

test('groupTasks: 连续短片段按字符预算合并成一组', () => {
	const tasks = [T('a'.repeat(300)), T('b'.repeat(300)), T('c'.repeat(200))];
	const groups = groupTasks(tasks);
	// 300 + 1 + 300 + 1 + 200 = 802 ≤ 900,一次请求装得下。
	assert.deepEqual(groups, [[0, 1, 2]]);
});

test('groupTasks: 超预算就断开,且断点前后都不丢片段', () => {
	const tasks = [T('a'.repeat(500)), T('b'.repeat(500)), T('c'.repeat(100))];
	const groups = groupTasks(tasks);
	// 500 + 1 + 500 = 1001 > 900 → 第二条另起一组;再加 100 仍在预算内。
	assert.deepEqual(groups, [[0], [1, 2]]);
	const flat = groups.flat();
	assert.deepEqual(flat, [0, 1, 2], '每个片段必须恰好出现一次、且保持原序');
});

test('groupTasks: 打包后每组的真实送出长度不超预算', () => {
	const lens = [120, 80, 640, 90, 300, 450, 200, 30, 710, 55];
	const tasks = lens.map(n => T('x'.repeat(n)));
	const groups = groupTasks(tasks);
	for (const g of groups) {
		const sent = g.map(i => tasks[i]!.text).join('\n');
		// 单个片段自身就超预算时只能独占一组(上游 splitLongText 已按 900 切过),
		// 但**合并**永远不许把一组撑过预算。
		if (g.length > 1) {
			assert.ok(sent.length <= 900, `一组送出 ${sent.length} 字符,超过 900 预算`);
		}
	}
});

test('groupTasks: 含换行的片段单独成组(分隔符必须无歧义)', () => {
	const tasks = [T('short one'), T('has\nnewline'), T('another short'), T('also short')];
	const groups = groupTasks(tasks);
	assert.deepEqual(groups, [[0], [1], [2, 3]],
		'含换行的片段一旦被并进组里,拆回来的条数就会多出来 —— 必须独占一组');
	// 换行片段自己一组时,translateGroup 走 texts.length === 1 的直通路径,
	// 原文里的换行原样送出,不经过 join/split。
	assert.equal(groups[1]!.length, 1);
});

test('groupTasks: 换行片段在组中间时,前面的组要先收口再独立成组', () => {
	const tasks = [T('a'), T('b'), T('c\nd'), T('e')];
	assert.deepEqual(groupTasks(tasks), [[0, 1], [2], [3]]);
});

test('groupTasks: 空任务表返回空分组', () => {
	assert.deepEqual(groupTasks([]), []);
});

test('splitGroupResult: 条数对得上才拆,对不上返回 null', () => {
	assert.deepEqual(splitGroupResult('一\n二\n三', 3), ['一', '二', '三']);
	// 引擎吞掉一个换行 → 2 条对 3 条,必须拒收。
	assert.equal(splitGroupResult('一二\n三', 3), null);
	// 引擎多吐一个换行 → 4 条对 3 条,同样拒收。
	assert.equal(splitGroupResult('一\n二\n三\n', 3), null);
	// 整组被合成一句 → 1 条对 3 条。
	assert.equal(splitGroupResult('一二三', 3), null);
});

test('splitGroupResult: 拒收的代价是多一次往返,而不是把译文错位', () => {
	// 这条锁的是行为的**方向**:宁可返回 null(调用方逐条重翻),
	// 也绝不返回一个长度不等于 expected 的数组 —— 那会让第 k 段的译文
	// 落到第 k+1 段上,而且下游完全看不出来。
	const bad = splitGroupResult('只有一条', 4);
	assert.equal(bad, null);
	const good = splitGroupResult('A\nB\nC\nD', 4);
	assert.ok(good);
	assert.equal(good!.length, 4);
});
