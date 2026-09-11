/**
 * 不依赖渲染的抽取路径 (2.9.7, 真机第九轮)。
 *
 * ## 为什么这条路是正解
 *
 * 两个决定性的数字:
 *
 *   `charsPath: { "threw:EXTRACTION_FAILED/present": 97 }`
 *      —— fork 的私有 `getPageData` **方法在**(`present`),但 97/97 页调用都失败。
 *         路径 1 从来就没通过。
 *   `textContentApi: "available"`
 *      —— 标准 PDF.js 的 `getPage()` 可用。
 *
 * 于是插件一直只剩 DOM 文本层一条路,而**文本层只对 PDF.js 正在渲染的那几页存在**。
 * 2.9.0–2.9.6 七个版本(释放记账、事件补回、原因分流、距离闸、两套重试预算……)
 * 全都是在给这个固有属性打补丁。`getTextContent()` 走 worker 的解析结果,
 * **任何页随时可读** —— 从根上不需要那些补丁。
 *
 * ## 这个文件盯什么
 *
 * 新代码只有一处真正的新逻辑:`transform` → 包围盒。建块之后的每一步都与文本层
 * 路径共用同一个实现(`blocksFromSpanPage`),所以 37 个布局快照就是下游的回归
 * 测试;这里只需把几何算对,并钉住"两条路共用一份实现"这件事。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { textContentItemRect } from '../../src/reader/zoteroReaderAdapter';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

// ---- 1. transform → 包围盒 ----------------------------------------------------

test('水平文字: em 盒跨骑基线,下方留出下伸部 (2.10.1)', () => {
	// 10pt 字,基线在 y = 700,advance 50。
	const box = textContentItemRect([10, 0, 0, 10, 100, 700], 50)!;
	// 2.9.7 曾是 [100, 700, 150, 710] —— 下沿**恰好是基线**,基线以下零空间。
	// 逗号、分号、g/p/y 的尾巴全在基线以下,于是遮罩盖不住它们:真机上
	// 原文每一行的标点尾巴从遮罩下沿漏出来,译文页上留下一片规则的小点。
	assert.deepEqual(box.rect, [100, 697.8, 150, 707.8]);
	assert.equal(box.fontSize, 10);
	// 盒高仍是一个 em —— 只是放对了位置,不是变大。
	assert.ok(Math.abs((box.rect[3] - box.rect[1]) - 10) < 1e-9);
	// 基线必须落在盒子**内部**,不是边界上。
	assert.ok(box.rect[1] < 700 && 700 < box.rect[3], '基线要被盒子跨骑');
});

test('竖排文字(旋转 90°)不能算成横躺的盒子 (2.9.7 真机页边水印)', () => {
	// 真机上每一页都有一条竖排的 "Downloaded from …" 水印。它的 transform 是旋转的,
	// 若图省事写成 [e, f, e+width, f+height],会得到一个横跨半页的盒子,
	// 把正文全框进去 —— 阅读序和分栏当场被毁。
	const box = textContentItemRect([0, 8, -8, 0, 30, 300], 200)!;
	// 前进方向是 +y,字高方向是 -x。2.10.1 让盒子沿**它自己的**下方向退
	// 0.22em —— 这里的「下」是 +x,所以整条带子右移 1.76,不是一律往 -y 挪。
	assert.deepEqual(box.rect, [23.76, 300, 31.76, 500]);
	assert.equal(box.fontSize, 8);
	const [x1, , x2] = box.rect;
	assert.ok(x2 - x1 < 20, '竖排文字的盒子必须是**窄条**,不是横躺的长条');
	assert.ok(Math.abs((x2 - x1) - 8) < 1e-9, '盒宽仍是一个 em');
});

test('缩放为 0 的退化 transform 按水平处理,不丢字 (2.9.7)', () => {
	const box = textContentItemRect([0, 0, 0, 10, 100, 700], 50)!;
	assert.deepEqual(box.rect, [100, 697.8, 150, 707.8], '退化时也要给出一个可用的盒子');
});

test('非有限数一律丢弃,不让 NaN 流进排版 (2.9.7)', () => {
	assert.equal(textContentItemRect([NaN, 0, 0, 10, 100, 700], 50), null);
	assert.equal(textContentItemRect([10, 0, 0, 10, 100, 700], Number.POSITIVE_INFINITY), null);
	assert.equal(textContentItemRect([10, 0, 0, 10], 50), null, '缺项的 transform 同样丢弃');
});

// ---- 2. 路径顺序: 不依赖渲染的那条要排在前面 ----------------------------------

test('getTextContent 排在 DOM 文本层之前 (结构性回归闸, 2.9.7)', () => {
	const src = read('src/reader/textExtractor.ts');
	const fn = src.slice(src.indexOf('async extractPage(pageIndex: number)'), src.indexOf('async extractRenderedPage'));
	const content = fn.indexOf('extractFromTextContent');
	const layer = fn.indexOf('extractFromTextLayer');
	assert.ok(content > 0 && layer > 0 && content < layer,
		'不依赖渲染的那条必须先试 —— 它通了,「文本层只对渲染着的页存在」这个毛病就不再是主路的毛病');
	assert.ok(/this\.pathByPage\.set\(pageIndex, 'text-content'\)/.test(fn),
		'走通了要如实记路径,导出时才分得清这一页的结构是哪条路产出的');
});

test('两条基于 span 的路径共用同一份建块实现 (结构性回归闸, 2.9.7)', () => {
	const src = read('src/reader/textExtractor.ts');
	// 各写一遍,两条路迟早会在阅读序、表格结构化或合并上悄悄分叉,而分叉出来的
	// 差异会伪装成"这一页的结构变了",把语料的结构比对引向错误的结论。
	assert.equal((src.match(/buildBlocksFromSpans\(/g) ?? []).length, 1,
		'buildBlocksFromSpans 只能被调用一处');
	assert.equal((src.match(/private blocksFromSpanPage\(/g) ?? []).length, 1);
	for (const caller of ['extractFromTextLayer', 'extractFromTextContent']) {
		const body = src.slice(src.indexOf(`private async ${caller}(`), src.indexOf('\n\t}', src.indexOf(`private async ${caller}(`)));
		assert.ok(/this\.blocksFromSpanPage\(/.test(body), `${caller} 必须走共用实现`);
	}
});

test('getTextContentItems 不碰 DOM,也不等渲染 (结构性回归闸, 2.9.7)', () => {
	const src = read('src/reader/zoteroReaderAdapter.ts');
	const fn = src.slice(src.indexOf('export async function getTextContentItems'),
		src.indexOf('\n}', src.indexOf('export async function getTextContentItems')));
	assert.ok(!/waitForTextLayer|querySelector|getBoundingClientRect|pageViewOf/.test(fn),
		'这条路的全部意义就是不依赖渲染 —— 碰一下 DOM 或等一次就白做了');
	assert.ok(/getTextContent/.test(fn) && /getPage\(pageIndex \+ 1\)/.test(fn),
		'PDF.js 的 getPage 是 1-based,页号差一就会整篇错页');
});

// ---- 3. 2.9.9: 穿过 Xray ------------------------------------------------------
//
// 2.9.7 上线后的真机:`extractPath` **一次 `text-content` 都没有**,
// `textContentMs` 整轮只有 **5 ms / 21 页** —— 它在 `getPage` 之后、
// `getTextContent` 之前就退出了。
//
// 三件事指向同一条边界:
//   - `getTextLayerItems` 一直能用 —— 走的是 DOM,DOM 有完整 Xray 支持;
//   - `getPageData` typeof 为 function,但 97/97 页调用都抛错;
//   - `getPage` 探针说 available,而 `getTextContent` 在那个视角下不可见。
//
// **凡是走 JS 对象方法的路都不通,走 DOM 的路都通。** 而这个代码库从头到尾
// 没有一处 `wrappedJSObject` —— 从来没穿过 Xray。

test('每一层 JS 对象都穿过 Xray (结构性回归闸, 2.9.9)', () => {
	const src = read('src/reader/zoteroReaderAdapter.ts');
	assert.ok(/function waive<T>\(value: T\): T \{/.test(src), '必须有一处 waive');
	assert.ok(/wrappedJSObject/.test(src), '这是穿 Xray 的标准做法');
	const fn = src.slice(src.indexOf('export async function getTextContentItems'),
		src.indexOf('\n}', src.indexOf("note?.('ok')")));
	// pdfDocument 是一层,getPage 返回的 PDFPageProxy 又是一层。少穿一层,
	// 下一层的方法就"不存在" —— 2.9.7 正是栽在第二层。
	assert.ok(/waive\(pdfWindow\(reader\)\?\.PDFViewerApplication\)/.test(fn), '第一层: window → app');
	assert.ok(/waive\(\(waive\([\s\S]{0,120}\)\?\.pdfDocument\)/.test(fn), '第二层: app → pdfDocument');
	assert.ok(/waive\(await doc\.getPage\(pageIndex \+ 1\)\)/.test(fn), '第三层: getPage → PDFPageProxy');
	assert.ok(/waive\(await page\.getTextContent\(\)\)/.test(fn), '第四层: 返回的 content');
});

test('穿不过就退回原对象,不许因此变得更坏 (2.9.9)', async () => {
	const { getTextContentItems } = await import('../../src/reader/zoteroReaderAdapter');
	// 没有 wrappedJSObject 的普通对象 —— waive 必须原样返回,路径照常工作。
	const page = {
		getTextContent: async () => ({ items: [{ str: 'Hello', transform: [10, 0, 0, 10, 50, 700], width: 40 }] }),
		view: [0, 0, 612, 792]
	};
	const reader = { _internalReader: { _primaryView: { _iframeWindow: {
		PDFViewerApplication: { pdfDocument: { getPage: async () => page } }
	} } } };
	const seen: string[] = [];
	const result = await getTextContentItems(reader as never, 0, r => seen.push(r));
	assert.ok(result, 'waive 只可能让更多东西可见,不会让已经能用的变得不能用');
	assert.equal(result!.items.length, 1);
	assert.deepEqual(result!.items[0]!.rect, [50, 697.8, 90, 707.8]);
	assert.equal(result!.pageWidth, 612);
	// 变异验证补的闸:只报失败、不报成功,`textContentPath` 里就只剩各种退出
	// 原因 —— 看上去像"全都没通",而真正要判定 Xray 假设成立与否的那一格是空的。
	assert.deepEqual(seen, ['ok'], '走通的页必须自报 ok,否则下一轮没有分母');
});

test('每一种退出都报一个原因 (2.9.9)', async () => {
	const { getTextContentItems } = await import('../../src/reader/zoteroReaderAdapter');
	const mk = (pdfDocument: unknown): never =>
		({ _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument } } } } }) as never;
	const seen: string[] = [];
	await getTextContentItems(mk({}), 0, r => seen.push(r));
	await getTextContentItems(mk({ getPage: async () => ({}) }), 0, r => seen.push(r));
	await getTextContentItems(mk({ getPage: async () => ({ getTextContent: async () => ({ items: [] }) }) }), 0, r => seen.push(r));
	await getTextContentItems(mk({ getPage: async () => { throw new TypeError('x'); } }), 0, r => seen.push(r));
	assert.deepEqual(seen, ['no-getpage', 'no-gettextcontent', 'no-items', 'threw:TypeError'],
		'2.9.7 那一轮:一页都没走通,而日志里一个字都没有 —— 同一个教训不付第二次');
});

test('路径 1.5 的结局分布进了导出 (结构性回归闸, 2.9.9)', () => {
	assert.ok(/textContentPath: this\.extractor\.textContentOutcomes\(\)/.test(read('src/reader/readerSession.ts')),
		'不进导出就等于没量');
});


// ---- 4. 2.10.1: 下伸部必须被盖住 ---------------------------------------------
//
// 真机 2.10.0 的截图:作者名单那种标点密集的段落,原文被遮罩盖住之后,
// **每一行的逗号分号尾巴从遮罩下沿漏出来**,在译文页上留下一片规则排布的小点。
// 遮罩自己的 padding 补不了 —— 它按字号 8% 算、上限 3px,而下伸部约 0.22em,
// 小字号下差一个数量级。错的是矩形,不是遮罩。

test('基线以下留出下伸部,逗号尾巴不会漏出遮罩 (2.10.1)', () => {
	for (const size of [6, 8, 10, 12, 18]) {
		const box = textContentItemRect([size, 0, 0, size, 0, 1000], 100)!;
		const belowBaseline = 1000 - box.rect[1];
		assert.ok(belowBaseline > 0, `${size}pt: 基线以下必须有空间`);
		// 常见正文字体 descent 在 0.20–0.25 em;低于 0.18 就盖不住逗号尾巴。
		assert.ok(belowBaseline / size >= 0.18,
			`${size}pt: 基线以下只有 ${(belowBaseline / size).toFixed(3)} em,盖不住下伸部`);
		// 上限:超过 0.3 em 会吃到上一行的下沿(常见行距 1.15–1.2 em)。
		assert.ok(belowBaseline / size <= 0.3,
			`${size}pt: 基线以下 ${(belowBaseline / size).toFixed(3)} em 太多,会吃到相邻行`);
	}
});

test('下移是沿字高方向,不是一律 -y (2.10.1)', () => {
	// 旋转 180° 的文字:它的「下」是 +y。若写死 -y,盒子会朝错误方向让开,
	// 下伸部照样漏,而上伸部被多盖一截。
	const box = textContentItemRect([-10, 0, 0, -10, 100, 700], 50)!;
	assert.ok(box.rect[3] > 700, '倒置文字的盒子要向 +y 让开');
	assert.ok(Math.abs((box.rect[3] - box.rect[1]) - 10) < 1e-9, '盒高仍是一个 em');
});
