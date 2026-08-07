/**
 * Translation pane UI. Renders exclusively via textContent — translated
 * strings are NEVER parsed as HTML (spec §9).
 */

import type { PageTranslationState } from '../translation/translationManager';
import type { SourceBlock } from '../types/models';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export interface PaneStrings {
	direction: string;
	statusIdle: string;
	statusTranslating: string;
	statusDone: string;
	statusCached: string;
	statusError: string;
	noTextLayer: string;
	pagePrefix: string;
	syncOn: string;
	syncOff: string;
	retranslate: string;
	copy: string;
	copyBoth: string;
	saveNote: string;
	settings: string;
	close: string;
	swapSides: string;
	privacyNotice: string;
	privacyAccept: string;
	pending: string;
	cancel: string;
}

export interface PaneCallbacks {
	onToggleSync(enabled: boolean): void;
	onRetranslate(): void;
	onCopy(mode: 'plain' | 'both'): void;
	onSaveNote(): void;
	onOpenSettings(): void;
	onClose(): void;
	onSwapSides(): void;
	onBlockClick(pageIndex: number, blockId: string): void;
	onScrolledToPage(pageIndex: number): void;
	onAcceptPrivacy(): void;
	onCancel(): void;
}

interface PageSection {
	root: HTMLElement;
	blocksHost: HTMLElement;
	status: HTMLElement;
}

export class TranslationPane {
	private host: HTMLElement;
	private doc: Document;
	private strings: PaneStrings;
	private callbacks: PaneCallbacks;
	private body!: HTMLElement;
	private statusEl!: HTMLElement;
	private directionEl!: HTMLElement;
	private syncBtn!: HTMLElement;
	private pages = new Map<number, PageSection>();
	private selectedBlockId: string | null = null;
	private syncEnabled = true;
	private scrollHandler: ((event: Event) => void) | null = null;
	private privacyOverlay: HTMLElement | null = null;

	constructor(host: HTMLElement, title: string, strings: PaneStrings, callbacks: PaneCallbacks) {
		this.host = host;
		this.doc = host.ownerDocument!;
		this.strings = strings;
		this.callbacks = callbacks;
		this.build(title);
	}

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

	private button(label: string, onClick: () => void, title?: string): HTMLElement {
		const btn = this.el('button', 'pm-bilingual-btn', label);
		if (title) {
			btn.setAttribute('title', title);
		}
		btn.addEventListener('click', onClick);
		return btn;
	}

	private build(title: string): void {
		const header = this.el('div', 'pm-bilingual-header');
		const titleEl = this.el('div', 'pm-bilingual-title', title);
		const meta = this.el('div', 'pm-bilingual-meta');
		this.directionEl = this.el('span', undefined, this.strings.direction);
		this.statusEl = this.el('span', undefined, this.strings.statusIdle);
		meta.append(this.directionEl, this.statusEl);

		const toolbar = this.el('div', 'pm-bilingual-toolbar');
		this.syncBtn = this.button(this.strings.syncOn, () => {
			this.syncEnabled = !this.syncEnabled;
			this.syncBtn.textContent = this.syncEnabled ? this.strings.syncOn : this.strings.syncOff;
			this.syncBtn.setAttribute('data-pm-active', String(this.syncEnabled));
			this.callbacks.onToggleSync(this.syncEnabled);
		});
		this.syncBtn.setAttribute('data-pm-active', 'true');
		toolbar.append(
			this.syncBtn,
			this.button(this.strings.retranslate, () => this.callbacks.onRetranslate()),
			this.button(this.strings.cancel, () => this.callbacks.onCancel()),
			this.button(this.strings.copy, () => this.callbacks.onCopy('plain')),
			this.button(this.strings.copyBoth, () => this.callbacks.onCopy('both')),
			this.button(this.strings.saveNote, () => this.callbacks.onSaveNote()),
			this.button(this.strings.swapSides, () => this.callbacks.onSwapSides()),
			this.button(this.strings.settings, () => this.callbacks.onOpenSettings()),
			this.button(this.strings.close, () => this.callbacks.onClose())
		);

		header.append(titleEl, meta, toolbar);
		this.body = this.el('div', 'pm-bilingual-body');
		this.scrollHandler = () => this.handleScroll();
		this.body.addEventListener('scroll', this.scrollHandler, { passive: true });
		this.host.append(header, this.body);
	}

	setTheme(theme: 'light' | 'dark'): void {
		this.host.setAttribute('data-pm-theme', theme);
	}

	setDirection(text: string): void {
		this.directionEl.textContent = text;
	}

	setStatus(text: string, isError = false): void {
		this.statusEl.textContent = text;
		this.statusEl.classList.toggle('pm-error', isError);
	}

	showPrivacyNotice(host: string): void {
		if (this.privacyOverlay) {
			return;
		}
		const notice = this.el('div', 'pm-bilingual-notice');
		notice.append(
			this.el('div', undefined, this.strings.privacyNotice),
			this.el('div', undefined, `→ ${host}`)
		);
		const accept = this.button(this.strings.privacyAccept, () => {
			notice.remove();
			this.privacyOverlay = null;
			this.callbacks.onAcceptPrivacy();
		});
		accept.style.marginTop = '8px';
		notice.append(accept);
		this.body.append(notice);
		this.privacyOverlay = notice;
	}

	getSelectedBlockId(): string | null {
		return this.selectedBlockId;
	}

	/** Return current text selection inside the pane (for copy / note). */
	getSelectionText(): string {
		const selection = this.doc.defaultView?.getSelection?.();
		const text = selection ? selection.toString() : '';
		if (text.trim()) {
			return text;
		}
		return '';
	}

	private ensurePageSection(pageIndex: number): PageSection {
		let section = this.pages.get(pageIndex);
		if (section) {
			return section;
		}
		const root = this.el('div', 'pm-bilingual-page');
		root.setAttribute('data-pm-page', String(pageIndex));
		const label = this.el('div', 'pm-bilingual-page-label', `${this.strings.pagePrefix} ${pageIndex + 1}`);
		const status = this.el('div', 'pm-bilingual-status');
		const blocksHost = this.el('div');
		root.append(label, status, blocksHost);
		section = { root, blocksHost, status };
		this.pages.set(pageIndex, section);
		// Keep pages in order
		const after = [...this.pages.keys()].filter(p => p > pageIndex).sort((a, b) => a - b)[0];
		if (after !== undefined) {
			this.body.insertBefore(root, this.pages.get(after)!.root);
		}
		else {
			this.body.append(root);
		}
		return section;
	}

	renderPage(state: PageTranslationState): void {
		const section = this.ensurePageSection(state.pageIndex);
		switch (state.status) {
			case 'extracting':
			case 'translating': {
				section.status.textContent = '';
				const spin = this.el('span', 'pm-bilingual-spinner');
				section.status.append(spin, this.doc.createTextNode(this.strings.statusTranslating));
				section.status.classList.remove('pm-error');
				break;
			}
			case 'done':
				section.status.textContent = state.fromCache ? this.strings.statusCached : '';
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
				node = this.el('div', 'pm-bilingual-block');
				node.setAttribute('data-pm-block', block.id);
				node.setAttribute('data-pm-type', block.type);
				node.setAttribute('data-pm-page', String(block.pageIndex));
				const handler = (): void => {
					this.highlightBlock(block.id);
					this.callbacks.onBlockClick(block.pageIndex, block.id);
				};
				node.addEventListener('click', handler);
				section.blocksHost.append(node);
			}
			if (translated !== undefined) {
				if (node.textContent !== translated) {
					node.textContent = translated; // SAFE: text node only
				}
				node.removeAttribute('data-pm-pending');
			}
			else if (!node.hasAttribute('data-pm-pending')) {
				node.setAttribute('data-pm-pending', 'true');
				node.textContent = '';
				const pending = this.el('span', 'pm-pending', this.strings.pending);
				node.append(pending);
			}
		}
	}

	highlightBlock(blockId: string): void {
		if (this.selectedBlockId) {
			this.body.querySelector(`[data-pm-block="${CSS.escape(this.selectedBlockId)}"]`)?.classList.remove('pm-highlight');
		}
		this.selectedBlockId = blockId;
		this.body.querySelector(`[data-pm-block="${CSS.escape(blockId)}"]`)?.classList.add('pm-highlight');
	}

	scrollToPage(pageIndex: number): void {
		const section = this.pages.get(pageIndex);
		if (section) {
			section.root.scrollIntoView({ block: 'start' });
		}
	}

	scrollToBlock(blockId: string): void {
		this.body.querySelector(`[data-pm-block="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: 'center' });
	}

	/** Determine the topmost visible page for reverse sync. */
	private handleScroll(): void {
		const bodyRect = this.body.getBoundingClientRect();
		let best: number | null = null;
		for (const [pageIndex, section] of this.pages) {
			const rect = section.root.getBoundingClientRect();
			if (rect.bottom > bodyRect.top + 20 && rect.top < bodyRect.bottom) {
				best = best === null ? pageIndex : Math.min(best, pageIndex);
			}
		}
		if (best !== null) {
			this.callbacks.onScrolledToPage(best);
		}
	}

	/** Gather visible content for whole-page copy. */
	getPageText(pageIndex: number, blocks: SourceBlock[], translations: Map<string, string>, mode: 'plain' | 'both'): string {
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
			this.body.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		this.host.replaceChildren();
		this.pages.clear();
	}
}
