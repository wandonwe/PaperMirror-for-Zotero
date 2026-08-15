#!/usr/bin/env node
/**
 * 布局回归语料转储 (1.1.2, 无 BabelDOC 的回归测试集方案):
 *
 *   node scripts/dump-spans.mjs <paper.pdf> [pageList]
 *   e.g. node scripts/dump-spans.mjs radiology.pdf 3,7
 *
 * 用 pdfjs-dist 提取指定页(默认全部,上限 10 页)的文本 span,写成
 * tests/fixtures/layout/<pdf名>-p<页>.spans.json —— 与阅读器文本层路径
 * (extractFromTextLayer → buildBlocksFromSpans) 同形的输入。之后
 * tests/integration/layoutSnapshot.test.ts 会对每个 *.spans.json 跑完整纯
 * 函数流水线并与 .snapshot.json 对比;首跑自动生成快照,改动后有意的
 * 布局差异 → 删掉旧快照重新生成并在 PR 里审阅 diff。
 *
 * 只处理本地文件、只写 tests/fixtures/layout/ —— 不联网,不碰正文以外内容。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [, , pdfPath, pageList] = process.argv;
if (!pdfPath) {
	console.error('usage: node scripts/dump-spans.mjs <paper.pdf> [pages e.g. 1,3,7]');
	process.exit(1);
}

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const data = new Uint8Array(readFileSync(pdfPath));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
const wanted = pageList
	? pageList.split(',').map(n => Number(n.trim())).filter(n => n >= 1 && n <= doc.numPages)
	: Array.from({ length: Math.min(doc.numPages, 10) }, (_, i) => i + 1);

const outDir = join(root, 'tests', 'fixtures', 'layout');
mkdirSync(outDir, { recursive: true });
const stem = basename(pdfPath).replace(/\.pdf$/i, '').replace(/[^\w-]+/g, '_');

for (const pageNo of wanted) {
	const page = await doc.getPage(pageNo);
	const viewport = page.getViewport({ scale: 1 });
	const content = await page.getTextContent();
	const items = [];
	for (const item of content.items) {
		if (!('str' in item) || !item.str.trim()) {
			continue;
		}
		// transform = [a,b,c,d,e,f]; e/f = baseline origin (PDF user space,
		// bottom-origin). Rect 与阅读器文本层同形: [x1, y1, x2, y2] PDF 坐标。
		const [a, b, , , e, f] = item.transform;
		const fontSize = Math.hypot(a, b) || undefined;
		items.push({
			text: item.str,
			rect: [e, f, e + (item.width || 0), f + (item.height || fontSize || 10)],
			...(fontSize ? { fontSize } : {})
		});
	}
	const out = {
		source: basename(pdfPath),
		page: pageNo,
		pageWidth: viewport.width,
		pageHeight: viewport.height,
		items
	};
	const file = join(outDir, `${stem}-p${pageNo}.spans.json`);
	writeFileSync(file, JSON.stringify(out));
	console.log(`${file}: ${items.length} span(s)`);
}
process.exit(0);
