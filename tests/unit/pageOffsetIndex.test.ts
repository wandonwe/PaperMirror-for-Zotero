/**
 * 页位置索引 (2.8.0 第二批): 可见页定位不再遍历整篇文档。
 *
 * 两件事必须钉死:
 *   1. 结果与老的逐页扫描**逐个位置一致** —— 包括混合纸张、横向页、不等高页;
 *   2. 建索引之后,滚动定位**一次几何读取都不做**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CachedPageIndex, PageOffsetIndex } from '../../src/ui/pageOffsetIndex';

/** 老实现: 从第 0 页开始逐页读几何。这里当参照答案用。 */
function scanRange(boxes: { top: number; height: number }[], top: number, bottom: number): [number, number] | null {
	let first = -1;
	let last = -1;
	for (let i = 0; i < boxes.length; i++) {
		const b = boxes[i]!;
		if (b.top + b.height > top && b.top < bottom) {
			if (first < 0) {
				first = i;
			}
			last = i;
		}
	}
	return first < 0 ? null : [first, last];
}

/** 按一串页高铺出连续的页盒(含页码标签与页间距)。 */
function layout(heights: number[], gap = 34): { top: number; height: number }[] {
	const boxes: { top: number; height: number }[] = [];
	let y = 12;
	for (const height of heights) {
		boxes.push({ top: y, height });
		y += height + gap;
	}
	return boxes;
}

// A4 纵向 / A4 横向 / Letter / 一页超长的折页 —— 不能假定整篇等高。
const MIXED = layout([842, 595, 792, 842, 1400, 595, 842, 842, 396, 842]);

test('二分定位与逐页扫描逐个位置一致 —— 混合纸张、横向页、不等高页 (2.8.0 第二批)', () => {
	const index = PageOffsetIndex.fromBoxes(MIXED);
	const total = MIXED.at(-1)!.top + MIXED.at(-1)!.height + 40;
	for (const viewport of [200, 600, 900, 1600]) {
		for (let top = -50; top <= total; top += 13) {
			assert.deepEqual(
				index.rangeFor(top, top + viewport),
				scanRange(MIXED, top, top + viewport),
				`viewport=${viewport} top=${top}`);
		}
	}
});

test('边界: 视口刚好贴着页缝、零高视口、整篇之外 (2.8.0 第二批)', () => {
	const boxes = layout([100, 100, 100], 10);
	const index = PageOffsetIndex.fromBoxes(boxes);
	// 第 1 页 12..112,第 2 页 122..222,第 3 页 232..332。
	assert.deepEqual(index.rangeFor(112, 122), null, '正落在页缝里: 一页都不覆盖');
	assert.deepEqual(index.rangeFor(111, 123), [0, 1], '各压住一点点就都算');
	assert.deepEqual(index.rangeFor(0, 12), null, '刚好停在第一页上沿之前');
	assert.deepEqual(index.rangeFor(0, 13), [0, 0]);
	assert.deepEqual(index.rangeFor(100, 100), null, '零高视口');
	assert.deepEqual(index.rangeFor(400, 900), null, '整篇之外');
	assert.deepEqual(index.rangeFor(-100, 5000), [0, 2], '整篇都在视口里');
	assert.equal(PageOffsetIndex.fromBoxes([]).rangeFor(0, 100), null, '空文档');
});

test('还没排版的槽报 0 时,顶边仍然非递减(二分不塌) (2.8.0 第二批)', () => {
	const index = PageOffsetIndex.fromBoxes([
		{ top: 12, height: 100 },
		{ top: 0, height: 0 },     // 尚未排版
		{ top: 0, height: 0 },
		{ top: 400, height: 100 }
	]);
	// 未排版的两页被夹到前一页的顶边(零高),落在视口里无害 —— 它们本来就
	// 只是 ghost。关键是**顶边非递减**,二分不塌: 若不夹住,tops 会是
	// [12, 0, 0, 400],lowerBound 的前提被破坏,末页会定位到错的地方。
	assert.deepEqual(index.rangeFor(0, 200), [0, 2]);
	assert.deepEqual(index.rangeFor(390, 600), [3, 3], '末页仍然定位得准');
	assert.deepEqual(index.rangeFor(200, 380), null, '中间的空隙里没有页');
});

test('500 页: 建索引读一次几何,之后滚动定位零读取 (2.8.0 第二批)', () => {
	for (const count of [50, 200, 500]) {
		const heights = Array.from({ length: count }, (_, i) => (i % 7 === 3 ? 595 : 842));
		const boxes = layout(heights);
		let reads = 0;
		const index = PageOffsetIndex.build(count, page => {
			reads++;
			return boxes[page]!;
		});
		assert.equal(reads, count, `${count} 页: 建索引一趟批量读完`);
		assert.equal(index.stats.reads, count);

		const before = reads;
		// 一次"普通滚动": 逐帧向下滚,每帧定位一次。
		const total = boxes.at(-1)!.top + boxes.at(-1)!.height;
		for (let top = 0; top < total; top += 120) {
			const range = index.rangeFor(top, top + 900);
			assert.deepEqual(range, scanRange(boxes, top, top + 900), `${count} 页 top=${top}`);
		}
		assert.equal(reads, before,
			`${count} 页: 滚动定位期间不得再读几何 —— 老实现在这里读了 ${count} 次/帧`);
	}
});

test('索引缓存: 滚动只用不建,几何变了才重建 —— 500 页零重建 (2.8.0 第二批)', () => {
	const boxes = layout(Array.from({ length: 500 }, (_, i) => (i % 5 === 0 ? 595 : 842)));
	let reads = 0;
	const measure = (page: number): { top: number; height: number } => {
		reads++;
		return boxes[page]!;
	};
	const cache = new CachedPageIndex();

	// 一次"普通滚动": 400 帧,每帧问一次可见范围。
	for (let frame = 0; frame < 400; frame++) {
		const index = cache.get(boxes.length, measure)!;
		index.rangeFor(frame * 300, frame * 300 + 900);
	}
	assert.equal(cache.builds, 1, '滚动期间一次都不该重建 —— 关掉缓存这里就变成 400');
	assert.equal(reads, boxes.length, `整场滚动总共只读了 ${boxes.length} 次几何`);

	// 缩放 / 改页宽 → 几何真的变了,必须重建。
	cache.invalidate();
	cache.get(boxes.length, measure);
	assert.equal(cache.builds, 2, '作废之后必须重建');
	assert.equal(reads, boxes.length * 2);

	// 页数变了(换文档)也要重建。
	cache.get(3, measure);
	assert.equal(cache.builds, 3);
	assert.equal(cache.get(0, measure), null, '空文档没有索引');
});

// ---- 接线的结构闸 -----------------------------------------------------------

test('面板经索引定位,回收只看已挂载集合 (结构性回归闸, 2.8.0 第二批)', () => {
	const src = readFileSync(join(process.cwd(), 'src/ui/translationPane.ts'), 'utf8');
	const visible = src.slice(src.indexOf('private visibleRange(buffer: number)'),
		src.indexOf('private scheduleEnsure('));
	assert.ok(/index\.rangeFor\(top, top \+ this\.scroll\.clientHeight\)/.test(visible),
		'visibleRange 必须走二分索引');
	assert.ok(/this\.pageIndex\.get\(this\.slots\.length,/.test(src),
		'索引必须经 CachedPageIndex 拿 —— 缓存不在,滚动就退回每帧重建');
	assert.ok(!/for \(let i = 0; i < this\.slots\.length; i\+\+\)/.test(visible),
		'visibleRange 里不得再有逐页扫描');
	assert.ok(!/offsetTop/.test(visible), 'visibleRange 里不得再读 offsetTop');

	const release = src.slice(src.indexOf('private releaseFarSlots('), src.indexOf('setCurrentPage(pageIndex: number)'));
	assert.ok(/for \(const i of this\.mounted\)/.test(release),
		'releaseFarSlots 只遍历已挂载页');
	assert.ok(!/for \(let i = 0; i < this\.slots\.length; i\+\+\)/.test(release),
		'releaseFarSlots 里不得再遍历全篇');
	assert.ok(release.indexOf('const release: number[] = []') < release.indexOf('replaceChildren'),
		'先集中收集,再集中改 DOM —— 读写不交错');
	assert.ok(/this\.mounted\.delete\(i\);/.test(release), '回收后要从集合里去掉');
	// 集合不被填充 = 什么都不会被回收 = 画布永不释放。回收既然只看这个集合,
	// 填充点就必须钉住。
	const commit = src.slice(src.indexOf('private commitRender('), src.indexOf('private releaseFarSlots('));
	assert.ok(/this\.mounted\.add\(page\);/.test(commit), '渲染落地时必须登记进已挂载集合');
	assert.ok(commit.indexOf('if (result !== false)') < commit.indexOf('this.mounted.add(page)'),
		'只有真的画上了内容才登记');
	for (const reset of ['private relayoutSlots(', 'private initPageList(']) {
		const body = src.slice(src.indexOf(reset), src.indexOf(reset) + 2200);
		assert.ok(/this\.mounted\.clear\(\);/.test(body), `${reset} 重排后必须清空已挂载集合`);
	}

	// 几何变了必须作废索引;滚动不该作废。
	const relayout = src.slice(src.indexOf('private relayoutSlots('), src.indexOf('setDocumentPages('));
	assert.ok(/this\.invalidatePageIndex\(\);/.test(relayout), '重排后索引必须作废');
	assert.ok(!/invalidatePageIndex/.test(src.slice(src.indexOf('private scheduleEnsure('),
		src.indexOf('private renderSlot('))), '滚动路径不该作废索引');
});
