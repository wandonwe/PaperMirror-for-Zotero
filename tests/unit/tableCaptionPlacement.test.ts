/**
 * 表题参与原位替换 (2.8.14 真机第 9 页)。
 *
 * ## 真机证据
 *
 * 2.8.12 的语料/诊断把第 9 页钉死了: 整页只抽到**两块** —— 一行表标题和一行
 * 页脚,两块都 `state: translated`(译文早就拿到了),排版却是
 * `{ replaceable: 0, committed: 0, abandoned: 0, tooSmall: 1 }`。
 * 页脚是那个 `tooSmall`;表标题**连计数都没有** —— 它在 `geometric` 过滤那一步
 * 就被 `b.type !== 'table'` 无条件丢掉了,既不是失败也不是保留,凭空消失。
 * 用户看到的是"这页一个字没译"。
 *
 * ## 为什么这个过滤器从一开始就是错的
 *
 * `type === 'table'` 在整个代码库里**只在两处产生**,两处判的都是**标题那一行**:
 *
 *   - `blockBuilder.ts`     : startsWith('table') || /^表/  → 'table' : 'caption'
 *   - `spanBlockBuilder.ts` : /^(table|表)/i                → 'table' : 'caption'
 *
 * 而 `tableGuard.isTableCaptionAnchor` 正是**照这个含义**读它(拿它当标题锚)。
 * 表格**主体**的格子 type 是 paragraph,靠 `tableRow` / `-table-T-rR-cC` 认
 * (`isTableCellBlock`)。也就是说 `type !== 'table'` 挡掉的**只有表题**,
 * 一个表格主体都没挡到 —— 它想保护的东西一个也没保护到,只误伤了表题。
 *
 * 下面第一条测试把这个前提本身钉住: 哪天分类器开始给表格主体发 'table',
 * 这里先红,免得排版端悄悄开始往表格上盖中文。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectInkObstacleBlocks, shrinkStepsFor, allowsFontShrink } from '../../src/ui/strictPageReplacement';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

// ---- 1. 前提: 'table' 只表示表题 --------------------------------------------

test("'table' 类型只在分类【标题行】时产生 —— 表格主体永远不是 'table' (前提闸, 2.8.14)", () => {
	for (const file of ['src/reader/blockBuilder.ts', 'src/reader/spanBlockBuilder.ts']) {
		const src = read(file);
		const sites = [...src.matchAll(/'table'\s*:\s*'caption'/g)];
		assert.equal(sites.length, 1,
			`${file}: 'table' 应当恰好在一处产生,且与 'caption' 二选一 —— 这正是"这一行是不是标题"`);
	}
	// 表格主体的判据是另一套,与 type 无关。
	const strict = read('src/ui/strictPageReplacement.ts');
	assert.ok(/export function isTableCellBlock[\s\S]{0,240}tableRow[\s\S]{0,120}-table-\\d\+-r\\d\+-c\\d\+/.test(strict),
		'表格主体靠 tableRow / 格 id 认,不靠 type —— 这是两条独立的判据');
});

// ---- 2. 表题进替换流水线 ------------------------------------------------------

test('geometric 过滤不再排除表题 (结构性回归闸, 2.8.14)', () => {
	const src = read('src/ui/strictPageReplacement.ts');
	// 2.12.12: 准入收进 selectGeometricBlocks —— "不是**仍保留原文的**参考文献、有可用行矩形"。
	// 允许翻译的参考文献必须进排版(审核第 3 条),否则请求花了钱页面仍是英文。
	const line = src.slice(src.indexOf('const geometric = selectGeometricBlocks(input.blocks)'));
	const decl = line.slice(0, line.indexOf('\n'));
	assert.ok(decl.length > 0, '替换流水线的准入必须走 selectGeometricBlocks');
	const fn = src.slice(src.indexOf('export function selectGeometricBlocks'));
	const body = fn.slice(0, fn.indexOf('\n}'));
	assert.ok(/!isKeptReference\(b\) && !!b\.lineRectsPdf\?\.length/.test(body),
		'准入只剩两条: 不是仍保留原文的参考文献、有可用行矩形');
	assert.ok(!/type !== 'table'/.test(decl),
		"不许退回 `type !== 'table'` —— 它挡掉的只有表题,真机第 9 页整页因此一个字没译");
});

test('表格几何模型的输入维持原样(不含表题) (结构性回归闸, 2.8.14)', () => {
	const src = read('src/ui/strictPageReplacement.ts');
	assert.ok(/const tabular = geometric\.filter\(b => b\.type !== 'table'\);/.test(src),
		'表题不当区域种子、不当单元格成员 —— 它在表框外,进去会撑大区域范围');
	assert.ok(/detectTableRegions\(\s*\n?\s*tabular\.map/.test(src),
		'区域探测喂 tabular,不喂 geometric —— 这一版只放表题进排版,不动表格判定');
	assert.ok(/const members: CellMember\[\] = tabular\b/.test(src),
		'单元格成员也取自 tabular —— 否则表题会被收进某个格子当成员');
	// bodyPt 会喂给 detectTableRegions 的 em: 表题字号掺进中位数就会改变表格判定。
	assert.ok(/const bodySizes = tabular\.filter\(b => b\.translationMode !== 'preserve'\)/.test(src),
		'页面基准字号的样本必须仍取自 tabular,否则表题会经 em 间接改变表格判定');
});

test('表题按图注的最小宽度门槛,而不是正文的 (结构性回归闸, 2.8.14)', () => {
	const src = read('src/ui/strictPageReplacement.ts');
	// 3.0.3: 短标题标签("Purpose:")同样窄,与表题、图注同档(Goenka 2016 p1 实证)。
	// 3.1.3: 门槛改按 PDF 点(28/50px ÷ 1.333),不随面板缩放变。
	assert.ok(/const minWidthPt = \(block\.type === 'caption' \|\| block\.type === 'table' \|\| block\.type === 'heading'\) \? 21 : 37\.5;/.test(src),
		'"Table 3." 这类短标题盒子天然窄,套 50px 正文门槛会当噪声丢掉 —— 而它是整张表唯一能替换的散文');
	assert.ok(/box\.width < minWidthPt \* pxPerPoint \|\| box\.height < 6 \* pxPerPoint/.test(src),
		'宽高门槛都必须乘 pxPerPoint —— 否则窄面板里 7pt 的参考文献行整条被当噪声丢掉 (Goenka 2016 p8)');
});

// ---- 3. 表题的排版待遇与图注一致 ----------------------------------------------

test('表题走孤立块的缩字梯,与图注同档 (2.8.14)', () => {
	assert.deepEqual(shrinkStepsFor('table'), shrinkStepsFor('caption'),
		'表题是页面上的孤立小盒,缩字不会与相邻正文比出「发花」—— 与图注同档');
	assert.notDeepEqual(shrinkStepsFor('table'), shrinkStepsFor('paragraph'),
		'不能落回正文流的两档梯子');
	assert.equal(allowsFontShrink('table'), true, '表题允许缩字');
});

test('表题的行距与图注同一条 CSS 规则 (2.8.14)', () => {
	const css = read('src/ui/styles/translationPane.css');
	assert.ok(/\.pm-repage-block\[data-pm-type="caption"\],\s*\n\.pm-repage-block\[data-pm-type="table"\] \{/.test(css),
		'表题现在会被真的排出来,行距样式要跟上,否则它按正文行距排进一个矮盒里');
});

// ---- 4. 互补性(与 inkObstacles.test.ts 的构造性检查互为补充) ------------------

test('表题不再同时充当墨迹遮挡物 (2.8.14)', () => {
	const rects = [[0, 0, 1, 1]];
	const picked = selectInkObstacleBlocks([
		{ id: 'cap-of-table', isReference: false, type: 'table', lineRectsPdf: rects }
	]);
	assert.deepEqual(picked, [],
		'排版成功的表题若还留在遮挡物名单里,就成了"自己挡自己": 扩边与几何审计会当场判它压盖自己并回退');
	const doc = read('src/ui/strictPageReplacement.ts');
	// 排版失败的表题不能因此失去遮挡 —— 由 `preserved`(进了 geometric 却没成为
	// item 的块)接住,这两处必须都在。
	assert.equal(doc.split('preserved').length - 1 >= 2, true);
	assert.equal((doc.match(/geometric\s*\n?\s*\.filter\(b => !byId\.has\(b\.id\)\)/g) ?? []).length, 2,
		'扩边预校验与末端几何审计两处都要把"没成为 item 的 geometric 块"当遮挡物');
});
