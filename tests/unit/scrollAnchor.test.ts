/**
 * 同步落点的坐标系 (2.9.8)。
 *
 * ## 根因:两把尺子,零点差一个标题栏
 *
 * 面板里所有涉及位置的代码都在做同一件事 —— 拿 `slot.offsetTop` 当成一个
 * `scrollTop` 值用。可 `offsetTop` 量的是"到**定位祖先**的距离",而
 * `.pm-scroll` / `.pm-article-host` / `.pm-repage-host` **都没有 `position`**
 * (见 translationPane.css),定位祖先一路向上落到 `.pm-bilingual-pane`
 * —— 它才有 `position: relative`。于是 `offsetTop` 里**含着标题栏那一行**,
 * 而 `scrollTop` 是从滚动容器自己的内容顶边算起的。
 *
 * 同一个错误同时污染四处:
 *   1. `setPdfScrollFraction` —— 右侧落点系统性偏低约一个标题栏;
 *   2. `handleScroll` —— 反向判"当前页"用的也是这把错尺子;
 *   3. `ensurePageIndex` → `visibleRange` —— 可见窗口、挂载与渲染决策一起偏;
 *   4. 那个 `- 6` —— 照着这个偏差手调出来的补偿,来源解释不了、数值也补不对。
 *
 * 修法不是再调一个常数,而是**把换算做成一份纯函数**,四处共用。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchorFractionOf, anchorScrollTarget, toScrollTop, PageOffsetIndex } from '../../src/ui/pageOffsetIndex';
import { SYNC_ECHO_MS, SyncGuard } from '../../src/reader/scrollSynchronizer';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

// ---- 1. 换算按构造正确 --------------------------------------------------------

test('矩形差换算与"定位祖先在哪"无关 (2.9.8)', () => {
	// 标题栏 40px,滚动容器已经滚了 1200。槽此刻的视口顶边在 -300
	// (即它在视口上方 300px 处)。它在内容坐标里的位置应当是 1200 - 300 = 900,
	// 与标题栏、与谁是定位祖先都无关。
	const scrollRectTop = 40;
	assert.equal(toScrollTop(-260, scrollRectTop, 1200), 900);
	// 同一个槽,换一个有 padding / border 的容器布局(容器矩形顶边变了)——
	// 只要两个矩形取自同一次布局,换算结果仍然自洽。
	assert.equal(toScrollTop(-260 + 17, scrollRectTop + 17, 1200), 900);
});

test('落点没有任何常数补偿 (2.9.8)', () => {
	assert.equal(anchorScrollTarget(900, 1000, 0), 900, '页顶就是页顶,不许偷偷减 6');
	assert.equal(anchorScrollTarget(900, 1000, 0.37), 1270);
	assert.equal(anchorScrollTarget(900, 1000, 1), 1900);
});

test('页内比例与落点互逆 (2.9.8)', () => {
	const slotTop = 900;
	const slotHeight = 1000;
	for (const fraction of [-0.4, 0, 0.13, 0.5, 0.99, 1.3]) {
		const target = anchorScrollTarget(slotTop, slotHeight, fraction);
		assert.ok(Math.abs(anchorFractionOf(target, slotTop, slotHeight) - fraction) < 1e-9,
			`往返必须回到原处,fraction=${fraction}`);
	}
});

test('零高度的槽不产出 NaN (2.9.8)', () => {
	// 还没排版的槽高度是 0。旧写法 (top - slotTop) / 0 会得到 NaN 或 ±Infinity,
	// 一路传进 scrollTop 就是一次跳到文档头尾的大跳。
	assert.equal(anchorFractionOf(1000, 900, 0), 0);
	assert.ok(Number.isFinite(anchorScrollTarget(900, 0, 0.5)));
});

// ---- 2. 混合页高下,页锚点不随页码累积误差 ------------------------------------

test('混合纸张 + 页间距: 第 n 页的落点误差不随 n 增长 (2.9.8)', () => {
	// 竖版 / 横版交替,页间距 4px —— 正是真机文档的形态。
	const boxes: { top: number; height: number }[] = [];
	let top = 0;
	for (let i = 0; i < 120; i++) {
		const height = i % 3 === 0 ? 792.37 : 1122.52; // 故意带小数
		boxes.push({ top, height });
		top += height + 4;
	}
	const index = PageOffsetIndex.fromBoxes(boxes);
	// 逐页检查"页顶 + 37%"落点:锚在页上,所以误差恒为 0,与页码无关 ——
	// 而按"整篇滚动百分比"换算时,误差会随页码线性增长。
	for (const page of [0, 1, 37, 90, 119]) {
		const box = boxes[page]!;
		const target = anchorScrollTarget(box.top, box.height, 0.37);
		const hit = index.rangeFor(target, target + 1);
		assert.ok(hit, `第 ${page} 页的落点必须还落在文档里`);
		assert.equal(hit![0], page,
			`落点必须仍在第 ${page} 页内 —— 锚在页上就不会随页码漂移`);
	}
});

// ---- 3. 回声窗口只有一个 ------------------------------------------------------

test('面板与 SyncGuard 共用同一个回声窗口 (2.9.8)', () => {
	assert.equal(new SyncGuard().shouldPropagate('pane'), true);
	const pane = read('src/ui/translationPane.ts');
	assert.ok(/this\.suppressScrollUntil = Date\.now\(\) \+ SYNC_ECHO_MS;/.test(pane),
		'面板不许再自己写一个 300 —— 与 SyncGuard 的 400 之间那 100ms 的缝里,'
		+ '面板已经不把自己的回声当回声,而 SyncGuard 还在压制,两边对"谁说了算"的判断不一致');
	const sync = read('src/reader/scrollSynchronizer.ts');
	assert.ok(/export const SYNC_ECHO_MS = \d+;/.test(sync) && /cooldownMs \?\? SYNC_ECHO_MS/.test(sync),
		'窗口值只能有一个来源');
});

// ---- 4. 结构闸 ----------------------------------------------------------------

test('四处位置代码都走同一份换算,不再直接拿 offsetTop 当 scrollTop (结构性回归闸, 2.9.8)', () => {
	const src = read('src/ui/translationPane.ts');
	// 用**定义处**定位,不用第一次出现的地方 —— relayoutSlots 里也调它。
	for (const fn of ['setPdfScrollFraction(pageIndex: number, fraction: number): void {',
		'private readingAnchor(', 'private ensurePageIndex(']) {
		const start = src.indexOf(fn);
		assert.ok(start > 0, `${fn} 必须存在`);
		const body = src.slice(start, src.indexOf('\n\t}', start));
		assert.ok(/slotTopInScroll|slotTopBase|toScrollTop/.test(body),
			`${fn} 必须走滚动容器坐标 —— offsetTop 里含着标题栏`);
	}
	assert.ok(!/slot\.offsetTop \+ fraction/.test(src), '不许退回 offsetTop 直接当落点');
	// 索引是四处里唯一还留着 offsetTop 形状的地方(高度用它是对的,顶边不是)。
	const build = src.slice(src.indexOf('private ensurePageIndex('), src.indexOf('private slotTopBase('));
	assert.ok(!/top: slot\.offsetTop/.test(build),
		'索引的**顶边**必须来自矩形换算 —— 它一错,可见窗口、挂载与渲染决策一起偏');
	assert.ok(/top: rect\.top \+ base/.test(build) && /height: slot\.offsetHeight/.test(build),
		'高度用 offsetHeight 是对的(它是尺寸不是位置),顶边必须换算');
	assert.ok(!/- 6;/.test(src), '那个 -6 是手调补偿,零点对齐之后没有存在的理由');
});

test('连续跟随是瞬时滚动,离散跳转才平滑 (结构性回归闸, 2.9.8)', () => {
	const src = read('src/ui/translationPane.ts');
	const fn = src.slice(src.indexOf('setPdfScrollFraction(pageIndex: number'), src.indexOf('private scrollInstantly'));
	assert.ok(/this\.scrollInstantly\(/.test(fn),
		'`.pm-scroll` 带 scroll-behavior: smooth,而这个函数每滚动帧都被调用 —— '
		+ '每写一次就起一次平滑动画,下一帧又给新目标,右侧永远在追、从不到位,'
		+ '动画自己还不断发 scroll 事件回灌');
	const instant = src.slice(src.indexOf('private scrollInstantly'), src.indexOf('\n\t}', src.indexOf('private scrollInstantly')));
	assert.ok(/scrollBehavior = 'auto'/.test(instant) && /scrollBehavior = previous/.test(instant),
		"用临时改写 scrollBehavior,不用 scrollTo({behavior:'instant'}) —— "
		+ '后者在老引擎上会被当成无效值、静悄悄回落到 CSS 的 smooth');
	const css = read('src/ui/styles/translationPane.css');
	assert.ok(/scroll-behavior: smooth/.test(css), '离散跳转(scrollIntoView)仍然平滑 —— 这一条没被改掉');
});

test('判当前页走二分,不再逐页扫 (结构性回归闸, 2.9.8)', () => {
	const src = read('src/ui/translationPane.ts');
	const fn = src.slice(src.indexOf('private handleScroll'), src.indexOf('const sections:'));
	const anchor = src.slice(src.indexOf('private readingAnchor'), src.indexOf('private readingAnchor') + 800);
	assert.ok(/this\.readingAnchor\(\)/.test(fn) && /this\.ensurePageIndex\(\)/.test(anchor) && /rangeFor\(/.test(anchor),
		'索引本来就在(建一次用很多次),滚动热路径本该用它');
	assert.ok(!/for \(let i = 0; i < this\.slots\.length; i\+\+\)/.test(fn),
		'97 页的文档,一次滚动 194 次布局读取 —— 逐页扫不能回来');
});

test('几何变化后按"页 + 页内比例"回位,不按整篇百分比 (结构性回归闸, 2.9.8)', () => {
	const src = read('src/ui/translationPane.ts');
	const fn = src.slice(src.indexOf('private relayoutSlots'), src.indexOf('private readingAnchor'));
	assert.ok(/this\.readingAnchor\(\)/.test(fn) && /setPdfScrollFraction\(anchor\.pageIndex, anchor\.fraction\)/.test(fn),
		'页高不是按同一个比例变的(页宽有上限、混合纸张、页间距是定值)——'
		+ '整篇滚动百分比换算完就落到别的页上,文档越长偏得越远');
	assert.ok(!/scrollTop \/ this\.scroll\.scrollHeight/.test(fn), '不许退回整篇百分比锚点');
});
