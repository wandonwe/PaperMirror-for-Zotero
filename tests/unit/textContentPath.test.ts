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

test('水平文字: 原点在基线左端,盒子向右上展开 (2.9.7)', () => {
	// 10pt 字,从 (100, 700) 起,advance 50。
	const box = textContentItemRect([10, 0, 0, 10, 100, 700], 50)!;
	assert.deepEqual(box.rect, [100, 700, 150, 710]);
	assert.equal(box.fontSize, 10);
});

test('竖排文字(旋转 90°)不能算成横躺的盒子 (2.9.7 真机页边水印)', () => {
	// 真机上每一页都有一条竖排的 "Downloaded from …" 水印。它的 transform 是旋转的,
	// 若图省事写成 [e, f, e+width, f+height],会得到一个横跨半页的盒子,
	// 把正文全框进去 —— 阅读序和分栏当场被毁。
	const box = textContentItemRect([0, 8, -8, 0, 30, 300], 200)!;
	// 前进方向是 +y,字高方向是 -x:x ∈ [30-8, 30],y ∈ [300, 500]
	assert.deepEqual(box.rect, [22, 300, 30, 500]);
	assert.equal(box.fontSize, 8);
	const [x1, , x2] = box.rect;
	assert.ok(x2 - x1 < 20, '竖排文字的盒子必须是**窄条**,不是横躺的长条');
});

test('缩放为 0 的退化 transform 按水平处理,不丢字 (2.9.7)', () => {
	const box = textContentItemRect([0, 0, 0, 10, 100, 700], 50)!;
	assert.deepEqual(box.rect, [100, 700, 150, 710], '退化时也要给出一个可用的盒子');
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
