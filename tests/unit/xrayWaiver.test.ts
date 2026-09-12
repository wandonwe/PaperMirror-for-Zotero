import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Xray 穿越纪律的结构闸 (2.12.8)。
 *
 * 这个仓库在 2.9.9 学过一次:Firefox/Zotero 里 chrome 代码看 content 侧的
 * **JS 对象方法**会被 Xray 挡住,`wrappedJSObject`(本仓库的 `waive()`)是唯一
 * 的穿越办法。当时修好的是 `getTextContent` 那条路。
 *
 * 2.12.4 我新写 `getPageEdgesPdf` 时**从 `getImageRectsPdf` 抄了代码** ——
 * 而后者是 2.9.9 **之前**写的、从未补 waive。结果:
 *
 *   - 边框取证连着四个版本(2.12.4~2.12.7)一条线段都没取到;
 *   - 图片矩形很可能从一开始就静默返回空数组(有亮度网格兜底,没人发现);
 *   - 我据此连着两轮下错判断,还把一个从未运行的东西当成了肇事者。
 *
 * 单元测试碰不到真机的 Xray,所以这里锁**源码形态**:凡是走 operator list
 * 的取证函数,window / PDFViewerApplication / pdfDocument / getPage 结果 /
 * getOperatorList 结果 —— 每一跳都必须穿过 waive。抄代码的人下次会被这条拦住。
 */

const src = readFileSync('src/reader/zoteroReaderAdapter.ts', 'utf8');

/** 去掉注释,免得断言命中说明文字而不是真代码。 */
function code(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map(l => l.replace(/\/\/.*$/, ''))
		.join('\n');
}

/** 取出某个导出函数的函数体(到下一个顶层 `export ` 为止)。 */
function bodyOf(name: string): string {
	const all = code(src);
	const start = all.indexOf(`export async function ${name}(`);
	assert.ok(start >= 0, `找不到 ${name}`);
	const rest = all.slice(start + 1);
	const end = rest.indexOf('\nexport ');
	return rest.slice(0, end < 0 ? undefined : end);
}

const OPERATOR_LIST_READERS = ['getImageRectsPdf', 'getPageEdgesPdf'];

for (const fn of OPERATOR_LIST_READERS) {
	test(`${fn}: 每一跳都穿 Xray (2.12.8)`, () => {
		const body = bodyOf(fn);
		assert.ok(body.includes('getOperatorList'),
			`${fn} 应当是走 operator list 的取证函数 —— 若已改名请更新这份清单`);

		// (1) window 必须走 pdfWindow()(它内部 waive),不许直接摸 _iframeWindow。
		assert.ok(body.includes('pdfWindow(reader)'),
			`${fn} 必须用 pdfWindow(reader) 取 window(它内部已 waive)`);
		assert.ok(!/_primaryView\?\.\_iframeWindow/.test(body),
			`${fn} 不许直接访问 _iframeWindow —— 那条路没穿 Xray`);

		// (2) PDFViewerApplication 与 pdfDocument 各自都要 waive。
		assert.ok(/waive\(\s*waive\(\s*win\?\.PDFViewerApplication\s*\)\?\.pdfDocument\s*\)/.test(body),
			`${fn} 的 PDFViewerApplication 与 pdfDocument 必须逐跳 waive`);

		// (3) getPage 的**返回对象**要 waive —— 这正是 2.12.4~2.12.7 栽的那一跳:
		//     pdfDocument.getPage 看得见,它返回的 page 代理上的方法被挡住。
		assert.ok(body.includes('got.page = waive(p)'),
			`${fn} 必须 waive getPage() 的返回对象`);

		// (4) getOperatorList 的返回对象同样要 waive(fnArray/argsArray 是它的属性)。
		assert.ok(body.includes('got.ops = waive(o)'),
			`${fn} 必须 waive getOperatorList() 的返回对象`);

		// (5) OPS 表也在 content 侧。
		assert.ok(/waive\(\s*waive\(win\)\?\.pdfjsLib\s*\)\?\.OPS/.test(body),
			`${fn} 取 OPS 表也要逐跳 waive`);
	});
}

test('waive() 拿不到 wrappedJSObject 时退回原对象 (2.12.8)', () => {
	// 这一层只可能让更多东西可见,不会让已经能用的变得不能用 —— 模块注释里的
	// 承诺,锁住它。
	const all = code(src);
	const start = all.indexOf('function waive<T>(value: T): T {');
	assert.ok(start >= 0, '找不到 waive()');
	const body = all.slice(start, all.indexOf('\n}', start));
	assert.ok(body.includes('?? value'), 'waive 必须在拿不到 wrappedJSObject 时退回原对象');
	assert.ok(body.includes('catch'), 'waive 必须吞掉访问异常 —— 穿不过去不该把调用方带崩');
});
