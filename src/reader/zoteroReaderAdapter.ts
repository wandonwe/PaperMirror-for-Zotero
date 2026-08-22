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

/** Inner PDF.js window (reader submodule: _primaryView._iframeWindow). */
function getPdfApplication(reader: ReaderLike): any {
	const win = reader._internalReader?._primaryView?._iframeWindow;
	const app = win?.PDFViewerApplication;
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
	try {
		const div = pageViewOf(reader, pageIndex)?.div as HTMLElement | undefined;
		const layer = div?.querySelector?.('.textLayer');
		return !!layer && !!layer.querySelector('span');
	}
	catch {
		return false;
	}
}

/**
 * Wait (briefly) for PDF.js to render the text layer of a page. Resolves false
 * if the page never renders one — the caller then falls through to the next
 * extraction path rather than reporting "no text layer".
 */
export async function waitForTextLayer(reader: ReaderLike, pageIndex: number, timeoutMs = 2500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (hasRenderedTextLayer(reader, pageIndex)) {
			return true;
		}
		// Only worth waiting if PDF.js knows about the page at all.
		if (!pageViewOf(reader, pageIndex)) {
			return false;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return hasRenderedTextLayer(reader, pageIndex);
}

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
		const win = reader._internalReader?._primaryView?._iframeWindow;
		const pdfDocument = win?.PDFViewerApplication?.pdfDocument;
		if (!pdfDocument?.getPage) {
			return null;
		}
		const got: { page: any; ops: any; failed: boolean } = { page: null, ops: null, failed: false };
		try {
			pdfDocument.getPage(pageIndex + 1).then(
				(p: unknown) => { got.page = p; },
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
				(o: unknown) => { got.ops = o; },
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
		const winOps = (win as { pdfjsLib?: { OPS?: Record<string, number> } } | undefined)?.pdfjsLib?.OPS;
		return imageRectsFromOperatorList(got.ops.fnArray, got.ops.argsArray, winOps ?? {});
	}
	catch (e) {
		logger.debug(MODULE, 'getImageRectsPdf failed', e);
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
		const ctx = canvas.getContext('2d');
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
