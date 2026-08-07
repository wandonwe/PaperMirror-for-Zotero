/**
 * On-page translation overlay ("覆盖式").
 *
 * Draws the translation directly onto the rendered PDF page: for every source
 * paragraph we place an opaque box over the exact line rects it occupied and
 * typeset the translation inside, shrinking the font until it fits. Figures,
 * equations, tables, headers and the column grid are never touched, so the
 * paper's structure is preserved pixel-for-pixel.
 *
 * Boxes are keyed to per-line rects (grouped into column runs), so a paragraph
 * that wrapped from the left to the right column is covered by two boxes and
 * the translation flows across them in reading order.
 *
 * All undocumented reader access goes through zoteroReaderAdapter.
 */

import type { SourceBlock } from '../types/models';
import * as logger from '../utils/logger';
import {
	distributeText,
	groupLineRects,
	initialFontSize,
	isOverlayableType,
	rectToCssBox,
	type PdfRect
} from './overlayLayout';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'pdfOverlay';
const STYLE_ID = 'pm-overlay-style';
const LAYER_CLASS = 'pm-overlay-layer';
const BOX_CLASS = 'pm-overlay-box';

/**
 * Styling lives inside the PDF.js document. `mix-blend-mode` is avoided so the
 * overlay stays legible under Zotero's reader colour themes (which apply a
 * filter to the whole page — our boxes inherit it and stay consistent).
 */
const OVERLAY_CSS = `
.${LAYER_CLASS} {
	position: absolute;
	inset: 0;
	z-index: 3;
	pointer-events: none;
}
.${BOX_CLASS} {
	position: absolute;
	box-sizing: border-box;
	overflow: hidden;
	display: flex;
	align-items: center;
	background: var(--pm-overlay-bg, #fff);
	color: var(--pm-overlay-fg, #111);
	font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC",
		"Noto Serif SC", Georgia, serif;
	line-height: 1.28;
	text-align: justify;
	padding: 0 1px;
	border-radius: 2px;
	pointer-events: auto;
	transition: opacity .12s ease;
	cursor: default;
	user-select: text;
}
.${BOX_CLASS} > span {
	display: block;
	width: 100%;
}
/* Hover reveals the original underneath */
.${BOX_CLASS}:hover {
	opacity: 0;
}
.${LAYER_CLASS}[data-pm-peek="true"] .${BOX_CLASS} {
	opacity: 0;
}
.${BOX_CLASS}[data-pm-heading="true"] {
	font-weight: 700;
}
.${BOX_CLASS}[data-pm-pending="true"] {
	background: var(--pm-overlay-pending, rgba(255, 255, 255, .82));
	color: #8b93a0;
	font-style: italic;
}
`;

export interface OverlayPageData {
	blocks: SourceBlock[];
	translations: Map<string, string>;
}

export class PdfOverlay {
	private reader: ReaderLike;
	private enabled = false;
	private disposeEvents: (() => void) | null = null;
	private pages = new Map<number, OverlayPageData>();
	private redrawTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;
	private peekHandler: ((event: KeyboardEvent) => void) | null = null;

	constructor(reader: ReaderLike) {
		this.reader = reader;
	}

	isEnabled(): boolean {
		return this.enabled;
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

	/** Feed (or refresh) the data for one page and redraw it. */
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

	// ---- rendering ----------------------------------------------------------

	private subscribe(): void {
		if (this.disposeEvents) {
			return;
		}
		this.disposeEvents = adapter.onPdfRenderEvents(this.reader, (pageIndex) => {
			this.scheduleRedraw(pageIndex ?? undefined);
		});
		// Hold Alt to peek at the original underneath the whole page
		const doc = adapter.getPageView(this.reader, 0)?.doc;
		if (doc) {
			this.peekHandler = (event: KeyboardEvent) => {
				if (event.key === 'Alt' || event.altKey) {
					this.setPeek(event.type === 'keydown');
				}
			};
			doc.addEventListener('keydown', this.peekHandler);
			doc.addEventListener('keyup', this.peekHandler);
		}
	}

	private setPeek(on: boolean): void {
		for (const pageIndex of this.pages.keys()) {
			const view = adapter.getPageView(this.reader, pageIndex);
			const layer = view?.div.querySelector(`.${LAYER_CLASS}`) as HTMLElement | null;
			layer?.setAttribute('data-pm-peek', String(on));
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
		}, 60);
	}

	private removeLayer(pageIndex: number): void {
		const view = adapter.getPageView(this.reader, pageIndex);
		view?.div.querySelectorAll(`.${LAYER_CLASS}`).forEach(node => node.remove());
	}

	private drawPage(pageIndex: number): void {
		const data = this.pages.get(pageIndex);
		const view = adapter.getPageView(this.reader, pageIndex);
		if (!data || !view) {
			return;
		}
		// PDF.js rebuilds page content on re-render, so always start clean.
		view.div.querySelectorAll(`.${LAYER_CLASS}`).forEach(node => node.remove());

		const layer = view.doc.createElement('div');
		layer.className = LAYER_CLASS;

		let drawn = 0;
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
					return; // nothing to show in this box
				}
				const [x1, y1] = view.toCss(run.rect[0], run.rect[3]); // top-left
				const [x2, y2] = view.toCss(run.rect[2], run.rect[1]); // bottom-right
				const box = rectToCssBox([x1, y1], [x2, y2], 1);
				if (box.width < 8 || box.height < 6) {
					return;
				}
				const el = view.doc.createElement('div');
				el.className = BOX_CLASS;
				el.style.left = `${box.left}px`;
				el.style.top = `${box.top}px`;
				el.style.width = `${box.width}px`;
				el.style.height = `${box.height}px`;
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
				layer.appendChild(el);
				// Fit after insertion so measurements are real
				this.fitFontSize(el, span, box.height, run.lineCount);
				drawn++;
			});
		}

		if (drawn > 0) {
			// The .page element must be a positioning context (PDF.js sets
			// position: relative already, but be explicit and harmless).
			if (!view.div.style.position) {
				view.div.style.position = 'relative';
			}
			view.div.appendChild(layer);
		}
	}

	/** Binary-search the largest font size whose text still fits the box. */
	private fitFontSize(box: HTMLElement, span: HTMLElement, boxHeight: number, lineCount: number): void {
		let hi = initialFontSize(boxHeight, lineCount);
		let lo = 4;
		const fits = (size: number): boolean => {
			span.style.fontSize = `${size}px`;
			return span.scrollHeight <= boxHeight + 1 && span.scrollWidth <= box.clientWidth + 1;
		};
		if (fits(hi)) {
			return;
		}
		for (let i = 0; i < 8 && hi - lo > 0.3; i++) {
			const mid = (hi + lo) / 2;
			if (fits(mid)) {
				lo = mid;
			}
			else {
				hi = mid;
			}
		}
		span.style.fontSize = `${lo.toFixed(1)}px`;
		// Very long translations: allow a tighter line box rather than clipping
		if (span.scrollHeight > boxHeight + 1) {
			span.style.lineHeight = '1.12';
		}
	}

	// ---- teardown -----------------------------------------------------------

	private teardownLayers(): void {
		if (this.disposeEvents) {
			this.disposeEvents();
			this.disposeEvents = null;
		}
		if (this.peekHandler) {
			try {
				const doc = adapter.getPageView(this.reader, 0)?.doc;
				doc?.removeEventListener('keydown', this.peekHandler);
				doc?.removeEventListener('keyup', this.peekHandler);
			}
			catch {
				// reader may be gone
			}
			this.peekHandler = null;
		}
		if (this.redrawTimer) {
			clearTimeout(this.redrawTimer);
			this.redrawTimer = null;
		}
		for (const pageIndex of this.pages.keys()) {
			this.removeLayer(pageIndex);
		}
		// Also sweep any page we no longer track
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
