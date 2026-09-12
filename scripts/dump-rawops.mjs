#!/usr/bin/env node
/**
 * 新版 PDF.js 路径编码取证转储 (2.12.9):
 *
 *   node scripts/dump-rawops.mjs <paper.pdf> <页号> <输出名> [pdfjs模块URL]
 *
 * 把一页操作符列表里**与路径有关**的条目原样写成 fixture ——
 * save/restore/transform/constructPath/paintFormXObjectBegin 之外的参数一律置 null,
 * 所以 fixture 里不含任何正文文字,只有几何。
 * 用来给 tableBorders 的单元测试喂真机同形的输入。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [,,file,pageS,outName,modArg] = process.argv;
if (!file || !pageS || !outName) { console.error('用法: dump-rawops.mjs <pdf> <页号> <输出名> [模块URL]'); process.exit(1); }
const mod = modArg ?? 'pdfjs-dist/legacy/build/pdf.mjs';
const { getDocument, OPS } = await import(mod);
const doc = await getDocument({ data:new Uint8Array(readFileSync(file)), useSystemFonts:false }).promise;
const page = await doc.getPage(Number(pageS));
const vp = page.getViewport({ scale: 1 });
const { fnArray, argsArray } = await page.getOperatorList();
const KEEP = new Set([OPS.save, OPS.restore, OPS.transform, OPS.constructPath, OPS.paintFormXObjectBegin]);
const ser = (v) => {
	if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
	if (typeof v.length === 'number') return Array.from(v, ser);
	return null;
};
const out = {
	pdfjs: (await import(mod)).version ?? 'unknown',
	page: Number(pageS), width: vp.width, height: vp.height,
	ops: { constructPath: OPS.constructPath, save: OPS.save, restore: OPS.restore, transform: OPS.transform,
	       moveTo: OPS.moveTo, lineTo: OPS.lineTo, curveTo: OPS.curveTo, closePath: OPS.closePath, rectangle: OPS.rectangle },
	fnArray: Array.from(fnArray),
	argsArray: Array.from(fnArray, (fn,i) => KEEP.has(fn) ? ser(argsArray[i]) : null)
};
const dir = join(root,'tests','fixtures','layout');
mkdirSync(dir,{recursive:true});
const p = join(dir, `${outName}.rawops.json`);
writeFileSync(p, JSON.stringify(out));
console.log(`写出 ${p}  ops=${out.fnArray.length}  constructPath=${out.fnArray.filter(f=>f===OPS.constructPath).length}  pdfjs=${out.pdfjs}`);
