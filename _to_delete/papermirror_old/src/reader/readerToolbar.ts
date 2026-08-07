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

		// Existing readers: nudge their toolbars so the button appears now.
		for (const reader of adapter.getAllReaders()) {
			if (adapter.isPdfReader(reader)) {
				adapter.forceToolbarRerender(reader);
			}
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
			const button = doc.createElement('button');
			button.className = `toolbar-button ${BUTTON_CLASS}`;
			button.textContent = '译';
			button.title = getString('papermirror-toolbar-toggle');
			button.setAttribute('tabindex', '-1');
			const key = this.sessionKey(reader as ReaderLike);
			if (this.sessions.has(key)) {
				button.classList.add('active');
			}
			button.addEventListener('click', () => {
				void this.toggle(reader as ReaderLike, button);
			});
			append(button);
		}
		catch (e) {
			logger.error(MODULE, 'renderToolbar handler failed', e);
		}
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
