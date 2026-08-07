/**
 * Per-reader-tab session: split view + pane + extraction + translation +
 * sync + notes, with complete teardown.
 */

import * as cacheManager from '../cache/cacheManager';
import { hashSourceTexts, type CacheKeyParts } from '../cache/cacheSchema';
import { saveTranslationNote, buildAttachmentSelectURI } from '../notes/noteService';
import { getApiKey } from '../security/credentialStore';
import { getProvider } from '../translation/providers/registry';
import { endpointHost } from '../translation/providers/types';
import { TranslationManager, type PageTranslationState } from '../translation/translationManager';
import { PROMPT_VERSION } from '../translation/promptBuilder';
import { parseGlossaryJSON } from '../translation/glossary';
import type { GlossaryRule, ProviderSettings, TranslationRequest, TranslationResponse } from '../types/models';
import { PaperMirrorError } from '../types/models';
import { TranslationPane, type PaneStrings } from '../ui/translationPane';
import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { getPref, setPref } from '../utils/prefs';
import { detectLanguage, defaultTargetFor, sourceCodeFor } from '../utils/languageDetector';
import { createSyncController, type SyncController } from './scrollSynchronizer';
import { createSplitView, type SplitViewHandles } from './splitView';
import { TextExtractor } from './textExtractor';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'readerSession';
const PAGE_POLL_MS = 350;

function paneStrings(): PaneStrings {
	return {
		direction: getString('papermirror-pane-direction'),
		statusIdle: getString('papermirror-status-idle'),
		statusTranslating: getString('papermirror-status-translating'),
		statusDone: getString('papermirror-status-done'),
		statusCached: getString('papermirror-status-cached'),
		statusError: getString('papermirror-status-error'),
		noTextLayer: getString('papermirror-no-text-layer'),
		pagePrefix: getString('papermirror-page'),
		syncOn: getString('papermirror-sync-on'),
		syncOff: getString('papermirror-sync-off'),
		retranslate: getString('papermirror-retranslate'),
		copy: getString('papermirror-copy'),
		copyBoth: getString('papermirror-copy-both'),
		saveNote: getString('papermirror-save-note'),
		settings: getString('papermirror-settings'),
		close: getString('papermirror-close'),
		swapSides: getString('papermirror-swap-sides'),
		privacyNotice: getString('papermirror-privacy-notice'),
		privacyAccept: getString('papermirror-privacy-accept'),
		pending: getString('papermirror-pending'),
		cancel: getString('papermirror-cancel')
	};
}

export class ReaderSession {
	private reader: ReaderLike;
	private onClosed: () => void;
	private split: SplitViewHandles | null = null;
	private pane: TranslationPane | null = null;
	private extractor: TextExtractor;
	private manager: TranslationManager | null = null;
	private sync: SyncController | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastPageIndex = -1;
	private fileHash = '';
	private detectedSource: string | null = null;
	private destroyed = false;

	constructor(reader: ReaderLike, onClosed: () => void) {
		this.reader = reader;
		this.onClosed = onClosed;
		this.extractor = new TextExtractor(reader, {
			includeReferences: getPref<boolean>('translateReferences', false)
		});
	}

	get tabID(): string | undefined {
		return this.reader.tabID;
	}

	async open(): Promise<void> {
		const container = adapter.getTabContainer(this.reader);
		const browser = adapter.getReaderBrowser(this.reader);
		this.split = createSplitView(container, browser);

		const item = adapter.getReaderItem(this.reader);
		const title = item?.getDisplayTitle?.() ?? (item ? String(item.getField('title') ?? '') : '') ?? 'PDF';

		this.pane = new TranslationPane(this.split.paneHost, title || 'PDF', paneStrings(), {
			onToggleSync: enabled => this.setSyncEnabled(enabled),
			onRetranslate: () => void this.retranslateCurrent(),
			onCopy: mode => void this.copyCurrent(mode),
			onSaveNote: () => void this.saveSelectionToNote(),
			onOpenSettings: () => this.openSettings(),
			onClose: () => this.close(),
			onSwapSides: () => this.swapSides(),
			onBlockClick: (pageIndex, _blockId) => this.sync?.onPaneNavigated(pageIndex),
			onScrolledToPage: pageIndex => this.sync?.onPaneNavigated(pageIndex),
			onAcceptPrivacy: () => {
				setPref('privacyNoticeAccepted', true);
				this.startTranslating();
			},
			onCancel: () => this.manager?.cancelAll()
		});
		this.pane.setTheme(adapter.isDarkTheme(this.reader) ? 'dark' : 'light');

		this.sync = createSyncController({
			scrollPaneToPage: pageIndex => this.pane?.scrollToPage(pageIndex),
			navigatePdfToPage: pageIndex => adapter.navigateToPage(this.reader, pageIndex)
		});
		this.sync.enabled = getPref<boolean>('syncScroll', true);

		// Resolve the file hash for cache keys (item.attachmentHash is md5)
		try {
			this.fileHash = item?.attachmentHash ? await item.attachmentHash : '';
		}
		catch {
			this.fileHash = '';
		}

		await this.extractor.prime();

		if (!getPref<boolean>('privacyNoticeAccepted', false)) {
			const settings = await this.providerSettings();
			const provider = getProvider(getPref<string>('provider', 'anthropic'));
			this.pane.showPrivacyNotice(endpointHost(settings, provider.defaultBaseURL));
		}
		else {
			this.startTranslating();
		}

		this.startPolling();
		logger.info(MODULE, `Session opened for tab ${this.reader.tabID}`);
	}

	private startTranslating(): void {
		if (this.manager || this.destroyed) {
			if (this.manager) {
				this.manager.setCurrentPage(adapter.getCurrentPageIndex(this.reader));
			}
			return;
		}
		this.manager = new TranslationManager(
			{
				extractPage: pageIndex => this.extractor.extractPage(pageIndex),
				translateRequest: (request, signal) => this.translateRequest(request, signal),
				readCache: async (pageIndex, blocks) => {
					const parts = await this.cacheKey(pageIndex, blocks.map(b => b.sourceText));
					return parts ? cacheManager.readPage(parts) : null;
				},
				writeCache: async (pageIndex, blocks, translations) => {
					const parts = await this.cacheKey(pageIndex, blocks.map(b => b.sourceText));
					if (parts) {
						await cacheManager.writePage(parts, translations);
					}
				},
				getLanguages: sample => this.resolveLanguages(sample),
				getDocumentTitle: () => {
					const item = adapter.getReaderItem(this.reader);
					return item?.getDisplayTitle?.() ?? '';
				},
				getGlossary: () => this.loadGlossary(),
				useContext: () => getPref<boolean>('useContext', true),
				pageCount: () => adapter.getPageCount(this.reader)
			},
			{
				onPageUpdate: state => this.onPageUpdate(state)
			},
			{
				maxConcurrent: getPref<number>('maxConcurrentRequests', 2),
				prefetch: getPref<boolean>('autoPrefetch', true)
			}
		);
		const page = adapter.getCurrentPageIndex(this.reader);
		this.lastPageIndex = page;
		this.manager.setCurrentPage(page);
	}

	private resolveLanguages(sample: string): { source: string; target: string } {
		const prefSource = getPref<string>('sourceLanguage', 'auto');
		const prefTarget = getPref<string>('targetLanguage', 'auto');
		if (!this.detectedSource) {
			const detected = detectLanguage(sample);
			this.detectedSource = sourceCodeFor(detected);
			const dir = `${this.detectedSource} → ${prefTarget !== 'auto' ? prefTarget : defaultTargetFor(detected)}`;
			this.pane?.setDirection(`${getString('papermirror-pane-direction')}: ${dir}`);
		}
		const source = prefSource !== 'auto' ? prefSource : this.detectedSource;
		const target = prefTarget !== 'auto'
			? prefTarget
			: defaultTargetFor(source === 'zh' ? 'zh' : source === 'en' ? 'en' : 'other');
		return { source, target };
	}

	private async providerSettings(): Promise<ProviderSettings & { allowInsecureHTTP?: boolean }> {
		const providerId = getPref<string>('provider', 'anthropic');
		const apiKey = await getApiKey(providerId);
		return {
			providerId,
			apiBaseURL: getPref<string>('apiBaseURL', ''),
			apiKey,
			model: getPref<string>('model', ''),
			timeoutMs: getPref<number>('timeoutMs', 60000),
			customPrompt: getPref<string>('customPrompt', ''),
			allowInsecureHTTP: getPref<boolean>('allowHTTPEndpoint', false)
		};
	}

	private async translateRequest(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse> {
		const settings = await this.providerSettings();
		const provider = getProvider(settings.providerId);
		if (provider.requiresApiKey && !settings.apiKey) {
			throw new PaperMirrorError('NO_API_KEY', getString('papermirror-error-no-api-key'), { retryable: false });
		}
		if (getPref<boolean>('localOnlyMode', false)) {
			const host = endpointHost(settings, provider.defaultBaseURL);
			if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
				throw new PaperMirrorError('HTTP_INSECURE', 'Local-only mode is enabled; configure a localhost endpoint.', { retryable: false });
			}
		}
		return provider.translate(request, settings, { signal });
	}

	private async cacheKey(pageIndex: number, texts: string[]): Promise<CacheKeyParts | null> {
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return null;
		}
		const settings = await this.providerSettings();
		const { source, target } = this.resolveLanguages(texts.join('\n').slice(0, 2000));
		return {
			attachmentKey: item.key,
			fileHash: this.fileHash || 'nohash',
			pageIndex,
			sourceLanguage: source,
			targetLanguage: target,
			provider: settings.providerId,
			model: settings.model,
			promptVersion: getPref<number>('promptVersion', PROMPT_VERSION),
			sourceTextHash: hashSourceTexts(texts)
		};
	}

	private loadGlossary(): GlossaryRule[] {
		return parseGlossaryJSON(getPref<string>('glossaryGlobal', '[]'));
	}

	private onPageUpdate(state: PageTranslationState): void {
		if (this.destroyed) {
			return;
		}
		this.pane?.renderPage(state);
		if (state.pageIndex === this.lastPageIndex) {
			switch (state.status) {
				case 'translating':
				case 'extracting':
					this.pane?.setStatus(getString('papermirror-status-translating'));
					break;
				case 'done':
					this.pane?.setStatus(state.fromCache ? getString('papermirror-status-cached') : getString('papermirror-status-done'));
					break;
				case 'error':
					this.pane?.setStatus(state.error?.message ?? getString('papermirror-status-error'), true);
					break;
				case 'no-text-layer':
					this.pane?.setStatus(getString('papermirror-no-text-layer'), true);
					break;
			}
		}
	}

	private startPolling(): void {
		this.pollTimer = setInterval(() => {
			if (this.destroyed) {
				return;
			}
			const page = adapter.getCurrentPageIndex(this.reader);
			if (page !== this.lastPageIndex) {
				this.lastPageIndex = page;
				this.manager?.setCurrentPage(page);
				this.sync?.onPdfPageChanged(page);
			}
		}, PAGE_POLL_MS);
	}

	private setSyncEnabled(enabled: boolean): void {
		if (this.sync) {
			this.sync.enabled = enabled;
		}
		setPref('syncScroll', enabled);
	}

	private async retranslateCurrent(): Promise<void> {
		if (!this.manager) {
			this.startTranslating();
			return;
		}
		const page = adapter.getCurrentPageIndex(this.reader);
		// Bypasses the cache; the fresh result overwrites the old entry on write.
		await this.manager.retranslatePage(page);
	}

	private async copyCurrent(mode: 'plain' | 'both'): Promise<void> {
		if (!this.pane || !this.manager) {
			return;
		}
		// Prefer explicit selection in the pane
		const selection = this.pane.getSelectionText();
		let text = selection;
		if (!text) {
			const page = adapter.getCurrentPageIndex(this.reader);
			const state = this.manager.getPageState(page);
			if (state) {
				text = this.pane.getPageText(page, state.blocks, state.translations, mode);
			}
		}
		if (!text) {
			return;
		}
		try {
			const helper = Components.classes['@mozilla.org/widget/clipboardhelper;1']
				.getService(Components.interfaces.nsIClipboardHelper);
			helper.copyString(text);
			this.pane.setStatus('✓ ' + getString('papermirror-copy'));
		}
		catch (e) {
			logger.warn(MODULE, 'Clipboard copy failed', e);
		}
	}

	private async saveSelectionToNote(): Promise<void> {
		if (!this.pane || !this.manager) {
			return;
		}
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return;
		}
		const page = adapter.getCurrentPageIndex(this.reader);
		const state = this.manager.getPageState(page);
		if (!state) {
			return;
		}
		// Selection in pane, or the highlighted block, or the whole page
		const selection = this.pane.getSelectionText();
		let original = '';
		let translated = '';
		const selectedId = this.pane.getSelectedBlockId();
		if (selection) {
			translated = selection;
			original = adapter.getSelectedText(this.reader) || (selectedId
				? state.blocks.find(b => b.id === selectedId)?.sourceText ?? ''
				: '');
		}
		else if (selectedId) {
			const block = state.blocks.find(b => b.id === selectedId);
			original = block?.sourceText ?? '';
			translated = state.translations.get(selectedId) ?? '';
		}
		else {
			original = state.blocks.map(b => b.sourceText).join('\n\n');
			translated = this.pane.getPageText(page, state.blocks, state.translations, 'plain');
		}
		if (!translated) {
			return;
		}
		const noteID = await saveTranslationNote(item, {
			originalText: original,
			translatedText: translated,
			documentTitle: item.getDisplayTitle?.() ?? '',
			pageNumber: page + 1,
			attachmentURI: buildAttachmentSelectURI(item)
		});
		this.pane.setStatus(noteID ? '✓ ' + getString('papermirror-save-note') : getString('papermirror-status-error'), !noteID);
	}

	private openSettings(): void {
		try {
			(Zotero as unknown as { Utilities: { Internal: { openPreferences?: (pane: string) => void } } })
				.Utilities.Internal.openPreferences?.('papermirror-prefpane');
		}
		catch (e) {
			logger.warn(MODULE, 'openSettings failed', e);
		}
	}

	private swapSides(): void {
		const current = getPref<string>('paneSide', 'right');
		this.split?.setSide(current === 'right' ? 'left' : 'right');
	}

	close(): void {
		this.destroy();
		this.onClosed();
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.manager?.dispose();
		this.manager = null;
		this.pane?.destroy();
		this.pane = null;
		this.split?.destroy();
		this.split = null;
		logger.info(MODULE, `Session destroyed for tab ${this.reader.tabID}`);
	}
}
