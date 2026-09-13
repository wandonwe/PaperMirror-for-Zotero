/**
 * On-page translation overlay ("覆盖式").
 *
 * The translation is painted directly onto the rendered PDF page. Since 3.1.0
 * the layer IS a strict page (ui/strictPageReplacement, the same engine the
 * 对照 page view uses — same renderDocPage, same table model, ink detection,
 * expansion ladder, compress retries and abandon reasons); only its base
 * bitmap copy is hidden so masks and text sit on the live PDF.js canvas.
 * Figures, equations, tables and the column grid are never touched.
 *
 * Display modes
 *   translation-only 仅译文 — the paragraph is masked in the page's own paper
 *                    colour and the translation typeset on top, so the page
 *                    reads as a translated PDF (default).
 *   dim-original     原文淡化 — the same, but the mask is translucent so the
 *                    original stays faintly visible underneath as a reference.
 *   hover            悬停显示 — the page is untouched; a card appears only for
 *                    the paragraph under the pointer.
 *
 * Fit modes (pre-3.1.0) are gone: expansion is the strict engine's own ladder.
 *
 * TWO THINGS THIS GETS RIGHT THAT ARE EASY TO GET WRONG:
 *
 *  1. Dimming `.textLayer` does nothing — Zotero runs PDF.js with
 *     textLayerMode 1, so the text layer is transparent selection-only markup
 *     and the visible glyphs live on the <canvas>.
 *  2. ...but dimming the whole canvas is also wrong, and was what made the
 *     overlay look broken: it washes out the figures, tables and equations the
 *     overlay deliberately does NOT translate, so the entire page turns grey
 *     around a few white cards. The mask must be per-paragraph, painted only
 *     over the rects being replaced, in the page's sampled paper colour.
 *
 * All undocumented reader access goes through zoteroReaderAdapter.
 */

import type { SourceBlock } from '../types/models';
import * as logger from '../utils/logger';
import {
	groupLineRects,
	rectToCssBox,
	type PdfRect
} from './overlayLayout';
import type { FitMode } from './textFitter';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';
import { StatusCapsule, CAPSULE_CSS, capsuleStateFor, type OverlayProgress, type OverlayPhase } from '../ui/statusCapsule';
import type { PageRenderResult } from '../ui/translationPane';
import paneCSS from '../ui/styles/translationPane.css';

// Re-exported so existing importers (readerSession, tests) keep their paths.
export { capsuleStateFor };
export type { OverlayProgress, OverlayPhase };

const MODULE = 'pdfOverlay';
const STYLE_ID = 'pm-overlay-style';
const REPAGE_STYLE_ID = 'pm-repage-style';
const LAYER_CLASS = 'pm-overlay-layer';

export type OverlayDisplayMode = 'dim-original' | 'translation-only' | 'hover';

/** 会话装进来的页面渲染器 —— 与 translationPane 的 setPageRenderer 同一签名、同一实现。 */
export type OverlayPageRenderer = (pageIndex: number, host: HTMLElement, width: number, signal: AbortSignal) => Promise<PageRenderResult>;

const OVERLAY_CSS = `
/* 覆盖层 = 一张严格页 (3.1.0)。层本身不接指针事件,只有译文块接(悬停看原文、
   双击讲解、右键重译),页面其余部分照常可选可批注。 */
.${LAYER_CLASS} {
	position: absolute;
	inset: 0;
	z-index: 4;
	pointer-events: none;
	--pm-paper: #fff;
	--pm-ink: #15171a;
}
.${LAYER_CLASS} .pm-repage {
	margin: 0;
	box-shadow: none;
	overflow: visible;
	pointer-events: none;
	/* 严格页把纸色写在行内样式上;覆盖时必须透明,否则整页盖白。 */
	background: transparent !important;
}
/* 底图副本不显示 —— 实时画布就在下面;位图仍在内存里供墨迹检测与纸色采样。 */
.${LAYER_CLASS} .pm-repage-canvas {
	visibility: hidden;
}
.${LAYER_CLASS} .pm-repage-text {
	pointer-events: none;
}
.${LAYER_CLASS} .pm-repage-block {
	pointer-events: auto;
}

/* --- 原文淡化: translucent masks, original faintly readable underneath.
       Only the MASKS are translucent — the page canvas is never touched, so
       figures, tables and equations stay perfectly crisp. --- */
.${LAYER_CLASS}[data-pm-mode="dim-original"] .pm-repage-mask { opacity: .88; }

/* --- 悬停显示: nothing is painted until the pointer arrives --- */
.${LAYER_CLASS}[data-pm-mode="hover"] .pm-repage-mask { opacity: 0; }
.${LAYER_CLASS}[data-pm-mode="hover"] .pm-repage-block { opacity: 0; }
.${LAYER_CLASS}[data-pm-mode="hover"] .pm-repage-block:hover {
	opacity: 1;
	background: var(--pm-block-paper, var(--pm-paper));
	box-shadow: 0 1px 8px rgba(0, 0, 0, .18);
}

/* Alt held: hide the whole layer so the page can be selected/annotated */
.${LAYER_CLASS}[data-pm-peek="true"] { opacity: 0; pointer-events: none; }

/* One consolidated status capsule (bottom-right). 覆盖原文模式 hides the side
   pane, so this capsule is its only progress/▉ feedback: a real progress ring,
   overall page position, per-page translate/place counts, and honest end states
   (done / partial / failed / cancelled). Replaces the old pill + floating
   refresh button, which were redundant. */
${CAPSULE_CSS}
`;

export interface OverlayPageData {
	blocks: SourceBlock[];
	translations: Map<string, string>;
}


export class PdfOverlay {
	private reader: ReaderLike;
	private enabled = false;
	private displayMode: OverlayDisplayMode = 'translation-only';
	private fitMode: FitMode = 'expand';
	/** Sampled paper colour per page, so masks match the page (and the theme). */
	private paperColour = new Map<number, string>();
	private disposeEvents: (() => void) | null = null;
	private pages = new Map<number, OverlayPageData>();
	private redrawTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Pages that need a redraw, ACCUMULATED between debounce ticks. During a zoom
	 * PDF.js fires pagerendered/textlayerrendered for many pages in quick
	 * succession; the old "clear the timer, keep only the last event's page"
	 * logic dropped every page but the last, so a page whose overlay PDF.js had
	 * just destroyed was never repainted and its translation vanished. We now
	 * merge every page that fired into one redraw pass.
	 */
	private dirtyPages = new Set<number>();
	/** A document-level event (scalechanging/rotationchanging) → redraw all. */
	private redrawAll = false;
	private destroyed = false;
	private peekHandler: ((event: KeyboardEvent) => void) | null = null;
	private peekDoc: Document | null = null;
	/** 严格页渲染器(会话装入);没有它覆盖层什么也不画。 */
	private renderer: OverlayPageRenderer | null = null;
	/** 每页在飞的渲染,新一轮开始时作废上一轮。 */
	private inFlight = new Map<number, AbortController>();
	/**
	 * Geometry the currently drawn layer was built for, per page.
	 *
	 * PDF.js fires `updateviewarea` continuously while scrolling, and redrawing
	 * every page on every frame both burns CPU and makes the text flicker. The
	 * overlay only has to follow REAL geometry changes — zoom, rotation, a
	 * re-render after virtualisation — and all of those change the page div's
	 * pixel size or destroy our layer outright.
	 */
	private drawnSignature = new Map<number, string>();
	/** 悬停看原文: hovering a paragraph reveals the source underneath it. */
	private peekOnHover = true;

	/** The one consolidated status capsule (shared with the pane). */
	private readonly statusCapsule: StatusCapsule;

	constructor(reader: ReaderLike, options: { onCancel?: () => void; onRetry?: () => void; onViewPartial?: () => void; onDismiss?: () => void; onRefreshRing?: () => void; onCollapsedChange?: (collapsed: boolean) => void } = {}) {
		this.reader = reader;
		this.statusCapsule = new StatusCapsule(
			() => {
				const doc = adapter.getPageView(this.reader, adapter.getCurrentPageIndex(this.reader))?.doc
					?? adapter.getPageView(this.reader, 0)?.doc;
				return doc?.body ? { doc, container: doc.body } : null;
			},
			options,
			() => adapter.injectPdfStyle(this.reader, STYLE_ID, OVERLAY_CSS)
		);
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Install the page renderer — the SAME renderDocPage the pane uses, so
	 * 覆盖 and 对照 typeset a page identically (3.1.0).
	 */
	setPageRenderer(renderer: OverlayPageRenderer): void {
		this.renderer = renderer;
		if (this.enabled) {
			this.drawnSignature.clear();
			this.scheduleRedraw();
		}
	}

	setEnabled(enabled: boolean): void {
		if (this.destroyed || this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			// Re-sample paper colour: the reader theme may have changed.
			this.paperColour.clear();
			// 严格页的样式表与面板同源 (3.1.0):.pm-repage* 规则全部按类名限定,
			// 注入 PDF.js 文档不会碰到它自己的任何东西。
			adapter.injectPdfStyle(this.reader, REPAGE_STYLE_ID, paneCSS);
			adapter.injectPdfStyle(this.reader, STYLE_ID, OVERLAY_CSS);
			this.subscribe();
			this.scheduleRedraw();
		}
		else {
			this.teardownLayers();
		}
	}

	/**
	 * Rich per-page progress → the capsule. Translation is lazy (current page +
	 * a couple prefetched), so there is no meaningful document-wide bar — the
	 * honest signal is the current page's position plus its translate/place
	 * counts. `null` dismisses it.
	 */
	setProgress(model: OverlayProgress | null): void {
		if (!this.destroyed) {
			this.statusCapsule.setProgress(model);
		}
	}

	/** Superseded by setProgress; kept as a no-op for older callers. */
	setRefreshBusy(_busy: boolean): void {
		/* progress now flows through setProgress */
	}

	/** Mirror the session-owned collapsed state onto this surface's capsule. */
	setCollapsed(collapsed: boolean): void {
		if (!this.destroyed) {
			this.statusCapsule.setCollapsed(collapsed);
		}
	}

	/** 悬停看原文 on/off. */
	setPeekOnHover(enabled: boolean): void {
		this.peekOnHover = enabled;
		try {
			const doc = adapter.getPageView(this.reader, 0)?.doc;
			doc?.querySelectorAll(`.${LAYER_CLASS}`).forEach((node) => {
				node.setAttribute('data-pm-peekhover', String(enabled));
			});
		}
		catch {
			// reader may be gone
		}
	}

	/** 显示模式只是层上的一个属性 (3.1.0):改它不必重排,直接改活着的层。 */
	setDisplayMode(mode: OverlayDisplayMode): void {
		this.displayMode = mode;
		try {
			const doc = adapter.getPageView(this.reader, 0)?.doc;
			doc?.querySelectorAll(`.${LAYER_CLASS}`).forEach((node) => {
				node.setAttribute('data-pm-mode', mode);
			});
		}
		catch {
			// reader may be gone
		}
	}

	/**
	 * 3.1.0 起无效:扩边由严格页自己的阶梯决定(先无损扩进邻近空白,再压缩、
	 * 缩字、保留原文),不再有"严格/扩展"两档。保留接口免得偏好读取处报错。
	 */
	setFitMode(mode: FitMode): void {
		this.fitMode = mode;
	}

	setPageData(pageIndex: number, data: OverlayPageData): void {
		this.pages.set(pageIndex, data);
		// New text for this page: the drawn layer is stale whatever the
		// geometry says.
		this.drawnSignature.delete(pageIndex);
		if (this.enabled) {
			this.scheduleRedraw(pageIndex);
		}
	}

	clearPage(pageIndex: number): void {
		this.pages.delete(pageIndex);
		this.paperColour.delete(pageIndex);
		this.drawnSignature.delete(pageIndex);
		this.removeLayer(pageIndex);
	}

	// ---- lifecycle ----------------------------------------------------------

	private subscribe(): void {
		if (!this.disposeEvents) {
			// PDF.js virtualises pages: one that scrolls far out of view is
			// destroyed and re-rendered on return, firing pagerendered again.
			// Geometry events ONLY. The overlay layer is a child of the page
			// div, so it scrolls with the page for free — subscribing to
			// `updateviewarea` meant a full re-measure of every box on every
			// scroll frame, for no visible benefit.
			this.disposeEvents = adapter.onPdfRenderEvents(this.reader, (pageIndex) => {
				this.scheduleRedraw(pageIndex ?? undefined);
			}, adapter.PDF_GEOMETRY_EVENTS);
		}
		if (!this.peekHandler) {
			const doc = adapter.getPageView(this.reader, 0)?.doc ?? null;
			if (doc) {
				this.peekDoc = doc;
				this.peekHandler = (event: KeyboardEvent) => {
					if (event.key === 'Alt' || event.key === 'Meta') {
						this.setPeek(event.type === 'keydown');
					}
				};
				doc.addEventListener('keydown', this.peekHandler);
				doc.addEventListener('keyup', this.peekHandler);
			}
		}
	}

	/** Alt held → hide the overlay so the original can be selected/annotated. */
	private setPeek(on: boolean): void {
		for (const pageIndex of this.pages.keys()) {
			const view = adapter.getPageView(this.reader, pageIndex);
			if (!view) {
				continue;
			}
			view.div.querySelector(`.${LAYER_CLASS}`)?.setAttribute('data-pm-peek', String(on));
			view.div.setAttribute('data-pm-peek', String(on));
		}
	}

	private scheduleRedraw(pageIndex?: number): void {
		// ACCUMULATE the request instead of overwriting the last one. A page-level
		// event marks that page dirty; a document-level event (undefined index,
		// i.e. scalechanging/rotationchanging) marks every page. The timer is NOT
		// reset per call — the first event opens an 80ms window and every event
		// inside it is merged, so no page is dropped during a zoom storm.
		if (pageIndex === undefined) {
			this.redrawAll = true;
		}
		else {
			this.dirtyPages.add(pageIndex);
		}
		if (this.redrawTimer) {
			return;
		}
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = null;
			const targets = this.redrawAll ? [...this.pages.keys()] : [...this.dirtyPages];
			this.redrawAll = false;
			this.dirtyPages.clear();
			if (this.destroyed || !this.enabled) {
				return;
			}
			for (const p of targets) {
				try {
					this.drawPage(p);
				}
				catch (e) {
					logger.debug(MODULE, `drawPage(${p}) failed`, e);
				}
			}
			// Re-assert the capsule after a redraw — a page-view swap can replace
			// the document body the capsule lived in.
			this.statusCapsule.reassert();
		}, 80);
	}

	/**
	 * Paint masks in the page's own paper colour rather than hardcoded white,
	 * so the overlay is invisible on off-white scans, coloured pages and
	 * Zotero's sepia/dark reader themes. Ink flips to light on a dark page.
	 */
	private applyPaperColour(layer: HTMLElement, pageIndex: number): void {
		let colour = this.paperColour.get(pageIndex);
		if (colour === undefined) {
			const sampled = adapter.getPageBackground(this.reader, pageIndex);
			// Do NOT cache a miss: the canvas may simply not be painted yet,
			// and we want the real colour on the next redraw.
			if (sampled) {
				colour = `rgb(${sampled[0]}, ${sampled[1]}, ${sampled[2]})`;
				this.paperColour.set(pageIndex, colour);
			}
		}
		if (colour) {
			layer.style.setProperty('--pm-paper', colour);
			const match = /rgb\((\d+), (\d+), (\d+)\)/.exec(colour);
			if (match) {
				const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
				layer.style.setProperty('--pm-ink', luminance < 0.5 ? '#f2f4f7' : '#15171a');
			}
		}
	}

	private removeLayer(pageIndex: number): void {
		const view = adapter.getPageView(this.reader, pageIndex);
		if (!view) {
			return;
		}
		view.div.querySelectorAll(`.${LAYER_CLASS}`).forEach(node => node.remove());
		view.div.removeAttribute('data-pm-peek');
	}

	// ---- drawing ------------------------------------------------------------

	/**
	 * 覆盖模式改走严格原位替换引擎 (3.1.0, 用户要求「覆盖翻译模式也要按对照翻译的
	 * 能力优化」)。
	 *
	 * 3.0.x 之前覆盖层有自己的一套排版:按行段分配译文、字号阶梯、放不下就裁掉加
	 * 「…」—— 没有表格模型、没有墨迹检测、没有扩边、没有放弃原因;而左右对照的
	 * 页面视图早已是 buildStrictPage(遮罩按行、量测后才提交、表格格模型、扩边
	 * 阶梯、压缩重试、几何审计、每个没显示的块都有 abandonReason)。两套引擎意味
	 * 着同一页在两种模式下译出两种结果,而且覆盖模式的「裁掉 + 省略号」正是排版
	 * 禁令里的头一条。
	 *
	 * 现在覆盖层就是一张严格页:会话把与面板**同一个** renderDocPage 装进来
	 * (setPageRenderer),本层充当它的槽。严格页自带一份底图副本 —— 覆盖时用 CSS
	 * 把副本藏起来(visibility:hidden,位图仍在内存里供墨迹检测与纸色采样),只让
	 * 遮罩画布和译文层盖在 PDF.js 的实时画布上。
	 *
	 * 原子替换语义保留:新层先挂进页节点(严格页的遮罩起初是空的、底图不可见,
	 * 所以它挂上去什么都看不见),渲染承诺兑现、块开始提交之后再摘旧层 —— 缩放
	 * 时旧译文一直在,直到新译文落地。
	 */
	private drawPage(pageIndex: number): void {
		const data = this.pages.get(pageIndex);
		const view = adapter.getPageView(this.reader, pageIndex);
		if (!data || !view || !this.renderer) {
			return;
		}
		const width = view.div.clientWidth;
		const height = view.div.clientHeight || view.div.getBoundingClientRect().height;
		if (width < 20 || height < 20) {
			return; // 缩放中途还没有几何 —— 签名不记,下一个事件重试
		}
		// Scroll-only events: same page size, our layer still attached →
		// nothing to do. Zoom and rotation both change these numbers, and a
		// re-render after virtualisation removes the layer, so every case that
		// genuinely needs a redraw still gets one.
		const signature = `${Math.round(width)}x${Math.round(height)}`;
		if (this.drawnSignature.get(pageIndex) === signature && view.div.querySelector(`.${LAYER_CLASS}`)) {
			return;
		}
		// 同页在飞的旧渲染作废 —— renderDocPage 的世代闸会让它在下一个检查点退出。
		this.inFlight.get(pageIndex)?.abort();
		const ctrl = new AbortController();
		this.inFlight.set(pageIndex, ctrl);

		const layer = view.doc.createElement('div');
		layer.className = LAYER_CLASS;
		layer.setAttribute('data-pm-mode', this.displayMode);
		layer.setAttribute('data-pm-peekhover', String(this.peekOnHover));
		this.applyPaperColour(layer, pageIndex);
		if (!view.div.style.position) {
			view.div.style.position = 'relative';
		}
		// 必须先入文档再渲染:严格页的量测(settleStrictPage)只对在文档里的节点
		// 有效,游离子树的 scrollHeight 恒为 0 (2.5.2 的教训,同样适用于这里)。
		view.div.appendChild(layer);

		void this.renderer(pageIndex, layer, width, ctrl.signal).then((result) => {
			if (ctrl.signal.aborted || this.destroyed || !this.enabled) {
				layer.remove();
				return;
			}
			// The node may have been swapped by PDF.js during the render; only
			// commit to a page div that is still live, else reschedule onto the
			// fresh one instead of leaving a layer on a node about to be discarded.
			const latest = adapter.getPageView(this.reader, pageIndex);
			if (!latest || latest.div !== view.div || !view.div.isConnected) {
				layer.remove();
				this.drawnSignature.delete(pageIndex);
				this.scheduleRedraw(pageIndex);
				return;
			}
			if (result !== 'translated' && result !== 'partial') {
				// 这页此刻没有可放的译文(原文页 / 重建失败):撤掉本层 —— 不能把一张
				// 原文副本盖在实时页上;旧层也撤,免得显示过期译文。签名不记:
				// 'degraded' 的页要靠下一个事件再试。
				layer.remove();
				for (const node of Array.from(view.div.querySelectorAll(`.${LAYER_CLASS}`))) {
					node.remove();
				}
				this.drawnSignature.delete(pageIndex);
				return;
			}
			this.bindPeekHover(layer);
			// 旧层在新层的块提交之后再摘。提交发生在 document.fonts.ready 之后的
			// 最终量测里(通常已就绪 → 一两个微任务),这里等两帧再摘,缩放不闪原文。
			const win = view.doc.defaultView;
			const dropOld = (): void => {
				for (const node of Array.from(view.div.querySelectorAll(`.${LAYER_CLASS}`))) {
					if (node !== layer) {
						node.remove();
					}
				}
			};
			if (win?.requestAnimationFrame) {
				win.requestAnimationFrame(() => win.requestAnimationFrame(dropOld));
			}
			else {
				dropOld();
			}
			// Signature recorded ONLY now that a real layer is mounted — an aborted
			// or empty draw above leaves it unset so the next event retries.
			this.drawnSignature.set(pageIndex, signature);
		}).catch((e) => {
			layer.remove();
			logger.debug(MODULE, `overlay render failed on page ${pageIndex + 1}`, e);
		});
	}

	/**
	 * 悬停看原文:指针停在某个已提交的译文块上,它自己的遮罩清掉、译文隐去,
	 * 原文在原位露出;移开即恢复。逐块、即时,不动页面上任何别的东西。
	 * 由严格页的 pmPeek 实现(只对已提交块生效)。
	 */
	private bindPeekHover(layer: HTMLElement): void {
		const page = layer.querySelector('[data-pm-strict="true"]') as (HTMLElement & { pmPeek?: (ids: string[], on: boolean) => void }) | null;
		if (!page?.pmPeek) {
			return;
		}
		for (const node of Array.from(layer.querySelectorAll('[data-pm-block]')) as HTMLElement[]) {
			const id = node.getAttribute('data-pm-block');
			if (!id) {
				continue;
			}
			node.addEventListener('mouseenter', () => {
				if (this.peekOnHover) {
					page.pmPeek?.([id], true);
				}
			});
			node.addEventListener('mouseleave', () => page.pmPeek?.([id], false));
		}
	}

	// ---- diagnostics --------------------------------------------------------

	/**
	 * Coordinate self-check: reports, for the first few blocks of a page, the
	 * computed overlay box next to the position of the PDF.js text-layer span
	 * holding the same text. Large deltas mean the coordinate assumption is
	 * wrong for this document.
	 */
	verifyCoordinates(pageIndex: number): string {
		const data = this.pages.get(pageIndex);
		const view = adapter.getPageView(this.reader, pageIndex);
		if (!view) {
			return `Page ${pageIndex + 1} is not rendered.`;
		}
		if (!data) {
			return `No extracted blocks for page ${pageIndex + 1} yet.`;
		}
		const lines: string[] = [
			`Page ${pageIndex + 1}: page div ${Math.round(view.div.clientWidth)}×${Math.round(view.div.clientHeight)} css px`,
			`Text layer present: ${!!view.div.querySelector('.textLayer')}; canvas present: ${!!view.div.querySelector('canvas')}`
		];
		const pageRect = view.div.getBoundingClientRect();
		const spans = Array.from(view.div.querySelectorAll('.textLayer span')) as HTMLElement[];
		let checked = 0;
		for (const block of data.blocks) {
			if (checked >= 3 || !block.lineRectsPdf?.length) {
				continue;
			}
			const run = groupLineRects(block.lineRectsPdf as PdfRect[])[0];
			if (!run) {
				continue;
			}
			const [x1, y1] = view.toCss(run.rect[0], run.rect[3]);
			const [x2, y2] = view.toCss(run.rect[2], run.rect[1]);
			const box = rectToCssBox([x1, y1], [x2, y2]);
			const head = block.sourceText.slice(0, 24);
			const match = spans.find(s => s.textContent && head.startsWith(s.textContent.trim().slice(0, 8)) && s.textContent.trim().length > 3);
			let delta = 'no matching text-layer span';
			if (match) {
				const r = match.getBoundingClientRect();
				const spanLeft = r.left - pageRect.left;
				const spanTop = r.top - pageRect.top;
				delta = `textLayer(${spanLeft.toFixed(1)}, ${spanTop.toFixed(1)}) Δ=(${(box.left - spanLeft).toFixed(1)}, ${(box.top - spanTop).toFixed(1)})`;
			}
			lines.push(`  "${head}…" overlay(${box.left.toFixed(1)}, ${box.top.toFixed(1)}, ${box.width.toFixed(1)}×${box.height.toFixed(1)}) ${delta}`);
			checked++;
		}
		return lines.join('\n');
	}

	// ---- teardown -----------------------------------------------------------

	private teardownLayers(): void {
		if (this.disposeEvents) {
			this.disposeEvents();
			this.disposeEvents = null;
		}
		if (this.peekHandler && this.peekDoc) {
			try {
				this.peekDoc.removeEventListener('keydown', this.peekHandler);
				this.peekDoc.removeEventListener('keyup', this.peekHandler);
			}
			catch {
				// reader may be gone
			}
		}
		this.peekHandler = null;
		this.peekDoc = null;
		if (this.redrawTimer) {
			clearTimeout(this.redrawTimer);
			this.redrawTimer = null;
		}
		for (const ctrl of this.inFlight.values()) {
			ctrl.abort();
		}
		this.inFlight.clear();
		for (const pageIndex of this.pages.keys()) {
			this.removeLayer(pageIndex);
		}
		for (const pageIndex of adapter.getRenderedPageIndexes(this.reader)) {
			this.removeLayer(pageIndex);
		}
		this.drawnSignature.clear();
		this.statusCapsule.remove();
		adapter.removePdfStyle(this.reader, STYLE_ID);
		adapter.removePdfStyle(this.reader, REPAGE_STYLE_ID);
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.teardownLayers();
		this.destroyed = true;
		this.enabled = false;
		this.pages.clear();
	}
}
