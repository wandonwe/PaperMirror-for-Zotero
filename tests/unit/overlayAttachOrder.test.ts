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

test('测量循环之前,层已经进了文档', () => {
	const body = drawPageBody();
	const attach = body.indexOf('view.div.appendChild(layer)');
	const measure = body.indexOf('getBoundingClientRect().height || item.box.height');
	assert.ok(attach > 0, '仍在 drawPage 里挂载 layer');
	assert.ok(measure > 0, '仍在 drawPage 里量高度');
	assert.ok(
		attach < measure,
		'appendChild 必须排在测量之前 —— 否则量的是游离子树,尺寸恒为 0,字号阶梯失效'
	);
});

test('挂载与揭示之间用 visibility 隐藏,原子替换语义不破', () => {
	const body = drawPageBody();
	const hide = body.indexOf("layer.style.visibility = 'hidden'");
	const attach = body.indexOf('view.div.appendChild(layer)');
	const reveal = body.indexOf("layer.style.visibility = ''");
	const dropOld = body.indexOf('node.remove()');
	assert.ok(hide > 0 && hide < attach, '先隐藏再挂载,量的时候旧层仍占画面');
	assert.ok(reveal > attach, '揭示排在挂载之后');
	assert.ok(reveal < dropOld, '先揭示新层再摘旧层 —— 中间不能有一帧露原文');
});

test('页节点在测量期间被换掉时,隐藏层要撤走', () => {
	const body = drawPageBody();
	const guard = body.indexOf('latest.div !== view.div');
	assert.ok(guard > 0, '存活校验还在');
	const window = body.slice(guard, guard + 400);
	assert.match(window, /layer\.remove\(\)/, '否则页上会留一层隐藏的死层');
	assert.match(window, /scheduleRedraw\(pageIndex\)/, '并且要排重画');
});
