/**
 * 真实文献语料对比 (5.0 结构层重构的安全网)。
 *
 *   node scripts/corpus/corpus.mjs --pdfs <dir> --out <dir> [--compare <dir>] [--doc <name>]
 *
 * 1. 用 pdfjs-dist 读每份 PDF 的全部页文本,条目 → 矩形用插件自己的
 *    `textContentItemRect`(与 getTextContentItems 同映射,含旋转)。结果缓存在
 *    <out>/spans/,重跑不再解析 PDF。
 * 2. 按文档顺序对每页跑 `structureSpanPage`(插件里用的就是这一个纯函数),
 *    跨页上下文由 `contextFor` 提供 —— 与插件的取法保持一致。
 * 3. 每页的结构指纹写到 <out>/fp/<doc>.json;给了 --compare 就逐页与基线比对,
 *    打印哪些页的块变了、变成什么。
 *
 * 与插件的已知差异:没有图片障碍物和图例线段(要页面图像)。边框网格默认也不算;
 * 加 --edges 时按算子列表取线段、算网格(5.0 第 5 步:推荐表、带框表格),缓存在
 * <out>/edges/。所以它比较的是**同一输入下两版代码的差异**,不是逐像素复刻真机。
 *
 * 论文 PDF 有版权:语料目录和输出都放在仓库外,不提交。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { structureSpanPage, type SpanPage } from '../../src/reader/pagePipeline';
import { textContentItemRect } from '../../src/reader/zoteroReaderAdapter';
import { isBoldFontName } from '../../src/reader/paragraphHeuristics';
import { buildDocumentStyle, referencesContinueOnto, type DocumentStyle } from '../../src/reader/documentStyle';
import { borderGrid, borderGrids, segmentsFromOperatorList, type BorderGrid, type Segment } from '../../src/reader/tableBorders';

interface DocSpans { doc: string; pages: SpanPage[]; edges?: Segment[][]; weights?: 1 }
const EDGES = process.argv.includes('--edges');
interface BlockPrint { id: string; mode: string; ref: boolean; text: string }
interface PagePrint { page: number; blocks: BlockPrint[] }

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readSpans(pdf: string, cacheDir: string): Promise<DocSpans> {
	const doc = basename(pdf).replace(/\.pdf$/i, '');
	const cache = join(cacheDir, `${doc}.json`);
	if (existsSync(cache)) {
		const cached = JSON.parse(readFileSync(cache, 'utf8')) as DocSpans;
		// 5.1: caches written before font weights were recorded are re-read.
		if (cached.weights) return cached;
	}
	const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const pdfDoc = await getDocument({ data: new Uint8Array(readFileSync(pdf)), useSystemFonts: true, verbosity: 0 }).promise;
	const pages: SpanPage[] = [];
	for (let n = 1; n <= pdfDoc.numPages; n++) {
		const page = await pdfDoc.getPage(n);
		const vp = page.getViewport({ scale: 1 });
		const content = await page.getTextContent();
		// 5.1: bold runs, from the embedded font names — the plugin's adapter does the same.
		await page.getOperatorList();
		const bold = new Set<string>();
		for (const id of new Set((content.items as Array<{ fontName?: string }>).map(i => i.fontName).filter(Boolean) as string[])) {
			try { const f = page.commonObjs.get(id) as { name?: string }; if (f?.name && isBoldFontName(f.name)) bold.add(id); } catch { /* not bound */ }
		}
		const items = [];
		for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number; fontName?: string }>) {
			if (!raw.str?.trim() || !Array.isArray(raw.transform) || typeof raw.width !== 'number') continue;
			const r = textContentItemRect(raw.transform, raw.width);
			if (r) items.push({ text: raw.str, rect: r.rect, fontSize: r.fontSize, ...(raw.fontName && bold.has(raw.fontName) ? { bold: true } : {}) });
		}
		pages.push({ items, pageWidth: vp.width, pageHeight: vp.height });
	}
	const out: DocSpans = { doc, pages, weights: 1 };
	writeFileSync(cache, JSON.stringify(out));
	return out;
}

/** 每页的绘图线段(与插件 getPageEdgesPdf 同一套解析),缓存在 <out>/edges/。 */
async function readEdges(pdf: string, cacheDir: string): Promise<Segment[][]> {
	const doc = basename(pdf).replace(/\.pdf$/i, '');
	const cache = join(cacheDir, `${doc}.json`);
	if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as Segment[][];
	const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const pdfDoc = await getDocument({ data: new Uint8Array(readFileSync(pdf)), useSystemFonts: true, verbosity: 0 }).promise;
	const out: Segment[][] = [];
	for (let n = 1; n <= pdfDoc.numPages; n++) {
		const page = await pdfDoc.getPage(n);
		const ops = await page.getOperatorList();
		out.push(segmentsFromOperatorList(ops.fnArray, ops.argsArray, OPS as unknown as Record<string, number>, 20000));
	}
	writeFileSync(cache, JSON.stringify(out));
	return out;
}

/**
 * 跨页上下文 —— 与插件 TextExtractor 的取法一致(改插件时同步改这里)。
 *   legacy: 5.0 重构前 —— 参考文献靠"前面已抽过的页"累积(这里按顺序翻页,
 *           是旧取法的最好情况),正文字号未知。
 *   style:  全篇样式(documentStyle)给出,与翻页顺序无关。
 */
const CONTEXT = arg('context') ?? 'style';
function contextFor(pageIndex: number, style: DocumentStyle, startedSoFar: boolean) {
	if (CONTEXT === 'legacy') {
		// 正文字号:插件的 prime() 取当前页中位字号,与全篇统计相近 —— 用同一个值,
		// 让对比只反映参考文献范围的变化。
		return { pageIndex, includeReferences: true, referencesAlreadyStarted: startedSoFar, bodyFontSize: style.bodyFontSize };
	}
	return {
		pageIndex,
		includeReferences: true,
		referencesAlreadyStarted: referencesContinueOnto(style, pageIndex),
		bodyFontSize: style.bodyFontSize,
		knownGutters: style.columnGutters,
		referencesStartHere: style.referenceRanges.some(([a]) => a === pageIndex),
		paragraphIndent: style.paragraphIndent,
		furniture: style.furniture
	};
}

function printDoc(spans: DocSpans): PagePrint[] {
	const style = buildDocumentStyle(spans.pages);
	const prints: PagePrint[] = [];
	let started = false;
	spans.pages.forEach((page, pageIndex) => {
		const segs = spans.edges?.[pageIndex];
		const grids: { grid?: BorderGrid | null; grids?: BorderGrid[] } = segs?.length
			? { grid: borderGrid(segs, { pageHeight: page.pageHeight }), grids: borderGrids(segs, { pageHeight: page.pageHeight }) } : {};
		const result = structureSpanPage(page, { ...contextFor(pageIndex, style, started), ...grids });
		started ||= result.referencesStarted;
		prints.push({
			page: pageIndex + 1,
			blocks: result.blocks.map(b => ({
				id: b.id,
				mode: b.translationMode ?? 'translate',
				ref: !!b.isReference,
				text: b.sourceText.replace(/\s+/g, ' ').trim()
			}))
		});
	});
	return prints;
}

function label(b: BlockPrint): string {
	return `${b.mode === 'preserve' ? 'P' : 'T'}${b.ref ? 'R' : ' '} ${JSON.stringify(b.text.length > 110 ? b.text.slice(0, 107) + '…' : b.text)}`;
}

/** 按文本做最长公共子序列,列出删除 / 新增的块。 */
function diffBlocks(a: BlockPrint[], b: BlockPrint[]): string[] {
	const key = (x: BlockPrint) => `${x.mode}|${x.ref}|${x.text}`;
	const n = a.length, m = b.length;
	const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
		dp[i]![j] = key(a[i]!) === key(b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	const out: string[] = [];
	let i = 0, j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && key(a[i]!) === key(b[j]!)) { i++; j++; continue; }
		if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) out.push(`  + ${label(b[j++]!)}`);
		else out.push(`  - ${label(a[i++]!)}`);
	}
	return out;
}

async function main(): Promise<void> {
	const pdfDir = arg('pdfs'), outDir = arg('out'), compareDir = arg('compare'), only = arg('doc');
	if (!pdfDir || !outDir) {
		console.error('usage: node scripts/corpus/corpus.mjs --pdfs <dir> --out <dir> [--compare <dir>] [--doc <name>]');
		process.exit(2);
	}
	mkdirSync(join(outDir, 'spans'), { recursive: true });
	mkdirSync(join(outDir, 'fp'), { recursive: true });
	const pdfs = readdirSync(pdfDir).filter(f => /\.pdf$/i.test(f) && (!only || f.replace(/\.pdf$/i, '') === only)).sort();
	let changedPages = 0, totalPages = 0;
	const summary: string[] = [];
	for (const file of pdfs) {
		const spans = await readSpans(join(pdfDir, file), join(outDir, 'spans'));
		if (EDGES) {
			mkdirSync(join(outDir, 'edges'), { recursive: true });
			spans.edges = await readEdges(join(pdfDir, file), join(outDir, 'edges'));
		}
		const prints = printDoc(spans);
		const st = buildDocumentStyle(spans.pages);
		summary.push(`${spans.doc}: body ${st.bodyFontSize}pt, gutters [${st.columnGutters.join(',')}], indent ${st.paragraphIndent}pt, furniture ${st.furniture.length}, references ${st.referenceRanges.map(([a, b]) => `p${a + 1}–p${b + 1}`).join(', ') || 'none'} of ${st.pageCount}`);
		writeFileSync(join(outDir, 'fp', `${spans.doc}.json`), JSON.stringify(prints, null, 1));
		totalPages += prints.length;
		if (!compareDir) continue;
		const basePath = join(compareDir, 'fp', `${spans.doc}.json`);
		if (!existsSync(basePath)) { summary.push(`${spans.doc}: no baseline`); continue; }
		const base = JSON.parse(readFileSync(basePath, 'utf8')) as PagePrint[];
		let docChanged = 0;
		for (const p of prints) {
			const lines = diffBlocks(base.find(x => x.page === p.page)?.blocks ?? [], p.blocks);
			if (!lines.length) continue;
			docChanged++;
			console.log(`\n=== ${spans.doc} p${p.page}`);
			for (const l of lines) console.log(l);
		}
		changedPages += docChanged;
		summary.push(`${spans.doc}: ${docChanged}/${prints.length} pages changed`);
	}
	console.log(`\n${pdfs.length} documents, ${totalPages} pages${compareDir ? `, ${changedPages} changed` : ''}`);
	for (const s of summary) console.log('  ' + s);
}

void main();
