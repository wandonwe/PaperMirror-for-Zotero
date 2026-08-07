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

/**
 * Fallback text extraction without coordinates via the public-ish
 * Zotero.PDFWorker.getFullText. Returns per-page plain text.
 */
export async function getFullTextPages(itemID: number): Promise<string[]> {
	try {
		const result = await Zotero.PDFWorker.getFullText(itemID, null, true);
		const text = result?.text ?? '';
		return text.split('\f');
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
export function onPdfRenderEvents(reader: ReaderLike, handler: (pageIndex: number | null) => void): () => void {
	const events = ['pagerendered', 'textlayerrendered', 'scalechanging', 'rotationchanging', 'updateviewarea'];
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
