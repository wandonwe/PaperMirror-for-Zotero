/**
 * Toolbar integration.
 *
 * The reader toolbar carries ONE button — 对照翻译 — registered through the
 * official Zotero.Reader `renderToolbar` event.
 *
 * Pressed:  the reader splits. The original page stays on one side; the other
 *           side shows that same page rebuilt with the body text translated,
 *           rendered at exactly the same size, so the two read as a spread.
 *           The divider and Zotero's own zoom resize both together.
 * Released: the pane is hidden and the PDF is untouched. The session is kept
 *           alive, so pressing again is instant and costs no API calls.
 *
 * The on-page overlay mode still exists behind Zotero.PaperMirror.setMode()
 * for anyone who wants it; it is simply not on the toolbar.
 */

import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { ReaderSession, type ViewMode } from './readerSession';
import { TextExtractor } from './textExtractor';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'readerToolbar';
const SWITCH_CLASS = 'pm-compare-wrap';
const BUTTON_CLASS = 'pm-compare-btn';
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
`;

export class ReaderToolbarController {
	private pluginID: string;
	private sessions = new Map<string, ReaderSession>(); // key: tabID or itemID
	private modes = new Map<string, ViewMode>();
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
		// 选中文字弹窗中的「讲解」按钮 (Read Frog-style deep explanation)
		adapter.registerSelectionPopupListener(this.pluginID, event => this.renderSelectionPopup(event));

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

	/**
	 * Selection popup: offer 「讲解」 when a bilingual session is active for
	 * this reader. append() must be called synchronously (custom-sections
	 * contract), so the async work happens in the click handler.
	 */
	private renderSelectionPopup(event: ZoteroReaderEvent): void {
		if (this.disposed) {
			return;
		}
		try {
			const { reader, doc, params, append } = event;
			const session = this.sessions.get(this.sessionKey(reader as ReaderLike));
			if (!session) {
				return;
			}
			const selectedText: string = String(params?.annotation?.text ?? '');
			if (!selectedText.trim()) {
				return;
			}
			const button = doc.createElement('button');
			button.className = 'pm-bilingual-explain-popup-btn';
			button.textContent = getString('papermirror-explain');
			button.style.cssText = 'margin:2px;padding:2px 8px;font-size:12px;cursor:pointer;';
			button.addEventListener('click', () => {
				void session.explainSelection(selectedText);
			});
			append(button);
		}
		catch (e) {
			logger.warn(MODULE, 'renderTextSelectionPopup handler failed', e);
		}
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
		// Left half: light card
		svg.appendChild(el('path', {
			d: 'M8 2.4H3.9A1.9 1.9 0 0 0 2 4.3v7.4a1.9 1.9 0 0 0 1.9 1.9H8Z',
			fill: '#f7f8fa', stroke: 'rgba(0,0,0,.28)', 'stroke-width': '.6'
		}));
		// Right half: purple gradient card (slightly taller, like the icon)
		svg.appendChild(el('path', {
			d: 'M8 1.9h4.1A1.9 1.9 0 0 1 14 3.8v7.9a1.9 1.9 0 0 1-1.9 1.9H8Z',
			fill: 'url(#pm-cmp-grad)'
		}));
		// Left dark bar + text stubs
		svg.appendChild(el('rect', { x: '3.4', y: '4.4', width: '3', height: '1.1', rx: '.55', fill: '#1c1e24' }));
		svg.appendChild(el('rect', { x: '3.4', y: '7', width: '3.4', height: '.9', rx: '.45', fill: '#8b8f98' }));
		svg.appendChild(el('rect', { x: '3.4', y: '8.9', width: '2.4', height: '.9', rx: '.45', fill: '#8b8f98' }));
		// Right white bar + green dot + text stubs
		svg.appendChild(el('circle', { cx: '9.3', cy: '3.3', r: '.55', fill: '#37c871' }));
		svg.appendChild(el('rect', { x: '9', y: '4.4', width: '3.2', height: '1.1', rx: '.55', fill: '#4b50e6' }));
		svg.appendChild(el('rect', { x: '9', y: '7', width: '3.6', height: '.9', rx: '.45', fill: 'rgba(255,255,255,.92)' }));
		svg.appendChild(el('rect', { x: '9', y: '8.9', width: '2.7', height: '.9', rx: '.45', fill: 'rgba(255,255,255,.92)' }));
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
		button.setAttribute('aria-pressed', this.currentMode(reader) === 'split' ? 'true' : 'false');
		ReaderToolbarController.appendCompareIcon(doc, button);
		button.addEventListener('click', () => {
			const next: ViewMode = this.currentMode(reader) === 'split' ? 'original' : 'split';
			logger.info(MODULE, `Compare view ${next === 'split' ? 'opened' : 'closed'}`);
			void this.setMode(reader, next);
		});
		wrap.appendChild(button);
		return wrap;
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
			const pressed = this.currentMode(reader) === 'split';
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
			logger.error(MODULE, 'Failed to open bilingual view', e);
			created.destroy();
			this.sessions.delete(key);
			this.modes.set(key, 'original');
		}
		finally {
			this.busy.delete(key);
			this.refreshSwitcher(reader);
		}
	}

	/** Toggle between 原文 and 左右对照 on the current tab (manual/diagnostic entry). */
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
		const next: ViewMode = this.currentMode(reader) === 'original' ? 'split' : 'original';
		await this.setMode(reader, next);
		return next === 'split' ? 'Bilingual view opened.' : 'Bilingual view closed.';
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

	private activeReader(): ReaderLike | null {
		const win = Zotero.getMainWindow();
		const tabID = win?.Zotero_Tabs?.selectedID;
		return tabID ? adapter.getReaderByTabID(tabID) : null;
	}

	private activeSession(): ReaderSession | undefined {
		const win = Zotero.getMainWindow();
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
		await this.setMode(reader, this.currentMode(reader) === 'original' ? 'split' : 'original');
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
