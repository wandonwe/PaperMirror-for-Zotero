/**
 * On-page translation overlay ("覆盖式").
 *
 * The translation is painted directly onto the rendered PDF page: for every
 * source paragraph an overlay box is placed over the exact line rects it
 * occupied and the translation is typeset inside. Figures, equations, tables
 * and the column grid are never touched, so the paper's structure survives
 * pixel-for-pixel.
 *
 * Display modes
 *   dim-original     原文淡化 — the page canvas is dimmed and the translation
 *                    sits on a translucent card, so the original layout stays
 *                    visible as a reference (default).
 *   translation-only 仅译文 — opaque cards, the page reads as a translated PDF.
 *   hover            悬停显示 — the page is untouched; a card appears only for
 *                    the paragraph under the pointer.
 *
 * Fit modes
 *   strict 严格覆盖 — the box keeps the original rect, font shrinks to fit.
 *   expand 智能扩展 — the box may grow downward into free space in the same
 *                    column (never sideways, never over a neighbour).
 *
 * IMPORTANT (corrects a common assumption): dimming `.textLayer` does nothing.
 * Zotero runs PDF.js with textLayerMode 1, so the text layer is transparent
 * selection-only markup; the visible glyphs live on the <canvas>. Dimming must
 * therefore target .canvasWrapper / canvas.
 *
 * All undocumented reader access goes through zoteroReaderAdapter.
 */

import type { SourceBlock } from '../types/models';
import * as logger from '../utils/logger';
import {
	distributeText,
	groupLineRects,
	isOverlayableType,
	rectToCssBox,
	type PdfRect
} from './overlayLayout';
import {
	availableHeight,
	fontSizeBounds,
	shrinkRatio,
	type CssBox,
	type FitMode
} from './textFitter';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'pdfOverlay';
const STYLE_ID = 'pm-overlay-style';
const LAYER_CLASS = 'pm-overlay-layer';
const BOX_CLASS = 'pm-overlay-box';

export type OverlayDisplayMode = 'dim-original' | 'translation-only' | 'hover';

const OVERLAY_CSS = `
.${LAYER_CLASS} {
	position: absolute;
	inset: 0;
	z-index: 4;
	pointer-events: none;
	overflow: hidden;
}
.${BOX_CLASS} {
	position: absolute;
	box-sizing: border-box;
	overflow: hidden;
	display: flex;
	align-items: flex-start;
	padding: 1px 3px;
	border-radius: 3px;
	color: #15171a;
	background: rgba(255, 255, 255, .94);
	font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC",
		"Noto Serif SC", Georgia, serif;
	line-height: 1.35;
	text-align: justify;
	pointer-events: auto;
	user-select: text;
	transition: opacity .12s ease;
	cursor: default;
}
.${BOX_CLASS} > span { display: block; width: 100%; }
.${BOX_CLASS}[data-pm-heading="true"] { font-weight: 700; }
.${BOX_CLASS}[data-pm-pending="true"] {
	background: rgba(255, 255, 255, .72);
	color: #8b93a0;
	font-style: italic;
}

/* --- 原文淡化: dim the CANVAS (the text layer is invisible by design) --- */
.pm-overlay-dim .canvasWrapper,
.pm-overlay-dim canvas { opacity: .14; }
.pm-overlay-dim .${BOX_CLASS} { background: rgba(255, 255, 255, .88); }

/* --- 仅译文 --- */
.pm-overlay-solid .${BOX_CLASS} { background: #fff; }

/* --- 悬停显示: cards are invisible until hovered --- */
.pm-overlay-hover .${BOX_CLASS} { opacity: 0; background: rgba(255, 255, 255, .97); }
.pm-overlay-hover .${BOX_CLASS}:hover { opacity: 1; box-shadow: 0 2px 10px rgba(0,0,0,.16); }

/* Hover any box to peek at the original underneath (non-hover modes) */
.pm-overlay-dim .${BOX_CLASS}:hover,
.pm-overlay-solid .${BOX_CLASS}:hover { opacity: 0; }

/* Alt held: hide the whole layer so the page can be selected/annotated */
.${LAYER_CLASS}[data-pm-peek="true"] { opacity: 0; pointer-events: none; }
.pm-overlay-dim[data-pm-peek="true"] .canvasWrapper,
.pm-overlay-dim[data-pm-peek="true"] canvas { opacity: 1; }
`;

export interface OverlayPageData {
	blocks: SourceBlock[];
	translations: Map<string, string>;
}

interface PendingBox {
	el: HTMLElement;
	span: HTMLElement;
	box: CssBox;
	lineCount: number;
}

export class PdfOverlay {
	private reader: ReaderLike;
	private enabled = false;
	private displayMode: OverlayDisplayMode = 'dim-original';
	private fitMode: FitMode = 'strict';
	private disposeEvents: (() => void) | null = null;
	private pages = new Map<number, OverlayPageData>();
	private redrawTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;
	private peekHandler: ((event: KeyboardEvent) => void) | null = null;
	private peekDoc: Document | null = null;
	/** Fraction of boxes whose text had to be shrunk a lot (quality signal). */
	private lastShrinkWarnings = 0;

	constructor(reader: ReaderLike) {
		this.reader = reader;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getShrinkWarnings(): number {
		return this.lastShrinkWarnings;
	}

	setEnabled(enabled: boolean): void {
		if (this.destroyed || this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			adapter.injectPdfStyle(this.reader, STYLE_ID, OVERLAY_CSS);
			this.subscribe();
			this.scheduleRedraw();
		}
		else {
			this.teardownLayers();
		}
	}

	setDisplayMode(mode: OverlayDisplayMode): void {
		this.displayMode = mode;
		if (this.enabled) {
			this.scheduleRedraw();
		}
	}

	setFitMode(mode: FitMode): void {
		this.fitMode = mode;
		if (this.enabled) {
			this.scheduleRedraw();
		}
	}

	setPageData(pageIndex: number, data: OverlayPageData): void {
		this.pages.set(pageIndex, data);
		if (this.enabled) {
			this.scheduleRedraw(pageIndex);
		}
	}

	clearPage(pageIndex: number): void {
		this.pages.delete(pageIndex);
		this.removeLayer(pageIndex);
	}

	// ---- lifecycle ----------------------------------------------------------

	private subscribe(): void {
		if (!this.disposeEvents) {
			// PDF.js virtualises pages: one that scrolls far out of view is
			// destroyed and re-rendered on return, firing pagerendered again.
			this.disposeEvents = adapter.onPdfRenderEvents(this.reader, (pageIndex) => {
				this.scheduleRedraw(pageIndex ?? undefined);
			});
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
		if (this.redrawTimer) {
			clearTimeout(this.redrawTimer);
		}
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = null;
			if (this.destroyed || !this.enabled) {
				return;
			}
			const targets = pageIndex !== undefined ? [pageIndex] : [...this.pages.keys()];
			for (const p of targets) {
				try {
					this.drawPage(p);
				}
				catch (e) {
					logger.debug(MODULE, `drawPage(${p}) failed`, e);
				}
			}
		}, 80);
	}

	private removeLayer(pageIndex: number): void {
		const view = adapter.getPageView(this.reader, pageIndex);
		if (!view) {
			return;
		}
		view.div.querySelectorAll(`.${LAYER_CLASS}`).forEach(node => node.remove());
		view.div.classList.remove('pm-overlay-dim', 'pm-overlay-solid', 'pm-overlay-hover');
		view.div.removeAttribute('data-pm-peek');
	}

	// ---- drawing ------------------------------------------------------------

	private drawPage(pageIndex: number): void {
		const data = this.pages.get(pageIndex);
		const view = adapter.getPageView(this.reader, pageIndex);
		if (!data || !view) {
			return;
		}
		// PDF.js rebuilds page content on re-render, so always start clean.
		this.removeLayer(pageIndex);

		const layer = view.doc.createElement('div');
		layer.className = LAYER_CLASS;
		const pageHeight = view.div.clientHeight || view.div.getBoundingClientRect().height;

		// Pass 1 — compute every box for this page (needed for collision-aware
		// expansion, which must know where the following block starts).
		const pending: PendingBox[] = [];
		const allBoxes: CssBox[] = [];

		for (const block of data.blocks) {
			if (!isOverlayableType(block.type) || block.isReference) {
				continue;
			}
			const lineRects = (block.lineRectsPdf ?? []) as PdfRect[];
			if (!lineRects.length) {
				continue;
			}
			const translated = data.translations.get(block.id);
			const runs = groupLineRects(lineRects);
			const parts = distributeText(translated ?? '', runs);

			runs.forEach((run, i) => {
				const text = parts[i] ?? '';
				if (translated !== undefined && !text) {
					return;
				}
				const [x1, y1] = view.toCss(run.rect[0], run.rect[3]); // top-left
				const [x2, y2] = view.toCss(run.rect[2], run.rect[1]); // bottom-right
				const box = rectToCssBox([x1, y1], [x2, y2], 1);
				if (box.width < 8 || box.height < 6) {
					return;
				}
				const el = view.doc.createElement('div');
				el.className = BOX_CLASS;
				if (block.type === 'heading' || block.type === 'title') {
					el.setAttribute('data-pm-heading', 'true');
				}
				const span = view.doc.createElement('span');
				if (translated === undefined) {
					el.setAttribute('data-pm-pending', 'true');
					span.textContent = '…';
				}
				else {
					span.textContent = text; // SAFE: text node only
				}
				el.appendChild(span);
				el.title = block.sourceText;
				pending.push({ el, span, box, lineCount: run.lineCount });
				allBoxes.push(box);
			});
		}

		if (!pending.length) {
			return;
		}

		// Pass 2 — place, optionally expand, then fit the type.
		this.lastShrinkWarnings = 0;
		for (const item of pending) {
			const height = availableHeight(item.box, allBoxes, pageHeight, this.fitMode);
			item.el.style.left = `${item.box.left}px`;
			item.el.style.top = `${item.box.top}px`;
			item.el.style.width = `${item.box.width}px`;
			item.el.style.height = `${height}px`;
			layer.appendChild(item.el);
		}

		// Measure only after everything is in the document.
		for (const item of pending) {
			const height = item.el.getBoundingClientRect().height || item.box.height;
			const size = this.fitFontSize(item.el, item.span, height, item.lineCount);
			if (shrinkRatio(size, item.box.height, item.lineCount) < 0.62) {
				this.lastShrinkWarnings++;
			}
		}

		view.div.classList.add(
			this.displayMode === 'dim-original' ? 'pm-overlay-dim'
				: this.displayMode === 'hover' ? 'pm-overlay-hover'
					: 'pm-overlay-solid'
		);
		if (!view.div.style.position) {
			view.div.style.position = 'relative';
		}
		view.div.appendChild(layer);
	}

	/** Binary-search the largest font size whose text still fits. */
	private fitFontSize(box: HTMLElement, span: HTMLElement, boxHeight: number, lineCount: number): number {
		const { min, max } = fontSizeBounds(boxHeight, lineCount);
		const fits = (size: number): boolean => {
			span.style.fontSize = `${size}px`;
			return span.scrollHeight <= boxHeight + 1 && span.scrollWidth <= box.clientWidth + 1;
		};
		if (fits(max)) {
			return max;
		}
		let lo = min;
		let hi = max;
		for (let i = 0; i < 9 && hi - lo > 0.25; i++) {
			const mid = (hi + lo) / 2;
			if (fits(mid)) {
				lo = mid;
			}
			else {
				hi = mid;
			}
		}
		span.style.fontSize = `${lo.toFixed(1)}px`;
		if (span.scrollHeight > boxHeight + 1) {
			span.style.lineHeight = '1.15';
		}
		return lo;
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
		lines.push(`Boxes needing heavy shrink on last draw: ${this.lastShrinkWarnings}`);
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
		for (const pageIndex of this.pages.keys()) {
			this.removeLayer(pageIndex);
		}
		for (const pageIndex of adapter.getRenderedPageIndexes(this.reader)) {
			this.removeLayer(pageIndex);
		}
		adapter.removePdfStyle(this.reader, STYLE_ID);
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
