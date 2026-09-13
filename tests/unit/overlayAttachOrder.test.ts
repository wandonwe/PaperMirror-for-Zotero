import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2.5.2: 覆盖模式的字号阶梯从来没真正跑过。
 *
 * drawPage 把整层 layer 建好后才 view.div.appendChild(layer),而字号测量循环
 * 排在 appendChild **之前** —— 量的是一棵游离子树。游离子树上
 * getBoundingClientRect().height / scrollHeight / scrollWidth / clientWidth
 * 全部返回 0,fits() 在第 0 级阶梯就恒真:每个框都拿到最大字号,永不收缩,
 * data-pm-overflow 永不置位,.pm-overlay-box 的 overflow:hidden 把译文裁掉。
 * 源码注释「Measure only after everything is in the document」当时是**假的**。
 *
 * drawPage 依赖 reader/adapter/真实布局,单测里没法实例化,故用源码级顺序闸。
 */

const src = readFileSync(join(process.cwd(), 'src/reader/pdfOverlay.ts'), 'utf8');

/** drawPage 的函数体(到下一个同缩进的方法为止)。 */
function drawPageBody(): string {
	const start = src.indexOf('private drawPage(');
	assert.ok(start > 0, 'drawPage 还在');
	const end = src.indexOf('\n\t/**', start);
	assert.ok(end > start, 'drawPage 后面还有别的成员');
	return src.slice(start, end);
}

test('渲染之前,层已经进了文档 (3.1.0: 严格页的量测只对在文档里的节点有效)', () => {
	const body = drawPageBody();
	const attach = body.indexOf('view.div.appendChild(layer)');
	const render = body.indexOf('this.renderer(pageIndex, layer, width, ctrl.signal)');
	assert.ok(attach > 0, '仍在 drawPage 里挂载 layer');
	assert.ok(render > 0, '仍由会话装入的严格页渲染器画这一层');
	assert.ok(attach < render,
		'appendChild 必须排在渲染之前 —— settleStrictPage 量的是游离子树时尺寸恒为 0,一个块都不会提交');
});

test('新层落地后才摘旧层,原子替换语义不破 (3.1.0)', () => {
	const body = drawPageBody();
	const render = body.indexOf('this.renderer(pageIndex, layer, width, ctrl.signal)');
	const gate = body.indexOf("result !== 'translated' && result !== 'partial'");
	const dropOld = body.indexOf('if (node !== layer) {');
	assert.ok(gate > render, '只有真的放了译文的层才算落地');
	assert.ok(dropOld > gate, '先确认新层有译文,再摘旧层 —— 中间不能有一帧露原文');
	// 严格页的底图副本必须藏起来:覆盖层不是把一张页面副本盖在实时页上。
	assert.match(src, /\.pm-repage-canvas \{\s*visibility: hidden;/, '底图副本 visibility:hidden');
	assert.match(src, /\.pm-repage \{[^}]*background: transparent !important/, '严格页的行内纸色必须被覆盖为透明');
});

test('页节点在渲染期间被换掉时,层要撤走', () => {
	const body = drawPageBody();
	const guard = body.indexOf('latest.div !== view.div');
	assert.ok(guard > 0, '存活校验还在');
	const window = body.slice(guard, guard + 400);
	assert.match(window, /layer\.remove\(\)/, '否则页上会留一层死层');
	assert.match(window, /scheduleRedraw\(pageIndex\)/, '并且要排重画');
});

test('覆盖层与面板共用同一个页面渲染器 (3.1.0)', () => {
	const session = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	assert.match(session, /this\.overlay\.setPageRenderer\(\(pageIndex, host, width, signal\) => this\.renderDocPage\(pageIndex, host, width, signal\)\)/,
		'两种模式必须走同一个 renderDocPage —— 否则同一页译出两种结果');
	assert.match(session, /this\.pane\.setPageRenderer\(\(pageIndex, slot, width, signal\) => this\.renderDocPage\(pageIndex, slot, width, signal\)\)/);
	// 旧引擎的"裁掉 + 省略号"不许回来。
	assert.ok(!/data-pm-overflow/.test(src), '覆盖层不再有省略号截断');
	assert.ok(!/fitFontSize\(/.test(src), '覆盖层不再有自己的字号阶梯');
});

test('覆盖模式下隐藏的面板不泵 —— 两个表面共用渲染世代 (3.1.0)', () => {
	const pane = readFileSync(join(process.cwd(), 'src/ui/translationPane.ts'), 'utf8');
	const session = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	assert.match(pane, /windowOf: \(\) => \{\s*if \(!this\.surfaceActive \|\|/,
		'display:none 的面板 clientHeight=0,可视范围仍会算出一页;不可见就不能进泵');
	assert.match(pane, /setSurfaceActive\(active: boolean\): void \{[\s\S]*?this\.pump\.cancelAll\(\);[\s\S]*?this\.slotDirty\[i\] = true;/,
		'隐藏时取消在飞;重新可见时所有槽标脏(隐藏期间覆盖层可能接管了同页的世代)');
	const apply = session.slice(session.indexOf('private applyViewMode(): void {'));
	const overlayCase = apply.slice(apply.indexOf("case 'overlay':"), apply.indexOf("case 'split':"));
	const a = overlayCase.indexOf('this.pane?.setSurfaceActive(false)');
	const b = overlayCase.indexOf('this.applyOverlay(true, false)');
	assert.ok(a > 0 && b > a, '先停面板的泵,再开覆盖层');
	assert.match(apply.slice(apply.indexOf("case 'split':"), apply.indexOf('this.renderTopTask();')), /this\.pane\?\.setSurfaceActive\(true\)/);
});
