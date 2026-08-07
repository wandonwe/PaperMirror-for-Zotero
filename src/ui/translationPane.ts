/**
 * Translation pane UI — DOM structure mirrors demo/index.html exactly:
 *
 *   header  .pm-title-row   → [eyebrow(live dot + PAPERMIRROR) + h2 镜像译文]
 *                             [swap] [settings] [close]
 *           .pm-controls-row→ [源语言 → 目标语言] [服务商] [重新翻译]
 *           .pm-status-row  → ✓ 第 N 页已翻译 · 来自本地缓存
 *   scroll  → 讲解卡片 / 第 N 页 分隔 / 译文段落(原文小字 + 衬线译文)
 *   footer  → 显示原文对照 · 同步滚动 · 复制译文 · 保存到笔记
 *
 * Security: every dynamic string is rendered via textContent or a text node.
 * Model/remote content is NEVER assigned to innerHTML.
 */

import { isFormulaRun } from '../reader/formulaGuard';
import * as logger from '../utils/logger';
import type { ExplanationSection } from '../translation/explainer';
import type { PageTranslationState } from '../translation/translationManager';
import type { SourceBlock } from '../types/models';

const MODULE = 'translationPane';
/** How far the rebuilt page may be scaled up to fill the pane. */
const PAGE_MAX_UPSCALE = 2.4;
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Icon paths copied from demo/index.html
const ICON_PATHS = {
	swap: 'm7 7-4 4 4 4M3 11h13M17 17l4-4-4-4M21 13H8',
	settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.01V3h4v.08a1.7 1.7 0 0 0 1.03 1.53 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.96 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z',
	close: 'm6 6 12 12M18 6 6 18',
	refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7'
} as const;

export interface PaneStrings {
	eyebrow: string;
	title: string;
	explain: string;
	explainTitle: string;
	explainSubtitle: string;
	explainCopy: string;
	explainSave: string;
	showOriginal: string;
	overlay: string;
	syncScroll: string;
	statusTranslating: string; // template with %n%
	statusDone: string; // template with %n%
	statusCached: string;
	statusError: string;
	noTextLayer: string;
	pagePrefix: string;
	pageSuffix: string;
	retranslate: string;
	copy: string;
	saveNote: string;
	settings: string;
	close: string;
	swapSides: string;
	pending: string;
	/** Retained for the Zotero.PaperMirror.exportTranslatedPdf() entry point,
	 *  which no longer has a button in the pane. */
	exportPdf: string;
	exportPdfTip: string;
	viewArticle: string;
	viewPage: string;
	privacyNotice: string;
	privacyAccept: string;
}

export interface PaneCallbacks {
	onExplainBlock(pageIndex: number, blockId: string): void;
	onCopyExplanation(): void;
	onSaveExplanationNote(): void;
	onToggleShowOriginal(enabled: boolean): void;
	onToggleOverlay(enabled: boolean): void;
	onToggleSync(enabled: boolean): void;
	onRetranslate(): void;
	onCopy(mode: 'plain' | 'both'): void;
	onSaveNote(): void;
	onExportPdf(): void;
	onToggleViewKind(kind: 'page' | 'article'): void;
	onOpenSettings(): void;
	onClose(): void;
	onSwapSides(): void;
	onBlockClick(pageIndex: number, blockId: string): void;
	onScrolledToPage(pageIndex: number): void;
	onAcceptPrivacy(): void;
}

interface PageSection {
	marker: HTMLElement;
	blocksHost: HTMLElement;
	status: HTMLElement;
}

export class TranslationPane {
	private host: HTMLElement;
	private doc: Document;
	private strings: PaneStrings;
	private callbacks: PaneCallbacks;

	private scroll!: HTMLElement;
	private articleHost!: HTMLElement;
	private statusRow!: HTMLElement;
	private statusMain!: HTMLElement;
	private statusSub!: HTMLElement;
	private languagePill!: HTMLElement;
	private providerName!: HTMLElement;
	private providerMark!: HTMLElement;
	private originalSwitch!: HTMLElement;
	private overlaySwitch!: HTMLElement;
	private syncSwitch!: HTMLElement;
	private toastEl!: HTMLElement;
	private toastText!: HTMLElement;
	private toastTimer: ReturnType<typeof setTimeout> | null = null;
	private statusNote!: HTMLElement;
	private statusTimer: ReturnType<typeof setTimeout> | null = null;
	private lastStatusSignature = '';

	private pages = new Map<number, PageSection>();
	private selectedBlockId: string | null = null;
	private privacyNoticeEl: HTMLElement | null = null;
	private scrollHandler: (() => void) | null = null;
	private keyHandler: ((event: KeyboardEvent) => void) | null = null;

	/**
	 * 'page'    整页对照 — the page rebuilt with translated body text, read as
	 *           a spread beside the original PDF (default).
	 * 'article' 流式译文 — the translation as a continuous article.
	 */
	private viewKind: 'page' | 'article' = 'page';
	private pageRenderer: ((pageIndex: number, host: HTMLElement, width: number) => boolean) | null = null;
	private pageHost: HTMLElement | null = null;
	private currentPage = -1;
	private compareOriginal = false;
	private resizeObserver: { disconnect(): void } | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private lastWidth = 0;
	private viewKindButton: HTMLElement | null = null;
	private sideButton: HTMLElement | null = null;
	private sideFill: HTMLElement | null = null;
	private paneSide: 'left' | 'right' = 'right';
	/** Circuit breaker: draw timestamps, newest last. */
	private drawTimes: number[] = [];

	constructor(host: HTMLElement, _title: string, strings: PaneStrings, callbacks: PaneCallbacks) {
		this.host = host;
		this.doc = host.ownerDocument!;
		this.strings = strings;
		this.callbacks = callbacks;
		this.build();
	}

	// ---- element helpers ----------------------------------------------------

	private el(tag: string, className?: string, text?: string): HTMLElement {
		const node = this.doc.createElementNS(HTML_NS, tag) as HTMLElement;
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}

	private svgIcon(paths: string): Element {
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		for (const d of paths.split(' M').map((p, i) => (i === 0 ? p : 'M' + p))) {
			const path = this.doc.createElementNS(SVG_NS, 'path');
			path.setAttribute('d', d);
			svg.appendChild(path);
		}
		return svg;
	}

	private iconButton(pathD: string, title: string, onClick: () => void, extraClass = ''): HTMLElement {
		const btn = this.el('button', `pm-icon-button${extraClass ? ' ' + extraClass : ''}`);
		btn.setAttribute('title', title);
		btn.setAttribute('aria-label', title);
		btn.appendChild(this.svgIcon(pathD));
		btn.addEventListener('click', onClick);
		return btn;
	}

	private textButton(className: string, label: string, title: string, onClick: () => void): HTMLElement {
		const btn = this.el('button', className, label);
		btn.setAttribute('title', title);
		btn.addEventListener('click', onClick);
		return btn;
	}

	/** demo .switch-label — label + iOS-style toggle */
	private switchControl(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
		const wrap = this.el('span', 'pm-switch-label');
		wrap.setAttribute('data-pm-on', String(initial));
		wrap.setAttribute('title', label);
		wrap.setAttribute('role', 'switch');
		wrap.append(this.el('span', 'pm-switch'), this.el('span', undefined, label));
		wrap.addEventListener('click', () => {
			const next = wrap.getAttribute('data-pm-on') !== 'true';
			wrap.setAttribute('data-pm-on', String(next));
			onChange(next);
		});
		return wrap;
	}

	// ---- structure (demo/index.html) ----------------------------------------

	/** The plugin mark — the split card, in miniature, in colour. */
	private makeBrandIcon(): HTMLElement {
		const wrap = this.el('span', 'pm-brand');
		wrap.setAttribute('title', this.strings.title);
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		const node = (name: string, attrs: Record<string, string>): Element => {
			const el = this.doc.createElementNS(SVG_NS, name);
			for (const [k, v] of Object.entries(attrs)) {
				el.setAttribute(k, v);
			}
			return el;
		};
		const defs = this.doc.createElementNS(SVG_NS, 'defs');
		const grad = node('linearGradient', { id: 'pm-brand-grad', x1: '0', y1: '0', x2: '0', y2: '1' });
		grad.appendChild(node('stop', { offset: '0', 'stop-color': '#96abf1' }));
		grad.appendChild(node('stop', { offset: '1', 'stop-color': '#6f6ce8' }));
		defs.appendChild(grad);
		svg.appendChild(defs);
		svg.appendChild(node('path', {
			d: 'M8 2.4H3.9A1.9 1.9 0 0 0 2 4.3v7.4a1.9 1.9 0 0 0 1.9 1.9H8Z',
			fill: '#f7f8fa', stroke: 'rgba(0,0,0,.28)', 'stroke-width': '.6'
		}));
		svg.appendChild(node('path', {
			d: 'M8 1.9h4.1A1.9 1.9 0 0 1 14 3.8v7.9a1.9 1.9 0 0 1-1.9 1.9H8Z',
			fill: 'url(#pm-brand-grad)'
		}));
		svg.appendChild(node('rect', { x: '3.4', y: '4.4', width: '3', height: '1.1', rx: '.55', fill: '#1c1e24' }));
		svg.appendChild(node('rect', { x: '3.4', y: '7', width: '3.4', height: '.9', rx: '.45', fill: '#8b8f98' }));
		svg.appendChild(node('circle', { cx: '9.3', cy: '3.3', r: '.55', fill: '#37c871' }));
		svg.appendChild(node('rect', { x: '9', y: '4.4', width: '3.2', height: '1.1', rx: '.55', fill: '#4b50e6' }));
		svg.appendChild(node('rect', { x: '9', y: '7', width: '3.6', height: '.9', rx: '.45', fill: 'rgba(255,255,255,.92)' }));
		wrap.appendChild(svg);
		return wrap;
	}

	/**
	 * The layout-swap button. Not a generic arrow: it DRAWS the current
	 * arrangement — two panels side by side, the translation's one filled —
	 * so the button says which side the translation is on before you click it.
	 */
	private makeSideButton(): HTMLElement {
		const btn = this.el('button', 'pm-icon-button pm-side-toggle');
		btn.setAttribute('title', this.strings.swapSides);
		btn.setAttribute('aria-label', this.strings.swapSides);
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		const frame = this.doc.createElementNS(SVG_NS, 'rect');
		frame.setAttribute('x', '3');
		frame.setAttribute('y', '5');
		frame.setAttribute('width', '18');
		frame.setAttribute('height', '14');
		frame.setAttribute('rx', '2.5');
		svg.appendChild(frame);
		const divider = this.doc.createElementNS(SVG_NS, 'path');
		divider.setAttribute('d', 'M12 5v14');
		svg.appendChild(divider);
		// The filled half marks where the translation lives.
		const fill = this.doc.createElementNS(SVG_NS, 'rect');
		fill.setAttribute('class', 'pm-side-fill');
		fill.setAttribute('y', '5');
		fill.setAttribute('width', '9');
		fill.setAttribute('height', '14');
		svg.appendChild(fill);
		btn.appendChild(svg);
		btn.addEventListener('click', () => this.callbacks.onSwapSides());
		this.sideButton = btn;
		this.sideFill = fill as unknown as HTMLElement;
		this.setPaneSide(this.paneSide);
		return btn;
	}

	/** Which side the translation pane is on — drives the swap button's icon. */
	setPaneSide(side: 'left' | 'right'): void {
		this.paneSide = side;
		if (!this.sideFill || !this.sideButton) {
			return;
		}
		this.sideFill.setAttribute('x', side === 'right' ? '12' : '3');
		this.sideButton.setAttribute('data-pm-side', side);
	}

	private build(): void {
		// --- header: one row, fixed left-to-right order.
		//   icon · languages · engine · refresh · status · sync · save ·
		//   layout · settings · close
		const header = this.el('div', 'pm-header');
		const bar = this.el('div', 'pm-bar');

		// Three zones, in the fixed order 图标 · 语言 · 引擎 · 刷新 · 同步滚动 ·
		// 保存到笔记 · 布局 · 设置 · 关闭 — but grouped so the eye can find
		// things: what is being translated (left), what to do with it (middle),
		// what to do with the window (right). Hairlines mark the seams.
		bar.appendChild(this.makeBrandIcon());

		this.languagePill = this.el('button', 'pm-chip pm-chip-lang');
		this.languagePill.setAttribute('title', this.strings.settings);
		this.languagePill.addEventListener('click', () => this.callbacks.onOpenSettings());

		const providerPill = this.el('button', 'pm-chip pm-chip-provider');
		providerPill.setAttribute('title', this.strings.settings);
		this.providerMark = this.el('span', 'pm-provider-mark');
		this.providerName = this.el('span', 'pm-provider-name', '');
		providerPill.append(this.providerMark, this.providerName);
		providerPill.addEventListener('click', () => this.callbacks.onOpenSettings());

		this.statusRow = this.el('div', 'pm-status-row');
		this.statusMain = this.el('span', 'pm-status-main');
		this.statusSub = this.el('span', 'pm-status-sub');
		this.statusRow.append(this.statusMain, this.statusSub);

		this.syncSwitch = this.switchControl(this.strings.syncScroll, true, on => this.callbacks.onToggleSync(on));
		// Constructed but not mounted: session code still drives their state.
		this.originalSwitch = this.switchControl(
			this.strings.showOriginal,
			this.host.getAttribute('data-pm-show-original') !== 'false',
			on => this.preserveScroll(() => {
				this.host.setAttribute('data-pm-show-original', String(on));
				this.compareOriginal = on;
				this.applyCompareState();
				this.callbacks.onToggleShowOriginal(on);
			})
		);
		this.overlaySwitch = this.switchControl(this.strings.overlay, false, on => this.callbacks.onToggleOverlay(on));

		bar.append(
			this.languagePill,
			providerPill,
			this.iconButton(ICON_PATHS.refresh, this.strings.retranslate, () => this.callbacks.onRetranslate(), 'pm-refresh'),
			this.el('span', 'pm-bar-spacer'),
			this.syncSwitch,
			this.textButton('pm-bar-action', this.strings.saveNote, this.strings.saveNote, () => this.callbacks.onSaveNote()),
			this.el('span', 'pm-bar-sep'),
			this.makeSideButton(),
			this.iconButton(ICON_PATHS.settings, this.strings.settings, () => this.callbacks.onOpenSettings()),
			this.iconButton(ICON_PATHS.close, this.strings.close, () => this.callbacks.onClose())
		);

		header.append(bar);

		// --- scroll body
		this.scroll = this.el('div', 'pm-scroll');
		this.scroll.setAttribute('data-pm-view', this.viewKind);
		this.articleHost = this.el('div', 'pm-article-host');
		this.scroll.append(this.articleHost);
		this.scrollHandler = () => this.handleScroll();
		this.scroll.addEventListener('scroll', this.scrollHandler, { passive: true });

		// --- floating status note (bottom-right) + toast
		this.statusNote = this.el('div', 'pm-status-note');
		this.toastEl = this.el('div', 'pm-toast');
		this.toastText = this.el('p');
		this.toastEl.append(this.el('span', 'pm-toast-check', '✓'), this.toastText);

		this.host.append(header, this.scroll, this.statusNote, this.toastEl);

		this.keyHandler = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				this.hideExplanation();
			}
		};
		this.doc.addEventListener('keydown', this.keyHandler);
	}

	// ---- scroll anchoring ---------------------------------------------------

	/** Keep the topmost visible paragraph in place across a layout change. */
	private preserveScroll(mutate: () => void): void {
		const anchor = this.topmostVisibleBlock();
		const beforeTop = anchor?.getBoundingClientRect().top ?? 0;
		mutate();
		if (!anchor) {
			return;
		}
		const afterTop = anchor.getBoundingClientRect().top;
		this.scroll.scrollTop += afterTop - beforeTop;
	}

	private topmostVisibleBlock(): HTMLElement | null {
		const rect = this.scroll.getBoundingClientRect();
		for (const block of Array.from(this.articleHost.querySelectorAll('.pm-block'))) {
			if (block.getBoundingClientRect().bottom > rect.top + 4) {
				return block as HTMLElement;
			}
		}
		return null;
	}

	// ---- public state setters -----------------------------------------------

	setTheme(theme: 'light' | 'dark'): void {
		this.host.setAttribute('data-pm-theme', theme);
	}

	setArticleFontSize(px: number): void {
		this.host.style.setProperty('--pm-article-size', `${Math.min(22, Math.max(12, px))}px`);
	}

	/**
	 * 显示原文对照.
	 *   article view — show the small source line above each translation.
	 *   page view    — lift the mask so the ORIGINAL page shows through the
	 *                  rebuilt one, for a direct read against the source.
	 */
	setShowOriginal(enabled: boolean): void {
		this.host.setAttribute('data-pm-show-original', String(enabled));
		this.originalSwitch?.setAttribute('data-pm-on', String(enabled));
		this.compareOriginal = enabled;
		this.applyCompareState();
	}

	setOverlayEnabled(enabled: boolean): void {
		this.overlaySwitch?.setAttribute('data-pm-on', String(enabled));
	}

	setSyncEnabled(enabled: boolean): void {
		this.syncSwitch?.setAttribute('data-pm-on', String(enabled));
	}

	setLanguagePair(source: string, target: string): void {
		// One chip, both languages. Two separate truncating pills turned this
		// into "Eng… → 简体…", which tells the reader nothing.
		this.languagePill.replaceChildren(
			this.el('span', 'pm-lang-from', source),
			this.el('i', 'pm-lang-arrow', '→'),
			this.el('span', 'pm-lang-to', target)
		);
	}

	setProviderInfo(displayName: string): void {
		this.providerName.textContent = displayName;
		this.providerMark.textContent = '';
	}

	setBusy(busy: boolean): void {
		this.host.classList.toggle('pm-refreshing', busy);
	}

	/**
	 * Transient status, shown as a floating note in the bottom-right corner.
	 *
	 * Only NEW information appears: repeating the same message does not
	 * re-trigger it. Busy states stay up while the work runs, results fade
	 * after a couple of seconds, errors linger long enough to be read.
	 */
	setStatus(main: string, options?: { sub?: string; error?: boolean; busy?: boolean; check?: boolean }): void {
		const sub = options?.sub ?? '';
		const signature = `${main}|${sub}|${options?.error ? 'e' : ''}${options?.busy ? 'b' : ''}`;
		if (signature === this.lastStatusSignature) {
			return;
		}
		this.lastStatusSignature = signature;

		this.statusMain.replaceChildren();
		if (options?.busy) {
			this.statusMain.append(this.el('span', 'pm-bilingual-spinner'));
		}
		else if (options?.check) {
			this.statusMain.append(this.el('i', 'pm-check', '✓'));
		}
		this.statusMain.append(this.doc.createTextNode(main));
		this.statusSub.textContent = sub;
		this.statusRow.classList.toggle('pm-error', !!options?.error);

		this.statusNote.replaceChildren(this.statusRow);
		this.statusNote.setAttribute('data-pm-error', String(!!options?.error));
		this.statusNote.classList.add('pm-show');
		if (this.statusTimer) {
			clearTimeout(this.statusTimer);
			this.statusTimer = null;
		}
		if (!options?.busy) {
			this.statusTimer = setTimeout(
				() => this.statusNote.classList.remove('pm-show'),
				options?.error ? 7000 : 2400
			);
		}
	}

	toast(message: string): void {
		this.toastText.textContent = message;
		this.toastEl.classList.add('pm-show');
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
		}
		this.toastTimer = setTimeout(() => this.toastEl.classList.remove('pm-show'), 1900);
	}

	// ---- privacy notice -----------------------------------------------------

	showPrivacyNotice(hostName: string): void {
		if (this.privacyNoticeEl) {
			return;
		}
		const notice = this.el('div', 'pm-bilingual-notice');
		notice.append(
			this.el('div', undefined, this.strings.privacyNotice),
			this.el('div', 'pm-notice-host', `→ ${hostName}`),
			this.textButton('pm-footer-button pm-primary', this.strings.privacyAccept, this.strings.privacyAccept, () => {
				notice.remove();
				this.privacyNoticeEl = null;
				this.callbacks.onAcceptPrivacy();
			})
		);
		this.articleHost.before(notice);
		this.privacyNoticeEl = notice;
	}

	// ---- explain card (demo .explain-card) ----------------------------------

	showExplanation(content: { loading?: boolean; sections?: ExplanationSection[]; error?: string; passage?: string }): void {
		let card = this.scroll.querySelector('.pm-explain-card') as HTMLElement | null;
		const isNew = !card;
		if (!card) {
			card = this.el('div', 'pm-explain-card');
			const head = this.el('div', 'pm-card-head');
			const titles = this.el('div', 'pm-card-titles');
			titles.append(
				this.el('strong', undefined, this.strings.explainTitle),
				this.el('small', 'pm-explain-passage', this.strings.explainSubtitle)
			);
			const closeBtn = this.el('button', 'pm-card-close', '×');
			closeBtn.setAttribute('title', this.strings.close);
			closeBtn.addEventListener('click', () => this.hideExplanation());
			head.append(this.el('span', 'pm-sparkle', '✦'), titles, closeBtn);

			const grid = this.el('div', 'pm-explain-grid');
			const actions = this.el('div', 'pm-explain-actions');
			actions.append(
				this.textButton('pm-footer-button', this.strings.explainCopy, this.strings.explainCopy, () => this.callbacks.onCopyExplanation()),
				this.textButton('pm-footer-button', this.strings.explainSave, this.strings.explainSave, () => this.callbacks.onSaveExplanationNote())
			);
			card.append(head, grid, actions);
			this.scroll.prepend(card);
		}

		const passageEl = card.querySelector('.pm-explain-passage') as HTMLElement;
		const grid = card.querySelector('.pm-explain-grid') as HTMLElement;
		const actions = card.querySelector('.pm-explain-actions') as HTMLElement;

		if (content.passage !== undefined) {
			passageEl.textContent = content.passage || this.strings.explainSubtitle;
			passageEl.setAttribute('title', content.passage);
		}
		if (content.loading) {
			grid.replaceChildren();
			const loading = this.el('div', 'pm-explain-section');
			const p = this.el('p');
			p.append(this.el('span', 'pm-bilingual-spinner'), this.doc.createTextNode('…'));
			loading.append(p);
			grid.append(loading);
			actions.hidden = true;
		}
		else if (content.error !== undefined) {
			grid.replaceChildren();
			const err = this.el('div', 'pm-explain-section pm-error');
			err.append(this.el('p', undefined, content.error));
			grid.append(err);
			actions.hidden = true;
		}
		else if (content.sections) {
			grid.replaceChildren();
			for (const section of content.sections) {
				const sec = this.el('div', 'pm-explain-section');
				if (section.label) {
					sec.append(this.el('b', undefined, section.label));
				}
				sec.append(this.el('p', undefined, section.text));
				grid.append(sec);
			}
			actions.hidden = false;
		}

		if (isNew) {
			this.scroll.scrollTop = 0;
		}
	}

	hideExplanation(): void {
		const card = this.scroll.querySelector('.pm-explain-card') as HTMLElement | null;
		if (!card) {
			return;
		}
		const height = card.getBoundingClientRect().height;
		const wasScrolled = this.scroll.scrollTop > 0;
		card.remove();
		if (wasScrolled) {
			this.scroll.scrollTop = Math.max(0, this.scroll.scrollTop - height);
		}
	}

	// ---- pages & blocks -----------------------------------------------------

	private ensurePageSection(pageIndex: number): PageSection {
		let section = this.pages.get(pageIndex);
		if (section) {
			return section;
		}
		const marker = this.el('div', 'pm-page-marker');
		marker.setAttribute('data-pm-page', String(pageIndex));
		marker.append(
			this.el('span', undefined, `${this.strings.pagePrefix} ${pageIndex + 1} ${this.strings.pageSuffix}`.trim()),
			this.el('i')
		);
		const status = this.el('div', 'pm-status-inline');
		const blocksHost = this.el('div');
		blocksHost.setAttribute('data-pm-page-host', String(pageIndex));
		section = { marker, blocksHost, status };
		this.pages.set(pageIndex, section);
		const after = [...this.pages.keys()].filter(p => p > pageIndex).sort((a, b) => a - b)[0];
		const anchor = after !== undefined ? this.pages.get(after)!.marker : null;
		this.preserveScroll(() => {
			if (anchor) {
				this.articleHost.insertBefore(marker, anchor);
				this.articleHost.insertBefore(status, anchor);
				this.articleHost.insertBefore(blocksHost, anchor);
			}
			else {
				this.articleHost.append(marker, status, blocksHost);
			}
		});
		return section;
	}

	// ---- 整页对照 -----------------------------------------------------------

	/**
	 * Install the page-rebuilding renderer. The session owns it because it
	 * needs the reader; the pane only decides when to call it.
	 * Returning false means the page is not rendered by PDF.js yet.
	 */
	setPageRenderer(renderer: (pageIndex: number, host: HTMLElement, width: number) => boolean): void {
		this.pageRenderer = renderer;
		this.observeResize();
	}

	setViewKind(kind: 'page' | 'article'): void {
		if (this.viewKind === kind) {
			return;
		}
		this.viewKind = kind;
		this.scroll.setAttribute('data-pm-view', kind);
		this.articleHost.replaceChildren();
		this.pages.clear();
		this.pageHost = null;
		this.refreshViewKindButton();
	}

	/**
	 * The pane's two readings of the same text: 文章流 is complete and never
	 * clips (this is the mode that guarantees 无删减); 整页对照 rebuilds the
	 * page's own layout beside the original. The button offers the OTHER one.
	 */
	private refreshViewKindButton(): void {
		if (!this.viewKindButton) {
			return;
		}
		const label = this.viewKind === 'page' ? this.strings.viewArticle : this.strings.viewPage;
		this.viewKindButton.textContent = label;
		this.viewKindButton.setAttribute('title', label);
	}

	getViewKind(): 'page' | 'article' {
		return this.viewKind;
	}

	/**
	 * Width available to a rebuilt page, in CSS px.
	 *
	 * Clamped hard. The rebuilt page carries an explicit pixel width, so an
	 * over-large value here does not just look wrong — it becomes the pane's
	 * min-content width and shoves the reader off screen.
	 */
	private pageWidthAvailable(): number {
		// Informational only now: the rebuilt page is sized from the reader's
		// own render, not from this number. It is still passed through so the
		// renderer can centre small pages and log sensible diagnostics.
		const scrollW = this.scroll.clientWidth || this.host.clientWidth;
		return Math.max(160, (scrollW || 400) - 16);
	}

	/**
	 * Fit the rebuilt page to the pane by SCALING it, never by rebuilding it.
	 *
	 * The page is built at the reader's own pixel geometry, which is what keeps
	 * the text layer aligned with the bitmap. A CSS transform scales the
	 * finished result as one piece, so dragging the divider resizes the
	 * translation smoothly — no re-render, no canvas allocation, and no way for
	 * the text and the artwork to disagree. Only ever scales DOWN: the
	 * translated page must never end up larger than the original beside it.
	 */
	private fitPageToPane(): void {
		const page = this.pageHost?.querySelector('.pm-repage') as HTMLElement | null;
		if (!page) {
			return;
		}
		const pageWidth = parseFloat(page.style.width) || page.offsetWidth;
		const pageHeight = parseFloat(page.style.height) || page.offsetHeight;
		if (!pageWidth || !pageHeight) {
			return;
		}
		// FILL the pane, both directions. Scaling up is safe here in a way it
		// never was before: a transform scales the bitmap and the text layer as
		// one object, so they cannot drift apart. The bitmap is supersampled 2×,
		// so it stays sharp well past 1.0.
		const available = Math.max(120, (this.scroll.clientWidth || pageWidth) - 24);
		const scale = Math.max(0.2, Math.min(PAGE_MAX_UPSCALE, available / pageWidth));
		page.style.transformOrigin = 'top left';
		page.style.transform = Math.abs(scale - 1) < 0.002 ? '' : `scale(${scale.toFixed(4)})`;
		// A transform leaves the layout box untouched, so the footprint has to
		// be corrected by hand or the scroll area is the wrong size — negative
		// when shrinking, positive when growing.
		page.style.marginRight = `${Math.round(pageWidth * (scale - 1))}px`;
		page.style.marginBottom = `${Math.round(20 + pageHeight * (scale - 1))}px`;
	}

	private observeResize(): void {
		const view = this.doc.defaultView as (Window & { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } }) | null;
		if (!view?.ResizeObserver || this.resizeObserver) {
			return;
		}
		const observer = new view.ResizeObserver(() => {
			if (this.viewKind !== 'page') {
				return;
			}
			this.fitPageToPane();
		});
		observer.observe(this.scroll);
		this.resizeObserver = observer;
	}

	/**
	 * 整页对照 shows exactly ONE page: the one the reader is on.
	 *
	 * Two reasons it cannot be a scrolling list of pages. PDF.js virtualises —
	 * only the pages near the viewport are rendered, and the rebuilt page copies
	 * that render, so every other page would be a blank placeholder. And the
	 * point of the spread is that the translated page sits beside the original
	 * page it belongs to; a second scrollable column of pages fights the PDF's
	 * own scrolling instead of matching it.
	 */
	setCurrentPage(pageIndex: number): void {
		if (this.currentPage === pageIndex) {
			return;
		}
		this.currentPage = pageIndex;
		if (this.viewKind === 'page') {
			this.drawCurrentPage();
		}
	}

	private ensurePageHost(): HTMLElement {
		if (this.pageHost) {
			return this.pageHost;
		}
		const host = this.el('div', 'pm-repage-host');
		this.pageHost = host;
		this.articleHost.replaceChildren(host);
		return host;
	}

	/**
	 * Hard stop on runaway redraws.
	 *
	 * Every 整页对照 draw allocates two full-page canvases at 2× supersampling —
	 * tens of megabytes for a big page. A feedback loop between a draw and
	 * anything that observes its result therefore does not merely stutter, it
	 * exhausts memory and takes Zotero down with it. Whatever new loop a future
	 * change introduces, this bounds it: more than 8 draws in 3 seconds and the
	 * page freezes at its current size until something genuinely changes.
	 */
	private drawBudgetSpent(): boolean {
		const now = Date.now();
		this.drawTimes = this.drawTimes.filter(t => now - t < 3000);
		this.drawTimes.push(now);
		if (this.drawTimes.length > 8) {
			logger.warn(MODULE, 'page redraw budget exhausted — freezing the rebuilt page');
			return true;
		}
		return false;
	}

	private drawCurrentPage(): void {
		if (!this.pageRenderer || this.viewKind !== 'page' || this.currentPage < 0) {
			return;
		}
		if (this.drawBudgetSpent()) {
			return;
		}
		const host = this.ensurePageHost();
		this.lastWidth = this.pageWidthAvailable();
		const label = this.el('div', 'pm-repage-page-label',
			`${this.strings.pagePrefix} ${this.currentPage + 1} ${this.strings.pageSuffix}`.trim());
		const scrollTop = this.scroll.scrollTop;
		const ok = this.pageRenderer(this.currentPage, host, this.lastWidth);
		if (!ok) {
			const pending = this.el('div', 'pm-repage-pending');
			pending.style.width = `${this.lastWidth}px`;
			pending.style.height = '140px';
			pending.append(
				this.el('span', 'pm-bilingual-spinner'),
				this.doc.createTextNode(
					this.strings.statusTranslating.replace('%n%', String(this.currentPage + 1))
				)
			);
			host.replaceChildren(label, pending);
			return;
		}
		// Exactly one page label, whatever the renderer kept or replaced.
		host.querySelectorAll('.pm-repage-page-label').forEach(n => n.remove());
		host.insertBefore(label, host.firstChild);
		this.applyCompareState();
		this.scroll.scrollTop = Math.min(scrollTop, Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight));
		this.fitPageToPane();
	}

	/**
	 * PDF.js virtualises pages and re-renders on zoom. The rebuilt page copies
	 * that bitmap, so it has to be redrawn when the source page changes.
	 */
	refreshPage(pageIndex: number): void {
		if (this.viewKind !== 'page' || pageIndex !== this.currentPage) {
			return;
		}
		this.drawCurrentPage();
	}

	/**
	 * 同步滚动 (page view): mirror the reader's position WITHIN the page.
	 * `fraction` is how far down the original page the left viewport sits;
	 * the rebuilt page scrolls to the same relative spot.
	 */
	setPdfScrollFraction(pageIndex: number, fraction: number): void {
		if (this.viewKind !== 'page' || pageIndex !== this.currentPage || !this.pageHost) {
			return;
		}
		const pageEl = this.pageHost.querySelector('.pm-repage') as HTMLElement | null;
		if (!pageEl) {
			return;
		}
		const target = pageEl.offsetTop + fraction * pageEl.offsetHeight;
		const max = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
		this.scroll.scrollTop = Math.max(0, Math.min(target, max));
	}

	/**
	 * 显示原文对照 — hide the mask so the original text shows through the
	 * rebuilt page, for a direct read against the source.
	 */
	private applyCompareState(): void {
		this.pageHost?.querySelector('.pm-repage')
			?.setAttribute('data-pm-compare', String(this.compareOriginal));
	}

	renderPage(state: PageTranslationState): void {
		if (this.viewKind === 'page') {
			this.renderPageAsPage(state);
			return;
		}
		const section = this.ensurePageSection(state.pageIndex);
		switch (state.status) {
			case 'extracting':
			case 'translating':
				section.status.replaceChildren(
					this.el('span', 'pm-bilingual-spinner'),
					this.doc.createTextNode(this.strings.statusTranslating.replace('%n%', String(state.pageIndex + 1)))
				);
				section.status.classList.remove('pm-error');
				break;
			case 'done':
				section.status.textContent = '';
				section.status.classList.remove('pm-error');
				break;
			case 'no-text-layer':
				section.status.textContent = this.strings.noTextLayer;
				section.status.classList.add('pm-error');
				break;
			case 'error':
				section.status.textContent = `${this.strings.statusError}: ${state.error?.message ?? ''}`;
				section.status.classList.add('pm-error');
				break;
			default:
				section.status.textContent = '';
		}
		this.renderBlocks(section, state);
	}

	private renderPageAsPage(state: PageTranslationState): void {
		if (state.pageIndex !== this.currentPage) {
			return; // only the page the reader is on is shown
		}
		if (state.status === 'no-text-layer' || state.status === 'error') {
			const message = state.status === 'no-text-layer'
				? this.strings.noTextLayer
				: `${this.strings.statusError}: ${state.error?.message ?? ''}`;
			const box = this.el('div', 'pm-repage-pending', message);
			box.style.width = `${this.pageWidthAvailable()}px`;
			box.style.height = '110px';
			this.ensurePageHost().replaceChildren(
				this.el('div', 'pm-repage-page-label',
					`${this.strings.pagePrefix} ${state.pageIndex + 1} ${this.strings.pageSuffix}`.trim()),
				box
			);
			return;
		}
		this.drawCurrentPage();
	}

	/** Incremental update — existing nodes are patched, never rebuilt. */
	private renderBlocks(section: PageSection, state: PageTranslationState): void {
		const existing = new Map<string, HTMLElement>();
		for (const child of Array.from(section.blocksHost.children)) {
			const id = child.getAttribute('data-pm-block');
			if (id) {
				existing.set(id, child as HTMLElement);
			}
		}
		for (const block of state.blocks) {
			const translated = state.translations.get(block.id);
			let node = existing.get(block.id);
			if (!node) {
				node = this.el('div', 'pm-block');
				node.setAttribute('data-pm-block', block.id);
				node.setAttribute('data-pm-type', block.type);
				node.setAttribute('data-pm-page', String(block.pageIndex));
				// Standalone equations get the demo's .formula-card treatment
				if (this.looksLikeStandaloneFormula(block)) {
					node.setAttribute('data-pm-formula', 'true');
				}
				const original = this.el('p', 'pm-block-original', block.sourceText);
				const text = this.el('p', 'pm-block-text');
				const mini = this.el('button', 'pm-mini-explain', `✦ ${this.strings.explain}`);
				mini.setAttribute('title', this.strings.explain);
				mini.addEventListener('click', (event) => {
					event.stopPropagation();
					this.highlightBlock(block.id);
					this.callbacks.onExplainBlock(block.pageIndex, block.id);
				});
				node.append(original, text, mini);
				node.addEventListener('click', () => {
					this.highlightBlock(block.id);
					this.callbacks.onBlockClick(block.pageIndex, block.id);
				});
				section.blocksHost.append(node);
			}
			const textEl = node.querySelector('.pm-block-text') as HTMLElement | null;
			if (!textEl) {
				continue;
			}
			if (translated !== undefined) {
				if (textEl.textContent !== translated) {
					textEl.textContent = translated; // SAFE: text node only
				}
				node.removeAttribute('data-pm-pending');
			}
			else if (!node.hasAttribute('data-pm-pending')) {
				node.setAttribute('data-pm-pending', 'true');
				textEl.replaceChildren(this.el('span', 'pm-pending', this.strings.pending));
			}
		}
	}

	/** A short paragraph that is essentially one equation. */
	private looksLikeStandaloneFormula(block: SourceBlock): boolean {
		if (block.type !== 'paragraph' && block.type !== 'unknown') {
			return false;
		}
		const text = block.sourceText.trim();
		return text.length > 0 && text.length <= 160 && isFormulaRun(text);
	}

	highlightBlock(blockId: string): void {
		if (this.selectedBlockId) {
			this.articleHost.querySelector(`[data-pm-block="${CSS.escape(this.selectedBlockId)}"]`)?.classList.remove('pm-focused');
		}
		this.selectedBlockId = blockId;
		this.articleHost.querySelector(`[data-pm-block="${CSS.escape(blockId)}"]`)?.classList.add('pm-focused');
	}

	getSelectedBlockId(): string | null {
		return this.selectedBlockId;
	}

	getSelectionText(): string {
		const selection = this.doc.defaultView?.getSelection?.();
		const text = selection ? selection.toString() : '';
		return text.trim() ? text : '';
	}

	scrollToPage(pageIndex: number): void {
		if (this.viewKind === 'page') {
			this.setCurrentPage(pageIndex);
			return;
		}
		this.pages.get(pageIndex)?.marker.scrollIntoView({ block: 'start' });
	}

	scrollToBlock(blockId: string): void {
		this.articleHost.querySelector(`[data-pm-block="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: 'center' });
	}

	private handleScroll(): void {
		const rect = this.scroll.getBoundingClientRect();
		let best: number | null = null;
		if (this.viewKind === 'page') {
			return; // one page at a time; the PDF drives which one
		}
		const sections: [number, HTMLElement][] =
			[...this.pages.entries()].map(([p, s]) => [p, s.blocksHost] as [number, HTMLElement]);
		for (const [pageIndex, hostEl] of sections) {
			const hostRect = hostEl.getBoundingClientRect();
			if (hostRect.bottom > rect.top + 20 && hostRect.top < rect.bottom) {
				best = best === null ? pageIndex : Math.min(best, pageIndex);
			}
		}
		if (best !== null) {
			this.callbacks.onScrolledToPage(best);
		}
	}

	getPageText(_pageIndex: number, blocks: SourceBlock[], translations: Map<string, string>, mode: 'plain' | 'both'): string {
		const lines: string[] = [];
		for (const block of blocks) {
			const t = translations.get(block.id);
			if (t === undefined) {
				continue;
			}
			if (mode === 'both') {
				lines.push(block.sourceText, t, '');
			}
			else {
				lines.push(t, '');
			}
		}
		return lines.join('\n').trim();
	}

	destroy(): void {
		if (this.scrollHandler) {
			this.scroll.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		if (this.keyHandler) {
			this.doc.removeEventListener('keydown', this.keyHandler);
			this.keyHandler = null;
		}
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
			this.toastTimer = null;
		}
		if (this.statusTimer) {
			clearTimeout(this.statusTimer);
			this.statusTimer = null;
		}
		if (this.resizeTimer) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.pageRenderer = null;
		this.host.replaceChildren();
		this.pages.clear();
		this.pageHost = null;
	}
}
