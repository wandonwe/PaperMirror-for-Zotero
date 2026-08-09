/**
 * Per-reader-tab session: split view + pane + extraction + translation +
 * sync + notes, with complete teardown.
 */

import * as cacheManager from '../cache/cacheManager';
import { hashSourceTexts, type CacheKeyParts } from '../cache/cacheSchema';
import {
	buildAttachmentSelectURI,
	explanationToPlainText,
	saveExplanationNote,
	saveTranslationNote
} from '../notes/noteService';
import { getApiKey } from '../security/credentialStore';
import { getProvider, listProviders } from '../translation/providers/registry';
import { buildPool, pickProviderForPage } from '../translation/providerPool';
import { endpointHost } from '../translation/providers/types';
import { canExplain, explainText, parseExplanationSections, type ExplanationSection } from '../translation/explainer';
import { TranslationManager, type PageTranslationState } from '../translation/translationManager';
import { PROMPT_VERSION } from '../translation/promptBuilder';
import { parseGlossaryJSON } from '../translation/glossary';
import type { GlossaryRule, ProviderSettings, TranslationRequest, TranslationResponse } from '../types/models';
import { PaperMirrorError } from '../types/models';
import { TranslationPane, type PaneStrings } from '../ui/translationPane';
import { buildFallbackPage, buildOriginalPage, buildTranslatedPage, settleTranslatedPage } from '../ui/translatedPageView';
import { translateFullPdf, bytesToBase64, type TranslateSubmission } from '../translation/pdfService';
import { buildTranslatedPdf, type PageTranslationData } from '../pdfgen/translatedPdfBuilder';
import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { getPref, setPref } from '../utils/prefs';
import { detectLanguage, defaultTargetFor, sourceCodeFor } from '../utils/languageDetector';
import { createSyncController, type SyncController } from './scrollSynchronizer';
import { PdfOverlay, type OverlayDisplayMode } from './pdfOverlay';
import { createSplitView, type SplitViewHandles } from './splitView';
import { TextExtractor } from './textExtractor';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike } from './zoteroReaderAdapter';

const MODULE = 'readerSession';
const PAGE_POLL_MS = 350;

/**
 * The three reader states behind the toolbar switcher
 * 「原文 | 覆盖翻译 | 左右对照」.
 *
 * All three share one session, so switching never discards translations or
 * re-hits the provider: 'original' just hides both surfaces, 'overlay' paints
 * on the page with the pane hidden, 'split' shows the pane.
 */
export type ViewMode = 'original' | 'overlay' | 'split';

function paneStrings(): PaneStrings {
	return {
		eyebrow: 'PAPERMIRROR',
		title: getString('papermirror-pane-title'),
		explain: getString('papermirror-explain'),
		explainTip: getString('papermirror-explain-tip'),
		explainTitle: getString('papermirror-explain-title'),
		explainSubtitle: getString('papermirror-explain-subtitle'),
		explainCopy: getString('papermirror-explain-copy'),
		explainSave: getString('papermirror-explain-save'),
		syncScroll: getString('papermirror-prefs-syncscroll'),
		statusTranslating: getString('papermirror-status-translating-page'),
		statusDone: getString('papermirror-status-done-page'),
		statusCached: getString('papermirror-status-cached'),
		statusError: getString('papermirror-status-error'),
		noTextLayer: getString('papermirror-no-text-layer'),
		pagePrefix: getString('papermirror-page'),
		pageSuffix: getString('papermirror-page-suffix'),
		retranslate: getString('papermirror-retranslate'),
		saveNote: getString('papermirror-save-note'),
		settings: getString('papermirror-settings'),
		close: getString('papermirror-close'),
		swapSides: getString('papermirror-swap-sides'),
		pending: getString('papermirror-pending'),
		viewArticle: getString('papermirror-view-article'),
		viewPage: getString('papermirror-view-page'),
		privacyNotice: getString('papermirror-privacy-notice'),
		privacyAccept: getString('papermirror-privacy-accept')
	};
}

/** Human display name for a language code (for the header pill). */
function languageLabel(code: string): string {
	switch (code) {
		case 'en': return 'English';
		case 'zh': case 'zh-CN': return '简体中文';
		case 'zh-TW': return '繁體中文';
		case 'auto': return getString('papermirror-lang-auto');
		default: return code;
	}
}

export class ReaderSession {
	private reader: ReaderLike;
	private onClosed: () => void;
	private split: SplitViewHandles | null = null;
	private pane: TranslationPane | null = null;
	private extractor: TextExtractor;
	private manager: TranslationManager | null = null;
	private sync: SyncController | null = null;
	private overlay: PdfOverlay | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastPageIndex = -1;
	private fileHash = '';
	private detectedSource: string | null = null;
	private destroyed = false;
	private viewMode: ViewMode = 'split';
	private onViewModeChanged: ((mode: ViewMode) => void) | null = null;
	private disposePdfEvents: (() => void) | null = null;
	private pageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private statusHideTimer: ReturnType<typeof setTimeout> | null = null;
	/** Provider pool (primary first). Rebuilt when translation (re)starts. */
	private pool: string[] = [];
	/** Real image rects per page (operator list), fetched once per document. */
	private imageRects = new Map<number, [number, number, number, number][] | null>();
	/** True while a full-PDF translation is running on the local bridge. */
	private exportingPdf = false;
	/** Most recent deep explanation, for copy / save-to-note. */
	private lastExplanation: { passage: string; sections: ExplanationSection[]; pageNumber: number } | null = null;

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

	/** Called whenever the mode changes, so the toolbar can restyle itself. */
	setViewModeListener(listener: (mode: ViewMode) => void): void {
		this.onViewModeChanged = listener;
	}

	async open(mode: ViewMode = 'split'): Promise<void> {
		this.viewMode = mode === 'original' ? 'split' : mode;
		const container = adapter.getTabContainer(this.reader);
		const browser = adapter.getReaderBrowser(this.reader);
		this.split = createSplitView(container, browser);
		// 缩略图 | 原文 | 译文: the reader's own sidebar width is measured and
		// excluded from the split, so 原文 and 译文 divide the REMAINING space
		// equally — not "sidebar+original = translation".
		this.split.setInsetProvider(() => adapter.getViewerInsetWidth(this.reader));
		// Decide the pane's visibility NOW, not after priming.
		//
		// The pane is created visible, and applyViewMode() used to run only
		// after `extractor.prime()` — seconds later. In 覆盖模式 that read as
		// the translation panel popping open and then vanishing on its own,
		// which is exactly what it looked like. Settle it before anything can
		// be seen.
		this.split.setPaneVisible(this.viewMode === 'split'
			|| !getPref<boolean>('privacyNoticeAccepted', false));

		const item = adapter.getReaderItem(this.reader);
		const title = item?.getDisplayTitle?.() ?? (item ? String(item.getField('title') ?? '') : '') ?? 'PDF';

		this.pane = new TranslationPane(this.split.paneHost, title || 'PDF', paneStrings(), {
			onExplainBlock: (pageIndex, blockId) => {
				const state = this.manager?.getPageState(pageIndex);
				const source = state?.blocks.find(b => b.id === blockId)?.sourceText ?? '';
				void this.explainSelection(source);
			},
			onCopyExplanation: () => this.copyExplanation(),
			onSaveExplanationNote: () => void this.saveExplanationToNote(),
			// 菜单栏「解析」: explains the current PDF selection, or the
			// highlighted 译文 block, or asks the reader to select text first.
			onExplainSelection: () => void this.explainSelection(),
			onToggleSync: enabled => this.setSyncEnabled(enabled),
			onRetranslate: () => void this.retranslateCurrent(),
			onSaveNote: () => void this.saveSelectionToNote(),
			onOpenSettings: () => this.openSettings(),
			onToggleViewKind: kind => setPref('paneView', kind),
			onPickLanguages: (source, target) => this.applyLanguagePick(source, target),
			onPickProvider: providerId => this.applyProviderPick(providerId),
			onClose: () => this.close(),
			onSwapSides: () => this.swapSides(),
			onBlockClick: (pageIndex, _blockId) => this.sync?.onPaneNavigated(pageIndex),
			onScrolledToPage: pageIndex => this.sync?.onPaneNavigated(pageIndex),
			onAcceptPrivacy: () => {
				setPref('privacyNoticeAccepted', true);
				this.applyViewMode();
				this.startTranslating();
			}
		});
		this.pane.setTheme(adapter.isDarkTheme(this.reader) ? 'dark' : 'light');
		this.pane.setPaneSide(getPref<string>('paneSide', 'right') === 'left' ? 'left' : 'right');
		this.pane.setShowOriginal(getPref<boolean>('showOriginal', false));
		this.pane.setSyncEnabled(getPref<boolean>('syncScroll', true));
		this.overlay = new PdfOverlay(this.reader);
		this.overlay.setDisplayMode(getPref<OverlayDisplayMode>('overlayDisplayMode', 'dim-original'));
		this.overlay.setPeekOnHover(getPref<boolean>('overlayPeekHover', true));
		this.overlay.setFitMode(getPref<'strict' | 'expand'>('overlayFitMode', 'expand'));
		this.pane.setArticleFontSize(getPref<number>('articleFontSize', 16));
		// 整页对照: the pane shows the whole document; each page renders as
		// the original until its translation completes, then swaps.
		this.pane.setPageRenderer((pageIndex, slot, width) => this.renderDocPage(pageIndex, slot, width));
		this.installDocumentLayout();
		// 左右对照 = 原文左 / 版面级重排的整页译文右. 文章流 stays one click
		// away in the pane header for anyone who wants plain continuous text.
		this.pane.setViewKind(getPref<'page' | 'article'>('paneView', 'page'));
		{
			const providerId = getPref<string>('provider', 'bing-free');
			this.pane.setProviderChoices(
				listProviders().map(p => ({ id: p.id, displayName: p.displayName })),
				providerId
			);
			this.pane.setProviderInfo(getProvider(providerId).displayName, providerId);
			const prefSource = getPref<string>('sourceLanguage', 'auto');
			const prefTarget = getPref<string>('targetLanguage', 'auto');
			this.pane.setLanguageCodes(prefSource, prefTarget);
			this.pane.setLanguagePair(languageLabel(prefSource), languageLabel(prefTarget));
		}

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
			const provider = getProvider(getPref<string>('provider', 'bing-free'));
			// The notice lives in the pane, so it must be on screen to be read.
			this.split.setPaneVisible(true);
			this.pane.showPrivacyNotice(endpointHost(settings, provider.defaultBaseURL));
		}
		else {
			this.applyViewMode();
			// Instant acknowledgement of the click: the first page's status
			// only arrives once extraction finishes.
			this.overlayStatus(
				getString('papermirror-status-translating-page')
					.replace('%n%', String(adapter.getCurrentPageIndex(this.reader) + 1)),
				{ busy: true }
			);
			this.startTranslating();
		}

		// PDF.js events: the pane renders its pages itself now, so left-side
		// re-renders and zooms no longer force a rebuild. The only thing the
		// stream drives is 同步滚动 — following the reader's position (page AND
		// fraction within it) continuously, which is what keeps 原文第 2 页
		// from sitting beside 译文第 1 页.
		this.disposePdfEvents = adapter.onPdfRenderEvents(this.reader, (pageIndex) => {
			if (this.destroyed || pageIndex !== null) {
				return;
			}
			// Zoom on the left → the right pages match the new glyph size.
			this.pane?.setDisplayScale(adapter.getViewerPxPerPoint(this.reader));
			if (this.sync?.enabled) {
				const current = adapter.getCurrentPageIndex(this.reader);
				const fraction = adapter.getPageScrollFraction(this.reader, current);
				if (fraction !== null) {
					this.pane?.setPdfScrollFraction(current, fraction);
				}
			}
		});

		this.startPolling();
		logger.info(MODULE, `Session opened for tab ${this.reader.tabID}`);
	}

	private startTranslating(): void {
		void this.rebuildPool();
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
				// Free engines stay at ≤2 (scrape bot-risk); key providers may
				// go to 6 — modern tier-1 rate limits take that comfortably.
				maxConcurrent: Math.min(
					getProvider(getPref<string>('provider', 'bing-free')).requiresApiKey ? 6 : 2,
					Math.max(1, getPref<number>('maxConcurrentRequests', 2))
				),
				prefetch: getPref<boolean>('autoPrefetch', true)
			}
		);
		const page = adapter.getCurrentPageIndex(this.reader);
		this.lastPageIndex = page;
		this.pane?.setCurrentPage(page);
		this.manager.setCurrentPage(page);
	}

	private resolveLanguages(sample: string): { source: string; target: string } {
		const prefSource = getPref<string>('sourceLanguage', 'auto');
		const prefTarget = getPref<string>('targetLanguage', 'auto');
		if (!this.detectedSource) {
			const detected = detectLanguage(sample);
			this.detectedSource = sourceCodeFor(detected);
			const shownTarget = prefTarget !== 'auto' ? prefTarget : defaultTargetFor(detected);
			this.pane?.setLanguagePair(languageLabel(this.detectedSource), languageLabel(shownTarget));
		}
		const source = prefSource !== 'auto' ? prefSource : this.detectedSource;
		const target = prefTarget !== 'auto'
			? prefTarget
			: defaultTargetFor(source === 'zh' ? 'zh' : source === 'en' ? 'en' : 'other');
		return { source, target };
	}

	private async providerSettings(): Promise<ProviderSettings & { allowInsecureHTTP?: boolean }> {
		return this.providerSettingsFor(getPref<string>('provider', 'bing-free'));
	}

	/**
	 * Settings for one pool member. The PRIMARY provider carries the user's
	 * Base URL / model overrides; extras run on their own defaults with their
	 * own stored keys — the overrides belong to the provider they were typed
	 * for, and leaking an OpenAI base URL into a DeepSeek request would be a
	 * silent misroute.
	 */
	private async providerSettingsFor(providerId: string): Promise<ProviderSettings & { allowInsecureHTTP?: boolean }> {
		const primary = getPref<string>('provider', 'bing-free');
		const isPrimary = providerId === primary;
		const apiKey = await getApiKey(providerId);
		return {
			providerId,
			apiBaseURL: isPrimary ? getPref<string>('apiBaseURL', '') : '',
			apiKey,
			model: isPrimary ? getPref<string>('model', '') : '',
			timeoutMs: getPref<number>('timeoutMs', 60000),
			customPrompt: getPref<string>('customPrompt', ''),
			allowInsecureHTTP: getPref<boolean>('allowHTTPEndpoint', false)
		};
	}

	/** Rebuild the pool: primary + every checked extra that is actually usable. */
	private async rebuildPool(): Promise<void> {
		const primary = getPref<string>('provider', 'bing-free');
		let extras: string[] = [];
		try {
			const raw = JSON.parse(getPref<string>('parallelProviders', '[]'));
			extras = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
		}
		catch {
			extras = [];
		}
		const usable: string[] = [];
		for (const id of extras) {
			try {
				const provider = getProvider(id);
				if (!provider.requiresApiKey || (await getApiKey(id)).length > 0) {
					usable.push(id);
				}
				else {
					logger.warn(MODULE, `并行服务商 ${id} 未配置密钥, 已跳过`);
				}
			}
			catch {
				// unknown id in the pref — ignore
			}
		}
		this.pool = buildPool(primary, usable);
		if (this.pool.length > 1) {
			logger.info(MODULE, `Provider pool: ${this.pool.join(' + ')}`);
		}
	}

	private async translateRequest(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse> {
		const chosen = this.pool.length > 1 && typeof request.pageIndex === 'number'
			? pickProviderForPage(this.pool, request.pageIndex)
			: getPref<string>('provider', 'bing-free');
		const settings = await this.providerSettingsFor(chosen);
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
		const chosen = this.pool.length > 1
			? pickProviderForPage(this.pool, pageIndex)
			: getPref<string>('provider', 'bing-free');
		const settings = await this.providerSettingsFor(chosen);
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
		this.overlay?.setPageData(state.pageIndex, {
			blocks: state.blocks,
			translations: state.translations
		});
		if (state.pageIndex === this.lastPageIndex) {
			const pageNo = String(state.pageIndex + 1);
			switch (state.status) {
				case 'translating':
				case 'extracting': {
					const text = getString('papermirror-status-translating-page').replace('%n%', pageNo);
					this.pane?.setStatus(text, { busy: true });
					this.overlayStatus(text, { busy: true });
					break;
				}
				case 'done': {
					const text = getString('papermirror-status-done-page').replace('%n%', pageNo);
					this.pane?.setStatus(text, {
						check: true,
						sub: state.fromCache ? getString('papermirror-status-cached') : ''
					});
					// The page itself now shows the answer; the chip has done
					// its job and gets out of the way.
					this.overlayStatus(text, {});
					this.hideOverlayStatusSoon();
					break;
				}
				case 'error': {
					const text = state.error?.message ?? getString('papermirror-status-error');
					this.pane?.setStatus(text, { error: true });
					this.overlayStatus(text, { error: true });
					break;
				}
				case 'no-text-layer': {
					const text = getString('papermirror-no-text-layer');
					this.pane?.setStatus(text, { error: true });
					this.overlayStatus(text, { error: true });
					break;
				}
			}
		}
	}

	/** Status on the PDF page itself — only meaningful when the pane is hidden. */
	private overlayStatus(text: string | null, options: { busy?: boolean; error?: boolean }): void {
		if (this.viewMode !== 'overlay') {
			this.overlay?.setStatus(null);
			return;
		}
		if (this.statusHideTimer) {
			clearTimeout(this.statusHideTimer);
			this.statusHideTimer = null;
		}
		this.overlay?.setStatus(text, options);
	}

	private hideOverlayStatusSoon(): void {
		if (this.statusHideTimer) {
			clearTimeout(this.statusHideTimer);
		}
		this.statusHideTimer = setTimeout(() => {
			this.statusHideTimer = null;
			this.overlay?.setStatus(null);
		}, 2200);
	}

	private startPolling(): void {
		this.pollTimer = setInterval(() => {
			if (this.destroyed) {
				return;
			}
			// Sidebar opened/closed/resized → re-balance the split.
			this.split?.refreshLayout();
			const page = adapter.getCurrentPageIndex(this.reader);
			if (page !== this.lastPageIndex) {
				this.lastPageIndex = page;
				// In 原文 mode nothing is displayed, so don't spend requests
				// translating pages the reader scrolls past.
				if (this.viewMode !== 'original') {
					this.manager?.setCurrentPage(page);
				}
				this.pane?.setCurrentPage(page);
				this.sync?.onPdfPageChanged(page);
			}
		}, PAGE_POLL_MS);
	}

	/**
	 * Toggle the on-page (覆盖式) translation overlay. `persist` is false when
	 * the overlay is being driven by the view mode rather than by the user's
	 * footer checkbox, so mode switching never rewrites their preference.
	 */
	private applyOverlay(enabled: boolean, persist: boolean): void {
		if (persist) {
			setPref('overlayEnabled', enabled);
		}
		this.overlay?.setEnabled(enabled);
		if (enabled) {
			// Re-feed everything already translated so it appears immediately
			const count = adapter.getPageCount(this.reader);
			for (let p = 0; p < Math.max(count, 1); p++) {
				const state = this.manager?.getPageState(p);
				if (state) {
					this.overlay?.setPageData(p, { blocks: state.blocks, translations: state.translations });
				}
			}
		}
	}

	/**
	 * Hand the pane the whole document's page boxes so it can lay out every
	 * page before anything renders. PDF.js populates its page list slightly
	 * after the reader opens, so poll briefly instead of giving up.
	 */
	private installDocumentLayout(): void {
		const trySizes = (): boolean => {
			const sizes = adapter.getAllPageSizes(this.reader);
			if (sizes?.length) {
				this.pane?.setDisplayScale(adapter.getViewerPxPerPoint(this.reader));
				this.pane?.setDocumentPages(sizes);
				// Open the pane at the page the reader is on.
				this.pane?.scrollToPage(adapter.getCurrentPageIndex(this.reader));
				return true;
			}
			return false;
		};
		if (trySizes()) {
			return;
		}
		let tries = 0;
		const timer = setInterval(() => {
			if (this.destroyed || trySizes() || ++tries > 25) {
				clearInterval(timer);
			}
		}, 400);
	}

	/**
	 * Render one page into its slot: the rebuilt translated page when that
	 * page's translation is COMPLETE, the original page otherwise. Rendering
	 * goes through pdf.js core (adapter.renderPageBitmap), so any page works —
	 * not just the ones the left viewer keeps on screen.
	 */
	private async renderDocPage(pageIndex: number, slot: HTMLElement, width: number): Promise<'translated' | 'original' | false> {
		// Supersample within a fixed pixel budget: sharp text without letting a
		// tall page allocate an enormous canvas.
		const oversample = Math.max(1, Math.min(1.8, Math.sqrt(3_200_000 / Math.max(1, width * width * 1.4))));
		let render = await adapter.renderPageBitmap(this.reader, pageIndex, width, oversample);
		if (!render) {
			// Core rendering unavailable (compartment quirk, worker busy):
			// fall back to copying the LEFT viewer's canvas. It only exists for
			// pages near the left viewport, and comes at the left zoom rather
			// than the pane width — the element is scaled to fit below.
			render = adapter.getPageRender(this.reader, pageIndex);
		}
		if (!render || this.destroyed) {
			return false;
		}
		const fit = width / render.viewportWidth;
		const applyFit = (el: HTMLElement): HTMLElement => {
			if (Math.abs(fit - 1) > 0.01) {
				el.style.transformOrigin = 'top left';
				el.style.transform = `scale(${fit.toFixed(4)})`;
			}
			return el;
		};
		const doc = slot.ownerDocument!;
		const state = this.manager?.getPageState(pageIndex);
		if (state && state.status === 'done' && state.blocks.length) {
			// Real image boundaries (operator list) — fetched once per page and
			// cached for the document's lifetime; null = fall back to the grid.
			if (!this.imageRects.has(pageIndex)) {
				this.imageRects.set(pageIndex, await adapter.getImageRectsPdf(this.reader, pageIndex));
			}
			const built = buildTranslatedPage(doc, this.reader, {
				blocks: state.blocks,
				translations: state.translations,
				pageIndex,
				availableWidth: width,
				render,
				imageRectsPdf: this.imageRects.get(pageIndex) ?? undefined
			});
			if (built) {
				slot.replaceChildren(applyFit(built.element));
				// A long translation may have grown the page below the artwork;
				// the slot must carry the real footprint or the next page will
				// be drawn over the tail. Runs after EVERY settle (including the
				// font-readiness re-settle) so the slot never goes stale. A page
				// that FAILS the final visual check is not shown wrong — it is
				// swapped for the safe fallback: the untouched original with the
				// full translation flowed underneath.
				let degraded = false;
				settleTranslatedPage(built.element, (layoutOk) => {
					if (degraded) {
						return;
					}
					if (!layoutOk) {
						degraded = true;
						const fallback = buildFallbackPage(doc, render!, state.blocks, state.translations);
						slot.replaceChildren(applyFit(fallback));
						const h = fallback.offsetHeight;
						if (h > 0) {
							slot.style.height = `${Math.ceil(h * fit)}px`;
						}
						return;
					}
					const grownHeight = parseFloat(built.element.style.height) || built.element.offsetHeight;
					if (grownHeight > 0) {
						slot.style.height = `${Math.ceil(grownHeight * fit)}px`;
					}
				});
				// A single click on translated text must be INERT reading behaviour:
				// it only moves the focus highlight. The old handler ran 深度讲解 +
				// a scroll-to-top + a PDF navigation on every innocent click — the
				// reader clicked a paragraph and the whole layout convulsed.
				// 深度讲解 is now a deliberate DOUBLE-click.
				for (const node of Array.from(built.element.querySelectorAll('[data-pm-block]'))) {
					const focusBlock = (): void => {
						const scope = slot.closest('.pm-scroll') ?? built.element;
						for (const other of Array.from(scope.querySelectorAll('.pm-repage-block.pm-focused'))) {
							other.classList.remove('pm-focused');
						}
						node.classList.add('pm-focused');
					};
					node.addEventListener('click', focusBlock);
					node.addEventListener('dblclick', () => {
						focusBlock();
						const id = node.getAttribute('data-pm-block');
						if (id) {
							void this.explainSelection(
								state.blocks.find(b => b.id === id)?.sourceText ?? ''
							);
						}
					});
				}
				return 'translated';
			}
		}
		slot.replaceChildren(applyFit(buildOriginalPage(doc, render)));
		return 'original';
	}

	/**
	 * Something went wrong while opening: show it where the reader is looking
	 * instead of disappearing. Both surfaces get the message, because which one
	 * is visible depends on the mode that failed to apply.
	 */
	showOpenFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.split?.setPaneVisible(true);
		this.pane?.setStatus(message, { error: true });
		this.overlay?.setStatus(message, { error: true });
	}

	/** 悬停看原文 on/off, from the toolbar menu. */
	setPeekOnHover(enabled: boolean): void {
		this.overlay?.setPeekOnHover(enabled);
	}

	/** 仅译文 ⇄ 原文淡化, from the toolbar menu. */
	setOverlayDisplayMode(mode: OverlayDisplayMode): void {
		this.overlay?.setDisplayMode(mode);
	}

	getViewMode(): ViewMode {
		return this.viewMode;
	}

	/** 工具栏三态切换: 原文 | 覆盖翻译 | 左右对照. */
	setViewMode(mode: ViewMode): void {
		if (this.destroyed || this.viewMode === mode) {
			return;
		}
		this.viewMode = mode;
		setPref('viewMode', mode);
		this.applyViewMode();
		if (mode !== 'original' && getPref<boolean>('privacyNoticeAccepted', false)) {
			this.startTranslating();
			// Catch up on the page the reader is on now, since 原文 mode paused
			// page tracking.
			this.lastPageIndex = adapter.getCurrentPageIndex(this.reader);
			this.manager?.setCurrentPage(this.lastPageIndex);
		}
		this.onViewModeChanged?.(mode);
	}

	/** Push the current mode onto the split view and the overlay. */
	private applyViewMode(): void {
		// Until the privacy notice is accepted the pane must stay visible —
		// that is where the notice is shown.
		if (!getPref<boolean>('privacyNoticeAccepted', false)) {
			this.split?.setPaneVisible(true);
			this.applyOverlay(false, false);
			return;
		}
		switch (this.viewMode) {
			case 'original':
				this.split?.setPaneVisible(false);
				this.applyOverlay(false, false);
				break;
			case 'overlay':
				this.split?.setPaneVisible(false);
				this.applyOverlay(true, false);
				break;
			case 'split':
				this.split?.setPaneVisible(true);
				// 对照模式: the translation lives on the RIGHT page only. The
				// on-PDF overlay must never paint over the original on the left,
				// whatever the stored overlay preference says.
				this.applyOverlay(false, false);
				break;
		}
	}

	/**
	 * 完整 PDF 翻译: submit the attachment to the local BabelDOC bridge and
	 * attach the resulting 纯译文/双语 PDFs to the item. The compare view stays
	 * open as the instant preview while this runs in the background.
	 */
	async exportTranslatedPdf(): Promise<void> {
		if (this.exportingPdf) {
			this.pane?.toast(getString('papermirror-export-running').replace('%n%', '…'));
			return;
		}
		const item = adapter.getReaderItem(this.reader);
		const filePath = item ? await (item as unknown as { getFilePathAsync(): Promise<string | false> }).getFilePathAsync() : null;
		if (!item || !filePath) {
			this.pane?.setStatus(getString('papermirror-export-failed'), { error: true });
			return;
		}
		this.exportingPdf = true;
		const report = (pct: number): void => {
			this.pane?.setStatus(getString('papermirror-export-running').replace('%n%', String(Math.round(pct))), { busy: true });
		};
		try {
			const bytes = new Uint8Array(await IOUtils.read(String(filePath)));
			const mode = getPref<string>('pdfExportMode', 'builtin');
			let monoBytes: Uint8Array | null = null;
			let dualBytes: Uint8Array | null = null;
			if (mode === 'service') {
				({ monoBytes, dualBytes } = await this.exportViaService(bytes, String(filePath), report));
			}
			else {
				({ monoBytes, dualBytes } = await this.exportBuiltin(bytes, report));
			}
			const parentID = (item as unknown as { parentItemID?: number }).parentItemID ?? undefined;
			const stem = (String(filePath).split(/[\\/]/).pop() || 'paper').replace(/\.pdf$/i, '');
			const saveOne = async (data: Uint8Array | null, suffix: string): Promise<void> => {
				if (!data) {
					return;
				}
				const tmp = PathUtils.join((PathUtils as unknown as { tempDir: string }).tempDir, `${stem}.${suffix}.pdf`);
				await IOUtils.write(tmp, data);
				await (Zotero as unknown as {
					Attachments: { importFromFile(options: { file: string; parentItemID?: number; title?: string }): Promise<unknown> };
				}).Attachments.importFromFile({
					file: tmp,
					parentItemID: parentID,
					title: suffix === 'mono' ? `${stem} (译文)` : `${stem} (双语对照)`
				});
				try {
					await IOUtils.remove(tmp);
				}
				catch {
					// temp cleanup is best-effort
				}
			};
			await saveOne(monoBytes, 'mono');
			await saveOne(dualBytes, 'dual');
			this.pane?.setStatus(getString('papermirror-export-done'), { check: true });
			this.pane?.toast(getString('papermirror-export-done'));
		}
		catch (e) {
			const message = e instanceof PaperMirrorError ? e.message : String(e);
			logger.warn(MODULE, 'exportTranslatedPdf failed', e);
			this.pane?.setStatus(`${getString('papermirror-export-failed')}: ${message}`, { error: true });
		}
		finally {
			this.exportingPdf = false;
		}
	}

	/** Wait until one page's translation settles (done / error / no text). */
	private async waitForPage(pageIndex: number, timeoutMs = 300000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		await this.manager?.ensurePage(pageIndex, 5);
		for (;;) {
			const state = this.manager?.getPageState(pageIndex);
			if (!state || state.status === 'done' || state.status === 'error' || state.status === 'no-text-layer') {
				return;
			}
			if (Date.now() > deadline) {
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 400));
		}
	}

	/**
	 * 内置生成 (default): translate every page through the normal pipeline
	 * (cache-aware), then write the translations back into a real PDF with the
	 * bundled builder. No external service, no Python.
	 */
	private async exportBuiltin(
		sourceBytes: Uint8Array,
		report: (pct: number) => void
	): Promise<{ monoBytes: Uint8Array | null; dualBytes: Uint8Array | null }> {
		if (!this.manager) {
			this.startTranslating();
		}
		const count = adapter.getPageCount(this.reader);
		if (count <= 0) {
			throw new PaperMirrorError('EXTRACTION_FAILED', '无法确定页数。', { retryable: false });
		}
		const pages = new Map<number, PageTranslationData>();
		for (let p = 0; p < count; p++) {
			await this.waitForPage(p);
			const state = this.manager?.getPageState(p);
			if (state && state.status === 'done' && state.blocks.length) {
				pages.set(p, { blocks: state.blocks, translations: state.translations });
			}
			report((p + 1) / count * 70);
		}
		if (!pages.size) {
			throw new PaperMirrorError('EXTRACTION_FAILED', '没有任何页面翻译成功。', { retryable: true });
		}
		const built = await buildTranslatedPdf(sourceBytes, pages, {
			dual: true,
			onProgress: (done, total) => report(70 + (done / total) * 28)
		});
		if (built.clippedBlocks > 0) {
			logger.info(MODULE, `${built.clippedBlocks} block(s) clipped at minimum font size`);
		}
		return { monoBytes: built.monoBytes, dualBytes: built.dualBytes };
	}

	/** 可选高级模式: the local BabelDOC bridge (full layout re-flow). */
	private async exportViaService(
		bytes: Uint8Array,
		filePath: string,
		report: (pct: number) => void
	): Promise<{ monoBytes: Uint8Array | null; dualBytes: Uint8Array | null }> {
		const sample = this.manager?.getPageState(adapter.getCurrentPageIndex(this.reader))
			?.blocks.map(b => b.sourceText).join('\n').slice(0, 2000) ?? '';
		const { source, target } = this.resolveLanguages(sample);
		const settings = await this.providerSettings();
		const provider = getProvider(settings.providerId);
		const submission: TranslateSubmission = {
			filename: filePath.split(/[\\/]/).pop() || 'input.pdf',
			pdf_base64: bytesToBase64(bytes),
			lang_in: source === 'zh' ? 'zh' : 'en',
			lang_out: target.startsWith('zh') ? 'zh' : target,
			mono: true,
			dual: true,
			glossary: this.loadGlossary().map(rule => ({ source: rule.source, target: rule.target })),
			provider: settings.apiKey && provider.defaultBaseURL
				? {
					kind: 'openai-compatible',
					baseURL: settings.apiBaseURL || provider.defaultBaseURL,
					model: settings.model || provider.defaultModel || '',
					apiKey: settings.apiKey
				}
				: undefined
		};
		const serviceURL = getPref<string>('pdfServiceURL', 'http://127.0.0.1:11017');
		const result = await translateFullPdf(serviceURL, submission, (status) => {
			report(status.progress ?? 0);
		});
		return { monoBytes: result.monoBytes, dualBytes: result.dualBytes };
	}


	/** Per-path text extraction report for the active page (diagnostics). */
	async diagnoseExtraction(): Promise<string> {
		const pageIndex = adapter.getCurrentPageIndex(this.reader);
		const reports = await this.extractor.diagnose(pageIndex);
		const lines = [`Page ${pageIndex + 1} extraction paths:`];
		for (const r of reports) {
			lines.push(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.path}: ${r.detail}`);
		}
		lines.push(reports.some(r => r.ok)
			? 'This PDF HAS a text layer — translation should work.'
			: 'No path found text on this page. If other pages work, this page is image-only.');
		return lines.join('\n');
	}

	/** Coordinate self-check for the current page (diagnostics). */
	verifyOverlay(): string {
		if (!this.overlay) {
			return 'Overlay is not initialised for this tab.';
		}
		return this.overlay.verifyCoordinates(adapter.getCurrentPageIndex(this.reader));
	}

	/** Cycle 覆盖模式: 原文淡化 → 仅译文 → 悬停显示. */
	cycleOverlayMode(): OverlayDisplayMode {
		const order: OverlayDisplayMode[] = ['translation-only', 'dim-original', 'hover'];
		const current = getPref<OverlayDisplayMode>('overlayDisplayMode', 'dim-original');
		const next = order[(order.indexOf(current) + 1) % order.length]!;
		setPref('overlayDisplayMode', next);
		this.overlay?.setDisplayMode(next);
		return next;
	}

	private setSyncEnabled(enabled: boolean): void {
		if (this.sync) {
			this.sync.enabled = enabled;
		}
		setPref('syncScroll', enabled);
	}

	/**
	 * 菜单栏直接切换语言 — translations restart in the new pair; the persistent
	 * cache keeps the old entries under their own key, so switching back is
	 * instant.
	 */
	private applyLanguagePick(source: string, target: string): void {
		setPref('sourceLanguage', source);
		setPref('targetLanguage', target);
		this.pane?.setLanguageCodes(source, target);
		this.pane?.setLanguagePair(languageLabel(source), languageLabel(target));
		this.restartAfterConfigChange();
	}

	/** 菜单栏直接切换翻译服务 — same restart contract as a language switch. */
	private applyProviderPick(providerId: string): void {
		setPref('provider', providerId);
		// A provider carries its own base URL and model; stale per-provider
		// overrides from the previous engine must not leak into the new one.
		setPref('apiBaseURL', '');
		setPref('model', '');
		this.pane?.setProviderInfo(getProvider(providerId).displayName, providerId);
		this.restartAfterConfigChange();
	}

	private restartAfterConfigChange(): void {
		void this.rebuildPool();
		this.manager?.resetAll();
		this.detectedSource = null;
		if (getPref<boolean>('privacyNoticeAccepted', false)) {
			const page = adapter.getCurrentPageIndex(this.reader);
			this.manager?.setCurrentPage(page);
		}
	}

	private async retranslateCurrent(): Promise<void> {
		if (!this.manager) {
			this.startTranslating();
			return;
		}
		const page = adapter.getCurrentPageIndex(this.reader);
		this.pane?.setBusy(true);
		try {
			// Bypasses the cache; the fresh result overwrites the old entry on write.
			await this.manager.retranslatePage(page);
			this.pane?.toast(getString('papermirror-toast-retranslated'));
		}
		finally {
			this.pane?.setBusy(false);
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
		if (noteID) {
			this.pane.toast(getString('papermirror-toast-saved'));
		}
		else {
			this.pane.setStatus(getString('papermirror-status-error'), { error: true });
		}
	}

	/**
	 * 选中句子解析 (Read Frog-style analysis): explain the current PDF
	 * selection — or the highlighted block — using the configured LLM.
	 */
	async explainSelection(explicitText?: string): Promise<void> {
		if (!this.pane) {
			return;
		}
		// 1. Resolve the passage: explicit text > PDF selection > selected block
		let text = (explicitText ?? '').trim() || adapter.getSelectedText(this.reader).trim();
		let context = '';
		const page = adapter.getCurrentPageIndex(this.reader);
		const state = this.manager?.getPageState(page);
		const selectedId = this.pane.getSelectedBlockId();
		if (!text && selectedId && state) {
			text = state.blocks.find(b => b.id === selectedId)?.sourceText ?? '';
		}
		if (!text) {
			this.pane.showExplanation({ error: getString('papermirror-explain-no-selection') });
			return;
		}
		if (state) {
			context = state.blocks.map(b => b.sourceText).join('\n').slice(0, 600);
		}
		// 2. Resolve an LLM-capable provider
		const settings = await this.providerSettings();
		const provider = getProvider(settings.providerId);
		if (!canExplain(provider)) {
			this.pane.showExplanation({ passage: text, error: getString('papermirror-explain-needs-llm') });
			return;
		}
		// 3. Run
		this.pane.showExplanation({ passage: text, loading: true });
		try {
			const { target } = this.resolveLanguages(text);
			const item = adapter.getReaderItem(this.reader);
			const result = await explainText(provider, settings, {
				text,
				targetLanguage: target,
				documentTitle: item?.getDisplayTitle?.() ?? '',
				context
			});
			const sections = parseExplanationSections(result);
			this.lastExplanation = { passage: text, sections, pageNumber: page + 1 };
			this.pane.showExplanation({ passage: text, sections });
		}
		catch (e) {
			const error = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			const message = error.code === 'NO_API_KEY'
				? getString('papermirror-error-no-api-key')
				: error.message;
			this.pane.showExplanation({ error: message });
			logger.warn(MODULE, 'explainSelection failed', e);
		}
	}

	/** Copy the current deep explanation as plain text. */
	private copyExplanation(): void {
		if (!this.pane || !this.lastExplanation) {
			return;
		}
		const item = adapter.getReaderItem(this.reader);
		const text = explanationToPlainText({
			passage: this.lastExplanation.passage,
			sections: this.lastExplanation.sections,
			documentTitle: item?.getDisplayTitle?.() ?? '',
			pageNumber: this.lastExplanation.pageNumber
		});
		try {
			Components.classes['@mozilla.org/widget/clipboardhelper;1']
				.getService(Components.interfaces.nsIClipboardHelper)
				.copyString(text);
			this.pane.toast(getString('papermirror-toast-copied'));
		}
		catch (e) {
			logger.warn(MODULE, 'Clipboard copy failed', e);
		}
	}

	/** Save the current deep explanation as a child note. */
	private async saveExplanationToNote(): Promise<void> {
		const item = adapter.getReaderItem(this.reader);
		if (!this.pane || !this.lastExplanation || !item) {
			return;
		}
		const noteID = await saveExplanationNote(item, {
			passage: this.lastExplanation.passage,
			sections: this.lastExplanation.sections,
			documentTitle: item.getDisplayTitle?.() ?? '',
			pageNumber: this.lastExplanation.pageNumber,
			attachmentURI: buildAttachmentSelectURI(item)
		});
		if (noteID) {
			this.pane.toast(getString('papermirror-toast-saved'));
		}
		else {
			this.pane.setStatus(getString('papermirror-status-error'), { error: true });
		}
	}

	/** Drop every cached translation for this attachment, then re-translate. */
	async clearCurrentCache(): Promise<void> {
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return;
		}
		try {
			await cacheManager.clearAttachmentAllVersions(item.key);
			this.pane?.toast(getString('papermirror-toast-cache-cleared'));
			await this.retranslateCurrent();
		}
		catch (e) {
			logger.warn(MODULE, 'clearCurrentCache failed', e);
			this.pane?.setStatus(getString('papermirror-status-error'), { error: true });
		}
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
		const next = current === 'right' ? 'left' : 'right';
		this.split?.setSide(next);
		this.pane?.setPaneSide(next);
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
		if (this.pageRefreshTimer !== null) {
			clearTimeout(this.pageRefreshTimer);
			this.pageRefreshTimer = null;
		}
		this.disposePdfEvents?.();
		this.disposePdfEvents = null;
		if (this.statusHideTimer) {
			clearTimeout(this.statusHideTimer);
			this.statusHideTimer = null;
		}
		this.overlay?.destroy();
		this.overlay = null;
		this.manager?.dispose();
		this.manager = null;
		this.pane?.destroy();
		this.pane = null;
		this.split?.destroy();
		this.split = null;
		logger.info(MODULE, `Session destroyed for tab ${this.reader.tabID}`);
	}
}
