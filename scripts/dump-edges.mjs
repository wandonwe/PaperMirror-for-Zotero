#!/usr/bin/env node
/**
 * 表格边框取证转储 (2.12.4):
 *
 *   node scripts/dump-edges.mjs <paper.pdf> [页号,默认 1]
 *
 * 用 pdfjs-dist 读**绘图指令**(getOperatorList),把水平/垂直线段与矩形
 * 归一到页面 PDF 用户空间,写成 tests/fixtures/layout/<pdf名>.edges.json ——
 * 与运行时 `getPageEdgesPdf()` 同形的输入,供 tableBorders 的单元测试使用。
 *
 * 与 dump-spans.mjs 成对:spans 给文字,edges 给边框。
 * 只处理本地文件、只写 tests/fixtures/layout/ —— 不联网。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
const pageNo = Number(process.argv[3] ?? 1);
if (!file) {
	console.error('用法: node scripts/dump-edges.mjs <paper.pdf> [页号]');
	process.exit(1);
}

const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { segmentsFromOperatorList } = await import('../build/tableBorders.mjs').catch(() => ({ segmentsFromOperatorList: null }));

const doc = await getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: false }).promise;
const page = await doc.getPage(pageNo);
const viewport = page.getViewport({ scale: 1 });
const ops = await page.getOperatorList();

// 与 src/reader/tableBorders.ts 的 segmentsFromOperatorList 同一套逻辑;
// 这里内联一份,避免转储脚本依赖构建产物。
function dump(fnArray, argsArray, OP) {
	const IDENT = [1, 0, 0, 1, 0, 0];
	const mul = (m, n) => [
		m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
	];
	const app = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
	const out = [];
	let ctm = IDENT;
	const stack = [];
	for (let i = 0; i < fnArray.length; i++) {
		const fn = fnArray[i];
		if (fn === OP.save) { stack.push(ctm); continue; }
		if (fn === OP.restore) { ctm = stack.pop() ?? IDENT; continue; }
		if (fn === OP.transform) { ctm = mul(ctm, argsArray[i]); continue; }
		if (fn !== OP.constructPath) { continue; }
		const [subOps, coords] = argsArray[i];
		let k = 0;
		let cur = null;
		for (const sub of subOps) {
			if (sub === OP.moveTo) { cur = app(ctm, coords[k], coords[k + 1]); k += 2; }
			else if (sub === OP.lineTo) {
				const p = app(ctm, coords[k], coords[k + 1]); k += 2;
				if (cur) { out.push({ x0: cur[0], y0: cur[1], x1: p[0], y1: p[1] }); }
				cur = p;
			}
			else if (sub === OP.curveTo) { k += 6; cur = null; }
			else if (sub === OP.closePath) { /* no coords */ }
			else if (sub === OP.rectangle) {
				const x = coords[k], y = coords[k + 1], w = coords[k + 2], h = coords[k + 3]; k += 4;
				const c = [app(ctm, x, y), app(ctm, x + w, y), app(ctm, x + w, y + h), app(ctm, x, y + h)];
				for (let j = 0; j < 4; j++) {
					const a = c[j], b = c[(j + 1) % 4];
					out.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
				}
			}
			else { k += 2; }
		}
	}
	return out;
}

const segments = dump(ops.fnArray, ops.argsArray, OPS);
const dir = join(root, 'tests', 'fixtures', 'layout');
mkdirSync(dir, { recursive: true });
const name = `${basename(file).replace(/\.pdf$/i, '')}-p${pageNo}.edges.json`;
writeFileSync(join(dir, name), JSON.stringify({
	source: basename(file), page: pageNo,
	pageWidth: viewport.width, pageHeight: viewport.height,
	segments: segments.map(s => [
		Math.round(s.x0 * 100) / 100, Math.round(s.y0 * 100) / 100,
		Math.round(s.x1 * 100) / 100, Math.round(s.y1 * 100) / 100
	])
}));
console.log(`${join(dir, name)}: ${segments.length} 段`);
await doc.destroy();
