/**
 * ============================================================================
 * Zotero Reader adapter — THE ONLY module allowed to touch undocumented
 * Zotero Reader internals. Everything here was verified against the
 * Zotero 9.0.6 source (tag eabf364) and its pinned reader submodule (9643fac):
 *
 *  - Zotero.Reader.registerEventListener('renderToolbar', handler, pluginID)
 *      chrome/content/zotero/xpcom/reader.js (Reader.registerEventListener).
 *      NOTE: unregisterEventListener() in 9.0.6 has an inverted filter and
 *      cannot be used; listeners are removed automatically on plugin shutdown
 *      via the pluginID we pass (Zotero.Plugins observer in Reader ctor).
 *  - ReaderTab fields: _tabContainer (XUL container in the main window),
 *      _iframe (XUL browser), _iframeWindow, _internalReader (waived reader
 *      object created by reader.html), tabID, _item.
 *  - _internalReader._state.primaryViewState.pageIndex — reader state
 *      (reader submodule src/common/reader.js `this._state`).
 *  - _internalReader._primaryView._iframeWindow.PDFViewerApplication
 *      .pdfDocument.getPageData({ pageIndex }) — Zotero's PDF.js fork API
 *      returning { chars } with reading-order chars + break flags. Used by
 *      Zotero itself (reader submodule src/pdf/pdf-view.js).
 *  - reader.navigate({ pageIndex }) — ReaderInstance.navigate.
 *  - Zotero.Notifier events: ('pageChange','file'), ('close','file'),
 *      tab 'close'/'select' — chrome/content/zotero/xpcom/reader.js.
 *
 * If any of these disappear in a future Zotero, the adapter throws
 * READER_API_CHANGED and callers degrade gracefully.
 * ============================================================================
 */

import type { PageData } from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { imageRectsFromOperatorList } from './imageObstacles';
import { segmentsFromOperatorList, type SegmentScanStats } from './tableBorders';

/**
 * 最近一次取线段的计数 (2.12.7)。模块级单值 —— 取数是逐页串行的,调用方
 * 紧接着读走;它只进诊断导出,不参与任何判断。
 */
let lastSegmentScan: SegmentScanStats | null = null;

/** 读走最近一次取线段的计数(读后不清,重复读到同一份)。 */
export function lastEdgeScanStats(): SegmentScanStats | null {
	return lastSegmentScan;
}

const MODULE = 'readerAdapter';

/** Loose type for a ReaderInstance (ReaderTab). */
export interface ReaderLike {
	itemID?: number;
	tabID?: string;
	type?: string;
	_item?: ZoteroItem;
	_iframe?: any;
	_iframeWindow?: Window & { document: Document };
	_internalReader?: any;
	_tabContainer?: any;
	_window?: any;
	navigate?: (location: unknown) => void;
}

export function getAllReaders(): ReaderLike[] {
	try {
		return (Zotero.Reader._readers ?? []).slice();
	}
	catch (e) {
		logger.warn(MODULE, 'Zotero.Reader._readers unavailable', e);
		return [];
	}
}

export function getReaderByTabID(tabID: string): ReaderLike | null {
	try {
		return Zotero.Reader.getByTabID(tabID) ?? null;
	}
	catch {
		return null;
	}
}

export function isPdfReader(reader: ReaderLike): boolean {
	try {
		return (reader.type ?? reader._item?.attachmentReaderType) === 'pdf';
	}
	catch {
		return false;
	}
}

/**
 * Split view requires a ReaderTab (which has _tabContainer + tabID).
 * Standalone ReaderWindow instances are not supported, so we don't offer the
 * button there (avoids a button that errors on click).
 */
export function supportsSplitView(reader: ReaderLike): boolean {
	return !!reader._tabContainer && reader.tabID !== undefined;
}

export function getReaderItem(reader: ReaderLike): ZoteroItem | null {
	return reader._item ?? (reader.itemID ? (Zotero.Items.get(reader.itemID) as ZoteroItem) : null);
}

/** The XUL element that hosts the reader browser inside the tab. */
export function getTabContainer(reader: ReaderLike): Element {
	const container = reader._tabContainer;
	if (!container || !container.appendChild) {
		throw new PaperMirrorError('READER_API_CHANGED', 'ReaderTab._tabContainer is unavailable; the Zotero Reader API may have changed.');
	}
	return container as Element;
}

/** The XUL browser element rendering reader.html. */
export function getReaderBrowser(reader: ReaderLike): Element {
	const iframe = reader._iframe;
	if (!iframe) {
		throw new PaperMirrorError('READER_API_CHANGED', 'ReaderTab._iframe is unavailable; the Zotero Reader API may have changed.');
	}
	return iframe as Element;
}

export function getMainWindowForReader(reader: ReaderLike): Window {
	const win = reader._window ?? Zotero.getMainWindow();
	if (!win) {
		throw new PaperMirrorError('READER_API_CHANGED', 'No main window available for reader.');
	}
	return win;
}

/**
 * 归属判定专用 (2.0.10, 审核 P3): 不经 getMainWindow() 兜底。缺 _window 的
 * reader 被兜底归到「碰巧的窗口」时,disposeWindow 可能误杀在用会话或漏杀
 * 该杀的 —— 注释承诺的「归属不明保守保留」只对抛异常成立,对静默兜底不
 * 成立。判归属就必须诚实: 不知道就是 null。
 */
export function getOwnerWindowForReader(reader: ReaderLike): Window | null {
	return reader._window ?? null;
}

/** Current 0-based page index, best effort. */
export function getCurrentPageIndex(reader: ReaderLike): number {
	try {
		const state = reader._internalReader?._state;
		const index = state?.primaryViewState?.pageIndex;
		if (typeof index === 'number' && Number.isFinite(index)) {
			return index;
		}
	}
	catch {
		// fall through
	}
	try {
		const item = getReaderItem(reader);
		const saved = item?.getAttachmentLastPageIndex?.();
		if (typeof saved === 'number') {
			return saved;
		}
	}
	catch {
		// fall through
	}
	return 0;
}

export function getPageCount(reader: ReaderLike): number {
	try {
		const app = getPdfApplication(reader);
		const count = app?.pdfViewer?.pagesCount ?? app?.pdfDocument?.numPages;
		if (typeof count === 'number' && count > 0) {
			return count;
		}
	}
	catch {
		// fall through
	}
	return 0;
}

export function navigateToPage(reader: ReaderLike, pageIndex: number): void {
	try {
		reader.navigate?.({ pageIndex });
	}
	catch (e) {
		logger.warn(MODULE, 'navigateToPage failed', e);
	}
}

/**
 * 穿过 Xray,拿到 content 侧**真正的** JS 对象 (2.9.9)。
 *
 * ## 为什么整整十轮都卡在这里
 *
 * 插件跑在 system principal 的沙箱里,PDF.js 跑在阅读器 iframe 的 content
 * compartment 里。Firefox 默认给 chrome 代码 **Xray vision**:DOM 对象看得完整,
 * 而**普通 JS 对象上自定义的方法**要么看不见,要么调用时跨 compartment 出问题。
 *
 * 真机把这件事的形状画得很清楚:
 *
 *   - `getTextLayerItems` **一直能用** —— 它走的是 DOM(`querySelector('span')`、
 *     `getBoundingClientRect`),DOM 有完整的 Xray 支持;
 *   - `pdfDocument.getPageData` —— `typeof === 'function'` 为真(`present`),
 *     但 **97/97 页调用都抛错**;
 *   - 2.9.7 新加的 `getPage(n).getTextContent()` —— `getPage` 探针说 `available`,
 *     可整轮 `textContentMs` 只有 **5 ms / 21 页**,`extractPath` 一次
 *     `text-content` 都没有:它在 `getPage` 之后、`getTextContent` 之前就退出了。
 *
 * 三件事指向同一条边界:**凡是走 JS 对象方法的路都不通,走 DOM 的路都通。**
 * 而这个代码库从头到尾**没有一处 `wrappedJSObject`** —— 也就是从来没穿过 Xray。
 *
 * `wrappedJSObject` 是 Firefox/Zotero 插件访问 content JS 对象的标准做法。
 * 拿不到就退回原对象:这一层只可能让更多东西可见,不会让已经能用的变得不能用。
 */
function waive<T>(value: T): T {
	try {
		return ((value as { wrappedJSObject?: T } | null)?.wrappedJSObject ?? value) as T;
	}
	catch {
		return value;
	}
}

/** content 侧的 window —— 已穿过 Xray (2.9.9)。 */
function pdfWindow(reader: ReaderLike): any {
	return waive(reader._internalReader?._primaryView?._iframeWindow as unknown);
}

/** Inner PDF.js window (reader submodule: _primaryView._iframeWindow). */
function getPdfApplication(reader: ReaderLike): any {
	const app = waive(pdfWindow(reader)?.PDFViewerApplication);
	if (!app) {
		throw new PaperMirrorError('READER_API_CHANGED', 'PDFViewerApplication is not reachable; the Zotero Reader internals may have changed.');
	}
	return app;
}

export interface RawPageInfo {
	pageData: PageData;
	pageWidth: number;
	pageHeight: number;
}

/**
 * 路径 1(`pdfDocument.getPageData`)到底断在哪一环 (2.9.6)。
 *
 * 真机第八轮给了一个决定性的数字:`charsPath = { "threw:EXTRACTION_FAILED": 98 }`
 * —— **98/98 页,每一页都抛错**。不是慢、不是字体编码,是整条路根本走不通。
 * 而 `EXTRACTION_FAILED` 是个笼统的 code:调用抛错、返回的 chars 不是数组,
 * 都归它。**分不出是哪一种,就分不清是"这篇 PDF 不行"还是"这个 API 没了"**,
 * 而这两件事的修法完全不同。
 *
 * 这个探针是同步的、不发 RPC 的:只看对象和函数在不在。
 */
export type PageDataApiState =
	/** 连 PDFViewerApplication 都够不着。 */
	| 'no-app'
	/** 有 app,没有 pdfDocument(文档还没加载完?)。 */
	| 'no-pdfdocument'
	/** **有 pdfDocument,但它没有 `getPageData` 这个方法** —— fork 的私有 API 没了。 */
	| 'api-missing'
	/** 方法在,那失败就出在调用本身。 */
	| 'present';

export function probePageDataApi(reader: ReaderLike): PageDataApiState {
	try {
		// 2.9.9: 穿过 Xray 再看 —— 此前看的是 Xray 视角,它对普通 JS 对象的
		// 自定义方法要么藏、要么调用时跨 compartment 出问题。
		const app = waive(pdfWindow(reader)?.PDFViewerApplication) as
			{ pdfDocument?: { getPageData?: unknown } } | undefined;
		if (!app) {
			return 'no-app';
		}
		if (!app.pdfDocument) {
			return 'no-pdfdocument';
		}
		return typeof waive(app.pdfDocument).getPageData === 'function' ? 'present' : 'api-missing';
	}
	catch {
		return 'no-app';
	}
}

/**
 * 标准 PDF.js 的 `getPage(n).getTextContent()` 在不在 (2.9.6)。
 *
 * 这是**出路探针**,不是诊断:`getTextContent` 是 PDF.js 的**公开标准 API**,
 * 与 fork 的私有 `getPageData` 不同,而且**同样不依赖页面渲染** —— 文本层本身
 * 就是用它渲出来的。若它可用,2.9.0–2.9.5 六个版本一直在绕的那个难题
 * (「文本层只对渲染着的页存在」)就有了从根上绕开的办法。
 *
 * 同步、不发 RPC:只看函数在不在。
 */
export type TextContentApiState = 'available' | 'no-pdfdocument' | 'no-getpage' | 'unreachable';

/**
 * 一个 `getTextContent()` 条目 → PDF 用户空间的轴对齐包围盒 (2.9.7) — pure。
 *
 * PDF.js 给的是 `transform = [a, b, c, d, e, f]`(文本空间 → 用户空间)、
 * 加上已经换算到用户空间的 `width`。于是:
 *
 *   - 原点 `(e, f)` 是这一串字的**基线左端**;
 *   - 前进方向是 `(a, b)` 的单位向量,长度 `width`;
 *   - 上方向是 `(c, d)`,长度就是字高 `hypot(c, d)`。
 *
 * 四个角取 min/max 就是包围盒。**这样写而不是 `[e, f, e+width, f+height]`,
 * 是因为竖排的页边水印(真机上那条 "Downloaded from …")的 transform 是旋转的**
 * —— 直接加宽高会得到一个横躺的盒子,把半页正文都框进去。
 *
 * ## 2.10.1: em 盒**跨骑**基线,不是坐在基线上
 *
 * 2.9.7 写成从基线 `(e, f)` 向上一个 em —— 也就是盒子的下沿**恰好是基线**,
 * 基线以下一点空间都没有。可逗号、分号、以及 g/p/y/j 的尾巴全在基线**以下**。
 *
 * 这个错误在 2.9.9 之前是看不见的:那时这条路径根本没跑通(Xray),
 * 所有行矩形都来自 DOM 文本层的 `getBoundingClientRect()`,而 PDF.js 给 span
 * 的盒子本来就含下伸部。2.9.9 把路径修通,错误的几何第一次真的上了页面 ——
 * 真机表现是原文被遮罩盖住之后,**每一行的逗号分号尾巴从遮罩下沿漏出来**,
 * 在译文页上留下一片规则排布的小点(作者名单那种标点密集的段落最明显)。
 *
 * 遮罩的 padding 补不了这个:它是按字号 8% 算、上限 3px,而下伸部约 0.22em ——
 * 小字号下差一个数量级。要修的是矩形本身。
 *
 * 标准字体的量度:上伸约 0.78em、下伸约 0.22em,合起来一个 em。所以把这一个
 * em 的盒子沿字高方向**下移 0.22em**:上沿仍然刚好盖住上伸部,下沿这才盖住
 * 下伸部。盒子高度不变,只是放对了位置 —— 行与行的相对几何不受影响。
 */

/**
 * 基线以下的比例。多数正文字体的 descent 在 0.20–0.25 em 之间,
 * 取 0.22 是个保守的中值:小了盖不住逗号尾巴,大了会吃到下一行的上伸部
 * (常见行距 1.15–1.2 em,0.22 + 0.78 = 1.0,仍留有余量)。
 */
const DESCENDER_EM = 0.22;

export function textContentItemRect(
	transform: number[],
	width: number
): { rect: [number, number, number, number]; fontSize: number } | null {
	const [a, b, c, d, e, f] = transform as [number, number, number, number, number, number];
	if (![a, b, c, d, e, f, width].every(Number.isFinite)) {
		return null;
	}
	const fontSize = Math.hypot(c, d);
	const advance = Math.hypot(a, b);
	// 前进方向的单位向量;退化(缩放为 0)时按水平处理,总比丢掉整串字强。
	const ux = advance > 0 ? a / advance : 1;
	const uy = advance > 0 ? b / advance : 0;
	// 字高方向的单位向量 —— 旋转文本(页边水印)也必须沿**它自己的**下方向让开,
	// 不能一律往 -y 挪,否则竖排水印的盒子会横向错位。
	const dx = fontSize > 0 ? c / fontSize : 0;
	const dy = fontSize > 0 ? d / fontSize : 1;
	const drop = fontSize * DESCENDER_EM;
	// 基线原点先沿字高方向的反方向退 0.22em,盒子于是跨骑基线。
	const ox = e - dx * drop;
	const oy = f - dy * drop;
	const xs = [ox, ox + ux * width, ox + c, ox + ux * width + c];
	const ys = [oy, oy + uy * width, oy + d, oy + uy * width + d];
	return {
		rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
		fontSize: fontSize > 0 ? fontSize : undefined as unknown as number
	};
}

/**
 * 读一页的文字 —— **不依赖这一页有没有被渲染** (2.9.7)。
 *
 * ## 为什么要有它
 *
 * 真机第八、九轮钉死了两件事:
 *   - `charsPath = { "threw:EXTRACTION_FAILED/present": 97 }` —— fork 的私有
 *     `getPageData` **方法在**,但 97/97 页调用都失败,路径 1 从来就没通过;
 *   - `textContentApi = "available"` —— 标准 PDF.js 的 `getPage()` 可用。
 *
 * 于是插件一直只剩 DOM 文本层一条路,而**文本层只对 PDF.js 正在渲染的那几页存在**。
 * 2.9.0–2.9.6 七个版本(释放记账、事件补回、原因分流、距离闸……)全都是在给这个
 * 固有属性打补丁。`getTextContent()` 是公开 API,走的是 worker 里的解析结果,
 * **任何页随时可读** —— 从根上不需要那些补丁。
 *
 * 输出刻意与 `getTextLayerItems` **同构**(同样的 `TextLayerPage`),于是下游
 * `buildBlocksFromSpans → 阅读序 → 表格结构化 → 合并` 一行不改,
 * 37 个布局快照直接就是它的回归测试。
 */
export async function getTextContentItems(
	reader: ReaderLike,
	pageIndex: number,
	note?: (reason: string) => void
): Promise<TextLayerPage | null> {
	const say = (reason: string): null => {
		note?.(reason);
		return null;
	};
	try {
		// 2.9.9: 每一层都要穿 Xray —— `pdfDocument` 是一层,`getPage` 返回的
		// `PDFPageProxy` 又是一层。少穿一层,下一层的方法就"不存在"。
		// 2.9.7 正是栽在这里:`getPage` 探针说 available,而 `getTextContent`
		// 在 Xray 视角下不可见,于是整轮 textContentMs 只有 5 ms、一页没走通。
		const doc = waive((waive(pdfWindow(reader)?.PDFViewerApplication) as
			{ pdfDocument?: unknown } | undefined)?.pdfDocument) as
			{ getPage?: (n: number) => Promise<unknown> } | undefined;
		if (typeof doc?.getPage !== 'function') {
			return say('no-getpage');
		}
		const page = waive(await doc.getPage(pageIndex + 1)) as {
			getTextContent?: () => Promise<{ items?: unknown[] }>;
			view?: number[];
		};
		if (typeof page?.getTextContent !== 'function') {
			// 2.9.9 前这里是整条路的死穴,而日志里一个字都没有 —— 只看得到
			// `textContentMs` 只有 5 ms 和 `extractPath` 一次 text-content 都没有。
			return say('no-gettextcontent');
		}
		const content = waive(await page.getTextContent());
		const raw = Array.isArray(content?.items) ? content.items : [];
		const items: TextLayerItem[] = [];
		for (const entry of raw) {
			const it = entry as { str?: unknown; transform?: unknown; width?: unknown };
			const text = typeof it.str === 'string' ? it.str : '';
			if (!text.trim() || !Array.isArray(it.transform) || typeof it.width !== 'number') {
				continue; // 空串与结构标记(marked content)不是字
			}
			const box = textContentItemRect(it.transform as number[], it.width);
			if (!box) {
				continue;
			}
			items.push({ text, rect: box.rect, ...(box.fontSize ? { fontSize: box.fontSize } : {}) });
		}
		if (!items.length) {
			return say(raw.length ? 'all-filtered' : 'no-items');
		}
		note?.('ok');
		const view = Array.isArray(page.view) && page.view.length >= 4 ? page.view : null;
		return {
			items,
			pageWidth: view ? Number(view[2]) - Number(view[0]) : 612,
			pageHeight: view ? Number(view[3]) - Number(view[1]) : 792
		};
	}
	catch (e) {
		logger.debug(MODULE, `getTextContentItems(${pageIndex}) failed`, e);
		return say(`threw:${(e as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'}`);
	}
}

export function probeTextContentApi(reader: ReaderLike): TextContentApiState {
	try {
		const doc = waive((waive(pdfWindow(reader)?.PDFViewerApplication) as
			{ pdfDocument?: unknown } | undefined)?.pdfDocument) as { getPage?: unknown } | undefined;
		if (!doc) {
			return 'no-pdfdocument';
		}
		return typeof doc.getPage === 'function' ? 'available' : 'no-getpage';
	}
	catch {
		return 'unreachable';
	}
}

/**
 * Fetch the char stream for one page via Zotero's PDF.js fork.
 * Throws NO_TEXT_LAYER / PDF_ENCRYPTED / READER_API_CHANGED as appropriate.
 */
export async function getPageData(reader: ReaderLike, pageIndex: number): Promise<RawPageInfo> {
	let app: any;
	try {
		app = getPdfApplication(reader);
	}
	catch (e) {
		throw e instanceof PaperMirrorError ? e : new PaperMirrorError('READER_API_CHANGED', String(e));
	}
	let pageData: any;
	try {
		pageData = await app.pdfDocument.getPageData({ pageIndex });
	}
	catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/password/i.test(message)) {
			throw new PaperMirrorError('PDF_ENCRYPTED', 'This PDF is encrypted and cannot be read.');
		}
		throw new PaperMirrorError('EXTRACTION_FAILED', `Failed to read page ${pageIndex + 1}: ${message}`);
	}
	const chars = pageData?.chars;
	if (!Array.isArray(chars) && !(chars && typeof chars.length === 'number')) {
		throw new PaperMirrorError('EXTRACTION_FAILED', 'getPageData returned no chars array.');
	}
	// Page dimensions from the viewport (fallback: viewBox)
	let pageWidth = 612;
	let pageHeight = 792;
	try {
		const page = app.pdfViewer?._pages?.[pageIndex];
		const viewport = page?.viewport;
		if (viewport?.viewBox) {
			pageWidth = viewport.viewBox[2] - viewport.viewBox[0];
			pageHeight = viewport.viewBox[3] - viewport.viewBox[1];
		}
		else if (pageData.viewBox) {
			pageWidth = pageData.viewBox[2] - pageData.viewBox[0];
			pageHeight = pageData.viewBox[3] - pageData.viewBox[1];
		}
	}
	catch {
		if (pageData.viewBox) {
			pageWidth = pageData.viewBox[2] - pageData.viewBox[0];
			pageHeight = pageData.viewBox[3] - pageData.viewBox[1];
		}
	}
	// Copy chars out of the content compartment into plain objects.
	const copied = [];
	const length = chars.length;
	for (let i = 0; i < length; i++) {
		const c = chars[i];
		if (!c) {
			continue;
		}
		copied.push({
			c: String(c.c ?? ''),
			rect: [Number(c.rect?.[0] ?? 0), Number(c.rect?.[1] ?? 0), Number(c.rect?.[2] ?? 0), Number(c.rect?.[3] ?? 0)] as [number, number, number, number],
			fontName: c.fontName ? String(c.fontName) : undefined,
			fontSize: typeof c.fontSize === 'number' ? c.fontSize : undefined,
			ignorable: !!c.ignorable,
			spaceAfter: !!c.spaceAfter,
			lineBreakAfter: !!c.lineBreakAfter,
			paragraphBreakAfter: !!c.paragraphBreakAfter
		});
	}
	return {
		pageData: { chars: copied, viewBox: pageData.viewBox, pageLabel: pageData.pageLabel },
		pageWidth,
		pageHeight
	};
}

export interface FullTextInfo {
	/** Whole-document plain text. NOTE: Zotero does NOT insert page delimiters. */
	text: string;
	extractedPages: number;
	totalPages: number;
}

/**
 * Fallback text extraction without coordinates via the public-ish
 * Zotero.PDFWorker.getFullText.
 *
 * Verified in chrome/content/zotero/xpcom/pdfWorker/manager.js (9.0.6):
 * getFullText(itemID, maxPages, isPriority) resolves to
 *   { text, extractedPages, totalPages }
 * — a single concatenated string with NO '\f' (or any other) page separator.
 * Splitting it per page is therefore impossible in general; callers must treat
 * it as document-level evidence that a text layer exists, and only use it as
 * page text for single-page documents.
 */
export async function getFullTextInfo(itemID: number): Promise<FullTextInfo> {
	try {
		const result = await Zotero.PDFWorker.getFullText(itemID, null, true);
		return {
			text: String(result?.text ?? ''),
			extractedPages: Number(result?.extractedPages ?? 0),
			totalPages: Number(result?.totalPages ?? 0)
		};
	}
	catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (/password/i.test(message)) {
			throw new PaperMirrorError('PDF_ENCRYPTED', 'This PDF is encrypted and cannot be read.');
		}
		throw new PaperMirrorError('EXTRACTION_FAILED', `Full-text extraction failed: ${message}`);
	}
}

/* --------------------------------------------------------------------------
 * On-page overlay support.
 *
 * PDF.js exposes, per rendered page:
 *   pdfViewer.getPageView(i) -> { div, viewport }
 *   viewport.convertToViewportPoint(xPdf, yPdf) -> [xCss, yCss]
 * Zotero itself uses exactly this pair to place annotations (reader submodule
 * src/pdf/lib/coordinates.js p2v + pdf-view.js), so it is the same code path
 * the app depends on. Zotero paints annotations on a <canvas>; our overlay is
 * a sibling DOM layer inside page.div and does not collide with it.
 * ------------------------------------------------------------------------ */

export interface PageViewHandle {
	/** The .page element PDF.js renders into. */
	div: HTMLElement;
	/** Converts PDF coordinates to CSS pixels within `div`. */
	toCss(xPdf: number, yPdf: number): [number, number];
	/** Document of the inner PDF.js iframe (for creating nodes/styles). */
	doc: Document;
}

export function getPageView(reader: ReaderLike, pageIndex: number): PageViewHandle | null {
	try {
		const win = reader._internalReader?._primaryView?._iframeWindow;
		const viewer = win?.PDFViewerApplication?.pdfViewer;
		const page = viewer?.getPageView?.(pageIndex);
		const div = page?.div as HTMLElement | undefined;
		const viewport = page?.viewport;
		if (!div || !viewport?.convertToViewportPoint || !win?.document) {
			return null;
		}
		return {
			div,
			doc: win.document as Document,
			toCss: (xPdf: number, yPdf: number) => {
				const [x, y] = viewport.convertToViewportPoint(xPdf, yPdf);
				return [Number(x), Number(y)];
			}
		};
	}
	catch (e) {
		logger.debug(MODULE, `getPageView(${pageIndex}) failed`, e);
		return null;
	}
}

/* --------------------------------------------------------------------------
 * Text-layer DOM extraction (the most robust path).
 *
 * `pdfDocument.getPageData()` is a Zotero-fork API reached through the content
 * compartment and can fail or come back empty in a system-principal sandbox
 * (Xray wrapping, worker timing, fork changes). The rendered text layer, by
 * contrast, is ordinary DOM inside the PDF.js iframe: it is exactly the text
 * the user can select with the mouse, so if it has spans, the PDF has a text
 * layer — full stop. We read those spans and convert their client rects back
 * into PDF coordinates with the same viewport helper Zotero uses for
 * annotations (viewport.convertToPdfPoint, reader submodule
 * src/pdf/lib/coordinates.js v2p).
 * ------------------------------------------------------------------------ */

export interface TextLayerItem {
	text: string;
	/** [x1, y1, x2, y2] in raw PDF coordinates (origin bottom-left). */
	rect: [number, number, number, number];
	fontSize?: number;
}

export interface TextLayerPage {
	items: TextLayerItem[];
	pageWidth: number;
	pageHeight: number;
}

function pageViewOf(reader: ReaderLike, pageIndex: number): any {
	const win = reader._internalReader?._primaryView?._iframeWindow;
	const viewer = win?.PDFViewerApplication?.pdfViewer;
	return viewer?.getPageView?.(pageIndex) ?? viewer?._pages?.[pageIndex] ?? null;
}

/** Does this page currently have a rendered, non-empty text layer? */
export function hasRenderedTextLayer(reader: ReaderLike, pageIndex: number): boolean {
	return textLayerSpanCount(reader, pageIndex) > 0;
}

/**
 * 这一页的文本层里有多少个 span。**0 有两种含义**,靠 `textLayerExists` 区分:
 * 层不在(页面根本没渲染)还是层在但没字(真·图片页)。
 */
export function textLayerSpanCount(reader: ReaderLike, pageIndex: number): number {
	try {
		const div = pageViewOf(reader, pageIndex)?.div as HTMLElement | undefined;
		const layer = div?.querySelector?.('.textLayer');
		return layer ? layer.querySelectorAll('span').length : 0;
	}
	catch {
		return 0;
	}
}

/**
 * 这一页的文本层节点**存在吗** —— 与"里面有没有字"是两回事。
 *
 * 2.8.13 真机: 抽取拿不到文字时,旧代码一律当成"这页没有可译内容"并把页面标成
 * 完成。可**没渲染过的页压根没有文本层**,那不是"没文字",是"看不见"。这个函数
 * 就是用来分开这两件事的。
 */
export function textLayerExists(reader: ReaderLike, pageIndex: number): boolean {
	try {
		const div = pageViewOf(reader, pageIndex)?.div as HTMLElement | undefined;
		return !!div?.querySelector?.('.textLayer');
	}
	catch {
		return false;
	}
}

/**
 * PDF.js 的 `PDFPageView.renderingState` (2.9.1)。
 *
 * `RenderingStates`: 0 = INITIAL(还没排上)、1 = RUNNING(正在渲)、
 * 2 = PAUSED(排过又被推迟 —— 离视口太远)、3 = FINISHED。
 *
 * 拿不到就返回 null(fork 改过 API / 页对象不在)。调用方另有兜底,
 * **绝不据此做出"这页没文字"这种定论**。
 */
export function pageRenderState(reader: ReaderLike, pageIndex: number): number | null {
	try {
		const state = (pageViewOf(reader, pageIndex) as { renderingState?: unknown } | null)?.renderingState;
		return typeof state === 'number' ? state : null;
	}
	catch {
		return null;
	}
}

/** `renderingState` 里"等下去没意义"的两档: 还没排上 / 排过又被推迟。 */
const RENDER_STATE_INITIAL = 0;
const RENDER_STATE_PAUSED = 2;

/**
 * Wait (briefly) for PDF.js to render the text layer of a page. Resolves false
 * if the page never renders one — the caller then falls through to the next
 * extraction path rather than reporting "no text layer".
 *
 * ## 2.9.1: 别再对着没渲染的页干等 2.5 秒
 *
 * 真机第四轮把账算清楚了: 59 页的 `extractMs` 合计 50,987 ms,其中
 * **`textLayerWaitMs` 占 40,729 ms(80%)**;而我原先怀疑的 PDFWorker char 流
 * (`charsPathMs`)**整轮只有 19 ms** —— 那条假设被彻底证伪。最慢的页
 * `tlWait` 在 1.4–2.6 秒,p28=2583、p29=2527 **直接跑满** 2500 ms 上限。
 *
 * 原因是下面那条早退 `count === 0 && !pageViewOf(...)` **永远不触发**:
 * PDF.js 给文档里**每一页**都建了 PDFPageView 对象,`pageViewOf` 对任何页号
 * 都返回非空。于是预取去抽一个没渲染的页 = 白等满 2.5 秒 = 抽不到 = 释放;
 * 2.9.0 的补回再试一次 = 再白等 2.5 秒。同一轮
 * `releaseReasons['text-layer-not-rendered'] = 29`。
 *
 * 而这 2.5 秒还占着抽取信号量(最多 2 个并发)—— 白等的同时挡住用户正看的页。
 *
 * 两道闸,任一成立就立刻返回 false:
 *   1. **渲染状态**说这页还没排上或已被推迟(INITIAL / PAUSED),且一个 span
 *      都没有 —— 精确,但依赖 fork 保留这个字段;
 *   2. **冷启动上限** `coldMs`: 一个 span 都没出现就最多等这么久。真在渲的页
 *      几十毫秒内就会吐出第一批 span,所以这条不依赖任何 PDF.js 内部 API,
 *      是闸 1 拿不到状态时的兜底。
 *
 * 完整的 `timeoutMs` 只留给**已经开始长 span** 的页 —— 那时候等才有意义。
 */
export async function waitForTextLayer(
	reader: ReaderLike,
	pageIndex: number,
	timeoutMs = 2500,
	coldMs = TEXT_LAYER_COLD_MS
): Promise<boolean> {
	const startedAt = Date.now();
	const deadline = startedAt + timeoutMs;
	// PDF.js **逐步**往文本层里塞 span。旧代码"有一个 span 就算渲染好了",于是
	// 抽取经常读到半成品 —— 2.8.13 真机上第 9 页只抽出 2 个块(抽取耗时 7 ms),
	// 而整页正文一个字都没进翻译。改为**等它稳定**: 连续两次采样 span 数不变
	// 才算完成。稳定判据比"有没有"贵一次采样,但一页只付一次。
	let last = -1;
	let sawSpans = false;
	while (Date.now() < deadline) {
		const count = textLayerSpanCount(reader, pageIndex);
		if (count > 0) {
			sawSpans = true;
			if (count === last) {
				return true; // 两次采样之间没再长 —— 认为渲染完了
			}
		}
		if (!sawSpans) {
			// 闸 1: PDF.js 自己说这页还没排上 / 已被推迟。等下去毫无意义。
			const state = pageRenderState(reader, pageIndex);
			if (state === RENDER_STATE_INITIAL || state === RENDER_STATE_PAUSED) {
				return false;
			}
			// 闸 2: 冷启动上限 —— 不依赖任何 PDF.js 内部字段的兜底。
			if (Date.now() - startedAt >= coldMs) {
				return false;
			}
		}
		last = count;
		await new Promise(resolve => setTimeout(resolve, TEXT_LAYER_SETTLE_MS));
	}
	// 超时: 有字就用(总比没有强),但调用方能从 span 数看出它可能是半成品。
	return textLayerSpanCount(reader, pageIndex) > 0;
}

/** 两次采样之间的间隔 —— 也是"稳定"的判据粒度。 */
export const TEXT_LAYER_SETTLE_MS = 100;

/**
 * 一个 span 都还没出现时最多等多久 (2.9.1)。真在渲的页几十毫秒内就会吐出
 * 第一批 span;等满 2.5 秒只会发生在**根本没在渲**的页上,那是纯浪费 ——
 * 真机一轮白等掉 40.7 秒,还占着抽取信号量挡住当前页。
 */
export const TEXT_LAYER_COLD_MS = 400;

/**
 * Read the rendered text layer of one page as positioned items in PDF space.
 * Returns null when the page is not rendered or has no text layer.
 */
export function getTextLayerItems(reader: ReaderLike, pageIndex: number): TextLayerPage | null {
	try {
		const page = pageViewOf(reader, pageIndex);
		const div = page?.div as HTMLElement | undefined;
		const viewport = page?.viewport;
		if (!div || typeof viewport?.convertToPdfPoint !== 'function') {
			return null;
		}
		const layer = div.querySelector('.textLayer') as HTMLElement | null;
		if (!layer) {
			return null;
		}
		// The text layer box IS the viewport box, so its client rect is the
		// origin for convertToPdfPoint. Fall back to the page div if the layer
		// has no box of its own (older fork layouts).
		const layerRect = layer.getBoundingClientRect();
		const origin = layerRect.width > 0 && layerRect.height > 0 ? layerRect : div.getBoundingClientRect();

		const toPdf = (xCss: number, yCss: number): [number, number] => {
			const [x, y] = viewport.convertToPdfPoint(xCss - origin.left, yCss - origin.top);
			return [Number(x), Number(y)];
		};

		// PDF.js writes the glyph size onto each span as an inline font-size in
		// CSS px at the current scale. Dividing by the scale recovers the true
		// PDF font size — far more reliable than the span's bounding height,
		// which changes with ascenders/descenders and would make every
		// "font size changed → new paragraph" test misfire.
		const scale = Number(viewport.scale) > 0 ? Number(viewport.scale) : 1;

		const items: TextLayerItem[] = [];
		const spans = layer.querySelectorAll('span');
		for (let i = 0; i < spans.length; i++) {
			const span = spans[i] as HTMLElement;
			// Skip wrappers (markedContent, highlight containers) and sentinels;
			// only leaf spans carry the actual glyph runs.
			if (span.childElementCount > 0 || span.classList.contains('endOfContent')) {
				continue;
			}
			const text = span.textContent ?? '';
			if (!text.trim()) {
				continue;
			}
			const r = span.getBoundingClientRect();
			if (r.width <= 0 && r.height <= 0) {
				continue;
			}
			const [ax, ay] = toPdf(r.left, r.bottom);
			const [bx, by] = toPdf(r.right, r.top);
			if (![ax, ay, bx, by].every(Number.isFinite)) {
				continue;
			}
			const rect: [number, number, number, number] = [
				Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)
			];
			const declared = parseFloat(span.style.fontSize || '');
			const fontSize = Number.isFinite(declared) && declared > 0
				? declared / scale
				: rect[3] - rect[1];
			items.push({ text, rect, fontSize });
		}
		if (!items.length) {
			return null;
		}
		let pageWidth = 612;
		let pageHeight = 792;
		const viewBox = viewport.viewBox;
		if (viewBox && viewBox.length >= 4) {
			pageWidth = Number(viewBox[2]) - Number(viewBox[0]);
			pageHeight = Number(viewBox[3]) - Number(viewBox[1]);
		}
		return { items, pageWidth, pageHeight };
	}
	catch (e) {
		logger.debug(MODULE, `getTextLayerItems(${pageIndex}) failed`, e);
		return null;
	}
}

/**
 * Sample the page's paper colour from the rendered canvas.
 *
 * The overlay masks the paragraphs it replaces, and a hardcoded white mask
 * looks wrong on off-white scans, coloured pages, and Zotero's sepia/dark
 * reader themes. Sampling a handful of margin pixels and taking the most
 * common value makes the mask disappear into the page.
 *
 * Returns an "r,g,b" triple, or null when the canvas cannot be read.
 */
export function getPageBackground(reader: ReaderLike, pageIndex: number): [number, number, number] | null {
	try {
		const div = pageViewOf(reader, pageIndex)?.div as HTMLElement | undefined;
		const canvas = div?.querySelector('canvas') as HTMLCanvasElement | null;
		if (!canvas || !canvas.width || !canvas.height) {
			return null;
		}
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) {
			return null;
		}
		const w = canvas.width;
		const h = canvas.height;
		// Margin points: corners and edge midpoints, inset ~2% of the page.
		const inset = Math.max(2, Math.floor(Math.min(w, h) * 0.02));
		const points: [number, number][] = [
			[inset, inset], [w - inset, inset], [inset, h - inset], [w - inset, h - inset],
			[Math.floor(w / 2), inset], [Math.floor(w / 2), h - inset],
			[inset, Math.floor(h / 2)], [w - inset, Math.floor(h / 2)]
		];
		const counts = new Map<string, number>();
		for (const [x, y] of points) {
			const px = Math.min(w - 1, Math.max(0, x));
			const py = Math.min(h - 1, Math.max(0, y));
			const data = context.getImageData(px, py, 1, 1).data;
			// Ignore fully transparent pixels (PDF.js clears to transparent).
			if (data[3] === 0) {
				continue;
			}
			const key = `${data[0]},${data[1]},${data[2]}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		let best: string | null = null;
		let bestCount = 0;
		for (const [key, count] of counts) {
			if (count > bestCount) {
				best = key;
				bestCount = count;
			}
		}
		if (!best || bestCount < 2) {
			return null;
		}
		const parts = best.split(',').map(Number);
		return [parts[0]!, parts[1]!, parts[2]!];
	}
	catch (e) {
		logger.debug(MODULE, `getPageBackground(${pageIndex}) failed`, e);
		return null;
	}
}

/* --------------------------------------------------------------------------
 * Page bitmap access, for the rebuilt translated page.
 *
 * The 整页对照 view reproduces the page next to the original: same size, same
 * column grid, same figures, rules, header and footer — with the body text
 * re-typeset in the target language. Everything that is NOT text comes from
 * the page PDF.js already rendered, so figures and equations are pixel-exact
 * and nothing has to be re-rasterised.
 * ------------------------------------------------------------------------ */

export interface PageRender {
	/** The live PDF.js canvas. Read-only — never draw into this. */
	canvas: HTMLCanvasElement;
	/** Page box in CSS px at the current zoom (rotation-aware). */
	viewportWidth: number;
	viewportHeight: number;
	/** CSS px per PDF point at the current zoom. */
	scale: number;
	/** PDF point -> CSS px inside the viewport box. */
	toViewport(x: number, y: number): [number, number];
}

export function getPageRender(reader: ReaderLike, pageIndex: number): PageRender | null {
	try {
		const page = pageViewOf(reader, pageIndex);
		const div = page?.div as HTMLElement | undefined;
		const viewport = page?.viewport;
		const canvas = div?.querySelector('canvas') as HTMLCanvasElement | null;
		if (!canvas || !canvas.width || !canvas.height || typeof viewport?.convertToViewportPoint !== 'function') {
			return null;
		}
		const viewportWidth = Number(viewport.width) || canvas.width;
		const viewportHeight = Number(viewport.height) || canvas.height;
		const scale = Number(viewport.scale) > 0 ? Number(viewport.scale) : 1;
		return {
			canvas,
			viewportWidth,
			viewportHeight,
			scale,
			toViewport: (x: number, y: number) => {
				const [vx, vy] = viewport.convertToViewportPoint(x, y);
				return [Number(vx), Number(vy)];
			}
		};
	}
	catch (e) {
		logger.debug(MODULE, `getPageRender(${pageIndex}) failed`, e);
		return null;
	}
}

/**
 * Width of everything inside the reader browser that is NOT the PDF viewer —
 * Zotero's own sidebar (thumbnails, annotations) plus its resizer.
 *
 * Measured, not looked up: the PDF.js viewer lives in an iframe, and the
 * difference between the browser element's width and that iframe's width IS
 * the sidebar, whatever Zotero calls its elements this release. The split
 * view grants this inset to the browser on top of its half, so the visible
 * original page area and the translation pane end up pixel-equal.
 */
export function getViewerInsetWidth(reader: ReaderLike): number {
	try {
		const frame = (reader._internalReader?._primaryView?._iframeWindow as (Window & { frameElement?: Element }) | undefined)?.frameElement as HTMLElement | null;
		const browser = getReaderBrowser(reader) as HTMLElement | null;
		if (!frame || !browser) {
			return 0;
		}
		const browserWidth = browser.getBoundingClientRect().width;
		const viewerWidth = frame.getBoundingClientRect().width;
		if (browserWidth <= 0 || viewerWidth <= 0 || viewerWidth > browserWidth) {
			return 0;
		}
		return Math.round(browserWidth - viewerWidth);
	}
	catch {
		return 0;
	}
}

/** CSS px per PDF point at the reader's current zoom (viewport.scale). */
export function getViewerPxPerPoint(reader: ReaderLike): number {
	try {
		const viewer = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
		const scale = Number(viewer?._pages?.[0]?.viewport?.scale);
		return Number.isFinite(scale) && scale > 0 ? scale : 0;
	}
	catch {
		return 0;
	}
}

/**
 * Sizes of EVERY page, in PDF points (scale 1), whether rendered or not.
 *
 * PDF.js creates a PDFPageView per page as soon as the document loads, each
 * carrying a viewport at the current viewer scale — dividing that scale out
 * gives the page box without waiting for any rendering. This is what lets the
 * pane lay out the whole document up front.
 */
export function getAllPageSizes(reader: ReaderLike): { width: number; height: number }[] | null {
	try {
		const viewer = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
		const pages = viewer?._pages;
		if (!pages?.length) {
			return null;
		}
		const out: { width: number; height: number }[] = [];
		for (const page of pages) {
			const viewport = page?.viewport;
			const scale = Number(viewport?.scale) > 0 ? Number(viewport.scale) : 1;
			const width = Number(viewport?.width) / scale;
			const height = Number(viewport?.height) / scale;
			if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
				return null;
			}
			out.push({ width, height });
		}
		return out;
	}
	catch (e) {
		logger.debug(MODULE, 'getAllPageSizes failed', e);
		return null;
	}
}

/**
 * Render ONE page ourselves, at a chosen CSS width, independent of what the
 * viewer happens to have on screen.
 *
 * getPageRender() can only copy pages PDF.js currently keeps rendered — the
 * ones near the left viewport. A full-document translated pane needs every
 * page, so this goes to the pdf.js core API directly: getPage → getViewport →
 * render into a canvas of our own. `oversample` renders at a higher pixel
 * density than the CSS size for sharpness; the returned viewport numbers are
 * CSS px regardless, so callers never see the difference.
 *
 * The canvas is created in the INNER iframe document — pdf.js renders into a
 * context of its own compartment without Xray friction, and the outer pane can
 * still drawImage() from it (the copy path has always done exactly that).
 */
/**
 * Real image rectangles for one page, in PDF user-space coordinates, from the
 * operator list. Same poll-the-flags discipline as renderPageBitmap — content
 * promises are never awaited. Returns null when the operator list cannot be
 * had (caller falls back to the luminance grid).
 */
export async function getImageRectsPdf(
	reader: ReaderLike,
	pageIndex: number
): Promise<[number, number, number, number][] | null> {
	const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
	try {
		// 2.12.8: **每一跳都要穿 Xray**。2.9.9 就学过这一课 —— 模块开头写着
		// "凡是走 JS 对象方法的路都不通,走 DOM 的路都通";能用的
		// extractFromTextContent 在 window → PDFViewerApplication → pdfDocument
		// → getPage() 结果 → 内容 每一跳都套了 waive()。这两处取证是 2.9.9
		// **之前**写的,从未补上。
		//
		// 真机 2.12.7 的遥测把它钉死了:edgeSegments 全 0,而新加的
		// edgeByCode/edgeByShape/edgeSkipped **一个都没出现** —— 压根没走到解析;
		// gridMs≈55ms 正好是一次 50ms 轮询,即 getPage 之后就退出了。
		// 这也意味着图片矩形(同样的未 waive 代码)一直静默失效 ——
		// 它有亮度网格兜底,坏了没人会发现。
		const win = pdfWindow(reader);
		const pdfDocument = waive(waive(win?.PDFViewerApplication)?.pdfDocument);
		if (!pdfDocument?.getPage) {
			return null;
		}
		const got: { page: any; ops: any; failed: boolean } = { page: null, ops: null, failed: false };
		try {
			pdfDocument.getPage(pageIndex + 1).then(
				(p: unknown) => { got.page = waive(p); },
				() => { got.failed = true; }
			);
		}
		catch {
			return null;
		}
		for (let waited = 0; !got.page && !got.failed && waited < 4000; waited += 50) {
			await sleep(50);
		}
		if (!got.page?.getOperatorList) {
			return null;
		}
		try {
			got.page.getOperatorList().then(
				(o: unknown) => { got.ops = waive(o); },
				() => { got.failed = true; }
			);
		}
		catch {
			return null;
		}
		for (let waited = 0; !got.ops && !got.failed && waited < 5000; waited += 50) {
			await sleep(50);
		}
		if (!got.ops?.fnArray || !got.ops?.argsArray) {
			return null;
		}
		const winOps = waive(waive(win)?.pdfjsLib)?.OPS as Record<string, number> | undefined;
		return imageRectsFromOperatorList(got.ops.fnArray, got.ops.argsArray, winOps ?? {});
	}
	catch (e) {
		logger.debug(MODULE, 'getImageRectsPdf failed', e);
		return null;
	}
}

/**
 * 一页的表格边框线段 (2.12.4),PDF 用户空间。与 getImageRectsPdf 同一套
 * "轮询标志位、绝不 await 内容域 promise"的纪律 —— 拿不到就返回 null,
 * 调用方退回纯文字几何(与 2.12.3 行为逐字节一致)。
 */
export async function getPageEdgesPdf(
	reader: ReaderLike,
	pageIndex: number
): Promise<[number, number, number, number][] | null> {
	const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
	try {
		// 2.12.8: **每一跳都要穿 Xray**。2.9.9 就学过这一课 —— 模块开头写着
		// "凡是走 JS 对象方法的路都不通,走 DOM 的路都通";能用的
		// extractFromTextContent 在 window → PDFViewerApplication → pdfDocument
		// → getPage() 结果 → 内容 每一跳都套了 waive()。这两处取证是 2.9.9
		// **之前**写的,从未补上。
		//
		// 真机 2.12.7 的遥测把它钉死了:edgeSegments 全 0,而新加的
		// edgeByCode/edgeByShape/edgeSkipped **一个都没出现** —— 压根没走到解析;
		// gridMs≈55ms 正好是一次 50ms 轮询,即 getPage 之后就退出了。
		// 这也意味着图片矩形(同样的未 waive 代码)一直静默失效 ——
		// 它有亮度网格兜底,坏了没人会发现。
		const win = pdfWindow(reader);
		const pdfDocument = waive(waive(win?.PDFViewerApplication)?.pdfDocument);
		if (!pdfDocument?.getPage) {
			return null;
		}
		const got: { page: any; ops: any; failed: boolean } = { page: null, ops: null, failed: false };
		try {
			pdfDocument.getPage(pageIndex + 1).then(
				(p: unknown) => { got.page = waive(p); },
				() => { got.failed = true; }
			);
		}
		catch {
			return null;
		}
		for (let waited = 0; !got.page && !got.failed && waited < 4000; waited += 50) {
			await sleep(50);
		}
		if (!got.page?.getOperatorList) {
			return null;
		}
		try {
			got.page.getOperatorList().then(
				(o: unknown) => { got.ops = waive(o); },
				() => { got.failed = true; }
			);
		}
		catch {
			return null;
		}
		for (let waited = 0; !got.ops && !got.failed && waited < 5000; waited += 50) {
			await sleep(50);
		}
		if (!got.ops?.fnArray || !got.ops?.argsArray) {
			return null;
		}
		const winOps = waive(waive(win)?.pdfjsLib)?.OPS as Record<string, number> | undefined;
		// 2.12.7: 取证计数随线段一起交出去 —— 2.12.6 的遥测只告诉我"一条都没取到",
		// 却说不出为什么。现在能分清"没有绘图指令"、"码认不出靠形状认出来了"、
		// "子操作映射不平被跳过"这三种情形。
		const stats: SegmentScanStats = {
			ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false, shapeUnknown: 0, newShape: 0
		};
		const segs = segmentsFromOperatorList(got.ops.fnArray, got.ops.argsArray, winOps ?? {}, 20000, stats);
		lastSegmentScan = stats;
		return segs;
	}
	catch (e) {
		logger.debug(MODULE, 'getPageEdgesPdf failed', e);
		return null;
	}
}

export async function renderPageBitmap(
	reader: ReaderLike,
	pageIndex: number,
	cssWidth: number,
	oversample = 1.5
): Promise<PageRender | null> {
	const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
	try {
		const win = reader._internalReader?._primaryView?._iframeWindow;
		const pdfDocument = win?.PDFViewerApplication?.pdfDocument;
		const doc = win?.document as Document | undefined;
		if (!pdfDocument?.getPage || !doc || cssWidth <= 0) {
			return null;
		}

		// NEVER await a content-compartment promise directly. This codebase
		// already learned that lesson once with getPageData: a promise from the
		// PDF.js compartment can simply never settle for a sandbox awaiter, and
		// whoever awaits it hangs forever. Attach callbacks that set plain
		// flags, and POLL the flags with a deadline.
		const got: { page: any; failed: boolean } = { page: null, failed: false };
		try {
			pdfDocument.getPage(pageIndex + 1).then(
				(p: unknown) => { got.page = p; },
				() => { got.failed = true; }
			);
		}
		catch {
			return null;
		}
		{
			const deadline = Date.now() + 5000;
			while (!got.page && !got.failed && Date.now() < deadline) {
				await sleep(60);
			}
		}
		const page = got.page;
		if (!page) {
			return null;
		}

		const base = page.getViewport({ scale: 1 });
		const scale = cssWidth / Number(base.width);
		if (!Number.isFinite(scale) || scale <= 0) {
			return null;
		}
		const renderViewport = page.getViewport({ scale: scale * oversample });
		const canvas = doc.createElement('canvas') as HTMLCanvasElement;
		canvas.width = Math.max(1, Math.ceil(Number(renderViewport.width)));
		canvas.height = Math.max(1, Math.ceil(Number(renderViewport.height)));
		// willReadFrequently (2.1.7, 计划 PF-1): 完成轮询 sample() 反复 getImageData
		// 探测像素稳定性,声明后免去 GPU 回读。
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) {
			return null;
		}

		const done: { ok: boolean; failed: boolean } = { ok: false, failed: false };
		// RenderTask 持有引用 (2.0.6, 审核 P3): 失败/超时返回 null 后渲染任务
		// 此前继续在后台跑到天荒地老。放弃时显式 cancel。
		let renderTask: { promise: Promise<unknown>; cancel?: () => void } | null = null;
		const cancelRender = (): void => {
			try {
				renderTask?.cancel?.();
			}
			catch { /* pdf.js cancel 可因任务已结束而抛,无害 */ }
		};
		try {
			const task = page.render({ canvasContext: ctx, viewport: renderViewport }) as { promise: Promise<unknown>; cancel?: () => void };
			renderTask = task;
			task.promise.then(
				() => { done.ok = true; },
				() => { done.failed = true; }
			);
		}
		catch {
			return null;
		}

		// Completion: the promise flag when it works, and a pixel-stability
		// heuristic when it does not — the canvas starts fully transparent, so
		// once a sample of points is painted AND unchanged across two polls,
		// the page is done for every practical purpose.
		const sample = (): string => {
			try {
				const points: [number, number][] = [
					[canvas.width >> 1, canvas.height >> 1],
					[canvas.width >> 2, canvas.height >> 2],
					[(canvas.width * 3) >> 2, (canvas.height * 3) >> 2],
					[canvas.width >> 1, canvas.height - 4],
					[canvas.width - 4, canvas.height >> 1]
				];
				let out = '';
				let painted = false;
				for (const [x, y] of points) {
					const d = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
					if (d[3] !== 0) {
						painted = true;
					}
					out += `${d[0]},${d[1]},${d[2]},${d[3]};`;
				}
				return painted ? out : '';
			}
			catch {
				return '';
			}
		};
		const start = Date.now();
		let lastSig = '';
		let stable = 0;
		for (;;) {
			if (done.ok) {
				break;
			}
			if (done.failed) {
				cancelRender(); // 已失败: 释放任务引用 (幂等)
				return null;
			}
			if (Date.now() - start > 12000) {
				// Whatever is on the canvas after 12s is not a page.
				cancelRender(); // P3: 放弃时不再让渲染任务在后台继续跑
				return null;
			}
			await sleep(150);
			const sig = sample();
			if (sig && sig === lastSig) {
				stable++;
				if (stable >= 2 && Date.now() - start > 450) {
					break;
				}
			}
			else {
				stable = 0;
			}
			lastSig = sig;
		}

		const cssViewport = page.getViewport({ scale });
		return {
			canvas,
			viewportWidth: Number(cssViewport.width),
			viewportHeight: Number(cssViewport.height),
			scale,
			toViewport: (x: number, y: number) => {
				const [vx, vy] = cssViewport.convertToViewportPoint(x, y);
				return [Number(vx), Number(vy)];
			}
		};
	}
	catch (e) {
		logger.debug(MODULE, `renderPageBitmap(${pageIndex}) failed`, e);
		return null;
	}
}

/**
 * Where inside the current page the PDF viewport sits, as a 0–1 fraction of
 * the page's height (0 = page top at viewport top). Lets the rebuilt page
 * follow the reader's scrolling WITHIN a page, not just at page boundaries.
 */
export function getPageScrollFraction(reader: ReaderLike, pageIndex: number): number | null {
	try {
		const win = reader._internalReader?._primaryView?._iframeWindow;
		const viewer = win?.PDFViewerApplication?.pdfViewer;
		const container = viewer?.container as HTMLElement | undefined;
		const div = viewer?.getPageView?.(pageIndex)?.div as HTMLElement | undefined;
		if (!container || !div || !div.clientHeight) {
			return null;
		}
		const offset = container.scrollTop - div.offsetTop;
		// UNTRUNCATED anchor ratio: allow slightly negative / >1 so the pane maps
		// the reader's real position even when the page is only partly in view
		// (a page-top just above the viewport, a short page scrolled past). The
		// old 0–1 clamp snapped every partial position to the page edge, which is
		// what made the right side jump on page transitions. A wide guard keeps a
		// stray value from throwing the pane far off.
		const ratio = offset / div.clientHeight;
		return Number.isFinite(ratio) ? Math.max(-0.5, Math.min(1.5, ratio)) : null;
	}
	catch {
		return null;
	}
}

/** Page indexes PDF.js currently has rendered (so we only draw what's visible). */
export function getRenderedPageIndexes(reader: ReaderLike): number[] {
	try {
		const viewer = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
		const pages = viewer?._pages ?? [];
		const out: number[] = [];
		for (let i = 0; i < pages.length; i++) {
			if (pages[i]?.div?.querySelector?.('.textLayer, canvas')) {
				out.push(i);
			}
		}
		return out;
	}
	catch {
		return [];
	}
}

/**
 * Subscribe to PDF.js render lifecycle events so the overlay can be redrawn
 * after zooming, rotating or scrolling a page back into view.
 * Returns a disposer; never throws.
 */
export const PDF_RENDER_EVENTS = ['pagerendered', 'textlayerrendered', 'scalechanging', 'rotationchanging', 'updateviewarea'];

/**
 * `updateviewarea` fires on every scroll frame. A subscriber that only needs to
 * follow real geometry changes (zoom, rotation, re-render) should pass
 * PDF_GEOMETRY_EVENTS instead and save itself the storm.
 */
export const PDF_GEOMETRY_EVENTS = ['pagerendered', 'textlayerrendered', 'scalechanging', 'rotationchanging'];

export function onPdfRenderEvents(
	reader: ReaderLike,
	handler: (pageIndex: number | null) => void,
	eventNames: string[] = PDF_RENDER_EVENTS
): () => void {
	const events = eventNames;
	let bus: { on?: (t: string, h: (e: unknown) => void) => void; off?: (t: string, h: (e: unknown) => void) => void } | null = null;
	const wrapped = (event: unknown): void => {
		const pageNumber = (event as { pageNumber?: number })?.pageNumber;
		handler(typeof pageNumber === 'number' ? pageNumber - 1 : null);
	};
	try {
		bus = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.eventBus ?? null;
		if (bus?.on) {
			for (const type of events) {
				bus.on(type, wrapped);
			}
		}
	}
	catch (e) {
		logger.debug(MODULE, 'onPdfRenderEvents subscription failed', e);
	}
	return () => {
		try {
			if (bus?.off) {
				for (const type of events) {
					bus.off(type, wrapped);
				}
			}
		}
		catch {
			// reader may be gone
		}
	};
}

/** Inject a stylesheet into the inner PDF.js document (for overlay styling). */
export function injectPdfStyle(reader: ReaderLike, id: string, css: string): void {
	try {
		const doc = reader._internalReader?._primaryView?._iframeWindow?.document as Document | undefined;
		if (!doc || doc.getElementById(id)) {
			return;
		}
		const style = doc.createElement('style');
		style.id = id;
		style.textContent = css;
		(doc.head ?? doc.documentElement).appendChild(style);
	}
	catch (e) {
		logger.debug(MODULE, 'injectPdfStyle failed', e);
	}
}

export function removePdfStyle(reader: ReaderLike, id: string): void {
	try {
		reader._internalReader?._primaryView?._iframeWindow?.document?.getElementById(id)?.remove();
	}
	catch {
		// ignore
	}
}

/** Current text selection inside the PDF view, if any. */
export function getSelectedText(reader: ReaderLike): string {
	try {
		const win = reader._internalReader?._primaryView?._iframeWindow;
		const selection = win?.getSelection?.();
		return selection ? String(selection.toString()) : '';
	}
	catch {
		return '';
	}
}

/**
 * Register the toolbar event listener. MUST pass pluginID so Zotero removes
 * the listener automatically on plugin shutdown (9.0.6's manual unregister
 * is broken — see header comment).
 */
export function registerToolbarListener(pluginID: string, handler: (event: ZoteroReaderEvent) => void): void {
	Zotero.Reader.registerEventListener('renderToolbar', handler, pluginID);
}

/**
 * Official text-selection popup hook (documented event type in 9.0.6
 * registerEventListener JSDoc). event.params.annotation.text carries the
 * selected text. Cleanup happens via pluginID on shutdown, same as toolbar.
 */
export function registerSelectionPopupListener(pluginID: string, handler: (event: ZoteroReaderEvent) => void): void {
	Zotero.Reader.registerEventListener('renderTextSelectionPopup', handler, pluginID);
}

/**
 * Nudge an already-open reader to re-render its toolbar so the injected
 * button appears without waiting for an organic re-render. Uses the public
 * setToolbarPlaceholderWidth state setter (a benign state change). The two
 * calls are separated by a task boundary — React batches synchronous state
 * updates, and a same-tick set/reset nets to "no change" (no re-render).
 */
export function forceToolbarRerender(reader: ReaderLike): void {
	try {
		const internal = reader._internalReader;
		if (!internal?.setToolbarPlaceholderWidth) {
			return;
		}
		const current = internal._state?.toolbarPlaceholderWidth ?? 0;
		internal.setToolbarPlaceholderWidth(current + 1);
		setTimeout(() => {
			try {
				internal.setToolbarPlaceholderWidth(current);
			}
			catch {
				// reader may be gone
			}
		}, 150);
	}
	catch (e) {
		logger.debug(MODULE, 'forceToolbarRerender failed (harmless)', e);
	}
}

/**
 * The reader toolbar's plugin section (<div class="custom-sections"> inside
 * <div class="toolbar"> → ".end"; reader submodule
 * src/common/components/toolbar.js + custom-sections.js). Used as a direct
 * injection target for readers whose toolbar was rendered before our
 * renderToolbar listener registered. Nodes placed here are cleared by the
 * next organic toolbar re-render (replaceChildren), after which the event
 * listener re-adds the button — so direct injection never duplicates.
 */
export function getToolbarCustomSections(reader: ReaderLike): Element | null {
	try {
		const doc = reader._iframeWindow?.document;
		return doc?.querySelector('.toolbar .custom-sections') ?? null;
	}
	catch {
		return null;
	}
}

/** Theme detection for the pane (light/dark), based on the reader iframe. */
export function isDarkTheme(reader: ReaderLike): boolean {
	try {
		const win = reader._iframeWindow;
		if (win && 'matchMedia' in win) {
			return (win as Window).matchMedia('(prefers-color-scheme: dark)').matches;
		}
	}
	catch {
		// fall through
	}
	return false;
}

/**
 * 订阅主题变化 (2.10.0)。
 *
 * 在此之前 `isDarkTheme` 只在建窗格时读**一次**(readerSession 里一处调用),
 * 之后再没人问过。于是开着窗格切换系统/Zotero 主题,窗格会一直停在旧主题,
 * 直到关掉重开 —— 而 Zotero 的其余界面当场就变了,窗格成了唯一不变的那块。
 *
 * 返回取消订阅函数。拿不到 matchMedia 就返回一个空函数,调用方不必分支。
 */
export function watchTheme(reader: ReaderLike, onChange: (dark: boolean) => void): () => void {
	try {
		const win = reader._iframeWindow;
		if (!win || !('matchMedia' in win)) {
			return () => { /* 无法订阅 */ };
		}
		const mql = (win as Window).matchMedia('(prefers-color-scheme: dark)');
		const handler = (): void => {
			try {
				onChange(mql.matches);
			}
			catch (e) {
				logger.debug(MODULE, 'theme change handler failed', e);
			}
		};
		mql.addEventListener('change', handler);
		return () => {
			try {
				mql.removeEventListener('change', handler);
			}
			catch {
				// 阅读器已经拆掉了,没什么可解绑的
			}
		};
	}
	catch (e) {
		logger.debug(MODULE, 'watchTheme unavailable', e);
		return () => { /* 无法订阅 */ };
	}
}
