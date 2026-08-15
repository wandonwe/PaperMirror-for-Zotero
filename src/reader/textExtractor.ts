/**
 * Per-page text extraction.
 *
 * Three independent paths are tried in order, because each can fail on its own
 * for reasons that have nothing to do with the PDF actually lacking text:
 *
 *   1. adapter.getPageData()  — Zotero's PDF.js fork; richest data (break
 *      flags, font names). Can return empty or throw in a system-principal
 *      sandbox for reasons unrelated to the document.
 *   2. rendered text-layer DOM — the spans the user can select with the mouse.
 *      Plain DOM, no wrapper concerns. Structure inferred from geometry.
 *   3. Zotero.PDFWorker.getFullText() — document-level plain text, used mainly
 *      as *evidence* that a text layer exists (it carries no page delimiters,
 *      so per-page attribution is only possible for single-page documents).
 *
 * NO_TEXT_LAYER is reported only when all three agree the document has no
 * extractable text — never because one path came back empty.
 */

import type { SourceBlock } from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { buildBlocks, buildBlocksFromPlainText, medianFontSize } from './blockBuilder';
import { buildBlocksFromSpans } from './spanBlockBuilder';
import { coalesceRegions } from './regionCoalescer';
import { orderBlocksForReading } from './readingOrder';
import { structureTableCells } from './tableStructure';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';
import { validatePageIR, type PageParser } from '../ir/documentIR';

const MODULE = 'textExtractor';

/**
 * Hard ceiling on one getPageData round-trip.
 *
 * The call crosses from the plugin sandbox into the PDF.js worker in the
 * content compartment, and a promise from over there can simply never settle
 * (the same class of problem that made this path return empty on some
 * documents). Left unguarded, the hang holds a scheduler slot forever and the
 * UI spins on 「正在翻译」 indefinitely. On timeout the extractor falls
 * through to the rendered-text-layer path, which is plain DOM and cannot hang.
 */
const PAGE_DATA_TIMEOUT_MS = 8000;

class ExtractTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new ExtractTimeout(`${label} timed out after ${ms} ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

export interface PathReport {
	path: string;
	ok: boolean;
	detail: string;
}

export class TextExtractor implements PageParser {
	private reader: ReaderLike;
	private includeReferences: boolean;
	private referencesStartedByPage = new Map<number, boolean>();
	private fullText: adapter.FullTextInfo | null = null;
	private bodyFontSize = 0;
	/** 边框硬屏障: per-page figure rects (operator list), cached; [] = none. */
	private imageRects = new Map<number, [number, number, number, number][]>();
	/**
	 * PageData captured by prime() for the page open at startup, reused ONCE by
	 * the first extractPage() of that page. Without this, opening the reader
	 * fetches the current page's char stream twice — prime() for the body font
	 * size, then extractPage() for the real work — up to two 8 s round-trips
	 * back to back on a slow PDF. One-shot: cleared on use so a re-translate
	 * always re-reads fresh data.
	 */
	private primedPageData: { pageIndex: number; data: Awaited<ReturnType<typeof adapter.getPageData>> } | null = null;

	constructor(reader: ReaderLike, options: { includeReferences: boolean }) {
		this.reader = reader;
		this.includeReferences = options.includeReferences;
	}

	setIncludeReferences(include: boolean): void {
		if (this.includeReferences !== include) {
			this.includeReferences = include;
		}
	}

	private referencesAlreadyStarted(pageIndex: number): boolean {
		for (const [page, started] of this.referencesStartedByPage) {
			if (page < pageIndex && started) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 分组指标: fragments in → semantic groups out. A normal two-column page
	 * should land at 10–30 translation units, NOT 60–100 line-level shards. When
	 * a fragment-heavy page merges almost nothing (ratio ≈ 1), the coalescer is
	 * not working for this layout — surface it as a warning so the log shows
	 * WHY a page later needs many requests/salvages.
	 */
	private logGrouping(pageIndex: number, sourceBlockCount: number, groupCount: number): void {
		const ratio = sourceBlockCount > 0 ? groupCount / sourceBlockCount : 1;
		logger.info(
			MODULE,
			`Page ${pageIndex + 1} grouping: ${sourceBlockCount} fragment(s) → ${groupCount} unit(s) (ratio ${ratio.toFixed(2)})`
		);
		if (sourceBlockCount >= 40 && ratio > 0.85) {
			logger.warn(
				MODULE,
				`Page ${pageIndex + 1}: ${sourceBlockCount} fragments barely merged (${groupCount} units) — coalescer ineffective for this layout`
			);
		}
	}

	/**
	 * getPageData for a page, reusing prime()'s one-shot capture for the page it
	 * primed so the current page is never fetched twice on open.
	 */
	private async getPageData(pageIndex: number): Promise<Awaited<ReturnType<typeof adapter.getPageData>>> {
		if (this.primedPageData && this.primedPageData.pageIndex === pageIndex) {
			const cached = this.primedPageData.data;
			this.primedPageData = null; // one-shot: re-translate must re-read fresh
			return cached;
		}
		return withTimeout(
			adapter.getPageData(this.reader, pageIndex),
			PAGE_DATA_TIMEOUT_MS,
			`getPageData(page ${pageIndex + 1})`
		);
	}

	/** Figure rects for a page (best-effort, cached; never throws). */
	private async obstaclesFor(pageIndex: number): Promise<[number, number, number, number][]> {
		const cached = this.imageRects.get(pageIndex);
		if (cached) {
			return cached;
		}
		let rects: [number, number, number, number][] = [];
		try {
			const got = await withTimeout(adapter.getImageRectsPdf(this.reader, pageIndex), 2500, 'getImageRectsPdf');
			rects = got ?? [];
		}
		catch {
			// best-effort: no obstacles = old behavior
		}
		this.imageRects.set(pageIndex, rects);
		return rects;
	}

	/**
	 * IR 不变量审计 — log-only(1.1.0 目标架构第 1 步)。违例绝不改变行为,
	 * 只让"某个隐式不变量被搬丢了"这类回归在日志里立刻可见,而不是等到
	 * 字段 bug。契约本身由 validatePageIR 的单测保证;这里是运行期烟雾探测。
	 */
	private auditIR(pageIndex: number, blocks: SourceBlock[]): void {
		try {
			const violations = validatePageIR({ pageIndex, blocks });
			if (violations.length) {
				logger.warn(
					MODULE,
					`Page ${pageIndex + 1} IR violations (${violations.length}): `
					+ violations.slice(0, 5).map(v => `${v.invariant}[${v.blockId ?? '-'}] ${v.detail}`).join('; ')
					+ (violations.length > 5 ? ' …' : '')
				);
			}
		}
		catch (e) {
			logger.debug(MODULE, 'IR audit itself failed (ignored)', e);
		}
	}

	async extractPage(pageIndex: number): Promise<SourceBlock[]> {
		// 边框硬屏障: real figure boundaries participate in extraction — in-figure
		// labels stay out of the flow, and nothing merges across a figure.
		const obstacles = await this.obstaclesFor(pageIndex);
		// --- path 1: the fork's char stream (best structure) -----------------
		try {
			const { pageData, pageWidth, pageHeight } = await this.getPageData(pageIndex);
			// 扫描件/坏字体页检测 (参照 BabelDOC midend/detect_scanned_file.py 的
			// 思想): char 流大半是未解码的 (cid:N) 时,buildBlocks 只会产出乱码
			// 块并送去翻译烧请求 —— 按"无可用文本"处理,落到文本层路径,那边
			// 拿到的是 PDF.js 真正渲染出的字符。
			if (pageData.chars.length >= 10) {
				const cid = pageData.chars.filter(c => (c.c ?? '').startsWith('(cid:')).length;
				if (cid / pageData.chars.length > 0.6) {
					logger.warn(MODULE, `Page ${pageIndex + 1}: ${cid}/${pageData.chars.length} chars are undecoded (cid:) — treating char stream as unusable`);
					pageData.chars = [];
				}
			}
			if (pageData.chars.length) {
				const result = buildBlocks(pageData.chars, {
					pageIndex,
					pageWidth,
					pageHeight,
					bodyFontSize: this.bodyFontSize || undefined,
					includeReferences: this.includeReferences,
					referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex),
					imageRectsPdf: obstacles
				});
				const sourceBlockCount = result.blocks.length;
				// Canonical reading order BEFORE coalescing: row-wise streams
				// interleave the columns, and the coalescer only merges adjacent
				// blocks — without this, one-line shreds never rejoin.
				const structured = structureTableCells(orderBlocksForReading(result.blocks), pageIndex, this.bodyFontSize || 10);
				const tableCells = structured.filter(b => b.translationMode !== undefined);
				const prose = coalesceRegions(structured.filter(b => b.translationMode === undefined), obstacles);
				result.blocks = orderBlocksForReading([...prose, ...tableCells]);
				this.logGrouping(pageIndex, sourceBlockCount, result.blocks.length);
				if (result.blocks.length) {
					this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
					this.auditIR(pageIndex, result.blocks);
					return result.blocks;
				}
			}
			logger.debug(MODULE, `getPageData returned no usable text for page ${pageIndex}; trying the text layer`);
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'PDF_ENCRYPTED') {
				throw e;
			}
			logger.warn(MODULE, `getPageData path failed for page ${pageIndex}; trying the text layer`, e);
		}

		// --- path 2: the rendered text layer (what the user can select) ------
		const spanBlocks = await this.extractFromTextLayer(pageIndex, obstacles);
		if (spanBlocks && spanBlocks.length) {
			return spanBlocks;
		}

		// --- path 3: PDFWorker plain text ------------------------------------
		const pageText = await this.fullTextForPage(pageIndex);
		if (pageText.trim()) {
			const result = buildBlocksFromPlainText(pageText, pageIndex, {
				includeReferences: this.includeReferences,
				referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex)
			});
			this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
			return result.blocks;
		}

		// Nothing on this page. Only call it a scanned PDF if the WHOLE document
		// has no extractable text — a figure-only page is perfectly normal.
		if (await this.documentHasText(pageIndex)) {
			return [];
		}
		throw new PaperMirrorError('NO_TEXT_LAYER', 'This PDF has no text layer and needs OCR.');
	}

	/**
	 * Current-page recovery path. It deliberately skips getPageData and
	 * PDFWorker so a timed-out worker request is never duplicated.
	 */
	async extractRenderedPage(pageIndex: number): Promise<SourceBlock[]> {
		const blocks = await this.extractFromTextLayer(pageIndex, await this.obstaclesFor(pageIndex));
		return blocks ?? [];
	}

	/** Build blocks from the rendered PDF.js text layer, if there is one. */
	private async extractFromTextLayer(pageIndex: number, obstacles: [number, number, number, number][] = []): Promise<SourceBlock[] | null> {
		try {
			if (!adapter.hasRenderedTextLayer(this.reader, pageIndex)) {
				await adapter.waitForTextLayer(this.reader, pageIndex);
			}
			const page = adapter.getTextLayerItems(this.reader, pageIndex);
			if (!page || !page.items.length) {
				return null;
			}
			const result = buildBlocksFromSpans(page.items, {
				pageIndex,
				pageHeight: page.pageHeight,
				pageWidth: page.pageWidth,
				includeReferences: this.includeReferences,
				referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex),
				imageRectsPdf: obstacles
			});
			// Rebuild semantic regions from whatever fragments extraction
			// produced: whole regions translate as whole sentences.
			const sourceBlockCount = result.blocks.length;
			const structured = structureTableCells(orderBlocksForReading(result.blocks), pageIndex, this.bodyFontSize || 10);
			const tableCells = structured.filter(b => b.translationMode !== undefined);
			const prose = coalesceRegions(structured.filter(b => b.translationMode === undefined), obstacles);
			result.blocks = orderBlocksForReading([...prose, ...tableCells]);
			this.logGrouping(pageIndex, sourceBlockCount, result.blocks.length);
			this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
			logger.info(MODULE, `Page ${pageIndex + 1}: extracted ${result.blocks.length} block(s) from the text layer`);
			this.auditIR(pageIndex, result.blocks);
			return result.blocks;
		}
		catch (e) {
			logger.warn(MODULE, `Text-layer extraction failed for page ${pageIndex}`, e);
			return null;
		}
	}

	private async loadFullText(): Promise<adapter.FullTextInfo | null> {
		if (this.fullText) {
			return this.fullText;
		}
		const itemID = this.reader.itemID;
		if (!itemID) {
			return null;
		}
		try {
			this.fullText = await withTimeout(
				adapter.getFullTextInfo(itemID),
				PAGE_DATA_TIMEOUT_MS * 2,
				'PDFWorker.getFullText'
			);
			return this.fullText;
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'PDF_ENCRYPTED') {
				throw e;
			}
			logger.warn(MODULE, 'PDFWorker full text unavailable', e);
			return null;
		}
	}

	/**
	 * PDFWorker text for one page. Zotero returns the document as ONE string
	 * with no page delimiter, so this can only serve single-page documents;
	 * for anything longer it returns '' and the caller relies on paths 1–2.
	 */
	private async fullTextForPage(pageIndex: number): Promise<string> {
		const info = await this.loadFullText();
		if (!info || !info.text.trim()) {
			return '';
		}
		const pageCount = info.totalPages || adapter.getPageCount(this.reader);
		if (pageCount <= 1) {
			return pageIndex === 0 ? info.text : '';
		}
		return '';
	}

	/**
	 * Does this document have ANY extractable text? Checks the PDFWorker text
	 * first (cheap, whole-document), then samples a couple of other pages
	 * through paths 1 and 2 before concluding the PDF is scanned.
	 */
	private async documentHasText(originPage: number): Promise<boolean> {
		const info = await this.loadFullText();
		if (info && info.text.trim().length > 0) {
			return true;
		}
		const count = adapter.getPageCount(this.reader);
		const samples = [0, Math.floor(count / 2), count - 1]
			.filter(p => p >= 0 && p < count && p !== originPage)
			.filter((p, i, a) => a.indexOf(p) === i)
			.slice(0, 2);
		for (const page of samples) {
			if (adapter.hasRenderedTextLayer(this.reader, page)) {
				return true;
			}
			try {
				const { pageData } = await withTimeout(
					adapter.getPageData(this.reader, page),
					PAGE_DATA_TIMEOUT_MS,
					`getPageData(sample ${page + 1})`
				);
				if (pageData.chars.length > 10) {
					return true;
				}
			}
			catch {
				// treat as empty
			}
		}
		return false;
	}

	/** Per-path report for the 「诊断」 command — no document text is logged. */
	async diagnose(pageIndex: number): Promise<PathReport[]> {
		const reports: PathReport[] = [];
		try {
			const { pageData, pageWidth, pageHeight } = await withTimeout(
				adapter.getPageData(this.reader, pageIndex),
				PAGE_DATA_TIMEOUT_MS,
				'getPageData'
			);
			reports.push({
				path: 'getPageData',
				ok: pageData.chars.length > 0,
				detail: `${pageData.chars.length} chars, page ${Math.round(pageWidth)}×${Math.round(pageHeight)}pt`
			});
		}
		catch (e) {
			reports.push({ path: 'getPageData', ok: false, detail: e instanceof Error ? e.message : String(e) });
		}
		try {
			const rendered = adapter.hasRenderedTextLayer(this.reader, pageIndex);
			const page = adapter.getTextLayerItems(this.reader, pageIndex);
			reports.push({
				path: 'textLayerDOM',
				ok: !!page && page.items.length > 0,
				detail: page
					? `${page.items.length} spans, page ${Math.round(page.pageWidth)}×${Math.round(page.pageHeight)}pt`
					: `no spans (rendered=${rendered})`
			});
		}
		catch (e) {
			reports.push({ path: 'textLayerDOM', ok: false, detail: e instanceof Error ? e.message : String(e) });
		}
		try {
			const info = await this.loadFullText();
			reports.push({
				path: 'PDFWorker',
				ok: !!info && info.text.trim().length > 0,
				detail: info
					? `${info.text.length} chars over ${info.extractedPages}/${info.totalPages} pages (no page delimiters)`
					: 'unavailable'
			});
		}
		catch (e) {
			reports.push({ path: 'PDFWorker', ok: false, detail: e instanceof Error ? e.message : String(e) });
		}
		return reports;
	}

	/** Establish the document body font size from the current page (lazy). */
	async prime(): Promise<void> {
		if (this.bodyFontSize > 0) {
			return;
		}
		const pageIndex = adapter.getCurrentPageIndex(this.reader);
		try {
			const result = await withTimeout(
				adapter.getPageData(this.reader, pageIndex),
				PAGE_DATA_TIMEOUT_MS,
				'getPageData(prime)'
			);
			// Keep the char stream so the first extractPage() of this page reuses
			// it instead of paying for a second round-trip.
			this.primedPageData = { pageIndex, data: result };
			const sizes = result.pageData.chars
				.filter(c => typeof c.fontSize === 'number' && !c.ignorable)
				.map(c => c.fontSize as number)
				.sort((a, b) => a - b);
			if (sizes.length) {
				this.bodyFontSize = sizes[Math.floor(sizes.length / 2)] ?? 0;
				return;
			}
		}
		catch {
			// priming is best-effort
		}
		try {
			const page = adapter.getTextLayerItems(this.reader, pageIndex);
			const sizes = (page?.items ?? [])
				.map(i => i.fontSize ?? 0)
				.filter(s => s > 0)
				.sort((a, b) => a - b);
			if (sizes.length) {
				this.bodyFontSize = sizes[Math.floor(sizes.length / 2)] ?? 0;
			}
		}
		catch {
			// best-effort
		}
	}
}

export { medianFontSize };
