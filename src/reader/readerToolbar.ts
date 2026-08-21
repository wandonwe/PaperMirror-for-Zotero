/**
 * Toolbar integration.
 *
 * The reader toolbar carries the 翻译 icon plus a caret, registered through the
 * official Zotero.Reader `renderToolbar` event.
 *
 * Icon click — turns translation on and off. On means 左右对照 by default:
 *   the original PDF on the left, the same page re-flowed in Chinese on the
 *   right, both at the same size. Off restores the plain reader. The session is
 *   kept alive across toggles, so coming back is instant and costs no API calls.
 * Caret — picks the state directly: 原文 | 覆盖翻译 | 左右对照. The two
 *   translated states answer different questions, so neither is buried:
 *   覆盖 is for reading the paper as printed, 左右对照 is for reading the
 *   translation complete and unabridged in a side pane.
 */

import { getString } from '../utils/l10n';
import { getPref, setPref } from '../utils/prefs';
import * as logger from '../utils/logger';
import { ReaderSession, type ViewMode } from './readerSession';
import { TextExtractor } from './textExtractor';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'readerToolbar';
const SWITCH_CLASS = 'pm-compare-wrap';
const BUTTON_CLASS = 'pm-compare-btn';
const CARET_CLASS = 'pm-compare-caret';
const MENU_CLASS = 'pm-compare-menu';
const STYLE_ID = 'pm-compare-style';

const SWITCH_CSS = `
.${SWITCH_CLASS} {
	display: inline-flex;
	align-items: stretch;
	margin: 0 2px;
	-moz-user-select: none;
	user-select: none;
}
.${BUTTON_CLASS} {
	appearance: none;
	-moz-appearance: none;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 22px;
	margin: 0;
	padding: 0;
	border: 1px solid var(--fill-quinary, rgba(0, 0, 0, .16));
	border-radius: 5px;
	background: transparent;
	color: inherit;
	cursor: pointer;
}
.${BUTTON_CLASS} svg {
	width: 16px;
	height: 16px;
	display: block;
}
.${BUTTON_CLASS}:hover {
	background: var(--fill-quinary, rgba(0, 0, 0, .07));
}
/* The icon carries its own colours; pressed state is a ring + tint. */
.${BUTTON_CLASS}[aria-pressed="true"] {
	background: rgba(111, 108, 232, .16);
	border-color: #6f6ce8;
	box-shadow: 0 0 0 1px rgba(111, 108, 232, .45);
}
.${BUTTON_CLASS}[data-busy="true"] {
	opacity: .55;
	cursor: progress;
}

/* Caret opening the three-state menu: 原文 | 覆盖翻译 | 左右对照. The icon
   itself stays a one-click toggle — the caret is for choosing the mode. */
.${CARET_CLASS} {
	appearance: none;
	-moz-appearance: none;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 22px;
	margin: 0 0 0 1px;
	padding: 0;
	border: 1px solid var(--fill-quinary, rgba(0, 0, 0, .16));
	border-radius: 5px;
	background: transparent;
	color: inherit;
	cursor: pointer;
}
.${CARET_CLASS} svg {
	width: 12px;
	height: 12px;
	display: block;
	opacity: .75;
}
.${CARET_CLASS}:hover {
	background: var(--fill-quinary, rgba(0, 0, 0, .07));
}
.${CARET_CLASS}:hover svg { opacity: 1; }
/* Open state: the menu is showing — mark the caret as active. */
.${CARET_CLASS}[aria-expanded="true"] {
	background: rgba(111, 108, 232, .16);
	border-color: #6f6ce8;
}
.${CARET_CLASS}[aria-expanded="true"] svg { opacity: 1; }
.${SWITCH_CLASS} {
	position: relative;
}
.${MENU_CLASS} {
	position: absolute;
	top: 25px;
	right: 0;
	z-index: 20;
	min-width: 132px;
	padding: 4px;
	border: 1px solid var(--fill-quinary, rgba(0, 0, 0, .18));
	border-radius: 7px;
	background: var(--material-menu, var(--material-background, #fff));
	box-shadow: 0 6px 20px rgba(0, 0, 0, .22);
	font: 12px/1.4 system-ui, sans-serif;
	color: var(--fill-primary, #1b1d21);
}
.${MENU_CLASS} button {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 5px 8px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}
.${MENU_CLASS} button:hover {
	background: var(--fill-quinary, rgba(0, 0, 0, .08));
}
.${MENU_CLASS} button::before {
	content: "";
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: transparent;
}
.${MENU_CLASS} button[aria-checked="true"]::before {
	background: #6f6ce8;
}
.pm-compare-rule {
	height: 1px;
	margin: 4px 2px;
	background: var(--fill-quinary, rgba(0, 0, 0, .14));
}
`;

export class ReaderToolbarController {
	private pluginID: string;
	private sessions = new Map<string, ReaderSession>(); // key: tabID or itemID
	private modes = new Map<string, ViewMode>();
	/** Where the on/off button returns to, per reader. */
	private lastTranslatedMode = new Map<string, ViewMode>();
	private busy = new Set<string>();
	private notifierID: string | null = null;
	private handler: ((event: ZoteroReaderEvent) => void) | null = null;
	private disposed = false;

	constructor(pluginID: string) {
		this.pluginID = pluginID;
	}

	init(): void {
		this.handler = (event: ZoteroReaderEvent) => this.renderToolbarButton(event);
		// pluginID is REQUIRED: Zotero auto-unregisters by pluginID at shutdown
		// (manual unregisterEventListener is broken in 9.0.6 — see adapter).
		adapter.registerToolbarListener(this.pluginID, this.handler);
		// 「解析」 lives in the 译文面板 menu bar (a fixed button that explains
		// the current PDF selection). It is deliberately NOT in Zotero's shared
		// text-selection popup — every translation/note plugin crowds that popup
		// and the buttons collide — and not a floating chip either (the chip
		// fought the reader's selection events and never behaved reliably).

		// Close sessions when their tab closes; keep an eye on file deletes.
		this.notifierID = Zotero.Notifier.registerObserver(
			{
				notify: (action: string, type: string, ids: (number | string)[]) => {
					if (type === 'tab' && action === 'close') {
						for (const id of ids) {
							const session = this.sessions.get(String(id));
							if (session) {
								session.destroy();
								this.sessions.delete(String(id));
							}
							this.modes.delete(String(id));
						}
					}
				}
			},
			['tab'],
			'papermirror-toolbar'
		);

		// Existing readers: inject the switcher directly (their toolbars
		// rendered before our listener registered) AND nudge a re-render.
		for (const reader of adapter.getAllReaders()) {
			if (adapter.isPdfReader(reader) && adapter.supportsSplitView(reader)) {
				this.injectIntoExistingReader(reader);
				adapter.forceToolbarRerender(reader);
			}
		}
		logger.info(MODULE, `Toolbar controller initialized (${adapter.getAllReaders().length} open reader(s))`);
	}

	private ensureStyle(doc: Document): void {
		try {
			if (doc.getElementById(STYLE_ID)) {
				return;
			}
			const style = doc.createElement('style');
			style.id = STYLE_ID;
			style.textContent = SWITCH_CSS;
			(doc.head ?? doc.documentElement).appendChild(style);
		}
		catch (e) {
			logger.debug(MODULE, 'switcher style injection failed', e);
		}
	}

	/**
	 * The 对照翻译 icon — the plugin icon in miniature, in full colour:
	 * a split card, light left half (original, dark bar) and purple-gradient
	 * right half (translation, white bar + green live dot).
	 */
	private static appendCompareIcon(doc: Document, button: HTMLElement): void {
		const SVG_NS = 'http://www.w3.org/2000/svg';
		const el = (name: string, attrs: Record<string, string>): Element => {
			const node = doc.createElementNS(SVG_NS, name);
			for (const [k, v] of Object.entries(attrs)) {
				node.setAttribute(k, v);
			}
			return node;
		};
		const svg = el('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }) as SVGElement;
		const defs = el('defs', {});
		const grad = el('linearGradient', { id: 'pm-cmp-grad', x1: '0', y1: '0', x2: '0', y2: '1' });
		grad.appendChild(el('stop', { offset: '0', 'stop-color': '#96abf1' }));
		grad.appendChild(el('stop', { offset: '1', 'stop-color': '#6f6ce8' }));
		defs.appendChild(grad);
		svg.appendChild(defs);
		// Left sheet: the original
		svg.appendChild(el('path', {
			d: 'M8 2.4H3.9A1.9 1.9 0 0 0 2 4.3v7.4a1.9 1.9 0 0 0 1.9 1.9H8Z',
			fill: '#f7f8fa', stroke: 'rgba(0,0,0,.26)', 'stroke-width': '.6'
		}));
		// Right sheet: the translation
		svg.appendChild(el('path', {
			d: 'M8 1.9h4.1A1.9 1.9 0 0 1 14 3.8v7.9a1.9 1.9 0 0 1-1.9 1.9H8Z',
			fill: 'url(#pm-cmp-grad)'
		}));
		// Original: heading + two lines
		svg.appendChild(el('rect', { x: '3.4', y: '4.25', width: '3', height: '1.13', rx: '.56', fill: '#1c1e24' }));
		svg.appendChild(el('rect', { x: '3.4', y: '6.6', width: '3.4', height: '.88', rx: '.44', fill: '#9096a0' }));
		svg.appendChild(el('rect', { x: '3.4', y: '8.5', width: '2.4', height: '.88', rx: '.44', fill: '#9096a0' }));
		// Translation: live dot, heading, two lines
		svg.appendChild(el('circle', { cx: '9.5', cy: '3.1', r: '.58', fill: '#37c871' }));
		svg.appendChild(el('rect', { x: '9', y: '4.25', width: '3.2', height: '1.13', rx: '.56', fill: '#ffffff' }));
		svg.appendChild(el('rect', { x: '9', y: '6.6', width: '3.6', height: '.88', rx: '.44', fill: 'rgba(255,255,255,.72)' }));
		svg.appendChild(el('rect', { x: '9', y: '8.5', width: '2.7', height: '.88', rx: '.44', fill: 'rgba(255,255,255,.72)' }));
		button.appendChild(svg);
	}

	/**
	 * The mode-menu caret — a crisp stroked chevron instead of the text "▾",
	 * which rendered as a tiny off-centre glyph. currentColor + round joins so
	 * it stays sharp and matches the reader toolbar's other icons.
	 */
	private static appendCaretIcon(doc: Document, button: HTMLElement): void {
		const SVG_NS = 'http://www.w3.org/2000/svg';
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('aria-hidden', 'true');
		const path = doc.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', 'M4.5 6.5 8 10l3.5-3.5');
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.6');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
		button.appendChild(svg);
	}

	/**
	 * One icon button: 对照翻译. Pressed, the reader splits — original page on
	 * one side, that page rebuilt with translated text (原版排版保持不变) on
	 * the other. Pressed again, back to the plain PDF.
	 */
	private makeSwitcher(doc: Document, reader: ReaderLike): HTMLElement {
		this.ensureStyle(doc);
		const wrap = doc.createElement('div');
		wrap.className = SWITCH_CLASS;
		const button = doc.createElement('button');
		button.className = BUTTON_CLASS;
		button.title = `${getString('papermirror-compare')} — ${getString('papermirror-compare-tip')}`;
		button.setAttribute('aria-label', getString('papermirror-compare'));
		button.setAttribute('tabindex', '-1');
		button.setAttribute('aria-pressed', this.currentMode(reader) !== 'original' ? 'true' : 'false');
		ReaderToolbarController.appendCompareIcon(doc, button);
		// One click = 翻译开关. Off → back to whichever translated mode was last
		// used (覆盖 by default), so the button never surprises the reader with
		// a mode they did not pick.
		button.addEventListener('click', () => {
			const current = this.currentMode(reader);
			const next: ViewMode = current === 'original' ? this.preferredMode(reader) : 'original';
			logger.info(MODULE, `Translation view → ${next}`);
			void this.setMode(reader, next);
		});
		wrap.appendChild(button);

		const caret = doc.createElement('button');
		caret.className = CARET_CLASS;
		ReaderToolbarController.appendCaretIcon(doc, caret);
		caret.title = getString('papermirror-mode-pick');
		caret.setAttribute('aria-haspopup', 'menu');
		caret.setAttribute('aria-expanded', 'false');
		caret.setAttribute('tabindex', '-1');
		caret.addEventListener('click', (event) => {
			event.stopPropagation();
			this.toggleModeMenu(doc, wrap, reader);
		});
		wrap.appendChild(caret);
		return wrap;
	}

	/**
	 * 原文 | 覆盖翻译 | 左右对照 — the three reading states.
	 *
	 * 覆盖 keeps the page exactly as printed and swaps the words in place;
	 * 左右对照 gives the full, unabridged translation in a side pane. They
	 * answer different questions, so both stay one click away.
	 */
	private toggleModeMenu(doc: Document, wrap: HTMLElement, reader: ReaderLike): void {
		const caret = wrap.querySelector(`.${CARET_CLASS}`);
		const existing = wrap.querySelector(`.${MENU_CLASS}`);
		if (existing) {
			existing.remove();
			caret?.setAttribute('aria-expanded', 'false');
			return;
		}
		doc.querySelectorAll(`.${MENU_CLASS}`).forEach(node => node.remove());
		caret?.setAttribute('aria-expanded', 'true');
		const menu = doc.createElement('div');
		menu.className = MENU_CLASS;
		const current = this.currentMode(reader);
		const options: { mode: ViewMode; label: string }[] = [
			{ mode: 'original', label: getString('papermirror-mode-original') },
			{ mode: 'overlay', label: getString('papermirror-mode-overlay') },
			{ mode: 'split', label: getString('papermirror-mode-split') }
		];
		for (const option of options) {
			const item = doc.createElement('button');
			item.textContent = option.label;
			item.setAttribute('role', 'menuitemradio');
			item.setAttribute('aria-checked', option.mode === current ? 'true' : 'false');
			item.addEventListener('click', (event) => {
				event.stopPropagation();
				closeMenu();
				if (option.mode !== 'original') {
					this.lastTranslatedMode.set(this.sessionKey(reader), option.mode);
				}
				void this.setMode(reader, option.mode);
			});
			menu.appendChild(item);
		}

		// 覆盖模式下如何看原文 — without this the reader has no obvious way back
		// to the source text, which is the first thing they ask for.
		const rule = doc.createElement('div');
		rule.className = 'pm-compare-rule';
		menu.appendChild(rule);
		const peekOn = getPref<boolean>('overlayPeekHover', true);
		const peek = doc.createElement('button');
		peek.textContent = getString('papermirror-peek-hover');
		peek.title = getString('papermirror-peek-hover-tip');
		peek.setAttribute('role', 'menuitemcheckbox');
		peek.setAttribute('aria-checked', peekOn ? 'true' : 'false');
		peek.addEventListener('click', (event) => {
			event.stopPropagation();
			closeMenu();
			const next = !getPref<boolean>('overlayPeekHover', true);
			setPref('overlayPeekHover', next);
			this.sessions.get(this.sessionKey(reader))?.setPeekOnHover(next);
		});
		menu.appendChild(peek);

		const dim = doc.createElement('button');
		const dimOn = getPref<string>('overlayDisplayMode', 'dim-original') === 'dim-original';
		dim.textContent = getString('papermirror-dim-original');
		dim.title = getString('papermirror-dim-original-tip');
		dim.setAttribute('role', 'menuitemcheckbox');
		dim.setAttribute('aria-checked', dimOn ? 'true' : 'false');
		dim.addEventListener('click', (event) => {
			event.stopPropagation();
			closeMenu();
			const next = dimOn ? 'translation-only' : 'dim-original';
			setPref('overlayDisplayMode', next);
			this.sessions.get(this.sessionKey(reader))?.setOverlayDisplayMode(next);
		});
		menu.appendChild(dim);

		wrap.appendChild(menu);
		// Single close path: drop the menu, un-press the caret, unhook listeners.
		const closeMenu = (): void => {
			menu.remove();
			caret?.setAttribute('aria-expanded', 'false');
			doc.removeEventListener('click', dismiss, true);
		};
		// Any click elsewhere dismisses it.
		const dismiss = (): void => closeMenu();
		doc.addEventListener('click', dismiss, true);
	}

	/** The translated mode this reader returns to when switched back on. */
	private preferredMode(reader: ReaderLike): ViewMode {
		const stored = getPref<ViewMode>('viewMode', 'split');
		return this.lastTranslatedMode.get(this.sessionKey(reader))
			?? (stored === 'overlay' ? 'overlay' : 'split');
	}

	/**
	 * Direct DOM injection for readers already open at plugin startup. The
	 * next organic toolbar re-render clears this node and the renderToolbar
	 * listener re-adds it, so no duplication occurs.
	 */
	private injectIntoExistingReader(reader: ReaderLike): void {
		try {
			const sections = adapter.getToolbarCustomSections(reader);
			if (!sections) {
				logger.debug(MODULE, 'custom-sections not found for direct injection');
				return;
			}
			const doc = sections.ownerDocument!;
			if (doc.querySelector(`.${SWITCH_CLASS}`)) {
				return; // already present
			}
			const section = doc.createElement('div');
			section.className = 'section';
			section.appendChild(this.makeSwitcher(doc, reader));
			sections.appendChild(section);
			logger.info(MODULE, 'Injected compare button into already-open reader');
		}
		catch (e) {
			logger.warn(MODULE, 'Direct toolbar injection failed', e);
		}
	}

	private sessionKey(reader: ReaderLike): string {
		return String(reader.tabID ?? reader.itemID ?? 'unknown');
	}

	private currentMode(reader: ReaderLike): ViewMode {
		return this.modes.get(this.sessionKey(reader)) ?? 'original';
	}

	/** Repaint every button in this reader's toolbar to match the state. */
	private refreshSwitcher(reader: ReaderLike): void {
		try {
			const doc = reader._iframeWindow?.document;
			if (!doc) {
				return;
			}
			const key = this.sessionKey(reader);
			const pressed = this.currentMode(reader) !== 'original';
			const isBusy = this.busy.has(key);
			doc.querySelectorAll(`.${BUTTON_CLASS}`).forEach((node) => {
				const button = node as HTMLElement;
				button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
				if (isBusy) {
					button.dataset.busy = 'true';
				}
				else {
					delete button.dataset.busy;
				}
			});
		}
		catch (e) {
			logger.debug(MODULE, 'refreshSwitcher failed', e);
		}
	}

	private renderToolbarButton(event: ZoteroReaderEvent): void {
		if (this.disposed) {
			return;
		}
		try {
			const { reader, doc, append } = event;
			if (!adapter.isPdfReader(reader as ReaderLike) || !adapter.supportsSplitView(reader as ReaderLike)) {
				return;
			}
			logger.debug(MODULE, 'renderToolbar event received; appending compare button');
			append(this.makeSwitcher(doc, reader as ReaderLike));
		}
		catch (e) {
			logger.error(MODULE, 'renderToolbar handler failed', e);
		}
	}

	/** Switch a reader to one of the three states, creating a session if needed. */
	async setMode(reader: ReaderLike, mode: ViewMode): Promise<void> {
		const key = this.sessionKey(reader);
		if (this.busy.has(key)) {
			return;
		}
		const session = this.sessions.get(key);
		if (session) {
			this.modes.set(key, mode);
			session.setViewMode(mode);
			this.refreshSwitcher(reader);
			return;
		}
		if (mode === 'original') {
			// Nothing to tear down; just reflect the state.
			this.modes.set(key, 'original');
			this.refreshSwitcher(reader);
			return;
		}
		this.busy.add(key);
		this.modes.set(key, mode);
		this.refreshSwitcher(reader);
		const created = new ReaderSession(reader, () => {
			this.sessions.delete(key);
			this.modes.set(key, 'original');
			this.refreshSwitcher(reader);
		});
		created.setViewModeListener((next) => {
			this.modes.set(key, next);
			this.refreshSwitcher(reader);
		});
		this.sessions.set(key, created);
		try {
			await created.open(mode);
		}
		catch (e) {
			// Do NOT tear the session down silently. A vanished pane is the
			// least debuggable failure there is — leave it on screen carrying
			// the error, and keep the session so 「重试」 and the diagnostics
			// still work.
			logger.error(MODULE, 'Failed to open bilingual view', e);
			try {
				created.showOpenFailure(e);
			}
			catch (inner) {
				logger.error(MODULE, 'Could not surface the failure; tearing down', inner);
				created.destroy();
				this.sessions.delete(key);
				this.modes.set(key, 'original');
			}
		}
		finally {
			this.busy.delete(key);
			this.refreshSwitcher(reader);
		}
	}

	/** Toggle 翻译 on/off on the current tab (manual/diagnostic entry). */
	async toggleCurrent(): Promise<string> {
		const reader = this.activeReader();
		if (!reader) {
			return 'No reader tab is selected.';
		}
		if (!adapter.isPdfReader(reader)) {
			return 'The selected tab is not a PDF reader.';
		}
		if (!adapter.supportsSplitView(reader)) {
			return 'This reader does not support split view (standalone window?).';
		}
		const next: ViewMode = this.currentMode(reader) === 'original' ? this.preferredMode(reader) : 'original';
		await this.setMode(reader, next);
		return next === 'original' ? 'Translation closed.' : `Translation opened (${next}).`;
	}

	/** Public entry for the switcher used from Run JavaScript / prefs. */
	async setModeOnCurrent(mode: ViewMode): Promise<string> {
		const reader = this.activeReader();
		if (!reader) {
			return 'No reader tab is selected.';
		}
		await this.setMode(reader, mode);
		return `Reading mode: ${mode}`;
	}

	/**
	 * 「活动主窗口」(2.0.5, 审核 P2-20): 多主窗下 (Zotero 的「在新窗口中
	 * 打开」) `Zotero.getMainWindow()` 并不保证是用户正在操作的那个窗口 ——
	 * 以它解析 activeReader/activeSession 时,clearCurrentCache /
	 * exportCurrentPdf 这类 API 入口可能作用到**另一个窗口**里那篇文档。
	 * 现在优先选真正持有焦点的主窗口;没有任何主窗口有焦点(如从设置
	 * 窗口调用)时退回 getMainWindow(),与旧行为一致。
	 */
	private activeWindow(): (Window & { Zotero_Tabs?: any }) | null {
		try {
			const wins = (Zotero.getMainWindows?.() ?? []) as (Window & { Zotero_Tabs?: any })[];
			for (const w of wins) {
				try {
					if (w.document?.hasFocus?.()) {
						return w;
					}
				}
				catch {
					// a tearing-down window may throw — skip it
				}
			}
		}
		catch {
			// getMainWindows unavailable → fall back below
		}
		return Zotero.getMainWindow();
	}

	private activeReader(): ReaderLike | null {
		const win = this.activeWindow();
		const tabID = win?.Zotero_Tabs?.selectedID;
		return tabID ? adapter.getReaderByTabID(tabID) : null;
	}

	private activeSession(): ReaderSession | undefined {
		const win = this.activeWindow();
		const tabID = win?.Zotero_Tabs?.selectedID;
		return tabID ? this.sessions.get(String(tabID)) : undefined;
	}

	sessionCount(): number {
		return this.sessions.size;
	}

	/** Overlay coordinate self-check for the active reader tab. */
	verifyOverlay(): string {
		const session = this.activeSession();
		return session ? session.verifyOverlay() : 'No bilingual session is open for the active tab.';
	}

	/** Cycle the on-page overlay display mode for the active reader tab. */
	cycleOverlayMode(): string {
		const session = this.activeSession();
		return session ? session.cycleOverlayMode() : 'No bilingual session is open for the active tab.';
	}

	/**
	 * Report what each text-extraction path returned for the current page.
	 * Works even with no session open (a throwaway session is not created —
	 * the reader itself is enough).
	 */
	async diagnoseExtraction(): Promise<string> {
		const session = this.activeSession();
		if (session) {
			return session.diagnoseExtraction();
		}
		const reader = this.activeReader();
		if (!reader) {
			return 'No reader tab is selected.';
		}
		const extractor = new TextExtractor(reader, { includeReferences: false });
		const pageIndex = adapter.getCurrentPageIndex(reader);
		const reports = await extractor.diagnose(pageIndex);
		const lines = [`Page ${pageIndex + 1} extraction paths:`];
		for (const r of reports) {
			lines.push(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.path}: ${r.detail}`);
		}
		lines.push(reports.some(r => r.ok)
			? 'This PDF HAS a text layer — translation should work.'
			: 'No path found text on this page. If other pages work, this page is image-only.');
		return lines.join('\n');
	}

	/** 生成译文PDF for the active reader tab (API entry; no button any more). */
	async exportCurrentPdf(): Promise<string> {
		const session = this.activeSession();
		if (!session) {
			return 'Open the translation view first.';
		}
		await session.exportTranslatedPdf();
		return 'Translated PDF generation started.';
	}

	/** Clear cached translations for the document in the active reader tab. */
	async clearCurrentCache(): Promise<string> {
		const session = this.activeSession();
		if (!session) {
			return 'No bilingual session is open for the active tab.';
		}
		await session.clearCurrentCache();
		return 'Cache cleared for this document.';
	}

	/** Backwards-compatible toggle used by the public API. */
	async toggle(reader: ReaderLike): Promise<void> {
		await this.setMode(reader, this.currentMode(reader) === 'original' ? this.preferredMode(reader) : 'original');
	}

	/**
	 * 按窗口维度销毁会话 (2.0.4, 审核 P2-17)。多窗口场景 (Zotero 的
	 * 「在新窗口中打开」) 里主窗口关闭并不触发 tab close notifier,也不走
	 * shutdown —— 此前 onMainWindowUnload 只从 knownWindows 里删掉窗口,
	 * 属于该窗口的 ReaderSession(定时器、in-flight 请求、DOM 引用)整个泄漏,
	 * 且继续持有已死窗口的引用。归属判定失败 (getMainWindow 为 null) 的会话
	 * 保守保留 —— 误杀正在用的会话比多留一个待回收会话更糟。
	 */
	disposeWindow(win: Window): void {
		for (const [key, session] of [...this.sessions]) {
			if (session.getMainWindow() !== win) {
				continue;
			}
			try {
				session.destroy();
			}
			catch (e) {
				logger.warn(MODULE, 'disposeWindow: session destroy failed', e);
			}
			this.sessions.delete(key);
			this.modes.delete(key);
			this.lastTranslatedMode.delete(key);
			this.busy.delete(key);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			session.destroy();
		}
		this.sessions.clear();
		this.modes.clear();
		this.busy.clear();
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
		// The renderToolbar listener itself is removed by Zotero via pluginID
		// on shutdown. For disable-without-restart, our handler also checks
		// this.disposed and becomes inert immediately.
		this.handler = null;
		// Remove nodes we appended to open reader toolbars.
		for (const reader of adapter.getAllReaders()) {
			try {
				const doc = reader._iframeWindow?.document;
				doc?.querySelectorAll(`.${SWITCH_CLASS}`).forEach(el => el.remove());
				doc?.getElementById(STYLE_ID)?.remove();
			}
			catch {
				// ignore
			}
		}
	}
}
