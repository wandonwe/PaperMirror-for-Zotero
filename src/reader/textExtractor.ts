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

import { hashSourceTexts } from '../cache/cacheSchema';
import { failureKind } from '../export/jsonlWriter';
import type { SourceBlock } from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { buildBlocks, buildBlocksFromPlainText, medianFontSize } from './blockBuilder';
import { buildBlocksFromSpans } from './spanBlockBuilder';
import { coalesceRegions } from './regionCoalescer';
import { borderGrid, borderGrids, columnOfX, rowOfTop, type BorderGrid } from './tableBorders';
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

/**
 * 这一页的块最终是**哪条抽取路径**产出的 (2.8.5, 导出方案 P0)。
 *
 * 三条路径拿到的东西差别很大: `chars` 有断行标记与字体名,`text-layer` 只有
 * 渲染出来的 span 矩形,`plain-text` 连坐标都没有。导出诊断/语料时如果不知道
 * 当时走的是哪条,任何"重新解析 spans 再比对"的核对都说不清 —— 重建走的可能
 * 压根不是同一条路径,不匹配也无从判断是排版变了还是路径变了。
 *
 * 只记枚举,不记内容。
 */
export type ExtractPath = 'chars' | 'text-content' | 'text-layer' | 'plain-text' | 'rendered-recovery' | 'empty';
//                                  ^^^^^^^^^^^^^^ 2.9.7: 标准 PDF.js `getTextContent()`
// —— **不依赖这一页有没有被渲染**。与 `text-layer` 的区别正在这里:后者读的是 DOM,
// 而 DOM 只对 PDF.js 正在渲染的那几页存在;这一条走 worker 的解析结果,任何页随时可读。
// (声明写成单行不是随意: diagnosticsPrivacy 的枚举闸要能一眼扫完这个联合类型。)

/**
 * 一次抽取所依赖的**跨页累积 / 可中途改变**的输入 (2.8.7, 导出方案 P2 · 方案 §1.2)。
 *
 * 语料导出要在会话末尾重新解析每一页,再和留存结构比对。但下面这几项在两次解析
 * 之间可能已经不同了 —— 那样比出来的差异是自己制造的,比对结论也就不作数:
 *
 *   - `bodyFontSize`: 文档级正文字号估计,prime() 之后才有值,首页可能是 0;
 *   - `referencesAlreadyStarted`: 跨页累积的"前面是否已进参考文献";
 *   - `includeReferences` / 不译词表: 用户首选项,可中途改;
 *   - `path`: 运行时择路(含 `(cid:` 未解码比例的启发式),重解析可能走上另一条。
 *
 * 所以抽取时把它们记下来,导出时逐项比对 —— 有任一项变了,结构比对结论必须是
 * `unverifiable`,**哪怕逐项全等**。不译词表只记哈希,不记词表本身。
 */
export interface ExtractInputs {
	path?: ExtractPath;
	bodyFontSize: number;
	includeReferences: boolean;
	referencesAlreadyStarted: boolean;
	noTranslateHash: string;
}

/**
 * 一次抽取的分段耗时 (2.8.15)。
 *
 * 为什么要分段: 真机 30 页里 15 页的 `extractMs` 在 0.8–2.6 秒,而这些页
 * **一次请求都没发**(`requests: 0, fromCache: true`)—— 用户感到的"越翻越慢"
 * 落在抽取里,不在网络上。可 `extractMs` 是个总数,回答不了"等在哪":
 *
 *   - `charsPathMs`   路径 1(fork 的 char 流)整趟。本文档 30/30 页最终都落到
 *                     text-layer,说明这趟**每次都白跑** —— 它到底多贵,要量;
 *   - `textLayerWaitMs` 等 PDF.js 把文本层渲染稳定的纯等待;
 *   - `textLayerMs`   路径 2 整趟(含上面那段等待 + 建块);
 *   - `plainTextMs`   路径 3(PDFWorker 全文)。
 *
 * 同一条路最快的页只要 14 ms,所以那 2.6 秒是**等**,不是算。三个数字把
 * "等 PDFWorker"与"等文本层渲染"分开 —— 不分开就只能猜。
 */
export interface ExtractPhases {
	obstaclesMs: number;
	/**
	 * 2.12.6 边框取证的可观测性。上一版把网格接进了建格却**没有任何遥测**,
	 * 真机上一页只剩 3 个格时我拿不出证据说明运行时到底算出了什么网格 ——
	 * 于是这一版把网格降回"只观测、不参与建格",先把这几个数导出来。
	 */
	/** 这一页取到的线段数;0 = 没有绘图证据(或取数失败)。 */
	edgeSegments?: number;
	/** 操作符总数 —— 0 说明压根没拿到绘图指令,与"拿到了但认不出"是两回事。 */
	edgeOps?: number;
	/** 按操作符码认出的路径数。 */
	edgeByCode?: number;
	/** 码认不出、靠参数形状认出来的路径数 —— >0 说明内置码表与运行时不一致。 */
	edgeByShape?: number;
	/** 子操作映射不平而被跳过的路径数 —— >0 说明子操作码也对不上。 */
	edgeSkipped?: number;
	/** 是否拿到了运行时真实的 OPS 表(false = 用的内置默认码)。 */
	edgeRealOps?: boolean;
	/**
	 * 码对上了、可参数形状两种编码都不认识的条数 (2.12.9)。
	 *
	 * 2.12.8 缺的就是这一笔:那时候这种情况在计数前被 continue 掉,遥测里
	 * `edgeByCode` 恒为 0,把"参数形状变了"读成了"操作符码错了",方向整个反了。
	 */
	edgeShapeUnknown?: number;
	/** 用新版(pdf.js 5.3+ 扁平指令流)编码解出来的路径数 (2.12.9)。 */
	edgeNewShape?: number;
	/** 收尾是 endPath、一个像素都不画的路径数 —— 裁剪路径 (2.12.10)。 */
	edgeUnpainted?: number;
	/** 这一页推出的网格张数;结构识别目前只接格数最多的那一张 (2.12.10)。 */
	gridCount?: number;
	/**
	 * 2.12.8: 这一页取到的**图片矩形**数。同样是"从未被观测过"的东西 ——
	 * getImageRectsPdf 与边框取证是同一段未 waive 的代码,极可能一直静默返回
	 * 空数组,图表屏障一路靠亮度网格兜底。补上 waive 之后这个数应该从 0 变正。
	 */
	imageRects?: number;
	/** 推出的列数(边界数 - 1);-1 = 推不出网格。 */
	gridCols?: number;
	/** 推出的行数(边界数 - 1);-1 = 推不出网格。 */
	gridRows?: number;
	/** 网格外框,四舍五入到整点: [left, top, right, bottom]。 */
	gridRegion?: [number, number, number, number];
	/** 落在网格内的块数 —— 与总块数一起看才知道网格是不是套对了地方。 */
	gridInside?: number;
	/** 取网格耗时。 */
	gridMs?: number;
	charsPathMs: number;
	/** 2.9.7: 标准 PDF.js `getTextContent()` 整趟 —— 不依赖渲染的那条路。 */
	textContentMs?: number;
	textLayerMs: number;
	textLayerWaitMs?: number;
	plainTextMs: number;
	buildMs: number;
}

export class TextExtractor implements PageParser {
	private reader: ReaderLike;
	private includeReferences: boolean;
	private referencesStartedByPage = new Map<number, boolean>();
	private fullText: adapter.FullTextInfo | null = null;
	private bodyFontSize = 0;
	/** 边框硬屏障: per-page figure rects (operator list), cached; [] = none. */
	private imageRects = new Map<number, [number, number, number, number][]>();
	/** 逐页边框网格缓存;undefined = 还没取过,null = 取过但这页没有网格。 */
	private borderGrids = new Map<number, BorderGrid | null>();
	private allBorderGrids = new Map<number, BorderGrid[]>();
	/** 网格取证的计数,随网格一起缓存 (2.12.14):重抽取时从缓存拿网格,遥测也得跟着回填 ——
	 *  真机 2.12.13 的 p12–18 就是这样:gridInside 有值,edgeSegments/gridCols 全空。 */
	private gridPhases = new Map<number, Partial<ExtractPhases>>();
	/**
	 * PageData captured by prime() for the page open at startup, reused ONCE by
	 * the first extractPage() of that page. Without this, opening the reader
	 * fetches the current page's char stream twice — prime() for the body font
	 * size, then extractPage() for the real work — up to two 8 s round-trips
	 * back to back on a slow PDF. One-shot: cleared on use so a re-translate
	 * always re-reads fresh data.
	 */
	private primedPageData: { pageIndex: number; data: Awaited<ReturnType<typeof adapter.getPageData>> } | null = null;

	/** 2.7.8: 用户不译词表读取器 —— 表格短格的 glossary 不译证据来源。 */
	private readonly noTranslate: () => string[];

	/** 2.8.5: 每页最终走通的抽取路径。只在**返回块的那一刻**写入。 */
	private pathByPage = new Map<number, ExtractPath>();
	/** 2.8.7: 每页抽取当时的可变输入快照,导出核对结构一致性时用。 */
	private inputsByPage = new Map<number, Omit<ExtractInputs, 'path'>>();
	/** 2.8.15: 每页最近一次抽取的分段耗时 —— 回答"抽取等在哪一段"。 */
	private phasesByPage = new Map<number, ExtractPhases>();
	/**
	 * 路径 1(fork 的 char 流)每页的结局,按枚举计数 (2.9.5)。
	 *
	 * 真机第七轮:`charsPathMs` 整轮 **80 ms / 85 页**,约 **1 ms 一页** ——
	 * PDFWorker 的 RPC 往返不可能这么快,这不是"慢",是**立刻失败或立刻返回空**。
	 * 而路径 1 是唯一**不依赖页面渲染**的抽取方式:它若能用,整条"等文本层渲染"
	 * 的时序难题(2.9.0–2.9.4 五个版本都在绕它)就从根上绕过去了。
	 * 所以它为什么不出活是眼下最值得问的问题,而现有日志一个字都没有。
	 *
	 * 只记枚举与计数,不含页码以外的任何内容。
	 */
	private charsOutcome = new Map<string, number>();

	private noteCharsOutcome(pageIndex: number, outcome: string | null): void {
		this.noteOutcome(this.charsOutcome, this.charsNoted, pageIndex, outcome);
	}

	/**
	 * 路径 1.5(`getTextContent`)每页的结局 (2.9.9)。
	 *
	 * 2.9.7 上线后 `extractPath` **一次 `text-content` 都没有**,而
	 * `textContentMs` 整轮只有 **5 ms / 21 页** —— 跟当初 `charsPathMs` 一模一样的
	 * 症状:立刻返回空,而日志里一个字都没有。同一个教训要付两次就太贵了。
	 */
	private textContentOutcome = new Map<string, number>();
	private textContentNoted = new Set<number>();

	/** 一页只记第一个结论 —— 同一页被反复抽取时不该把分布压歪。 */
	private noteOutcome(into: Map<string, number>, seen: Set<number>, pageIndex: number, outcome: string | null): void {
		if (!outcome || seen.has(pageIndex)) {
			return;
		}
		seen.add(pageIndex);
		into.set(outcome, (into.get(outcome) ?? 0) + 1);
	}

	/** 路径 1.5 的结局分布 (2.9.9) —— 纯枚举计数。 */
	textContentOutcomes(): Record<string, number> {
		return Object.fromEntries([...this.textContentOutcome.entries()].sort((a, b) => b[1] - a[1]));
	}

	private charsNoted = new Set<number>();

	/** 路径 1 的结局分布 (2.9.5) —— 纯枚举计数。 */
	charsPathOutcomes(): Record<string, number> {
		return Object.fromEntries([...this.charsOutcome.entries()].sort((a, b) => b[1] - a[1]));
	}

	/**
	 * **出路探针** (2.9.6): 标准 PDF.js 的 `getPage(n).getTextContent()` 在不在。
	 *
	 * 它是公开 API(不是 fork 的私有 `getPageData`),而且**同样不依赖页面渲染**
	 * —— 文本层本身就是用它渲出来的。若可用,2.9.0–2.9.5 六个版本一直在绕的
	 * 「文本层只对渲染着的页存在」就有了从根上绕开的办法。同步,不发 RPC。
	 */
	textContentApiState(): string {
		return adapter.probeTextContentApi(this.reader);
	}

	constructor(reader: ReaderLike, options: { includeReferences: boolean; noTranslate?: () => string[] }) {
		this.reader = reader;
		this.includeReferences = options.includeReferences;
		this.noTranslate = options.noTranslate ?? (() => []);
	}

	private noTranslateSafe(): string[] {
		try {
			return this.noTranslate();
		}
		catch {
			return [];
		}
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
		const phases = this.phasesByPage.get(pageIndex);
		if (phases) {
			phases.imageRects = rects.length;
		}
		return rects;
	}

	/**
	 * 这一页的表格边框网格 (2.12.5),best-effort、逐页缓存、绝不抛。
	 *
	 * 拿不到就是 null,structureTableCells 照旧走文字几何 —— 绝大多数页面
	 * 本来就没有表格线,行为与 2.12.4 逐字节一致。超时是硬上限:取证不该
	 * 拖慢翻译。
	 */
	private async gridFor(pageIndex: number, pageHeight: number): Promise<BorderGrid | null> {
		const cached = this.borderGrids.get(pageIndex);
		if (cached !== undefined) {
			const phases = this.phasesByPage.get(pageIndex);
			const saved = this.gridPhases.get(pageIndex);
			if (phases && saved) { Object.assign(phases, saved); }
			return cached;
		}
		const started = Date.now();
		let grid: BorderGrid | null = null;
		let gridCount = 0;
		let segCount = 0;
		try {
			const segs = await withTimeout(adapter.getPageEdgesPdf(this.reader, pageIndex), 3000, 'getPageEdgesPdf');
			segCount = segs?.length ?? 0;
			if (segs && segs.length) {
				grid = borderGrid(segs, { pageHeight });
				const all = borderGrids(segs, { pageHeight });
				this.allBorderGrids.set(pageIndex, all);
				gridCount = all.length;
			}
		}
		catch {
			// best-effort: 没有边框证据 = 老行为
		}
		const phases = this.phasesByPage.get(pageIndex);
		if (phases) {
			phases.gridMs = (phases.gridMs ?? 0) + (Date.now() - started);
			phases.edgeSegments = segCount;
			const scan = adapter.lastEdgeScanStats();
			if (scan) {
				phases.edgeOps = scan.ops;
				phases.edgeByCode = scan.byCode;
				phases.edgeByShape = scan.byShape;
				phases.edgeSkipped = scan.skipped;
				phases.edgeRealOps = scan.realOps;
				phases.edgeShapeUnknown = scan.shapeUnknown;
				phases.edgeNewShape = scan.newShape;
				phases.edgeUnpainted = scan.unpainted;
			}
			phases.gridCount = gridCount;
			phases.gridCols = grid ? grid.columns.length - 1 : -1;
			phases.gridRows = grid ? grid.rows.length - 1 : -1;
			if (grid) {
				phases.gridRegion = [
					Math.round(grid.region.left), Math.round(grid.region.top),
					Math.round(grid.region.left + grid.region.width), Math.round(grid.region.top + grid.region.height)
				];
			}
		}
		if (grid) this.borderGrids.set(pageIndex, grid);
		{
			const phases = this.phasesByPage.get(pageIndex);
			if (phases) {
				const keys = ['gridMs', 'edgeSegments', 'edgeOps', 'edgeByCode', 'edgeByShape', 'edgeSkipped', 'edgeRealOps',
					'edgeShapeUnknown', 'edgeNewShape', 'edgeUnpainted', 'gridCount', 'gridCols', 'gridRows', 'gridRegion'] as const;
				const saved: Partial<ExtractPhases> = {};
				for (const k of keys) { if (phases[k] !== undefined) { (saved as Record<string, unknown>)[k] = phases[k]; } }
				this.gridPhases.set(pageIndex, saved);
			}
		}
		return grid;
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
		// 2.8.7: 先把这次抽取实际依赖的可变输入拍下来 —— 事后重解析时逐项比对,
		// 变了就把结构比对结论降为 unverifiable,不拿"碰巧相等"当证据。
		this.inputsByPage.set(pageIndex, this.currentExtractInputs(pageIndex));
		// 2.8.15: 分段计时。真机 30 页里有 15 页 `extractMs` 在 0.8–2.6 秒,而这些页
		// **一次接口请求都没发**(requests:0, fromCache:true)—— 用户感到的"翻到后面
		// 越来越慢"落在抽取里,不在网络上。但 `extractMs` 是个总数,分不清等在哪:
		// 是 getPageData 这趟 PDFWorker 往返(本文档 30/30 页都落到 text-layer,
		// 说明这趟每次都白跑),还是文本层就绪轮询。同一条路最快的页只要 14 ms,
		// 所以那 2.6 秒是**等**,不是算 —— 到底等谁,这三个数字才回答得了。
		const t0 = Date.now();
		const phases: ExtractPhases = { obstaclesMs: 0, charsPathMs: 0, textContentMs: 0, textLayerMs: 0, plainTextMs: 0, buildMs: 0 };
		this.phasesByPage.set(pageIndex, phases);
		// 边框硬屏障: real figure boundaries participate in extraction — in-figure
		// labels stay out of the flow, and nothing merges across a figure.
		const obstacles = await this.obstaclesFor(pageIndex);
		phases.obstaclesMs = Date.now() - t0;
		// --- path 1: the fork's char stream (best structure) -----------------
		const charsStartedAt = Date.now();
		try {
			const { pageData, pageWidth, pageHeight } = await this.getPageData(pageIndex);
			// 2.9.5: 路径 1 到底**为什么**没产出块 —— 枚举,不是猜。
			//
			// 真机第七轮量到一个说不通的数: `charsPathMs` 整轮 **80 ms / 85 页**,
			// 约 **1 ms 一页**。PDFWorker 的 RPC 往返不可能这么快 —— 这不是"慢",
			// 是**立刻失败或立刻返回空**。而路径 1 是唯一**不依赖页面渲染**的抽取
			// 方式:它能用,整条"等文本层渲染"的时序难题就绕过去了。所以它为什么
			// 不出活,是眼下最值得问的一个问题,而现有日志一个字都没有。
			this.noteCharsOutcome(pageIndex,
				!Array.isArray(pageData.chars) ? 'no-chars-array'
					: pageData.chars.length === 0 ? 'empty-chars'
						: null);
			// 扫描件/坏字体页检测 (参照 BabelDOC midend/detect_scanned_file.py 的
			// 思想): char 流大半是未解码的 (cid:N) 时,buildBlocks 只会产出乱码
			// 块并送去翻译烧请求 —— 按"无可用文本"处理,落到文本层路径,那边
			// 拿到的是 PDF.js 真正渲染出的字符。
			if (pageData.chars.length >= 10) {
				const cid = pageData.chars.filter(c => (c.c ?? '').startsWith('(cid:')).length;
				if (cid / pageData.chars.length > 0.6) {
					logger.warn(MODULE, `Page ${pageIndex + 1}: ${cid}/${pageData.chars.length} chars are undecoded (cid:) — treating char stream as unusable`);
					pageData.chars = [];
					this.noteCharsOutcome(pageIndex, 'undecoded-cid');
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
				const structured = structureTableCells(orderBlocksForReading(result.blocks), pageIndex, this.bodyFontSize || 10, this.noTranslateSafe(), (await this.gridFor(pageIndex, pageHeight), this.allBorderGrids.get(pageIndex)), true, pageHeight);
				const tableCells = structured.filter(b => b.translationMode !== undefined);
				const prose = coalesceRegions(structured.filter(b => b.translationMode === undefined), obstacles);
				result.blocks = orderBlocksForReading([...prose, ...tableCells]);
				this.logGrouping(pageIndex, sourceBlockCount, result.blocks.length);
				if (result.blocks.length) {
					this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
					this.auditIR(pageIndex, result.blocks);
					this.pathByPage.set(pageIndex, 'chars');
					this.noteCharsOutcome(pageIndex, 'ok');
					return result.blocks;
				}
				this.noteCharsOutcome(pageIndex, 'chars-but-no-blocks');
			}
			logger.debug(MODULE, `getPageData returned no usable text for page ${pageIndex}; trying the text layer`);
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'PDF_ENCRYPTED') {
				throw e;
			}
			// 抛错的**种类**是排查这条路的关键,而它此前只进了 logger。
			// 只取枚举化的 code 或异常类名 —— message 可能带路径或内容,一个字不带。
			//
			// 2.9.6: `EXTRACTION_FAILED` 太笼统了 —— 真机 98/98 页全落在它上面,
			// 而"调用抛错"与"这个 API 根本不存在"是两件修法完全不同的事。
			// 这里补一个**同步、不发 RPC** 的探针,直接看方法在不在。
			this.noteCharsOutcome(pageIndex,
				`threw:${failureKind(e)}/${adapter.probePageDataApi(this.reader)}`);
			logger.warn(MODULE, `getPageData path failed for page ${pageIndex}; trying the text layer`, e);
		}
		// 走通与走不通都记 —— 走不通的那趟正是"白付的往返",它的耗时才是问题。
		phases.charsPathMs = Date.now() - charsStartedAt;

		// --- path 1.5: 标准 PDF.js getTextContent —— **不依赖渲染** (2.9.7) ----
		//
		// 这一条摆在 DOM 文本层**之前**,因为它没有文本层那个固有毛病:
		// DOM 只对 PDF.js 正在渲染的那几页存在,而这一条走 worker 里的解析结果,
		// 任何页随时可读。2.9.0–2.9.6 七个版本(释放记账、事件补回、原因分流、
		// 距离闸……)都是在给那个毛病打补丁 —— 这一条通了,补丁才有可能拆。
		//
		// 取数与建块都与文本层路径**同构**,于是 37 个布局快照直接就是它的回归测试。
		const textContentStartedAt = Date.now();
		const contentBlocks = await this.extractFromTextContent(pageIndex, obstacles);
		phases.textContentMs = Date.now() - textContentStartedAt;
		if (contentBlocks && contentBlocks.length) {
			this.pathByPage.set(pageIndex, 'text-content');
			return contentBlocks;
		}

		// --- path 2: the rendered text layer (what the user can select) ------
		const textLayerStartedAt = Date.now();
		const spanBlocks = await this.extractFromTextLayer(pageIndex, obstacles);
		phases.textLayerMs = Date.now() - textLayerStartedAt;
		if (spanBlocks && spanBlocks.length) {
			this.pathByPage.set(pageIndex, 'text-layer');
			return spanBlocks;
		}

		// --- path 3: PDFWorker plain text ------------------------------------
		const plainTextStartedAt = Date.now();
		const pageText = await this.fullTextForPage(pageIndex);
		phases.plainTextMs = Date.now() - plainTextStartedAt;
		if (pageText.trim()) {
			const result = buildBlocksFromPlainText(pageText, pageIndex, {
				includeReferences: this.includeReferences,
				referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex)
			});
			this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
			this.pathByPage.set(pageIndex, 'plain-text');
			return result.blocks;
		}

		// —— 三条路都空。这时**必须分清两件事** (2.8.13 真机):
		//
		//   (a) 这页真的没有可译文字(整页图、空白页)—— 返回 [],调用方标完成;
		//   (b) 这页的**文本层根本不在**(PDF.js 只渲染视口附近那几页,预取时
		//       抽的多半是没渲染的页)—— 那不是"没文字",是"看不见"。
		//
		// 旧代码把两者一律当成 (a): 预取在页面渲染前抽一次,抽到空,页面就被
		// 永久标成"已完成、无可译内容",用户翻到那一页时一个字都没译,也不会
		// 重试。真机 19 页里有 6 页栽在这上面 —— 而导出时那几页重解析出了
		// 12–14 个块、约 200 个 span,证明文字一直都在。
		if (!adapter.textLayerExists(this.reader, pageIndex)) {
			throw new PaperMirrorError('EXTRACTION_FAILED',
				`第 ${pageIndex + 1} 页的文字层尚未渲染,稍后重试。`, { retryable: true });
		}
		if (await this.documentHasText(pageIndex)) {
			this.pathByPage.set(pageIndex, 'empty');
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
		if (blocks && blocks.length) {
			// 与 path 2 分开记: 恢复路径跳过了 getPageData 与 PDFWorker,拿到的
			// 结构和正常走 text-layer 一样,但**触发的原因**不同,导出时要能分辨。
			this.pathByPage.set(pageIndex, 'rendered-recovery');
		}
		return blocks ?? [];
	}

	/**
	 * 这一页最后一次成功抽取走的路径;从没抽过(或从没产出块)时为 undefined。
	 */
	extractPathFor(pageIndex: number): ExtractPath | undefined {
		return this.pathByPage.get(pageIndex);
	}

	/** 这一页最近一次抽取的分段耗时 (2.8.15);没抽过则 undefined。 */
	extractPhasesFor(pageIndex: number): ExtractPhases | undefined {
		const phases = this.phasesByPage.get(pageIndex);
		return phases ? { ...phases } : undefined;
	}

	/** 这一页抽取当时的可变输入(含最终走通的路径);没抽过则 undefined。 */
	extractInputsFor(pageIndex: number): ExtractInputs | undefined {
		const inputs = this.inputsByPage.get(pageIndex);
		return inputs ? { ...inputs, ...(this.pathByPage.get(pageIndex) ? { path: this.pathByPage.get(pageIndex) } : {}) } : undefined;
	}

	/** 此刻重新解析这一页会用到的可变输入 —— 与上面那份比对即可判断能否核。 */
	currentExtractInputs(pageIndex: number): Omit<ExtractInputs, 'path'> {
		return {
			bodyFontSize: this.bodyFontSize,
			includeReferences: this.includeReferences,
			referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex),
			noTranslateHash: hashSourceTexts(this.noTranslateSafe())
		};
	}

	/** Build blocks from the rendered PDF.js text layer, if there is one. */
	private async extractFromTextLayer(pageIndex: number, obstacles: [number, number, number, number][] = []): Promise<SourceBlock[] | null> {
		try {
			// 2.8.15: **无条件**等就绪。此前这里有一道 `if (!hasRenderedTextLayer)`
			// 短路 —— 而 `hasRenderedTextLayer` 就是"span 数 > 0",于是 2.8.13 那条
			// 「等它两次采样不变」的稳定判据,恰恰在**它唯一要防的情形**下被跳过:
			// 文本层已经长出了第一批 span、还在继续长,短路当场放行,读到半成品。
			// 真机第 9 页当初只抽出 2 个块、抽取耗时 7 ms,就是这条短路放的行;
			// 2.8.13 只堵住了"层根本不在"那一半。
			// 代价是已就绪的页多付一次采样(约 100 ms)—— 与实测 0.8–2.6 秒的抽取
			// 等待相比是噪声,而少抽半页是用户直接看得见的错。
			const waitStartedAt = Date.now();
			await adapter.waitForTextLayer(this.reader, pageIndex);
			const phases = this.phasesByPage.get(pageIndex);
			if (phases) {
				phases.textLayerWaitMs = (phases.textLayerWaitMs ?? 0) + (Date.now() - waitStartedAt);
			}
			const page = adapter.getTextLayerItems(this.reader, pageIndex);
			const grid = page ? await this.gridFor(pageIndex, page.pageHeight) : null;
			return this.blocksFromSpanPage(pageIndex, page, obstacles, 'the text layer', grid);
		}
		catch (e) {
			logger.warn(MODULE, `Text-layer extraction failed for page ${pageIndex}`, e);
			return null;
		}
	}

	/**
	 * 读一页的文字并建块,**不等渲染** (2.9.7)。
	 *
	 * 与 `extractFromTextLayer` 唯一的区别就是取数那一步:那边读 DOM(只有渲染
	 * 着的页才有),这边读 worker 的解析结果(任何页随时可读)。建块之后的每一步
	 * 都走同一个 `blocksFromSpanPage`,所以两条路产出的结构**按构造相同** ——
	 * 这也是 37 个布局快照能直接当它回归测试的原因。
	 */
	private async extractFromTextContent(pageIndex: number, obstacles: [number, number, number, number][] = []): Promise<SourceBlock[] | null> {
		try {
			const page = await adapter.getTextContentItems(this.reader, pageIndex,
				reason => this.noteOutcome(this.textContentOutcome, this.textContentNoted, pageIndex, reason));
			const grid = page ? await this.gridFor(pageIndex, page.pageHeight) : null;
			return this.blocksFromSpanPage(pageIndex, page, obstacles, 'getTextContent', grid);
		}
		catch (e) {
			logger.warn(MODULE, `getTextContent extraction failed for page ${pageIndex}`, e);
			return null;
		}
	}

	/**
	 * span 条目 → 结构块。**两条基于 span 的路径共用的唯一实现** (2.9.7)。
	 *
	 * 抽成一个函数不是为了少写几行:`text-layer` 与 `text-content` 若各写一遍,
	 * 两条路迟早会在阅读序、表格结构化或合并上悄悄分叉,而分叉出来的差异会伪装成
	 * "这一页的结构变了",把语料的结构比对引向错误的结论。
	 */
	private blocksFromSpanPage(
		pageIndex: number,
		page: adapter.TextLayerPage | null,
		obstacles: [number, number, number, number][],
		sourceLabel: string,
		grid: BorderGrid | null = null
	): SourceBlock[] | null {
		if (!page || !page.items.length) {
			return null;
		}
		const phases = this.phasesByPage.get(pageIndex);
		const buildStartedAt = Date.now();
		const result = buildBlocksFromSpans(page.items, {
			pageIndex,
			pageHeight: page.pageHeight,
			pageWidth: page.pageWidth,
			includeReferences: this.includeReferences,
			referencesAlreadyStarted: this.referencesAlreadyStarted(pageIndex),
			imageRectsPdf: obstacles,
			grid,
			grids: this.allBorderGrids.get(pageIndex)
		});
		// Rebuild semantic regions from whatever fragments extraction
		// produced: whole regions translate as whole sentences.
		const sourceBlockCount = result.blocks.length;
		if (grid) {
			const phases2 = this.phasesByPage.get(pageIndex);
			if (phases2) {
				phases2.gridInside = result.blocks.filter(b => {
					if (!b.boundingBox) { return false; }
					const cx = b.boundingBox.x + b.boundingBox.width / 2;
					const cy = b.boundingBox.y + b.boundingBox.height / 2;
					return columnOfX(grid, cx) >= 0 && rowOfTop(grid, cy) >= 0;
				}).length;
			}
		}
		const structured = structureTableCells(orderBlocksForReading(result.blocks), pageIndex, this.bodyFontSize || 10, this.noTranslateSafe(), this.allBorderGrids.get(pageIndex) ?? grid, true, page.pageHeight);
		const tableCells = structured.filter(b => b.translationMode !== undefined);
		const prose = coalesceRegions(structured.filter(b => b.translationMode === undefined), obstacles);
		result.blocks = orderBlocksForReading([...prose, ...tableCells]);
		// 建块是**同步 CPU 段**,与等待是两回事 —— 主线程卡不卡看这个数,
		// 等得久不久看 textLayerWaitMs。混在一起就分不出该优化哪边。
		if (phases) {
			phases.buildMs += Date.now() - buildStartedAt;
		}
		this.logGrouping(pageIndex, sourceBlockCount, result.blocks.length);
		this.referencesStartedByPage.set(pageIndex, result.referencesStarted);
		logger.info(MODULE, `Page ${pageIndex + 1}: extracted ${result.blocks.length} block(s) from ${sourceLabel}`);
		this.auditIR(pageIndex, result.blocks);
		return result.blocks;
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
