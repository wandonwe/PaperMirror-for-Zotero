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
	explainTip: string;
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
	/** 菜单栏「解析」按钮 — explain the current PDF selection. */
	onExplainSelection(): void;
	onToggleShowOriginal(enabled: boolean): void;
	onToggleOverlay(enabled: boolean): void;
	onToggleSync(enabled: boolean): void;
	onRetranslate(): void;
	onCopy(mode: 'plain' | 'both'): void;
	onSaveNote(): void;
	onExportPdf(): void;
	onToggleViewKind(kind: 'page' | 'article'): void;
	/** 菜单栏直接切换 — no round-trip through the settings pane. */
	onPickLanguages(source: string, target: string): void;
	onPickProvider(providerId: string): void;
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
	private pageRenderer: ((pageIndex: number, slot: HTMLElement, width: number) => Promise<'translated' | 'original' | false>) | null = null;
	private pageHost: HTMLElement | null = null;
	private currentPage = -1;
	private compareOriginal = false;
	private resizeObserver: { disconnect(): void } | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private explainKeyHandler: ((event: KeyboardEvent) => void) | null = null;
	private viewKindButton: HTMLElement | null = null;
	private sideButton: HTMLElement | null = null;
	private sideFill: HTMLElement | null = null;
	private paneSide: 'left' | 'right' = 'right';
	private providerPill: HTMLElement | null = null;
	private barMenu: HTMLElement | null = null;
	private barMenuDismiss: (() => void) | null = null;
	private langSource = 'auto';
	private langTarget = 'auto';
	private providerChoices: { id: string; displayName: string }[] = [];
	private currentProviderId = '';

	// ---- full-document page list (整页对照) --------------------------------
	/** Page boxes in PDF points, one per page, whether rendered or not. */
	private docPageSizes: { width: number; height: number }[] = [];
	/** One slot element per page, alive for the whole session. */
	private slots: HTMLElement[] = [];
	/** What each slot currently shows. */
	private slotState: ('empty' | 'original' | 'translated')[] = [];
	/** Set when a slot's content is stale (translation arrived, resize…). */
	private slotDirty: boolean[] = [];
	/** Monotonic token per slot — a stale async render must never land. */
	private slotToken: number[] = [];
	/** A failed slot is not retried before this timestamp (no hot spinning). */
	private slotRetryAt: number[] = [];
	/** One render at a time; re-prioritised between renders. */
	private pumping = false;
	private ensureTimer: ReturnType<typeof setTimeout> | null = null;
	/** Echo guard: ignore our own programmatic scrolls. */
	private suppressScrollUntil = 0;
	/** Width the slots were laid out for. */
	private layoutWidth = 0;
	/**
	 * CSS px per PDF point at the LEFT reader's current zoom. The translated
	 * page renders at this scale (capped by the pane), so its glyphs are the
	 * same size as the original's — never larger because the pane happens to
	 * be wider than the reader's page display.
	 */
	private displayPxPerPoint = 0;

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

	/** Human label for a language code, for the in-bar menus. */
	private static langLabel(code: string): string {
		const MAP: Record<string, string> = {
			'auto': '自动', 'en': 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文',
			'ja': '日本語', 'ko': '한국어', 'fr': 'Français', 'de': 'Deutsch',
			'es': 'Español', 'ru': 'Русский'
		};
		return MAP[code] ?? code;
	}

	private closeBarMenu(): void {
		this.barMenu?.remove();
		this.barMenu = null;
		if (this.barMenuDismiss) {
			this.doc.removeEventListener('click', this.barMenuDismiss, true);
			this.barMenuDismiss = null;
		}
	}

	/**
	 * One dropdown component for every bar chip. Anchored under its chip,
	 * dismissed by any click elsewhere — switching language or engine is a
	 * two-click affair, never a trip through the settings pane.
	 */
	private openBarMenu(
		anchor: HTMLElement,
		sections: { title?: string; items: { badge?: Element; label: string; checked: boolean; onPick(): void }[] }[]
	): void {
		if (this.barMenu?.getAttribute('data-pm-anchor') === anchor.className) {
			this.closeBarMenu();
			return;
		}
		this.closeBarMenu();
		const menu = this.el('div', 'pm-bar-menu');
		menu.setAttribute('data-pm-anchor', anchor.className);
		for (const section of sections) {
			if (section.title) {
				menu.appendChild(this.el('div', 'pm-bar-menu-title', section.title));
			}
			for (const item of section.items) {
				const row = this.el('button', 'pm-bar-menu-item');
				row.setAttribute('role', 'menuitemradio');
				row.setAttribute('aria-checked', String(item.checked));
				if (item.badge) {
					row.appendChild(item.badge);
				}
				row.appendChild(this.el('span', 'pm-bar-menu-label', item.label));
				row.addEventListener('click', (event) => {
					event.stopPropagation();
					this.closeBarMenu();
					item.onPick();
				});
				menu.appendChild(row);
			}
		}
		const hostRect = this.host.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		menu.style.top = `${anchorRect.bottom - hostRect.top + 4}px`;
		menu.style.left = `${Math.max(6, anchorRect.left - hostRect.left)}px`;
		this.host.appendChild(menu);
		// Keep it on screen when the chip sits near the right edge.
		const overflow = menu.getBoundingClientRect().right - hostRect.right + 8;
		if (overflow > 0) {
			menu.style.left = `${Math.max(6, anchorRect.left - hostRect.left - overflow)}px`;
		}
		this.barMenu = menu;
		this.barMenuDismiss = () => this.closeBarMenu();
		setTimeout(() => {
			if (this.barMenuDismiss) {
				this.doc.addEventListener('click', this.barMenuDismiss, true);
			}
		}, 0);
	}

	private openLanguageMenu(): void {
		const SOURCES = ['auto', 'en', 'zh-CN', 'ja', 'ko', 'de', 'fr'];
		const TARGETS = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'];
		this.openBarMenu(this.languagePill, [
			{
				title: '源语言',
				items: SOURCES.map(code => ({
					label: code === 'auto' ? '自动检测' : TranslationPane.langLabel(code),
					checked: this.langSource === code,
					onPick: () => this.callbacks.onPickLanguages(code, this.langTarget)
				}))
			},
			{
				title: '目标语言',
				items: TARGETS.map(code => ({
					label: code === 'auto' ? '自动（与源语言配对）' : TranslationPane.langLabel(code),
					checked: this.langTarget === code,
					onPick: () => this.callbacks.onPickLanguages(this.langSource, code)
				}))
			}
		]);
	}

	private openProviderMenu(): void {
		if (!this.providerPill || !this.providerChoices.length) {
			this.callbacks.onOpenSettings();
			return;
		}
		this.openBarMenu(this.providerPill, [
			{
				title: '翻译服务',
				items: this.providerChoices.map(choice => ({
					badge: this.providerBadge(choice.id),
					label: choice.displayName,
					checked: this.currentProviderId === choice.id,
					onPick: () => this.callbacks.onPickProvider(choice.id)
				}))
			},
			{
				items: [{
					label: this.strings.settings + '…',
					checked: false,
					onPick: () => this.callbacks.onOpenSettings()
				}]
			}
		]);
	}

	/** The engine roster for the in-bar switcher, supplied by the session. */
	setProviderChoices(choices: { id: string; displayName: string }[], currentId: string): void {
		this.providerChoices = choices;
		this.currentProviderId = currentId;
	}

	/** Current language codes, so the menus can mark the active entries. */
	setLanguageCodes(source: string, target: string): void {
		this.langSource = source;
		this.langTarget = target;
	}

	/**
	 * A small brand badge per translation service, drawn in code — Microsoft's
	 * four squares, Google's four-colour ring, coloured monograms for the rest.
	 * One function, used by the header chip and the switcher menu, so the two
	 * can never disagree.
	 */
	private providerBadge(id: string): Element {
		const svg = this.doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('class', 'pm-provider-badge');
		const node = (name: string, attrs: Record<string, string>, text?: string): Element => {
			const el = this.doc.createElementNS(SVG_NS, name);
			for (const [k, v] of Object.entries(attrs)) {
				el.setAttribute(k, v);
			}
			if (text !== undefined) {
				el.textContent = text;
			}
			return el;
		};
		const tile = (fill: string): Element => node('rect', { x: '.5', y: '.5', width: '15', height: '15', rx: '3.5', fill });

		switch (id) {
			case 'bing-free':
				// Microsoft: the four squares.
				svg.append(
					node('rect', { x: '1.5', y: '1.5', width: '6', height: '6', fill: '#f25022' }),
					node('rect', { x: '8.5', y: '1.5', width: '6', height: '6', fill: '#7fba00' }),
					node('rect', { x: '1.5', y: '8.5', width: '6', height: '6', fill: '#00a4ef' }),
					node('rect', { x: '8.5', y: '8.5', width: '6', height: '6', fill: '#ffb900' })
				);
				return svg;
			case 'google-free': {
				// Google: the sign-in "G", the canonical four-colour path
				// (24×24 artwork, scaled to fit).
				const g = node('g', { transform: 'translate(1.4 1.4) scale(0.55)' });
				g.append(
					node('path', { fill: '#4285F4', d: 'M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z' }),
					node('path', { fill: '#34A853', d: 'M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z' }),
					node('path', { fill: '#FBBC05', d: 'M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z' }),
					node('path', { fill: '#EA4335', d: 'M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z' })
				);
				svg.appendChild(g);
				return svg;
			}
			case 'openai': {
				// The hexagonal knot: six identical petals, rotated 60° apart.
				const g = node('g', {});
				for (let i = 0; i < 6; i++) {
					g.appendChild(node('path', {
						d: 'M8 1.4c1.5 0 2.7 1.2 2.7 2.7v3.2L8 8.9 5.3 7.3V4.1C5.3 2.6 6.5 1.4 8 1.4Z',
						fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15',
						'stroke-linejoin': 'round',
						transform: `rotate(${i * 60} 8 8)`
					}));
				}
				svg.appendChild(g);
				return svg;
			}
			case 'anthropic': {
				// Anthropic: the radiating burst mark on the warm cream tile —
				// their actual symbol, not a letter. Tapered rays out of centre.
				const g = node('g', { fill: '#141413' });
				for (let i = 0; i < 12; i++) {
					// Alternating ray lengths give the burst its distinctive
					// long/short rhythm.
					const long = i % 2 === 0;
					const outer = long ? 6.4 : 4.9;
					g.appendChild(node('path', {
						d: `M8 ${8 - outer} 8.62 8 8 8.62 7.38 8Z`,
						transform: `rotate(${i * 30} 8 8)`
					}));
				}
				svg.append(tile('#F0EEE5'), g);
				return svg;
			}
			case 'gemini': {
				// Gemini: the four-point gradient star (the real mark).
				const defs = node('defs', {});
				const grad = node('linearGradient', { id: 'pm-gem', x1: '0', y1: '1', x2: '1', y2: '0' });
				grad.append(
					node('stop', { offset: '0', 'stop-color': '#1C7DFF' }),
					node('stop', { offset: '.52', 'stop-color': '#4796E3' }),
					node('stop', { offset: '1', 'stop-color': '#9177C7' })
				);
				defs.appendChild(grad);
				svg.append(defs, node('path', {
					d: 'M8 1c.55 3.8 2.65 5.9 6.5 6.5-3.85.6-5.95 2.7-6.5 6.5-.55-3.8-2.65-5.9-6.5-6.5C5.35 6.9 7.45 4.8 8 1Z',
					fill: 'url(#pm-gem)'
				}));
				return svg;
			}
			case 'deepseek':
				// DeepSeek: the blue whale swoosh.
				svg.append(node('path', {
					d: 'M14.6 4.2c-.5 2.1-1.7 3.5-3.2 4.5.1.5.1 1-.05 1.6-.4 1.7-1.7 3-3.6 3.4-1.9.4-3.9-.2-5.5-1.7-.4-.4-.8-.9-1-1.4.9.5 1.8.7 2.6.6-.9-.7-1.5-1.6-1.8-2.7-.3-1.2-.1-2.4.5-3.5.7 1.4 1.7 2.4 3 3 .9.4 1.9.6 2.9.5.6-1.5 1.7-2.7 3.2-3.6-.5-.2-1-.3-1.6-.3.7-.5 1.5-.8 2.3-.8.8-.1 1.5 0 2.25.4Z',
					fill: '#4D6BFE'
				}));
				return svg;
			case 'deepl':
				// DeepL: the navy tile with the white dart.
				svg.append(
					tile('#0F2B46'),
					node('path', { d: 'M4.4 3.6 12.4 8l-8 4.4v-3.1L8.6 8 4.4 6.7Z', fill: '#fff' })
				);
				return svg;
			case 'moonshot':
				// Kimi: the black tile with the crescent-cut K.
				svg.append(
					tile('#101418'),
					node('path', { d: 'M4.6 3.4h2.1v3.9L10 3.4h2.7L9.2 7.6l3.6 5h-2.6L7.7 9.1l-1 1.1v2.4H4.6Z', fill: '#fff' })
				);
				return svg;
			case 'qwen': {
				// 通义千问: the violet interlocking hexagram.
				const defs = node('defs', {});
				const grad = node('linearGradient', { id: 'pm-qwen', x1: '0', y1: '0', x2: '1', y2: '1' });
				grad.append(node('stop', { offset: '0', 'stop-color': '#7B5CFF' }), node('stop', { offset: '1', 'stop-color': '#4735D9' }));
				defs.appendChild(grad);
				svg.append(defs, tile('url(#pm-qwen)'),
					node('path', { d: 'M8 2.8 12.5 10.6H3.5Z', fill: 'none', stroke: '#fff', 'stroke-width': '1.2', 'stroke-linejoin': 'round' }),
					node('path', { d: 'M8 13.2 3.5 5.4h9Z', fill: 'none', stroke: '#fff', 'stroke-width': '1.2', 'stroke-linejoin': 'round', opacity: '.85' })
				);
				return svg;
			}
			case 'zhipu':
				svg.append(tile('#2D5CFE'), node('path', { d: 'M4.4 3.6h7.2v1.9L7.4 10.5h4.4v1.9H4.2v-1.9l4.2-5H4.4Z', fill: '#fff' }));
				return svg;
			case 'siliconflow': {
				// SiliconFlow: the purple pinwheel.
				const g = node('g', {});
				for (let i = 0; i < 4; i++) {
					g.appendChild(node('path', {
						d: 'M8 8C8 4.7 9.6 2.4 12.6 1.6 12.2 4.9 10.7 7 8 8Z',
						fill: '#8A5BF6', transform: `rotate(${i * 90} 8 8)`
					}));
				}
				svg.appendChild(g);
				return svg;
			}
			case 'groq':
				svg.append(tile('#F55036'), node('path', {
					d: 'M11.4 7.9a3.4 3.4 0 1 0-3.4 3.4h1.5v1.9H8a5.3 5.3 0 1 1 5.3-5.3v3.3h-1.9Z',
					fill: '#fff'
				}));
				return svg;
			case 'ollama':
				// Ollama: the llama face.
				svg.append(
					tile('#ffffff'),
					node('path', {
						d: 'M5.1 2.2c.7 0 1.2 1 1.3 2.2a4 4 0 0 1 3.2 0c.1-1.2.6-2.2 1.3-2.2s1.3 1.3 1.2 2.7c0 .3-.1.6-.2.9a4 4 0 0 1 1 2.7c0 1-.3 1.8-.9 2.5.2.4.3.9.3 1.4 0 .5-.1.9-.3 1.3h-1.3c.2-.4.4-.8.4-1.3 0-.4-.1-.8-.3-1.1a4 4 0 0 1-5.6 0c-.2.3-.3.7-.3 1.1 0 .5.2.9.4 1.3H4.0a3.1 3.1 0 0 1 0-2.7c-.6-.7-.9-1.5-.9-2.5a4 4 0 0 1 1-2.7c-.1-.3-.2-.6-.2-.9-.1-1.4.5-2.7 1.2-2.7Z',
						fill: 'none', stroke: '#111', 'stroke-width': '.9', 'stroke-linejoin': 'round'
					}),
					node('circle', { cx: '6.6', cy: '8.3', r: '.55', fill: '#111' }),
					node('circle', { cx: '9.4', cy: '8.3', r: '.55', fill: '#111' })
				);
				return svg;
			case 'openrouter':
				svg.append(tile('#20242C'), node('path', {
					d: 'M3 6.2h2.4c1 0 1.7.4 2.5 1 .8-.6 1.5-1 2.5-1h.9V4.6L13.9 7 11.3 9.4V7.8h-.9c-.7 0-1.2.3-2 .9-.8.6-1.6 1.1-2.9 1.1H3Z',
					fill: '#fff'
				}));
				return svg;
			case 'openai-compatible':
			case 'custom': {
				// No brand to borrow: a neutral endpoint glyph.
				svg.append(tile('#3A4150'),
					node('circle', { cx: '8', cy: '8', r: '4.4', fill: 'none', stroke: '#fff', 'stroke-width': '1.1' }),
					node('path', { d: 'M3.6 8h8.8M8 3.6c1.5 1.3 1.5 7.5 0 8.8M8 3.6c-1.5 1.3-1.5 7.5 0 8.8', fill: 'none', stroke: '#fff', 'stroke-width': '.9' })
				);
				return svg;
			}
			default:
				svg.append(tile('#5b6472'), node('text', {
					x: '8', y: '8.5', fill: '#fff', 'text-anchor': 'middle', 'dominant-baseline': 'central',
					'font-family': 'Inter, system-ui, sans-serif', 'font-weight': '700', 'font-size': '8'
				}, (id[0] ?? '?').toUpperCase()));
				return svg;
		}
	}

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
			fill: '#f7f8fa', stroke: 'rgba(0,0,0,.26)', 'stroke-width': '.6'
		}));
		svg.appendChild(node('path', {
			d: 'M8 1.9h4.1A1.9 1.9 0 0 1 14 3.8v7.9a1.9 1.9 0 0 1-1.9 1.9H8Z',
			fill: 'url(#pm-brand-grad)'
		}));
		svg.appendChild(node('rect', { x: '3.4', y: '4.25', width: '3', height: '1.13', rx: '.56', fill: '#1c1e24' }));
		svg.appendChild(node('rect', { x: '3.4', y: '6.6', width: '3.4', height: '.88', rx: '.44', fill: '#9096a0' }));
		svg.appendChild(node('circle', { cx: '9.5', cy: '3.1', r: '.58', fill: '#37c871' }));
		svg.appendChild(node('rect', { x: '9', y: '4.25', width: '3.2', height: '1.13', rx: '.56', fill: '#ffffff' }));
		svg.appendChild(node('rect', { x: '9', y: '6.6', width: '3.6', height: '.88', rx: '.44', fill: 'rgba(255,255,255,.72)' }));
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
		this.languagePill.setAttribute('title', '切换语言');
		this.languagePill.addEventListener('click', (event) => {
			event.stopPropagation();
			this.openLanguageMenu();
		});

		const providerPill = this.el('button', 'pm-chip pm-chip-provider');
		this.providerPill = providerPill;
		providerPill.setAttribute('title', '切换翻译服务');
		this.providerMark = this.el('span', 'pm-provider-mark');
		this.providerName = this.el('span', 'pm-provider-name', '');
		providerPill.append(this.providerMark, this.providerName);
		providerPill.addEventListener('click', (event) => {
			event.stopPropagation();
			this.openProviderMenu();
		});

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
			this.textButton('pm-bar-action', `✦ ${this.strings.explain}`, this.strings.explainTip, () => this.callbacks.onExplainSelection()),
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

	setProviderInfo(displayName: string, providerId?: string): void {
		this.providerName.textContent = displayName;
		this.providerMark.replaceChildren();
		if (providerId) {
			this.currentProviderId = providerId;
			this.providerMark.appendChild(this.providerBadge(providerId));
		}
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
		// The card FLOATS over the pane's lower edge — it must never touch the
		// scroll position. The old behaviour prepended it into the scroll body
		// and jumped to the top of the document, which read as "everything I
		// was looking at just vanished".
		let card = this.host.querySelector('.pm-explain-card') as HTMLElement | null;
		if (!card) {
			card = this.el('div', 'pm-explain-card pm-explain-floating');
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
			this.host.append(card);
			// Esc dismisses — there must always be an obvious way out.
			this.explainKeyHandler = (event: KeyboardEvent): void => {
				if (event.key === 'Escape') {
					this.hideExplanation();
				}
			};
			this.doc.addEventListener('keydown', this.explainKeyHandler, true);
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
	}

	hideExplanation(): void {
		if (this.explainKeyHandler) {
			this.doc.removeEventListener('keydown', this.explainKeyHandler, true);
			this.explainKeyHandler = null;
		}
		this.host.querySelector('.pm-explain-card')?.remove();
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
	 * Install the page renderer. The session owns it because rendering needs
	 * the reader and the translation state; the pane only decides WHICH pages
	 * to render and when. The renderer resolves to what the slot now shows —
	 * 'translated', 'original' (translation not finished yet), or false when
	 * the page could not be rendered at all.
	 */
	setPageRenderer(renderer: (pageIndex: number, slot: HTMLElement, width: number) => Promise<'translated' | 'original' | false>): void {
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
		this.slots = [];
		this.slotState = [];
		this.slotDirty = [];
		this.slotToken = [];
		this.slotRetryAt = [];
		this.refreshViewKindButton();
		if (kind === 'page') {
			this.initPageList();
		}
	}

	/**
	 * The pane's two readings of the same text: 文章流 is complete and never
	 * clips; 整页对照 rebuilds the page's own layout beside the original. The
	 * button offers the OTHER one.
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

	/** Width a page gets, in CSS px — nearly edge to edge of the pane. */
	private pageWidthAvailable(): number {
		const scrollW = this.scroll.clientWidth || this.host.clientWidth;
		return Math.max(160, (scrollW || 400) - 20);
	}

	/**
	 * Pane resized: re-lay the slots out at the new width and re-render what
	 * is on screen. Debounced — a divider drag fires continuously, and each
	 * re-render costs real canvases.
	 */
	private observeResize(): void {
		const view = this.doc.defaultView as (Window & { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } }) | null;
		if (!view?.ResizeObserver || this.resizeObserver) {
			return;
		}
		const observer = new view.ResizeObserver(() => {
			if (this.viewKind !== 'page' || !this.slots.length) {
				return;
			}
			if (Math.abs(this.pageWidthAvailable() - this.layoutWidth) < 8) {
				return;
			}
			if (this.resizeTimer) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.relayoutSlots();
			}, 180);
		});
		observer.observe(this.scroll);
		this.resizeObserver = observer;
	}

	private relayoutSlots(force = false): void {
		const fresh = this.pageWidthAvailable();
		if (!force && Math.abs(fresh - this.layoutWidth) < 8) {
			return;
		}
		// Keep the same document position through the resize.
		const anchorFraction = this.scroll.scrollHeight > 0
			? this.scroll.scrollTop / this.scroll.scrollHeight
			: 0;
		this.layoutWidth = fresh;
		for (let i = 0; i < this.slots.length; i++) {
			this.sizeSlot(this.slots[i]!, i);
			// Content was built for the old width: release it.
			if (this.slotState[i] !== 'empty') {
				this.slotToken[i]!++;
				this.slotState[i] = 'empty';
				this.slots[i]!.replaceChildren(this.makeGhost(i));
			}
		}
		this.scroll.scrollTop = anchorFraction * this.scroll.scrollHeight;
		this.scheduleEnsure();
	}

	/**
	 * 整页对照 now shows the WHOLE document: one slot per page, laid out from
	 * the page boxes before anything is rendered, so the scrollbar and page
	 * positions are correct from the first frame. Pages render lazily around
	 * the viewport — the original page while its translation is pending, the
	 * rebuilt translated page once it is done.
	 */
	setDocumentPages(sizes: { width: number; height: number }[]): void {
		this.docPageSizes = sizes;
		if (this.viewKind === 'page') {
			this.initPageList();
		}
	}

	/** The reader zoomed — match it. */
	setDisplayScale(pxPerPoint: number): void {
		if (!Number.isFinite(pxPerPoint) || pxPerPoint <= 0) {
			return;
		}
		if (Math.abs(pxPerPoint - this.displayPxPerPoint) < 0.005) {
			return;
		}
		this.displayPxPerPoint = pxPerPoint;
		if (this.viewKind === 'page' && this.slots.length) {
			this.relayoutSlots(true);
		}
	}

	/** Target CSS width for one page: the reader's display width, pane-capped. */
	private slotWidthFor(pageIndex: number): number {
		const available = this.pageWidthAvailable();
		const size = this.docPageSizes[pageIndex];
		if (!size || this.displayPxPerPoint <= 0) {
			return available;
		}
		return Math.min(available, Math.round(size.width * this.displayPxPerPoint));
	}

	private initPageList(): void {
		if (!this.docPageSizes.length) {
			return;
		}
		const host = this.ensurePageHost();
		this.layoutWidth = this.pageWidthAvailable();
		this.slots = [];
		this.slotState = [];
		this.slotDirty = [];
		this.slotToken = [];
		this.slotRetryAt = [];
		const children: HTMLElement[] = [];
		for (let i = 0; i < this.docPageSizes.length; i++) {
			const slot = this.el('div', 'pm-repage-slot');
			slot.setAttribute('data-pm-slot', String(i));
			this.sizeSlot(slot, i);
			slot.appendChild(this.makeGhost(i));
			this.slots.push(slot);
			this.slotState.push('empty');
			this.slotDirty.push(false);
			this.slotToken.push(0);
			this.slotRetryAt.push(0);
			children.push(
				this.el('div', 'pm-repage-page-label',
					`${this.strings.pagePrefix} ${i + 1} ${this.strings.pageSuffix}`.trim()),
				slot
			);
		}
		host.replaceChildren(...children);
		this.scheduleEnsure();
	}

	private sizeSlot(slot: HTMLElement, pageIndex: number): void {
		const size = this.docPageSizes[pageIndex]!;
		const width = this.slotWidthFor(pageIndex);
		slot.style.width = `${width}px`;
		slot.style.height = `${Math.round(width * (size.height / size.width))}px`;
	}

	/** Placeholder shown before a page renders and after it is released. */
	private makeGhost(pageIndex: number): HTMLElement {
		const ghost = this.el('div', 'pm-repage-ghost');
		ghost.append(
			this.el('span', 'pm-bilingual-spinner'),
			this.el('span', undefined, String(pageIndex + 1))
		);
		return ghost;
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

	// ---- virtualisation -----------------------------------------------------

	/** Slots intersecting the viewport, expanded by `buffer` pages each way. */
	private visibleRange(buffer: number): [number, number] {
		const top = this.scroll.scrollTop;
		const bottom = top + this.scroll.clientHeight;
		let first = -1;
		let last = -1;
		for (let i = 0; i < this.slots.length; i++) {
			const slot = this.slots[i]!;
			const slotTop = slot.offsetTop;
			const slotBottom = slotTop + slot.offsetHeight;
			if (slotBottom > top && slotTop < bottom) {
				if (first < 0) {
					first = i;
				}
				last = i;
			}
		}
		if (first < 0) {
			return [0, Math.min(this.slots.length - 1, buffer)];
		}
		return [Math.max(0, first - buffer), Math.min(this.slots.length - 1, last + buffer)];
	}

	private scheduleEnsure(): void {
		if (this.ensureTimer) {
			return;
		}
		this.ensureTimer = setTimeout(() => {
			this.ensureTimer = null;
			void this.pumpRenders();
		}, 60);
	}

	/**
	 * Render what the reader is looking at, one page at a time, nearest first.
	 * Between pages the priorities are recomputed, so a fast scroll does not
	 * queue up a wake of stale work. Pages far outside the window release
	 * their canvases — with several supersampled canvases per page, an
	 * unbounded list is an out-of-memory crash on a long paper.
	 */
	private async pumpRenders(): Promise<void> {
		if (this.pumping || this.viewKind !== 'page' || !this.pageRenderer || !this.slots.length) {
			return;
		}
		this.pumping = true;
		try {
			for (let guard = 0; guard < 24; guard++) {
				const [first, last] = this.visibleRange(1);
				const now = Date.now();
				let target = -1;
				for (let i = first; i <= last; i++) {
					if ((this.slotState[i] === 'empty' || this.slotDirty[i]) && now >= (this.slotRetryAt[i] ?? 0)) {
						target = i;
						break;
					}
				}
				if (target < 0) {
					// Anything left is only waiting out its retry backoff.
					for (let i = first; i <= last; i++) {
						if (this.slotState[i] === 'empty' || this.slotDirty[i]) {
							this.ensureTimer ??= setTimeout(() => {
								this.ensureTimer = null;
								void this.pumpRenders();
							}, 1500);
							break;
						}
					}
					break;
				}
				const token = ++this.slotToken[target]!;
				this.slotDirty[target] = false;
				const slot = this.slots[target]!;
				let result: 'translated' | 'original' | false = false;
				try {
					// The renderer has its own timeouts; this race is the
					// backstop that keeps the whole pump from freezing if it
					// ever hangs anyway — the freeze bug, once, was the pane
					// stuck on a spinner forever.
					result = await Promise.race([
						this.pageRenderer(target, slot, this.slotWidthFor(target)),
						new Promise<false>(resolve => setTimeout(() => resolve(false), 20000))
					]);
				}
				catch (e) {
					logger.debug(MODULE, `page ${target + 1} render failed`, e);
				}
				if (this.slotToken[target] !== token || this.viewKind !== 'page') {
					continue; // superseded while rendering
				}
				if (result === false) {
					// Not renderable right now: keep the ghost, come back in a
					// moment — never spin on the same failing page.
					this.slotState[target] = 'empty';
					this.slotRetryAt[target] = Date.now() + 2500;
				}
				else {
					this.slotState[target] = result;
					this.slotRetryAt[target] = 0;
					this.applyCompareState();
				}
			}
			this.releaseFarSlots();
		}
		finally {
			this.pumping = false;
		}
	}

	private releaseFarSlots(): void {
		const [first, last] = this.visibleRange(2);
		for (let i = 0; i < this.slots.length; i++) {
			if (i >= first && i <= last) {
				continue;
			}
			if (this.slotState[i] !== 'empty') {
				this.slotToken[i]!++;
				this.slotState[i] = 'empty';
				this.slotDirty[i] = false;
				this.slots[i]!.replaceChildren(this.makeGhost(i));
			}
		}
	}

	/**
	 * The reader moved to another page. The fraction-level scroll sync handles
	 * following; this only records the position and nudges rendering priority.
	 */
	setCurrentPage(pageIndex: number): void {
		if (this.currentPage === pageIndex) {
			return;
		}
		this.currentPage = pageIndex;
		if (this.viewKind === 'page') {
			this.scheduleEnsure();
		}
	}

	/**
	 * A page's translation state changed. Only completion is worth a rebuild:
	 * re-rendering on every intermediate state would repaint the original page
	 * over and over while the provider streams in.
	 */
	refreshPage(pageIndex: number): void {
		if (this.viewKind !== 'page' || !this.slots[pageIndex]) {
			return;
		}
		this.slotDirty[pageIndex] = true;
		this.scheduleEnsure();
	}

	/**
	 * 同步滚动: mirror the reader's position — page AND the fraction within
	 * it. This is what keeps 原文第 2 页 from sitting beside 译文第 1 页: the
	 * pane follows the document position continuously, not per page.
	 */
	setPdfScrollFraction(pageIndex: number, fraction: number): void {
		if (this.viewKind !== 'page') {
			return;
		}
		const slot = this.slots[pageIndex];
		if (!slot) {
			return;
		}
		const target = slot.offsetTop + fraction * slot.offsetHeight - 6;
		const max = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
		this.suppressScrollUntil = Date.now() + 300;
		this.scroll.scrollTop = Math.max(0, Math.min(target, max));
		this.scheduleEnsure();
	}

	/**
	 * 显示原文对照 — hide the masks so the original text shows through the
	 * rebuilt pages, for a direct read against the source.
	 */
	private applyCompareState(): void {
		this.pageHost?.querySelectorAll('.pm-repage').forEach((page) => {
			page.setAttribute('data-pm-compare', String(this.compareOriginal));
		});
	}

	renderPage(state: PageTranslationState): void {
		if (this.viewKind === 'page') {
			// Show the original until the translation is COMPLETE; swap the
			// slot to the rebuilt page only on 'done'.
			if (state.status === 'done') {
				this.refreshPage(state.pageIndex);
			}
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
			this.setPdfScrollFraction(pageIndex, 0);
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
			// Full-document list: keep the window rendered, and tell the
			// session which page leads the viewport — unless this scroll is
			// the echo of our own 同步滚动 write.
			this.scheduleEnsure();
			if (Date.now() < this.suppressScrollUntil) {
				return;
			}
			const anchor = this.scroll.scrollTop + this.scroll.clientHeight * 0.35;
			for (let i = 0; i < this.slots.length; i++) {
				const slot = this.slots[i]!;
				if (slot.offsetTop <= anchor && slot.offsetTop + slot.offsetHeight > anchor) {
					best = i;
					break;
				}
			}
			if (best !== null && best !== this.currentPage) {
				this.currentPage = best;
				this.callbacks.onScrolledToPage(best);
			}
			return;
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
		if (this.explainKeyHandler) {
			this.doc.removeEventListener('keydown', this.explainKeyHandler, true);
			this.explainKeyHandler = null;
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
		if (this.ensureTimer) {
			clearTimeout(this.ensureTimer);
			this.ensureTimer = null;
		}
		this.closeBarMenu();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.pageRenderer = null;
		this.host.replaceChildren();
		this.pages.clear();
		this.pageHost = null;
	}
}
