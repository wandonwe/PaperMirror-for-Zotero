/**
 * Translation pane UI — visual baseline: demo/index.html.
 *
 * Layout:
 *   header  row 1: brand dot · 镜像译文 · [更多菜单] [关闭]
 *           row 2: 源语言→目标语言 · 服务商 · 重新翻译 · 状态 chip
 *   scroll : 讲解卡片(紫色) · 页标 · 译文段落(衬线,可显示原文)
 *   footer : 显示原文对照 · 同步滚动 · 复制译文 · 保存到笔记
 *   plus   : overflow menu (交换左右/重新翻译/清除本文缓存/设置) and a toast
 *
 * Security: every dynamic string is rendered with textContent or as a text
 * node. Remote/model content is NEVER assigned to innerHTML.
 */

import type { ExplanationSection } from '../translation/explainer';
import type { PageTranslationState } from '../translation/translationManager';
import type { SourceBlock } from '../types/models';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
	more: 'M12 6.5h.01M12 12h.01M12 17.5h.01',
	close: 'm6 6 12 12M18 6 6 18',
	refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7'
} as const;

export interface PaneStrings {
	title: string;
	explain: string;
	explainTitle: string;
	explainCopy: string;
	explainSave: string;
	showOriginal: string;
	syncScroll: string;
	statusTranslating: string; // template with %n%
	statusDone: string; // template with %n%
	statusCached: string;
	statusError: string;
	noTextLayer: string;
	pagePrefix: string;
	pageSuffix: string;
	retranslate: string;
	clearCache: string;
	copy: string;
	saveNote: string;
	settings: string;
	close: string;
	swapSides: string;
	more: string;
	pending: string;
	privacyNotice: string;
	privacyAccept: string;
}

export interface PaneCallbacks {
	onExplainBlock(pageIndex: number, blockId: string): void;
	onCopyExplanation(): void;
	onSaveExplanationNote(): void;
	onToggleShowOriginal(enabled: boolean): void;
	onToggleSync(enabled: boolean): void;
	onRetranslate(): void;
	onClearCache(): void;
	onCopy(mode: 'plain' | 'both'): void;
	onSaveNote(): void;
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
	private statusChip!: HTMLElement;
	private statusMain!: HTMLElement;
	private statusSub!: HTMLElement;
	private languagePill!: HTMLElement;
	private providerName!: HTMLElement;
	private providerMark!: HTMLElement;
	private originalSwitch!: HTMLElement;
	private syncSwitch!: HTMLElement;
	private menu!: HTMLElement;
	private menuButton!: HTMLElement;
	private toastEl!: HTMLElement;
	private toastText!: HTMLElement;
	private toastTimer: ReturnType<typeof setTimeout> | null = null;

	private pages = new Map<number, PageSection>();
	private selectedBlockId: string | null = null;
	private privacyNoticeEl: HTMLElement | null = null;
	private scrollHandler: (() => void) | null = null;
	private keyHandler: ((event: KeyboardEvent) => void) | null = null;
	private outsideClickHandler: ((event: MouseEvent) => void) | null = null;

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

	private menuItem(glyph: string, label: string, onClick: () => void): HTMLElement {
		const item = this.el('button', 'pm-menu-item');
		item.setAttribute('title', label);
		item.append(this.el('span', 'pm-menu-glyph', glyph), this.el('span', undefined, label));
		item.addEventListener('click', () => {
			this.closeMenu();
			onClick();
		});
		return item;
	}

	// ---- structure ----------------------------------------------------------

	private build(): void {
		// ---- header row 1
		const header = this.el('div', 'pm-header');
		const titleRow = this.el('div', 'pm-title-row');
		this.menuButton = this.iconButton(ICON_PATHS.more, this.strings.more, () => this.toggleMenu());
		this.menuButton.setAttribute('aria-expanded', 'false');
		titleRow.append(
			this.el('span', 'pm-brand-dot'),
			this.el('h2', 'pm-title', this.strings.title),
			(() => {
				const actions = this.el('div', 'pm-header-actions');
				actions.append(
					this.menuButton,
					this.iconButton(ICON_PATHS.close, this.strings.close, () => this.callbacks.onClose())
				);
				return actions;
			})()
		);

		// ---- header row 2
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

		const refreshBtn = this.iconButton(
			ICON_PATHS.refresh,
			this.strings.retranslate,
			() => this.callbacks.onRetranslate(),
			'pm-soft pm-refresh'
		);

		this.statusChip = this.el('span', 'pm-status-chip');
		this.statusMain = this.el('span', 'pm-status-main');
		this.statusSub = this.el('span', 'pm-status-sub');
		this.statusChip.append(this.statusMain, this.statusSub);

		controls.append(this.languagePill, providerPill, refreshBtn, this.statusChip);
		header.append(titleRow, controls);

		// ---- overflow menu
		this.menu = this.el('div', 'pm-menu');
		this.menu.hidden = true;
		this.menu.append(
			this.menuItem('⇄', this.strings.swapSides, () => this.callbacks.onSwapSides()),
			this.menuItem('↻', this.strings.retranslate, () => this.callbacks.onRetranslate()),
			this.menuItem('⌫', this.strings.clearCache, () => this.callbacks.onClearCache()),
			this.el('div', 'pm-menu-sep'),
			this.menuItem('⚙', this.strings.settings, () => this.callbacks.onOpenSettings())
		);

		// ---- scroll body
		this.scroll = this.el('div', 'pm-scroll');
		this.articleHost = this.el('div', 'pm-article-host');
		this.scroll.append(this.articleHost);
		this.scrollHandler = () => this.handleScroll();
		this.scroll.addEventListener('scroll', this.scrollHandler, { passive: true });

		// ---- footer (high-frequency only)
		const footer = this.el('div', 'pm-footer');
		this.originalSwitch = this.switchControl(
			this.strings.showOriginal,
			this.host.getAttribute('data-pm-show-original') === 'true',
			on => this.preserveScroll(() => {
				this.host.setAttribute('data-pm-show-original', String(on));
				this.callbacks.onToggleShowOriginal(on);
			})
		);
		this.syncSwitch = this.switchControl(this.strings.syncScroll, true, on => this.callbacks.onToggleSync(on));
		footer.append(
			this.originalSwitch,
			this.syncSwitch,
			this.el('span', 'pm-footer-spacer'),
			this.textButton('pm-footer-button', this.strings.copy, this.strings.copy, () => this.callbacks.onCopy('plain')),
			this.textButton('pm-footer-button pm-primary', this.strings.saveNote, this.strings.saveNote, () => this.callbacks.onSaveNote())
		);

		// ---- toast
		this.toastEl = this.el('div', 'pm-toast');
		this.toastText = this.el('p');
		this.toastEl.append(this.el('span', 'pm-toast-check', '✓'), this.toastText);

		this.host.append(header, this.menu, this.scroll, footer, this.toastEl);

		this.keyHandler = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				if (!this.menu.hidden) {
					this.closeMenu();
				}
				else {
					this.hideExplanation();
				}
			}
		};
		this.doc.addEventListener('keydown', this.keyHandler);

		this.outsideClickHandler = (event: MouseEvent) => {
			if (this.menu.hidden) {
				return;
			}
			const target = event.target as Node | null;
			if (target && !this.menu.contains(target) && !this.menuButton.contains(target)) {
				this.closeMenu();
			}
		};
		this.doc.addEventListener('click', this.outsideClickHandler, true);
	}

	// ---- overflow menu ------------------------------------------------------

	private toggleMenu(): void {
		if (this.menu.hidden) {
			this.menu.hidden = false;
			this.menuButton.setAttribute('aria-expanded', 'true');
		}
		else {
			this.closeMenu();
		}
	}

	private closeMenu(): void {
		this.menu.hidden = true;
		this.menuButton.setAttribute('aria-expanded', 'false');
	}

	// ---- scroll anchoring ---------------------------------------------------

	/**
	 * Run a layout-changing mutation while keeping the reader's place: the
	 * topmost visible block stays put instead of the view jumping.
	 */
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
		const blocks = this.articleHost.querySelectorAll('.pm-block');
		for (const block of Array.from(blocks)) {
			const blockRect = block.getBoundingClientRect();
			if (blockRect.bottom > rect.top + 4) {
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

	setShowOriginal(enabled: boolean): void {
		this.host.setAttribute('data-pm-show-original', String(enabled));
		this.originalSwitch?.setAttribute('data-pm-on', String(enabled));
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
		this.statusChip.classList.toggle('pm-error', !!options?.error);
		this.statusChip.classList.toggle('pm-busy', !!options?.busy);
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

	// ---- explain card (purple) ----------------------------------------------

	showExplanation(content: { loading?: boolean; sections?: ExplanationSection[]; error?: string; passage?: string }): void {
		let card = this.scroll.querySelector('.pm-explain-card') as HTMLElement | null;
		const isNew = !card;
		if (!card) {
			card = this.el('div', 'pm-explain-card');
			const head = this.el('div', 'pm-card-head');
			const titles = this.el('div', 'pm-card-titles');
			titles.append(this.el('span', undefined, this.strings.explainTitle));
			const closeBtn = this.el('button', 'pm-card-close', '×');
			closeBtn.setAttribute('title', this.strings.close);
			closeBtn.addEventListener('click', () => this.hideExplanation());
			head.append(this.el('span', 'pm-sparkle', '✦'), titles, closeBtn);

			const passage = this.el('div', 'pm-explain-passage');
			const grid = this.el('div', 'pm-explain-grid');
			const actions = this.el('div', 'pm-explain-actions');
			actions.append(
				this.textButton('pm-footer-button', this.strings.explainCopy, this.strings.explainCopy, () => this.callbacks.onCopyExplanation()),
				this.textButton('pm-footer-button', this.strings.explainSave, this.strings.explainSave, () => this.callbacks.onSaveExplanationNote())
			);
			card.append(head, passage, grid, actions);
			this.scroll.prepend(card);
		}

		const passageEl = card.querySelector('.pm-explain-passage') as HTMLElement;
		const grid = card.querySelector('.pm-explain-grid') as HTMLElement;
		const actions = card.querySelector('.pm-explain-actions') as HTMLElement;

		if (content.passage !== undefined) {
			passageEl.textContent = content.passage;
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

		// Only scroll the card into view when it first appears; later content
		// swaps must not yank the reader's position around.
		if (isNew) {
			this.scroll.scrollTop = 0;
		}
	}

	hideExplanation(): void {
		const card = this.scroll.querySelector('.pm-explain-card') as HTMLElement | null;
		if (!card) {
			return;
		}
		// Compensate for the removed height so the article does not jump up.
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
		// Inserting a page above the viewport would shift content; keep place.
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

	renderPage(state: PageTranslationState): void {
		const section = this.ensurePageSection(state.pageIndex);
		switch (state.status) {
			case 'extracting':
			case 'translating': {
				section.status.replaceChildren(
					this.el('span', 'pm-bilingual-spinner'),
					this.doc.createTextNode(this.strings.statusTranslating.replace('%n%', String(state.pageIndex + 1)))
				);
				section.status.classList.remove('pm-error');
				break;
			}
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

	/** Incremental: existing nodes are updated in place (no full rebuild). */
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
		this.pages.get(pageIndex)?.marker.scrollIntoView({ block: 'start' });
	}

	scrollToBlock(blockId: string): void {
		this.articleHost.querySelector(`[data-pm-block="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: 'center' });
	}

	private handleScroll(): void {
		const rect = this.scroll.getBoundingClientRect();
		let best: number | null = null;
		for (const [pageIndex, section] of this.pages) {
			const hostRect = section.blocksHost.getBoundingClientRect();
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
		if (this.outsideClickHandler) {
			this.doc.removeEventListener('click', this.outsideClickHandler, true);
			this.outsideClickHandler = null;
		}
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
			this.toastTimer = null;
		}
		this.host.replaceChildren();
		this.pages.clear();
	}
}
