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
import type { ExplanationSection } from '../translation/explainer';
import type { PageTranslationState } from '../translation/translationManager';
import type { SourceBlock } from '../types/models';

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
	exportPdf: string;
	exportPdfTip: string;
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
	/** Guard for the post-draw width recheck, so it can never oscillate. */
	private widthRetry = 0;

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

	private build(): void {
		// --- header
		const header = this.el('div', 'pm-header');

		const titleRow = this.el('div', 'pm-title-row');
		const titleCol = this.el('div', 'pm-title-col');
		const eyebrow = this.el('div', 'pm-eyebrow');
		eyebrow.append(this.el('span', 'pm-live-dot'), this.doc.createTextNode(this.strings.eyebrow));
		titleCol.append(eyebrow, this.el('h2', 'pm-title', this.strings.title));
		const actions = this.el('div', 'pm-header-actions');
		actions.append(
			this.iconButton(ICON_PATHS.swap, this.strings.swapSides, () => this.callbacks.onSwapSides()),
			this.iconButton(ICON_PATHS.settings, this.strings.settings, () => this.callbacks.onOpenSettings()),
			this.iconButton(ICON_PATHS.close, this.strings.close, () => this.callbacks.onClose())
		);
		titleRow.append(titleCol, actions);

		const controls = this.el('div', 'pm-controls-row');
		this.languagePill = this.el('button', 'pm-pill');
		this.languagePill.setAttribute('title', this.strings.settings);
		this.languagePill.addEventListener('click', () => this.callbacks.onOpenSettings());
		const providerPill = this.el('button', 'pm-pill pm-provider');
		providerPill.setAttribute('title', this.strings.settings);
		this.providerMark = this.el('span', 'pm-provider-mark', '·');
		this.providerName = this.el('span', undefined, '');
		providerPill.append(this.providerMark, this.providerName, this.el('b', undefined, '⌄'));
		providerPill.addEventListener('click', () => this.callbacks.onOpenSettings());
		controls.append(
			this.languagePill,
			providerPill,
			this.iconButton(ICON_PATHS.refresh, this.strings.retranslate, () => this.callbacks.onRetranslate(), 'pm-soft pm-refresh')
		);

		this.statusRow = this.el('div', 'pm-status-row');
		this.statusMain = this.el('span', 'pm-status-main');
		this.statusSub = this.el('span', 'pm-status-sub');
		this.statusRow.append(this.statusMain, this.statusSub);

		header.append(titleRow, controls, this.statusRow);

		// --- scroll body
		this.scroll = this.el('div', 'pm-scroll');
		this.scroll.setAttribute('data-pm-view', this.viewKind);
		this.articleHost = this.el('div', 'pm-article-host');
		this.scroll.append(this.articleHost);
		this.scrollHandler = () => this.handleScroll();
		this.scroll.addEventListener('scroll', this.scrollHandler, { passive: true });

		// --- controls live in the HEADER, not a footer bar (下面不要有按钮).
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
		this.syncSwitch = this.switchControl(this.strings.syncScroll, true, on => this.callbacks.onToggleSync(on));
		// Only 同步滚动 · 复制译文 · 保存到笔记 are mounted; the 显示原文对照 /
		// PDF 叠加 switches stay constructed (session code drives their state)
		// but have no UI entry.
		actions.prepend(
			this.syncSwitch,
			this.textButton('pm-footer-button', this.strings.copy, this.strings.copy, () => this.callbacks.onCopy('plain')),
			this.textButton('pm-footer-button pm-primary', this.strings.saveNote, this.strings.saveNote, () => this.callbacks.onSaveNote()),
			this.textButton('pm-footer-button pm-export', this.strings.exportPdf, this.strings.exportPdfTip, () => this.callbacks.onExportPdf())
		);

		// --- toast
		this.toastEl = this.el('div', 'pm-toast');
		this.toastText = this.el('p');
		this.toastEl.append(this.el('span', 'pm-toast-check', '✓'), this.toastText);

		this.host.append(header, this.scroll, this.toastEl);

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
		this.languagePill.replaceChildren(
			this.el('span', undefined, source),
			this.el('i', undefined, '→'),
			this.el('span', undefined, target),
			this.el('b', undefined, '⌄')
		);
	}

	setProviderInfo(displayName: string): void {
		this.providerName.textContent = displayName;
		this.providerMark.textContent = (displayName.trim().charAt(0) || '·').toLowerCase();
	}

	setBusy(busy: boolean): void {
		this.host.classList.toggle('pm-refreshing', busy);
	}

	/** demo .status-row — green main label plus a muted secondary label. */
	setStatus(main: string, options?: { sub?: string; error?: boolean; busy?: boolean; check?: boolean }): void {
		this.statusMain.replaceChildren();
		if (options?.busy) {
			this.statusMain.append(this.el('span', 'pm-bilingual-spinner'));
		}
		else if (options?.check) {
			this.statusMain.append(this.el('i', 'pm-check', '✓'));
		}
		this.statusMain.append(this.doc.createTextNode(main));
		this.statusSub.textContent = options?.sub ?? '';
		this.statusRow.classList.toggle('pm-error', !!options?.error);
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
		const width = this.scroll.clientWidth || this.host.clientWidth;
		// Nearly edge to edge: the page must read as "the other half of the
		// spread", so only a sliver of backdrop is kept around it.
		return Math.max(160, width - 16);
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
			const width = this.pageWidthAvailable();
			if (Math.abs(width - this.lastWidth) < 8) {
				return;
			}
			if (this.resizeTimer) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.drawCurrentPage();
			}, 140);
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

	private drawCurrentPage(): void {
		if (!this.pageRenderer || this.viewKind !== 'page' || this.currentPage < 0) {
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
		// Self-healing width check: the first draw can race the 50/50 pixel
		// split (and anything else that changes the pane's width without a
		// resize event we catch), leaving the page rendered against a stale,
		// narrower width — floating small with margins. One frame later the
		// layout HAS settled; if the real width disagrees, redraw once with it.
		const win = this.doc.defaultView;
		win?.requestAnimationFrame?.(() => {
			if (this.viewKind !== 'page') {
				return;
			}
			const fresh = this.pageWidthAvailable();
			if (Math.abs(fresh - this.lastWidth) > 12 && this.widthRetry < 2) {
				this.widthRetry++;
				this.drawCurrentPage();
			}
			else {
				this.widthRetry = 0;
			}
		});
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
