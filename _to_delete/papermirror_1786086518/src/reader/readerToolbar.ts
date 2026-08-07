/**
 * Toolbar integration: registers the "中英对照" toggle button through the
 * official Zotero.Reader renderToolbar event and manages one ReaderSession
 * per reader tab.
 */

import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { ReaderSession } from './readerSession';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'readerToolbar';
const BUTTON_CLASS = 'pm-bilingual-toolbar-toggle';

export class ReaderToolbarController {
	private pluginID: string;
	private sessions = new Map<string, ReaderSession>(); // key: tabID or itemID
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
						}
					}
				}
			},
			['tab'],
			'papermirror-toolbar'
		);

		// Existing readers: inject the button directly (their toolbars rendered
		// before our listener registered) AND nudge a re-render as backup.
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

	/** Build the toolbar button in the given reader document. */
	private makeButton(doc: Document, reader: ReaderLike): HTMLElement {
		const button = doc.createElement('button');
		button.className = `toolbar-button ${BUTTON_CLASS}`;
		button.textContent = '译';
		button.title = getString('papermirror-toolbar-toggle');
		button.setAttribute('tabindex', '-1');
		button.style.fontSize = '13px';
		button.style.lineHeight = '1';
		const key = this.sessionKey(reader);
		if (this.sessions.has(key)) {
			button.classList.add('active');
		}
		button.addEventListener('click', () => {
			logger.info(MODULE, 'Bilingual toggle clicked');
			void this.toggle(reader, button);
		});
		return button;
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
			if (doc.querySelector(`.${BUTTON_CLASS}`)) {
				return; // already present
			}
			const section = doc.createElement('div');
			section.className = 'section';
			section.appendChild(this.makeButton(doc, reader));
			sections.appendChild(section);
			logger.info(MODULE, 'Injected toolbar button into already-open reader');
		}
		catch (e) {
			logger.warn(MODULE, 'Direct toolbar injection failed', e);
		}
	}

	private sessionKey(reader: ReaderLike): string {
		return String(reader.tabID ?? reader.itemID ?? 'unknown');
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
			logger.debug(MODULE, 'renderToolbar event received; appending button');
			append(this.makeButton(doc, reader as ReaderLike));
		}
		catch (e) {
			logger.error(MODULE, 'renderToolbar handler failed', e);
		}
	}

	/** Toggle bilingual mode on the currently selected reader tab (manual/diagnostic entry). */
	async toggleCurrent(): Promise<string> {
		const win = Zotero.getMainWindow();
		const tabID = win?.Zotero_Tabs?.selectedID;
		const reader = tabID ? adapter.getReaderByTabID(tabID) : null;
		if (!reader) {
			return 'No reader tab is selected.';
		}
		if (!adapter.isPdfReader(reader)) {
			return 'The selected tab is not a PDF reader.';
		}
		if (!adapter.supportsSplitView(reader)) {
			return 'This reader does not support split view (standalone window?).';
		}
		await this.toggle(reader);
		return this.sessions.has(this.sessionKey(reader)) ? 'Bilingual view opened.' : 'Bilingual view closed.';
	}

	sessionCount(): number {
		return this.sessions.size;
	}

	/** Clear cached translations for the document in the active reader tab. */
	async clearCurrentCache(): Promise<string> {
		const win = Zotero.getMainWindow();
		const tabID = win?.Zotero_Tabs?.selectedID;
		const session = tabID ? this.sessions.get(String(tabID)) : undefined;
		if (!session) {
			return 'No bilingual session is open for the active tab.';
		}
		await session.clearCurrentCache();
		return 'Cache cleared for this document.';
	}

	async toggle(reader: ReaderLike, button?: HTMLElement): Promise<void> {
		const key = this.sessionKey(reader);
		const existing = this.sessions.get(key);
		if (existing) {
			existing.destroy();
			this.sessions.delete(key);
			button?.classList.remove('active');
			return;
		}
		const session = new ReaderSession(reader, () => {
			this.sessions.delete(key);
			button?.classList.remove('active');
		});
		this.sessions.set(key, session);
		try {
			await session.open();
			button?.classList.add('active');
		}
		catch (e) {
			logger.error(MODULE, 'Failed to open bilingual view', e);
			session.destroy();
			this.sessions.delete(key);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			session.destroy();
		}
		this.sessions.clear();
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
		// The renderToolbar listener itself is removed by Zotero via pluginID
		// on shutdown. For disable-without-restart, our handler also checks
		// this.disposed and becomes inert immediately.
		this.handler = null;
		// Remove buttons we appended to open reader toolbars.
		for (const reader of adapter.getAllReaders()) {
			try {
				const doc = reader._iframeWindow?.document;
				doc?.querySelectorAll(`.${BUTTON_CLASS}`).forEach(el => el.remove());
			}
			catch {
				// ignore
			}
		}
	}
}
