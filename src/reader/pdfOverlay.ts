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
 *   translation-only 仅译文 — the paragraph is masked in the page's own paper
 *                    colour and the translation typeset on top, so the page
 *                    reads as a translated PDF (default).
 *   dim-original     原文淡化 — the same, but the mask is translucent so the
 *                    original stays faintly visible underneath as a reference.
 *   hover            悬停显示 — the page is untouched; a card appears only for
 *                    the paragraph under the pointer.
 *
 * Fit modes
 *   expand 智能扩展 — the box may grow downward into free space in the same
 *                    column, capped so it can never reach a figure (default).
 *   strict 严格覆盖 — the box keeps the original rect exactly.
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
	MIN_READABLE_PX,
	TYPE_LADDER,
	type CssBox,
	type FitMode
} from './textFitter';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'pdfOverlay';
const STYLE_ID = 'pm-overlay-style';
const LAYER_CLASS = 'pm-overlay-layer';
const BOX_CLASS = 'pm-overlay-box';
const MASK_CLASS = 'pm-overlay-mask';
const CAPSULE_CLASS = 'pm-overlay-capsule';

/** Attribute-selector escaping for block ids (they contain '#'). */
function CSS_ESCAPE(value: string): string {
	return value.replace(/["\\]/g, '\\$&');
}

export type OverlayDisplayMode = 'dim-original' | 'translation-only' | 'hover';

const OVERLAY_CSS = `
.${LAYER_CLASS} {
	position: absolute;
	inset: 0;
	z-index: 4;
	pointer-events: none;
	/* No overflow:hidden — an expanded box must be able to show its tail. */
	--pm-paper: #fff;
	--pm-ink: #15171a;
}
/* One mask per SOURCE LINE — never one rectangle over the paragraph. The
   union rect would swallow the last line's ragged tail, the first line's
   indent and anything the text wraps around. */
.${MASK_CLASS} {
	position: absolute;
	background: var(--pm-paper);
	pointer-events: none;
	transition: opacity .12s ease;
}
.${BOX_CLASS} {
	position: absolute;
	box-sizing: border-box;
	display: block;
	padding: 0 1px;
	color: var(--pm-ink);
	/* Transparent: the masks underneath supply the paper. */
	background: transparent;
	/* A UI sans face stays legible at 9px where a serif turns to mush. */
	font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
		"Noto Sans CJK SC", "Source Han Sans SC", "Segoe UI", system-ui, sans-serif;
	line-height: 1.42;
	/* Justify makes short CJK lines gappy; ragged-right reads better here. */
	text-align: left;
	text-justify: none;
	word-break: normal;
	overflow-wrap: break-word;
	overflow: hidden;
	pointer-events: auto;
	user-select: text;
	transition: opacity .12s ease;
	cursor: default;
}
.${BOX_CLASS} > span { display: block; width: 100%; }
.${BOX_CLASS}[data-pm-heading="true"] { font-weight: 600; }
.${BOX_CLASS}[data-pm-pending="true"] {
	color: color-mix(in srgb, var(--pm-ink) 38%, transparent);
	font-style: italic;
}

/* --- 仅译文 (default): opaque paper-coloured masks --- */
.pm-overlay-solid .${MASK_CLASS} { opacity: 1; }

/* --- 原文淡化: translucent masks, original faintly readable underneath.
       Only the MASKS are translucent — the page canvas is never touched, so
       figures, tables and equations stay perfectly crisp. --- */
.pm-overlay-dim .${MASK_CLASS} { opacity: .88; }

/* 悬停看原文 — the answer to 「原文没对照了」.
   Covering the page is the whole point of 覆盖模式, but the reader still has
   to be able to check a sentence against the original. Hovering a translated
   paragraph fades ITS mask and ITS text (nothing else on the page moves), so
   the English underneath is readable for as long as the pointer stays. This
   is per-paragraph and instant — no mode switch, no round trip. */
.${LAYER_CLASS}[data-pm-peekhover="true"] .${BOX_CLASS}:hover {
	opacity: .06;
}
.${LAYER_CLASS}[data-pm-peekhover="true"] .${BOX_CLASS}:hover ~ .${BOX_CLASS} {
	/* siblings unaffected — declared so the rule above cannot cascade */
	opacity: inherit;
}
.${MASK_CLASS}[data-pm-lifted="true"] {
	opacity: 0 !important;
}

/* --- 悬停显示: nothing is painted until the pointer arrives --- */
.pm-overlay-hover .${MASK_CLASS} { opacity: 0; }
.pm-overlay-hover .${BOX_CLASS} { opacity: 0; }
.pm-overlay-hover .${BOX_CLASS}:hover {
	opacity: 1;
	background: var(--pm-paper);
	box-shadow: 0 1px 8px rgba(0, 0, 0, .18);
}

/* Text that did not fit even at the minimum size, after the whole type ladder
   was spent: an ellipsis marker in the corner. CLICK pins the box open with
   the full translation — hover-only was too easy to lose by accident while
   reading, and impossible on a trackpad mid-scroll. */
.${BOX_CLASS}[data-pm-overflow="true"] {
	cursor: zoom-in;
}
.${BOX_CLASS}[data-pm-overflow="true"]::after {
	content: "…";
	position: absolute;
	right: 1px;
	bottom: -1px;
	padding: 0 2px;
	font-size: 11px;
	line-height: 1;
	color: color-mix(in srgb, var(--pm-ink) 55%, transparent);
	background: var(--pm-paper);
	border-radius: 3px;
	box-shadow: -4px 0 6px var(--pm-paper);
	pointer-events: none;
}
.${BOX_CLASS}[data-pm-expanded="true"] {
	height: auto !important;
	min-height: 0;
	overflow: visible;
	z-index: 9;
	background: var(--pm-paper);
	box-shadow: 0 2px 14px rgba(0, 0, 0, .24);
	border-radius: 3px;
	cursor: zoom-out;
}
.${BOX_CLASS}[data-pm-expanded="true"]::after { content: none; }

/* Alt held: hide the whole layer so the page can be selected/annotated */
.${LAYER_CLASS}[data-pm-peek="true"] { opacity: 0; pointer-events: none; }

/* One consolidated status capsule (bottom-right). 覆盖原文模式 hides the side
   pane, so this capsule is its only progress/▉ feedback: a real progress ring,
   overall page position, per-page translate/place counts, and honest end states
   (done / partial / failed / cancelled). Replaces the old pill + floating
   refresh button, which were redundant. */
.${CAPSULE_CLASS} {
	position: fixed;
	right: 22px;
	bottom: 22px;
	z-index: 2147483000;
	display: flex;
	align-items: center;
	gap: 10px;
	width: 260px;
	min-height: 56px;
	box-sizing: border-box;
	padding: 10px 12px;
	border-radius: 16px;
	background: rgba(24, 26, 31, .9);
	color: #eef1f5;
	font: 12px/1.35 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif;
	box-shadow: 0 6px 22px rgba(0, 0, 0, .28);
	transition: opacity .18s ease, width .18s ease;
	cursor: pointer;
	user-select: none;
}
.${CAPSULE_CLASS}[data-pm-hidden="true"] { opacity: 0; pointer-events: none; }
.${CAPSULE_CLASS} .pm-ring { position: relative; flex: 0 0 auto; width: 34px; height: 34px; }
.${CAPSULE_CLASS} .pm-ring svg { width: 34px; height: 34px; display: block; transform: rotate(-90deg); }
.${CAPSULE_CLASS} .pm-ring circle { fill: none; stroke-width: 3.5; }
.${CAPSULE_CLASS} .pm-ring .pm-track { stroke: rgba(255, 255, 255, .16); }
.${CAPSULE_CLASS} .pm-ring .pm-arc { stroke: #6c9bff; stroke-linecap: round; transition: stroke-dashoffset .3s ease, stroke .2s ease; }
.${CAPSULE_CLASS} .pm-glyph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; }
.${CAPSULE_CLASS} .pm-body { flex: 1 1 auto; min-width: 0; }
.${CAPSULE_CLASS} .pm-main { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${CAPSULE_CLASS} .pm-sub { margin-top: 2px; opacity: .72; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.${CAPSULE_CLASS} .pm-action {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	justify-content: center;
	min-width: 26px;
	height: 26px;
	padding: 0 8px;
	border: none;
	border-radius: 8px;
	background: rgba(255, 255, 255, .08);
	color: inherit;
	font: inherit;
	cursor: pointer;
}
.${CAPSULE_CLASS} .pm-action:hover { background: rgba(255, 255, 255, .18); }
.${CAPSULE_CLASS} .pm-action svg { width: 15px; height: 15px; display: block; }
.${CAPSULE_CLASS}[data-pm-collapsed="true"] { width: auto; }
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-body,
.${CAPSULE_CLASS}[data-pm-collapsed="true"] .pm-action { display: none; }
.${CAPSULE_CLASS}[data-pm-phase="done"] .pm-arc { stroke: #37c871; }
.${CAPSULE_CLASS}[data-pm-phase="partial"] .pm-arc { stroke: #f5a623; }
.${CAPSULE_CLASS}[data-pm-phase="failed"] .pm-arc { stroke: #ff6b6b; }
.${CAPSULE_CLASS}[data-pm-phase="cancelled"] .pm-arc { stroke: rgba(255, 255, 255, .4); }
.${CAPSULE_CLASS}[data-pm-indeterminate="true"] .pm-ring svg { animation: pm-status-spin 1s linear infinite; }
@keyframes pm-status-spin { to { transform: rotate(360deg); } }
`;

export interface OverlayPageData {
	blocks: SourceBlock[];
	translations: Map<string, string>;
}

/** Overall/current-page progress the reader session feeds the status capsule. */
export type OverlayPhase = 'translating' | 'laying-out' | 'done' | 'partial' | 'failed' | 'cancelled';
export interface OverlayProgress {
	phase: OverlayPhase;
	/** 1-based current page and document page count (position, not a doc-wide bar). */
	currentPage: number;
	totalPages: number;
	/** Per-CURRENT-page segment counts. */
	segTotal: number;
	segTranslated: number;
	segPlaced: number;
	/** Segments that should have translated but were kept original (unfit / no response). */
	kept: number;
	/** For the failed phase. */
	message?: string;
}

interface CapsuleAction {
	kind: 'cancel' | 'retry' | 'view' | 'close';
	label: string;
	title?: string;
}

/** Normalized capsule render state — both setProgress and setStatus produce one. */
interface CapsuleState {
	phase: OverlayPhase;
	glyph: 'ring' | 'check' | 'warn' | 'error' | 'dot' | 'stop';
	indeterminate?: boolean;
	fraction: number | null;
	main: string;
	sub?: string;
	action?: CapsuleAction;
	autoHideMs?: number;
}

/** Map a progress model to the capsule's normalized state and final 文案. */
export function capsuleStateFor(m: OverlayProgress): CapsuleState {
	const pagePos = `第 ${m.currentPage} / ${m.totalPages} 页`;
	const counts = `翻译 ${m.segTranslated}/${m.segTotal} 段 · 排版 ${m.segPlaced}/${m.segTotal} 段`;
	switch (m.phase) {
		case 'translating':
			return {
				phase: m.phase,
				glyph: 'ring',
				indeterminate: m.segTotal <= 0,
				fraction: m.segTotal > 0 ? m.segTranslated / m.segTotal : null,
				main: `正在处理 ${pagePos}`,
				sub: m.segTotal > 0 ? counts : '正在识别段落',
				action: { kind: 'cancel', label: '×', title: '取消翻译' }
			};
		case 'laying-out':
			return {
				phase: m.phase,
				glyph: 'ring',
				fraction: m.segTotal > 0 ? m.segPlaced / m.segTotal : null,
				main: `正在适配 ${pagePos} 排版`,
				sub: counts,
				action: { kind: 'cancel', label: '×', title: '取消' }
			};
		case 'done':
			return {
				phase: m.phase,
				glyph: 'check',
				fraction: 1,
				main: `已完成 第 ${m.currentPage} 页`,
				autoHideMs: 2000
			};
		case 'partial':
			return {
				phase: m.phase,
				glyph: 'warn',
				fraction: m.segTotal > 0 ? m.segPlaced / m.segTotal : null,
				main: `第 ${m.currentPage} 页 · ${m.kept} 段保留原文`,
				sub: counts,
				action: { kind: 'view', label: '查看', title: '查看保留原文的段落' }
			};
		case 'failed':
			return {
				phase: m.phase,
				glyph: 'error',
				fraction: null,
				main: m.message ?? '翻译失败',
				action: { kind: 'retry', label: '重试', title: '重试翻译' }
			};
		case 'cancelled':
			return {
				phase: m.phase,
				glyph: 'stop',
				fraction: null,
				main: '已停止翻译',
				autoHideMs: 2600
			};
	}
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
	private displayMode: OverlayDisplayMode = 'translation-only';
	private fitMode: FitMode = 'expand';
	/** Sampled paper colour per page, so masks match the page (and the theme). */
	private paperColour = new Map<number, string>();
	private disposeEvents: (() => void) | null = null;
	private pages = new Map<number, OverlayPageData>();
	private redrawTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;
	private peekHandler: ((event: KeyboardEvent) => void) | null = null;
	private peekDoc: Document | null = null;
	/** Fraction of boxes whose text had to be shrunk a lot (quality signal). */
	private lastShrinkWarnings = 0;
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

	/** Actions the consolidated status capsule can invoke. */
	private capsule: {
		onCancel?: () => void;
		onRetry?: () => void;
		onViewPartial?: () => void;
	} = {};
	/** Last rendered capsule state, so a redraw can re-assert it. */
	private capsuleState: CapsuleState | null = null;
	private collapsed = false;
	private capsuleAutoHide: ReturnType<typeof setTimeout> | null = null;
	private capsuleCollapseTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(reader: ReaderLike, options: { onCancel?: () => void; onRetry?: () => void; onViewPartial?: () => void } = {}) {
		this.reader = reader;
		this.capsule = options;
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
			// Re-sample paper colour: the reader theme may have changed.
			this.paperColour.clear();
			adapter.injectPdfStyle(this.reader, STYLE_ID, OVERLAY_CSS);
			this.subscribe();
			this.scheduleRedraw();
		}
		else {
			this.teardownLayers();
		}
	}

	/**
	 * Progress chip inside the PDF view — the only feedback 覆盖模式 has while
	 * the pane is hidden. `null` hides it.
	 */
	/**
	 * Legacy generic-message API (open failures, PDF export progress). Rendered
	 * as a message in the SAME capsule so there is only ever one element.
	 */
	setStatus(text: string | null, options: { busy?: boolean; error?: boolean; check?: boolean } = {}): void {
		if (this.destroyed) {
			return;
		}
		if (!text) {
			this.setProgress(null);
			return;
		}
		this.renderCapsule({
			phase: options.error ? 'failed' : options.check ? 'done' : 'translating',
			glyph: options.error ? 'error' : options.check ? 'check' : 'dot',
			indeterminate: !!options.busy,
			fraction: null,
			main: text,
			autoHideMs: options.check ? 2000 : undefined
		});
	}

	/**
	 * The rich per-page progress model → the capsule. `null` dismisses it.
	 * Translation is lazy (current page + a couple prefetched), so there is no
	 * meaningful document-wide "N of M pages translated" bar — the honest signal
	 * is the current page's position plus its own translate/place counts.
	 */
	setProgress(model: OverlayProgress | null): void {
		if (this.destroyed) {
			return;
		}
		if (!model) {
			this.setProgress0();
			return;
		}
		this.renderCapsule(capsuleStateFor(model));
	}

	private setProgress0(): void {
		this.capsuleState = null;
		const doc = this.capsuleDoc();
		doc?.querySelector(`.${CAPSULE_CLASS}`)?.setAttribute('data-pm-hidden', 'true');
	}

	/** 覆盖原文模式 kept `setRefreshBusy` as a thin no-op for callers; progress now
	 * flows through setProgress instead. */
	setRefreshBusy(_busy: boolean): void {
		/* superseded by setProgress */
	}

	private capsuleDoc(): Document | null {
		try {
			return adapter.getPageView(this.reader, adapter.getCurrentPageIndex(this.reader))?.doc
				?? adapter.getPageView(this.reader, 0)?.doc
				?? null;
		}
		catch {
			return null;
		}
	}

	/** Build (once) and paint the single status capsule for a normalized state. */
	private renderCapsule(state: CapsuleState): void {
		this.capsuleState = state;
		if (this.capsuleAutoHide) {
			clearTimeout(this.capsuleAutoHide);
			this.capsuleAutoHide = null;
		}
		try {
			const doc = this.capsuleDoc();
			const body = doc?.body;
			if (!doc || !body) {
				return;
			}
			adapter.injectPdfStyle(this.reader, STYLE_ID, OVERLAY_CSS);
			const SVG_NS = 'http://www.w3.org/2000/svg';
			let el = doc.querySelector(`.${CAPSULE_CLASS}`) as HTMLElement | null;
			if (!el) {
				el = doc.createElement('div');
				el.className = CAPSULE_CLASS;
				const ring = doc.createElement('div');
				ring.className = 'pm-ring';
				const svg = doc.createElementNS(SVG_NS, 'svg');
				svg.setAttribute('viewBox', '0 0 34 34');
				const track = doc.createElementNS(SVG_NS, 'circle');
				track.setAttribute('class', 'pm-track');
				track.setAttribute('cx', '17'); track.setAttribute('cy', '17'); track.setAttribute('r', '15');
				const arc = doc.createElementNS(SVG_NS, 'circle');
				arc.setAttribute('class', 'pm-arc');
				arc.setAttribute('cx', '17'); arc.setAttribute('cy', '17'); arc.setAttribute('r', '15');
				svg.appendChild(track); svg.appendChild(arc);
				const glyph = doc.createElement('span');
				glyph.className = 'pm-glyph';
				ring.appendChild(svg); ring.appendChild(glyph);
				const bodyDiv = doc.createElement('div');
				bodyDiv.className = 'pm-body';
				const main = doc.createElement('div'); main.className = 'pm-main';
				const sub = doc.createElement('div'); sub.className = 'pm-sub';
				bodyDiv.appendChild(main); bodyDiv.appendChild(sub);
				const action = doc.createElement('button');
				action.className = 'pm-action'; action.type = 'button';
				el.appendChild(ring); el.appendChild(bodyDiv); el.appendChild(action);
				// Click the body toggles collapsed; the action button is separate.
				el.addEventListener('click', (e) => {
					if ((e.target as HTMLElement)?.closest('.pm-action')) {
						return;
					}
					this.collapsed = !this.collapsed;
					el!.setAttribute('data-pm-collapsed', String(this.collapsed));
				});
				body.appendChild(el);
			}
			el.removeAttribute('data-pm-hidden');
			el.setAttribute('data-pm-phase', state.phase);
			el.setAttribute('data-pm-collapsed', String(this.collapsed));
			el.setAttribute('data-pm-indeterminate', String(!!state.indeterminate));

			const C = 2 * Math.PI * 15;
			const arc = el.querySelector('.pm-arc') as SVGElement | null;
			if (arc) {
				arc.setAttribute('stroke-dasharray', String(C));
				const frac = state.indeterminate || state.fraction == null
					? 0.25
					: Math.max(0, Math.min(1, state.fraction));
				arc.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
			}
			const glyph = el.querySelector('.pm-glyph');
			if (glyph) {
				glyph.textContent = state.glyph === 'check' ? '✓'
					: state.glyph === 'warn' || state.glyph === 'error' ? '!'
						: state.glyph === 'stop' ? '—'
							: (!state.indeterminate && state.fraction != null && state.phase !== 'done')
								? `${Math.round(Math.max(0, Math.min(1, state.fraction)) * 100)}%`
								: '';
			}
			const main = el.querySelector('.pm-main');
			if (main) { main.textContent = state.main; }
			const sub = el.querySelector('.pm-sub') as HTMLElement | null;
			if (sub) {
				sub.textContent = state.sub ?? '';
				sub.style.display = state.sub ? '' : 'none';
			}
			const action = el.querySelector('.pm-action') as HTMLButtonElement | null;
			if (action) {
				if (state.action) {
					action.style.display = '';
					action.textContent = state.action.label;
					action.title = state.action.title ?? state.action.label;
					action.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						this.runCapsuleAction(state.action!.kind);
					};
				}
				else {
					action.style.display = 'none';
					action.onclick = null;
				}
			}
			if (state.autoHideMs) {
				this.capsuleAutoHide = setTimeout(() => {
					this.capsuleAutoHide = null;
					this.setProgress0();
				}, state.autoHideMs);
			}
		}
		catch (e) {
			logger.debug(MODULE, 'status capsule failed', e);
		}
	}

	private runCapsuleAction(kind: CapsuleAction['kind']): void {
		if (kind === 'cancel') {
			this.capsule.onCancel?.();
		}
		else if (kind === 'retry') {
			this.capsule.onRetry?.();
		}
		else if (kind === 'view') {
			this.capsule.onViewPartial?.();
		}
		else {
			this.setProgress0();
		}
	}

	private removeCapsule(): void {
		if (this.capsuleAutoHide) {
			clearTimeout(this.capsuleAutoHide);
			this.capsuleAutoHide = null;
		}
		this.capsuleState = null;
		try {
			const doc = adapter.getPageView(this.reader, 0)?.doc;
			doc?.querySelectorAll(`.${CAPSULE_CLASS}`).forEach(node => node.remove());
		}
		catch {
			// reader may be gone
		}
	}

	/**
	 * Hover a translated paragraph → its own masks lift and its text fades, so
	 * the original shows through in place. Bound per box; the layer-level
	 * attribute decides whether it is active.
	 */
	private bindPeekHover(layer: HTMLElement, box: HTMLElement): void {
		const runKey = box.getAttribute('data-pm-run');
		if (!runKey) {
			return;
		}
		const lift = (on: boolean): void => {
			if (!this.peekOnHover) {
				return;
			}
			layer.querySelectorAll(`.${MASK_CLASS}[data-pm-run="${CSS_ESCAPE(runKey)}"]`).forEach((node) => {
				if (on) {
					node.setAttribute('data-pm-lifted', 'true');
				}
				else {
					node.removeAttribute('data-pm-lifted');
				}
			});
		};
		box.addEventListener('mouseenter', () => lift(true));
		box.addEventListener('mouseleave', () => lift(false));
	}

	/** 悬停看原文 on/off. */
	setPeekOnHover(enabled: boolean): void {
		this.peekOnHover = enabled;
		try {
			const doc = adapter.getPageView(this.reader, 0)?.doc;
			doc?.querySelectorAll(`.${LAYER_CLASS}`).forEach((node) => {
				node.setAttribute('data-pm-peekhover', String(enabled));
				if (!enabled) {
					node.querySelectorAll(`.${MASK_CLASS}[data-pm-lifted]`).forEach(m => m.removeAttribute('data-pm-lifted'));
				}
			});
		}
		catch {
			// reader may be gone
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
			// Re-assert the capsule after a redraw — a page-view swap can replace
			// the document body the capsule lived in.
			if (this.capsuleState) {
				this.renderCapsule(this.capsuleState);
			}
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
		// Scroll-only events: same page size, our layer still attached →
		// nothing to do. Zoom and rotation both change these numbers, and a
		// re-render after virtualisation removes the layer, so every case that
		// genuinely needs a redraw still gets one.
		const signature = `${Math.round(view.div.clientWidth)}x${Math.round(view.div.clientHeight)}|${this.displayMode}|${this.fitMode}`;
		if (this.drawnSignature.get(pageIndex) === signature && view.div.querySelector(`.${LAYER_CLASS}`)) {
			return;
		}
		// PDF.js rebuilds page content on re-render, so always start clean.
		this.removeLayer(pageIndex);
		this.drawnSignature.set(pageIndex, signature);

		const layer = view.doc.createElement('div');
		layer.className = LAYER_CLASS;
		this.applyPaperColour(layer, pageIndex);
		const pageHeight = view.div.clientHeight || view.div.getBoundingClientRect().height;

		// Pass 1 — compute every box for this page (needed for collision-aware
		// expansion, which must know where the following block starts).
		const pending: PendingBox[] = [];
		const allBoxes: CssBox[] = [];
		const masks: HTMLElement[] = [];

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
				// Until the translation for this block arrives, the page stays
				// EXACTLY as printed. Masking a paragraph early — or dropping a
				// placeholder "…" on it — blanks the page while the reader is
				// still reading it, which is the opposite of what 覆盖模式 is for.
				if (translated === undefined || !text) {
					return;
				}
				const [x1, y1] = view.toCss(run.rect[0], run.rect[3]); // top-left
				const [x2, y2] = view.toCss(run.rect[2], run.rect[1]); // bottom-right
				const box = rectToCssBox([x1, y1], [x2, y2], 1);
				if (box.width < 8 || box.height < 6) {
					return;
				}
				// 局部遮盖: one mask per source line, sized to that line's own
				// rect. Painted first so every text box sits above every mask.
				const runKey = `${block.id}#${i}`;
				for (const line of run.lines) {
					const [lx1, ly1] = view.toCss(line[0], line[3]);
					const [lx2, ly2] = view.toCss(line[2], line[1]);
					const lineBox = rectToCssBox([lx1, ly1], [lx2, ly2], 1);
					if (lineBox.width < 4 || lineBox.height < 3) {
						continue;
					}
					const maskEl = view.doc.createElement('div');
					maskEl.className = MASK_CLASS;
					maskEl.setAttribute('data-pm-run', runKey);
					maskEl.style.left = `${lineBox.left}px`;
					maskEl.style.top = `${lineBox.top}px`;
					maskEl.style.width = `${lineBox.width}px`;
					maskEl.style.height = `${lineBox.height}px`;
					masks.push(maskEl);
				}
				const el = view.doc.createElement('div');
				el.className = BOX_CLASS;
				el.setAttribute('data-pm-run', runKey);
				if (block.type === 'heading' || block.type === 'title') {
					el.setAttribute('data-pm-heading', 'true');
				}
				const span = view.doc.createElement('span');
				span.textContent = text; // SAFE: text node only, never innerHTML
				el.appendChild(span);
				el.title = block.sourceText;
				pending.push({ el, span, box, lineCount: run.lineCount });
				allBoxes.push(box);
			});
		}

		if (!pending.length) {
			return;
		}

		// Pass 2 — masks first (they must sit under every text box), then
		// place, optionally expand, and fit the type.
		this.lastShrinkWarnings = 0;
		for (const maskEl of masks) {
			layer.appendChild(maskEl);
		}
		for (const item of pending) {
			const height = availableHeight(item.box, allBoxes, pageHeight, this.fitMode);
			item.el.style.left = `${item.box.left}px`;
			item.el.style.top = `${item.box.top}px`;
			item.el.style.width = `${item.box.width}px`;
			item.el.style.height = `${height}px`;
			this.bindPeekHover(layer, item.el);
			layer.appendChild(item.el);
		}
		layer.setAttribute('data-pm-peekhover', String(this.peekOnHover));

		// Measure only after everything is in the document.
		for (const item of pending) {
			const height = item.el.getBoundingClientRect().height || item.box.height;
			const size = this.fitFontSize(item.el, item.span, height, item.lineCount);
			if (shrinkRatio(size, item.box.height, item.lineCount) < 0.62) {
				this.lastShrinkWarnings++;
			}
		}

		// Restore the source reading order for the DOM (hover/expand stacking).
		layer.setAttribute('data-pm-mode', this.displayMode);

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

	/**
	 * Fit the translation into its box on three axes, in the order that costs
	 * the reader least: leading, then letter-spacing, then — only if those are
	 * exhausted — the font size, binary-searched and floored at
	 * MIN_READABLE_PX.
	 *
	 * The ladder is walked AT THE SOURCE SIZE first. The common case is a
	 * translation that runs one line long; tightening the leading absorbs that
	 * invisibly, where the old size-only search would have shrunk the whole
	 * paragraph. Only when no rung fits does the type get smaller.
	 *
	 * If even the floor overflows, the box keeps the readable size, is marked
	 * `data-pm-overflow` (an "…" appears in the corner) and a click pins it
	 * open with the full text. Shrinking to 4–6px to make it "fit" is what made
	 * 覆盖翻译 unreadable in the first place.
	 */
	private fitFontSize(box: HTMLElement, span: HTMLElement, boxHeight: number, lineCount: number): number {
		const { min, max } = fontSizeBounds(boxHeight, lineCount, MIN_READABLE_PX);
		const apply = (size: number, rung: number): void => {
			const step = TYPE_LADDER[Math.min(rung, TYPE_LADDER.length - 1)]!;
			span.style.fontSize = `${size}px`;
			span.style.lineHeight = String(step.lineHeight);
			span.style.letterSpacing = step.letterSpacingEm ? `${step.letterSpacingEm}em` : '';
		};
		const fits = (size: number, rung: number): boolean => {
			apply(size, rung);
			return span.scrollHeight <= boxHeight + 1 && span.scrollWidth <= box.clientWidth + 1;
		};

		// 1. the ladder, at full size
		for (let rung = 0; rung < TYPE_LADDER.length; rung++) {
			if (fits(max, rung)) {
				return max;
			}
		}

		// 2. shrink, with the ladder fully tightened
		const lastRung = TYPE_LADDER.length - 1;
		let lo = min;
		let hi = max;
		for (let i = 0; i < 9 && hi - lo > 0.25; i++) {
			const mid = (hi + lo) / 2;
			if (fits(mid, lastRung)) {
				lo = mid;
			}
			else {
				hi = mid;
			}
		}
		apply(lo, lastRung);
		const chosen = lo;

		// 3. still over: keep it readable, offer the full text on click.
		if (span.scrollHeight > boxHeight + 1) {
			box.setAttribute('data-pm-overflow', 'true');
			const full = span.textContent ?? '';
			box.title = full;
			if (!box.dataset.pmExpandBound) {
				box.dataset.pmExpandBound = '1';
				box.addEventListener('click', (event) => {
					// A click that is really a text selection must not toggle.
					const selection = box.ownerDocument?.defaultView?.getSelection?.();
					if (selection && String(selection).length > 1) {
						return;
					}
					event.stopPropagation();
					const open = box.getAttribute('data-pm-expanded') === 'true';
					box.setAttribute('data-pm-expanded', String(!open));
				});
			}
		}
		return chosen;
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
		this.drawnSignature.clear();
		this.removeCapsule();
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
