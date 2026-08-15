/**
 * Per-reader-tab session: split view + pane + extraction + translation +
 * sync + notes, with complete teardown.
 */

import * as cacheManager from '../cache/cacheManager';
import { hashSourceTexts, type CacheKeyParts, type SegmentContextParts } from '../cache/cacheSchema';
import {
	buildAttachmentSelectURI,
	explanationToPlainText,
	saveExplanationNote,
	saveTranslationNote
} from '../notes/noteService';
import { getApiKey } from '../security/credentialStore';
import { getProvider, listProviders } from '../translation/providers/registry';
import { buildPool, pickProviderForPage, poolLanePlan, prefetchWindowFor, normalizePerfMode, normalizeGlobalMax, DEFAULT_PERF_MODE, GLOBAL_MAX_DEFAULT, type ProviderCapability } from '../translation/providerPool';
import { endpointHost, supportsCharBudget } from '../translation/providers/types';
import { canExplain, explainText, parseExplanationSections, type ExplanationSection } from '../translation/explainer';
import { TranslationManager, type PageTranslationState } from '../translation/translationManager';
import { PROMPT_VERSION } from '../translation/promptBuilder';
import { parseGlossaryJSON } from '../translation/glossary';
import { parseProviderProfiles, effectiveProviderConfig } from '../translation/providerProfiles';
import type { GlossaryRule, ProviderSettings, TranslationRequest, TranslationResponse } from '../types/models';
import { PaperMirrorError } from '../types/models';
import { TranslationPane, type PaneStrings } from '../ui/translationPane';
import { buildOriginalPage } from '../ui/translatedPageView';
import { buildStrictPage, revertStrictBlocks, settleStrictPage, shrinkStrictBlocks, applyCompressedStrict, planStrictRetry, strictPageStats, placementTally, type UnfitBlock } from '../ui/strictPageReplacement';
import { translateFullPdf, bytesToBase64, type TranslateSubmission } from '../translation/pdfService';
import { buildTranslatedPdf, type PageTranslationData } from '../pdfgen/translatedPdfBuilder';
import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { getPref, setPref } from '../utils/prefs';
import { detectLanguage, defaultTargetFor, sourceCodeFor } from '../utils/languageDetector';
import { createSyncController, type SyncController } from './scrollSynchronizer';
import { PdfOverlay, type OverlayDisplayMode, type OverlayProgress } from './pdfOverlay';
import { taskPriority } from '../ui/statusCapsule';
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
	/** Provider pool (primary first). Rebuilt when translation (re)starts. */
	private pool: string[] = [];
	/** Real image rects per page (operator list), fetched once per document. */
	private imageRects = new Map<number, [number, number, number, number][] | null>();
	/**
	 * Compress-and-retry rounds already spent, keyed by BLOCK id (max 2 each).
	 * Per-block, not per-page: two long paragraphs at the top of a page must not
	 * exhaust the budget for every long paragraph below them.
	 */
	private compressRounds = new Map<string, number>();
	/**
	 * Pages with a compress request currently in flight. A round is counted
	 * ONLY when a request is actually dispatched — settle can measure the same
	 * render several times (font readiness), and without this guard those
	 * repeat measures burned all the rounds on one render and long blocks
	 * reverted to English ("译文显示后又消失").
	 */
	private compressPending = new Set<number>();
	/**
	 * Per-page render generation. Bumped at the start of every renderDocPage;
	 * an async render (or its settle/compress callbacks) that discovers a newer
	 * generation for its page aborts instead of overwriting the live slot — no
	 * stale render can flash an old page in after a newer one has been shown.
	 */
	private renderToken = new Map<number, number>();
	/**
	 * 刷新-driven engine rotation. With a provider pool active, hitting 刷新 on
	 * a page bumps its offset so the RE-translation is dealt to the NEXT
	 * engine in the pool — a page that came out poorly on one service gets a
	 * genuinely different translator, not the same one again.
	 */
	private pageProviderOffset = new Map<number, number>();
	/** The single capsule's task queue (see setTask/renderTopTask). */
	private tasks = new Map<string, OverlayProgress>();
	private taskHideTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private topTaskId: string | null = null;
	/**
	 * The shared collapsed state of the single capsule. The SESSION owns it (not
	 * the two StatusCapsule instances), so collapsing in 覆盖原文 stays collapsed
	 * after switching to 对照翻译 and vice-versa. Mirrored onto both surfaces via
	 * syncCapsuleCollapsedState().
	 */
	private capsuleCollapsed = false;
	/** Pages that have been translated at least once — drives the idle glyph
	 * (✓ vs ↻ 刷新本页) so the resting capsule tells the truth per page. */
	private translatedPages = new Set<number>();
	/**
	 * The most recent page that settled with kept-original segments, and the
	 * strict-page element that holds its `[data-pm-unfit]` boxes. Drives
	 * 「查看保留原文」so the capsule action can scroll to and flash the exact
	 * segments that stayed in the source language.
	 */
	private lastPartial: { pageIndex: number; element: HTMLElement } | null = null;

	/** The engine responsible for a page, honouring the 刷新 rotation. */
	private providerForPage(pageIndex: number): string {
		if (this.pool.length > 1) {
			const offset = this.pageProviderOffset.get(pageIndex) ?? 0;
			return pickProviderForPage(this.pool, pageIndex + offset);
		}
		return getPref<string>('provider', 'bing-free');
	}
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
			onRetranslate: () => void this.retranslateAll(), // 菜单栏刷新 = 刷新全部 (强制全量,清页+段缓存)
			onRefreshPage: () => void this.retranslateCurrent(), // 胶囊圆环 = 刷新本页 (普通刷新,复用合格段落)
			onCancelPage: () => this.cancelCurrentTranslation(), // 胶囊取消 = 停止翻译
			onViewPartial: () => this.viewKeptOriginal(), // 胶囊「查看保留原文」= 定位保留段落
			onDismiss: () => this.dismissTopTask(), // 胶囊 × = 关闭当前通知
			onCollapsedChange: (c) => this.setCapsuleCollapsed(c), // 折叠状态由会话统一管理
			onSaveNote: () => void this.saveSelectionToNote(),
			onShowDiagnostics: () => this.copyDiagnostics(),
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
		this.overlay = new PdfOverlay(this.reader, {
			onCancel: () => this.cancelCurrentTranslation(),
			onRetry: () => void this.retranslateCurrent(),
			onViewPartial: () => this.viewKeptOriginal(), // switch to pane + locate the kept blocks
			onDismiss: () => this.dismissTopTask(),
			onCollapsedChange: (c) => this.setCapsuleCollapsed(c), // 折叠状态由会话统一管理
			onRefreshRing: () => void this.retranslateCurrent() // ring → 刷新本页
		});
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
			// Instant acknowledgement of the click: the first page's real counts
			// arrive once extraction finishes; until then show an indeterminate
			// "识别段落" capsule (segTotal 0 → indeterminate ring).
			this.pushOverlayProgress({
				phase: 'translating',
				currentPage: adapter.getCurrentPageIndex(this.reader) + 1,
				totalPages: adapter.getPageCount(this.reader),
				segTotal: 0, segTranslated: 0, segPlaced: 0, kept: 0
			});
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
			this.pane?.setDisplayScale(this.actualPxPerPoint());
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
				extractRenderedPage: pageIndex => this.extractor.extractRenderedPage(pageIndex),
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
				// 段落级缓存: per-segment store scoped by provider/model/prompt/
				// glossary, beneath the page cache. 普通刷新 (圆环) reuses it.
				readSegments: async (pageIndex, hashes) => {
					const parts = await this.segmentContext(pageIndex);
					return parts ? cacheManager.readSegments(parts, hashes) : null;
				},
				writeSegments: async (pageIndex, entries) => {
					const parts = await this.segmentContext(pageIndex);
					if (parts) {
						await cacheManager.writeSegments(parts, entries);
					}
				},
				getLanguages: sample => this.resolveLanguages(sample),
				getDocumentTitle: () => {
					const item = adapter.getReaderItem(this.reader);
					return item?.getDisplayTitle?.() ?? '';
				},
				getGlossary: () => this.loadGlossary(),
				getNoTranslate: () => String(getPref<string>('noTranslateList', '') ?? '')
					.split(/\r?\n/)
					.map(l => l.trim())
					.filter(l => l.length >= 2 && !l.startsWith('#')),
				useContext: () => getPref<boolean>('useContext', true),
				pageCount: () => adapter.getPageCount(this.reader),
				// Each page's provider LANE — lets the scheduler cap providers
				// independently and reserve a foreground slot for the current one.
				laneFor: (pageIndex: number) => this.providerForPage(pageIndex)
			},
			{
				onPageUpdate: state => this.onPageUpdate(state),
				// 熔断: this page's engine keeps dropping/echoing ids → deal its
				// REMAINING requests to the next engine in the pool. With a single
				// configured provider there is no backup — log and continue.
				onProviderUnstable: (pageIndex, missingRatio) => {
					const pct = Math.round(missingRatio * 100);
					if (this.pool.length > 1) {
						this.pageProviderOffset.set(pageIndex, ((this.pageProviderOffset.get(pageIndex) ?? 0) + 1) % this.pool.length);
						logger.warn(MODULE, `page ${pageIndex + 1}: engine unstable (${pct}% missing) → switching to ${this.providerForPage(pageIndex)}`);
					}
					else {
						logger.warn(MODULE, `page ${pageIndex + 1}: engine unstable (${pct}% missing); no backup provider configured`);
					}
				}
			},
			{
				// The global cap is set properly by applyConcurrencyPlan() below
				// (sum of each enabled provider's own lane cap); this initial value
				// is just a safe floor until that runs.
				maxConcurrent: 24,
				reservedForeground: 1,
				prefetch: getPref<boolean>('autoPrefetch', true)
			}
		);
		this.applyConcurrencyPlan();
		const page = adapter.getCurrentPageIndex(this.reader);
		this.lastPageIndex = page;
		this.pane?.setCurrentPage(page);
		this.manager.setCurrentPage(page);
	}

	/**
	 * 每服务商独立限流 + 自动全局并发: translate the current provider pool into
	 * per-lane page caps and a global cap (their sum, clamped 2–24), and size the
	 * prefetch window to the pool. The 最大并行页面数 setting is an OPTIONAL
	 * ceiling: 0 = auto (pure per-provider sum); >0 caps the global total. Called
	 * on manager creation and whenever the pool changes.
	 */
	private applyConcurrencyPlan(): void {
		if (!this.manager) {
			return;
		}
		const caps = this.poolCapabilities();
		const mode = normalizePerfMode(getPref<string>('perfMode', DEFAULT_PERF_MODE));
		const plan = poolLanePlan(caps, mode, mode === 'custom' ? this.customConcurrency() : undefined);
		// 全局上限 is now a plain user number (1–24, default 12), no 0=auto. The
		// scheduler enforces min(globalMax, Σ lane caps, schedulable pages), so
		// setting 24 never forces providers past their own lanes.
		const globalMax = normalizeGlobalMax(getPref<number>('maxConcurrentRequests', GLOBAL_MAX_DEFAULT));
		this.manager.setLaneCaps(plan.laneBands);
		this.manager.setGlobalConcurrency(globalMax);
		const win = prefetchWindowFor(mode, Math.max(1, this.pool.length));
		this.manager.setPrefetchWindow(win.forward, win.backward);
		logger.info(MODULE, `Concurrency plan: mode=${mode}, global ${globalMax}, ~${Math.min(globalMax, plan.initialSum)} parallel, lanes ${JSON.stringify(plan.laneBands)}, prefetch +${win.forward}/-${win.backward}`);
	}

	/**
	 * px-per-point derived from the LEFT page's ACTUAL rendered size, not from
	 * viewport.scale — so the right page ends up the same CSS pixel size as the
	 * PDF page beside it (≤1px), instead of a re-derived size that drifts. Falls
	 * back to the viewer scale when the current page isn't measurable yet.
	 */
	private actualPxPerPoint(): number {
		try {
			const idx = adapter.getCurrentPageIndex(this.reader);
			const div = adapter.getPageView(this.reader, idx)?.div;
			const pts = adapter.getAllPageSizes(this.reader)?.[idx];
			if (div?.clientWidth && pts?.width) {
				return div.clientWidth / pts.width;
			}
		}
		catch {
			// fall through
		}
		return adapter.getViewerPxPerPoint(this.reader);
	}

	/** Per-provider custom concurrency values (custom mode), from the pref JSON. */
	private customConcurrency(): Record<string, number> {
		try {
			const raw = JSON.parse(getPref<string>('providerConcurrency', '{}'));
			if (raw && typeof raw === 'object') {
				const out: Record<string, number> = {};
				for (const [k, v] of Object.entries(raw)) {
					if (typeof v === 'number' && Number.isFinite(v)) {
						out[k] = v;
					}
				}
				return out;
			}
		}
		catch {
			// malformed pref → defaults
		}
		return {};
	}

	/** The current pool as capability descriptors (id + key + local). */
	private poolCapabilities(): ProviderCapability[] {
		const caps: ProviderCapability[] = this.pool.map((id) => {
			const p = getProvider(id);
			const local = id === 'ollama'
				|| /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(p.defaultBaseURL || '');
			return { id, requiresApiKey: p.requiresApiKey, local };
		});
		return caps.length ? caps : [{ id: 'bing-free', requiresApiKey: false, local: false }];
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
	 * Settings for one pool member. EVERY provider — primary and parallel alike
	 * — reads its OWN Base URL / model from its own profile (0.9.3). Overrides
	 * belong to the provider they were typed for; leaking an OpenAI base URL or
	 * model into a Gemini request was the cross-provider bleed this replaces.
	 */
	private async providerSettingsFor(providerId: string): Promise<ProviderSettings & { allowInsecureHTTP?: boolean }> {
		const profiles = parseProviderProfiles(getPref<string>('providerProfiles', '{}'));
		const { apiBaseURL, model } = effectiveProviderConfig(profiles, providerId);
		const profile = profiles[providerId] ?? {};
		const apiKey = await getApiKey(providerId);
		return {
			providerId,
			apiBaseURL,
			apiKey,
			model,
			timeoutMs: getPref<number>('timeoutMs', 60000),
			customPrompt: getPref<string>('customPrompt', ''),
			allowInsecureHTTP: getPref<boolean>('allowHTTPEndpoint', false),
			// Advanced, opt-in per-provider params (unset → request unchanged).
			apiPath: (profile.apiPath ?? '').trim() || undefined,
			reasoning: profile.reasoning,
			maxOutputTokens: profile.maxOutputTokens,
			temperature: profile.temperature
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
		// Pool membership changed → recompute per-lane caps, global cap, window.
		this.applyConcurrencyPlan();
	}

	private async translateRequest(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse> {
		const chosen = typeof request.pageIndex === 'number'
			? this.providerForPage(request.pageIndex)
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
		// Scale the request timeout with the PAYLOAD: a fixed 60 s was fine for a
		// one-block salvage but structurally too short for an 8000-char batch on a
		// slow/thinking model (whose honest generation time is 70–200 s) — the old
		// behavior was timeout → retry → same timeout → page dies "stuck". Rule:
		// base + 12 ms per source char, capped at 120 s (the manager's idle
		// watchdog is 150 s, so a full-length request can never trip it).
		const payloadChars = request.blocks.reduce((n, b) => n + b.text.length, 0);
		const scaled = Math.min(120000, Math.max(settings.timeoutMs, 20000 + payloadChars * 12));
		return provider.translate(request, { ...settings, timeoutMs: scaled }, { signal });
	}

	private async cacheKey(pageIndex: number, texts: string[]): Promise<CacheKeyParts | null> {
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return null;
		}
		const chosen = this.providerForPage(pageIndex);
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

	/** Context parts scoping the per-segment store (see cacheSchema). */
	private async segmentContext(pageIndex: number): Promise<SegmentContextParts | null> {
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return null;
		}
		const settings = await this.providerSettingsFor(this.providerForPage(pageIndex));
		return {
			attachmentKey: item.key,
			fileHash: this.fileHash || 'nohash',
			provider: settings.providerId,
			model: settings.model,
			promptVersion: getPref<number>('promptVersion', PROMPT_VERSION),
			glossaryHash: hashSourceTexts([getPref<string>('glossaryGlobal', '[]')])
		};
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
			// ONE status system: the capsule. All translation-process feedback
			// flows through pushOverlayProgress — never the old pane.setStatus,
			// which caused the "✓ 已翻译" + "0%" double display. The FINAL
			// done/partial state is posted only by reportPlacement(), so we
			// never show "done" before layout has actually finished.
			const common = {
				currentPage: state.pageIndex + 1,
				totalPages: adapter.getPageCount(this.reader),
				segTotal: state.blocks.filter(block => block.translationMode !== 'preserve').length,
				segTranslated: state.translations.size
			};
			switch (state.status) {
				case 'translating':
				case 'extracting':
					this.pushOverlayProgress({ ...common, phase: 'translating', segPlaced: 0, kept: 0 });
					break;
				case 'done':
					// Translation finished; placement runs next. Keep the ring at
					// its translation level (no reset to 0%) and say 正在适配排版;
					// reportPlacement() posts the real done/partial when placed.
					this.pushOverlayProgress({ ...common, phase: 'laying-out', segPlaced: 0, kept: 0 });
					break;
				case 'error':
					this.pushOverlayProgress({
						...common, phase: 'failed',
						message: state.error?.message ?? getString('papermirror-status-error'),
						segPlaced: 0, kept: 0
					});
					break;
				case 'no-text-layer':
					this.pushOverlayProgress({
						...common, phase: 'failed',
						message: getString('papermirror-no-text-layer'),
						segPlaced: 0, kept: 0
					});
					break;
			}
		}
	}

	/**
	 * Push a progress model to the status capsule of whichever surface is
	 * visible: the on-page capsule in 覆盖原文 mode, the pane capsule in 对照翻译
	 * mode. The inactive surface's capsule is dismissed so only one ever shows.
	 */
	/** Route a translation/export progress model into the task queue. */
	private pushOverlayProgress(model: OverlayProgress): void {
		this.setTask(model.task === 'export' ? 'export' : 'translation', model);
	}

	/**
	 * A NON-translation failure (save note, copy, clear cache, open) surfaced in
	 * the capsule as its own task. retryable:false → the capsule shows a × that
	 * dismisses this task, never a 重试 that would wrongly re-translate.
	 */
	private pushFailure(message: string): void {
		this.setTask('notice', {
			phase: 'failed', message, retryable: false,
			currentPage: adapter.getCurrentPageIndex(this.reader) + 1,
			totalPages: adapter.getPageCount(this.reader),
			segTotal: 0, segTranslated: 0, segPlaced: 0, kept: 0
		});
	}

	/**
	 * The task queue behind the single capsule. Several tasks can be live at
	 * once (a page translating WHILE a PDF exports); the capsule shows the
	 * highest-priority one instead of whichever updated last, so export and
	 * translation no longer flip-flop over each other. done/cancelled tasks
	 * self-clear after a moment; failed/partial persist until replaced or
	 * dismissed.
	 */
	private setTask(id: string, model: OverlayProgress | null): void {
		const timer = this.taskHideTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.taskHideTimers.delete(id);
		}
		if (!model) {
			this.tasks.delete(id);
			this.renderTopTask();
			return;
		}
		this.tasks.set(id, model);
		// done/cancelled linger ~2.2s as a full message, then clear. On DONE we
		// also auto-collapse: the capsule shrinks to the resting bottom-right
		// ring (idle) instead of vanishing. A transient 'notice' (copied / saved /
		// cache cleared) flashes ~1.9s then clears WITHOUT collapsing. failed and
		// partial NEVER auto-clear or auto-collapse — they wait for the user.
		if (model.phase === 'done' || model.phase === 'cancelled' || model.phase === 'notice') {
			const collapseAfter = model.phase === 'done';
			const ms = model.phase === 'notice' ? 1900 : 2200;
			this.taskHideTimers.set(id, setTimeout(() => {
				this.taskHideTimers.delete(id);
				this.tasks.delete(id);
				if (collapseAfter) {
					this.setCapsuleCollapsed(true);
				}
				this.renderTopTask();
			}, ms));
		}
		this.renderTopTask();
	}

	/**
	 * 成功提示统一走胶囊: a transient success flash (copied / saved / cache
	 * cleared) shown IN the single capsule — there is no separate bottom toast
	 * anymore. It rides the task queue as a short-lived 'notice' so it routes to
	 * the visible surface and auto-clears back to whatever was underneath.
	 */
	private flashNotice(message: string): void {
		if (this.destroyed) {
			return; // a promise resolving after teardown must not spawn a zombie toast
		}
		this.setTask('flash', {
			phase: 'notice', message,
			currentPage: adapter.getCurrentPageIndex(this.reader) + 1,
			totalPages: adapter.getPageCount(this.reader),
			segTotal: 0, segTranslated: 0, segPlaced: 0, kept: 0
		});
	}

	/**
	 * Show the highest-priority live task in the visible surface's capsule. When
	 * NO task is live the capsule does not disappear — it settles into a
	 * persistent idle ring (✓ if this page is translated, ↻ 刷新本页 if not), so
	 * the shrunk ring is always available bottom-right in both translation modes.
	 * 原文 mode shows nothing (there is no translation to refresh there).
	 */
	private renderTopTask(): void {
		let best: OverlayProgress | null = null;
		let bestScore = -1;
		let bestId: string | null = null;
		for (const [id, m] of this.tasks) {
			const score = taskPriority(m);
			if (score > bestScore) {
				bestScore = score;
				best = m;
				bestId = id;
			}
		}
		this.topTaskId = bestId;
		const current = best ?? this.idleCapsuleState();
		switch (this.viewMode) {
			case 'overlay':
				this.overlay?.setProgress(current);
				this.pane?.setProgress(null);
				break;
			case 'split':
				this.pane?.setProgress(current);
				this.overlay?.setProgress(null);
				break;
			case 'original':
				this.overlay?.setProgress(null);
				this.pane?.setProgress(null);
				break;
		}
	}

	/** The persistent resting model: reflects whether THIS page is translated. */
	private idleCapsuleState(): OverlayProgress {
		const pageIndex = adapter.getCurrentPageIndex(this.reader);
		const translated = this.translatedPages.has(pageIndex);
		return {
			phase: 'idle',
			currentPage: pageIndex + 1,
			totalPages: adapter.getPageCount(this.reader),
			segTotal: 0,
			segTranslated: translated ? 1 : 0, // 0/1 flag → ✓ vs ↻ in the capsule
			segPlaced: 0,
			kept: 0
		};
	}

	/** Shared collapsed state → mirror onto BOTH surfaces' capsules. */
	private setCapsuleCollapsed(collapsed: boolean): void {
		this.capsuleCollapsed = collapsed;
		this.syncCapsuleCollapsedState();
	}

	private syncCapsuleCollapsedState(): void {
		this.overlay?.setCollapsed(this.capsuleCollapsed);
		this.pane?.setCollapsed(this.capsuleCollapsed);
	}

	/** Capsule × on a persistent state — drop the task it belongs to. */
	private dismissTopTask(): void {
		if (this.topTaskId) {
			this.setTask(this.topTaskId, null);
		}
	}

	/**
	 * 「查看保留原文」: jump to and flash the segments a page kept in the source
	 * language because their translation could not be placed. The segments live
	 * in the strict-page element recorded by reportPlacement (works whether that
	 * element sits in the on-PDF overlay or in the 对照 pane). When that element
	 * is gone (page re-rendered), fall back to asking the pane to locate the
	 * kept blocks on the same page.
	 */
	private viewKeptOriginal(): void {
		const target = this.lastPartial;
		const topPage = this.topTaskId
			? this.tasks.get(this.topTaskId)?.currentPage
			: undefined;
		const pageIndex = target?.pageIndex
			?? (topPage ? topPage - 1 : adapter.getCurrentPageIndex(this.reader));
		// Bring the PDF (and thus any on-page overlay) to the right page first.
		adapter.navigateToPage(this.reader, pageIndex);
		if (target && target.element.isConnected) {
			const boxes = Array.from(
				target.element.querySelectorAll('[data-pm-unfit="true"]')
			) as HTMLElement[];
			if (boxes.length) {
				boxes[0]?.scrollIntoView({ block: 'center' });
				for (const box of boxes) {
					this.flashKept(box);
				}
				return;
			}
		}
		// Overlay element gone or empty → let the pane locate them.
		this.pane?.revealKeptOriginal(pageIndex);
	}

	/**
	 * Briefly outline a kept-original segment. Inline styles (not a CSS class)
	 * so the same routine works in the overlay layer and the pane, whose
	 * stylesheets differ.
	 */
	private flashKept(node: HTMLElement): void {
		const prevOutline = node.style.outline;
		const prevTransition = node.style.transition;
		node.style.transition = 'outline-color 0.25s ease';
		node.style.outline = '2px solid rgba(240, 173, 78, 0.95)';
		const win = node.ownerDocument.defaultView;
		win?.setTimeout(() => {
			node.style.outline = prevOutline;
			node.style.transition = prevTransition;
		}, 2000);
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
				// NO forced scrollToPage on a page change: the continuous
				// updateviewarea → setPdfScrollFraction anchor sync already keeps
				// the pane aligned to the reader's exact position. Snapping the
				// pane to the new page's TOP here is what made the right side jump
				// to the page start mid-scroll; page-change only updates the label
				// and translation priority now.
				// A translation task pinned to the page we just LEFT must not keep
				// the capsule frozen on that page's state ("正在适配排版 50%" forever
				// — the audit's stale laying-out item). Drop it; the new page's own
				// updates repopulate the capsule within one notify.
				const stale = this.tasks.get('translation');
				if (stale && stale.currentPage !== page + 1) {
					this.setTask('translation', null);
				}
				// If nothing is actively running, the resting ring must retarget
				// the new page (✓ vs ↻) instead of showing the old page's state.
				if (!this.tasks.size) {
					this.renderTopTask();
				}
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
				this.pane?.setDisplayScale(this.actualPxPerPoint());
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
		// Claim this render's generation up front; any older render still in its
		// async tail will see a newer token and bow out before touching the slot.
		const token = (this.renderToken.get(pageIndex) ?? 0) + 1;
		this.renderToken.set(pageIndex, token);
		const current = (): boolean => !this.destroyed && this.renderToken.get(pageIndex) === token;
		// Supersample within a fixed pixel budget: sharp text without letting a
		// tall page allocate an enormous canvas.
		const oversample = Math.max(1, Math.min(1.8, Math.sqrt(3_200_000 / Math.max(1, width * width * 1.4))));
		let render = await adapter.renderPageBitmap(this.reader, pageIndex, width, oversample);
		if (!current()) {
			return false;
		}
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
				const rects = await adapter.getImageRectsPdf(this.reader, pageIndex);
				if (!current()) {
					return false;
				}
				this.imageRects.set(pageIndex, rects);
			}
			// STRICT in-place replacement: the page keeps its exact original
			// size and geometry. A translation that cannot fit its source
			// rectangle triggers up to two budgeted compress-and-retry rounds
			// (the manager's update re-renders this slot); after that the
			// block REVERTS to the original text — never clipped or moved.
			// A geometry exception in the builder must DEGRADE, not freeze: an
			// uncaught throw here left the capsule at "排版 0/N" forever while the
			// page stayed English (1.0.3 表格页卡死). Fall back to the original
			// page and clear the stuck layout task instead.
			let built: ReturnType<typeof buildStrictPage> | null = null;
			try {
				built = buildStrictPage(doc, {
					blocks: state.blocks,
					translations: state.translations,
					pageIndex,
					render,
					imageRectsPdf: this.imageRects.get(pageIndex) ?? undefined
				});
			}
			catch (e) {
				logger.error(MODULE, `buildStrictPage threw on page ${pageIndex + 1}; showing original`, e);
				this.setTask('translation', null);
				this.flashNotice(`第 ${pageIndex + 1} 页排版失败,已保留原文(可刷新本页重试)`);
			}
			if (built) {
				if (!current()) {
					return false;
				}
				slot.replaceChildren(applyFit(built.element));
				const element = built.element;
				// Measure-before-commit: fitting blocks are revealed only on the
				// FINAL (fonts-settled) pass; unfit blocks stay showing the
				// original and are resolved without ever being shown-then-hidden.
				settleStrictPage(element, (unfit: UnfitBlock[], final: boolean) => {
					if (!current() || !final) {
						return;
					}
					if (!unfit.length) {
						this.reportPlacement(pageIndex, element);
						return;
					}
					this.resolveStrictUnfit(pageIndex, element, unfit, token);
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
					// 右键 = 重译此段 (单段 replay, 参照 retain-pdf item replay):
					// one foreground request for exactly this block, keep-origin
					// and 止损 cleared so the retry is real.
					node.addEventListener('contextmenu', (event) => {
						event.preventDefault();
						event.stopPropagation();
						focusBlock();
						const id = node.getAttribute('data-pm-block');
						if (!id || !this.manager) {
							return;
						}
						node.classList.add('pm-retranslating');
						this.flashNotice('正在重译此段…');
						void this.manager.retranslateBlock(pageIndex, id).then((ok) => {
							node.classList.remove('pm-retranslating');
							// Neutral failure text: a scroll-cancel and a rejected response
							// look the same from here — don't claim a reason we don't know.
							this.flashNotice(ok ? '此段已重译' : '此段重译未完成,可再试或换服务商');
						});
					});
				}
				return 'translated';
			}
		}
		slot.replaceChildren(applyFit(buildOriginalPage(doc, render)));
		return 'original';
	}

	/**
	 * Resolve blocks whose translation did not fit their fixed rectangle,
	 * WITHOUT ever having shown them translated (the strict renderer keeps them
	 * hidden with the original text visible until they are accepted). Order:
	 *   1. budget-capable engine, rounds left → a compressed retry, applied in
	 *      place; blocks that then fit are revealed, the rest recurse;
	 *   2. otherwise → one bounded font shrink;
	 *   3. still won't fit → abandon (the original simply stays).
	 * `token` ties every async step to the render that started it: a newer
	 * render for this page makes this one bow out.
	 */
	private resolveStrictUnfit(pageIndex: number, element: HTMLElement, unfit: UnfitBlock[], token: number): void {
		const live = (): boolean => !this.destroyed && element.isConnected && this.renderToken.get(pageIndex) === token;
		if (!live() || !unfit.length) {
			return;
		}
		const budgetCapable = supportsCharBudget(getProvider(this.providerForPage(pageIndex)));
		const plan = planStrictRetry(unfit, {
			roundsFor: id => this.compressRounds.get(id) ?? 0,
			maxRounds: 2,
			budgetCapable
		});

		// (2)+(3): blocks that get no (more) budgeted retry — shrink, then abandon.
		if (plan.shrink.length) {
			const still = shrinkStrictBlocks(element, plan.shrink);
			if (still.length) {
				revertStrictBlocks(element, still);
				logger.info(MODULE, `page ${pageIndex + 1}: ${still.length} block(s) kept original (no fit within fixed geometry)`);
			}
		}

		// (1): budgeted compress for the rest — at most one page-level request
		// in flight, patched into the live page (no full re-render).
		if (!plan.compress.length || this.compressPending.has(pageIndex) || !this.manager) {
			return;
		}
		this.compressPending.add(pageIndex);
		for (const id of plan.compress) {
			this.compressRounds.set(id, (this.compressRounds.get(id) ?? 0) + 1);
		}
		const entries = unfit.filter(u => plan.compress.includes(u.id));
		void this.manager.compressBlocks(pageIndex, entries)
			.then((accepted) => {
				if (!live()) {
					return;
				}
				// Apply shorter retries in place; whatever still overflows (plus
				// any block the service failed to shorten) goes round again.
				const stillUnfit = applyCompressedStrict(element, accepted);
				const noProgress = entries.filter(e => !accepted.has(e.id));
				const next = [...stillUnfit, ...noProgress.filter(e => !stillUnfit.some(s => s.id === e.id))];
				this.compressPending.delete(pageIndex);
				if (next.length) {
					this.resolveStrictUnfit(pageIndex, element, next, token);
				}
				else {
					this.reportPlacement(pageIndex, element);
				}
			})
			.catch(() => this.compressPending.delete(pageIndex));
	}

	/**
	 * Honest placement accounting (#6): after a page settles, log the full
	 * tally and — if any block could NOT be shown translated — surface a
	 * non-blocking note rather than silently leaving English on the page.
	 * "Translation complete" and "every block placed" are now distinct: the
	 * text was translated; some rectangles are mathematically too small for it.
	 */
	private reportPlacement(pageIndex: number, element: HTMLElement): void {
		const s = strictPageStats(element);
		if (!s) {
			return;
		}
		logger.info(
			MODULE,
			`page ${pageIndex + 1} placement: ${s.committed}/${s.replaceable} shown, `
			+ `${s.abandoned} won't fit, ${s.untranslated} untranslated, `
			+ `${s.tableFailed} table-failed, ${s.tableIntentional} table-kept, `
			+ `${s.imageExcluded} on images, ${s.tooSmall} too small`
		);
		if (this.destroyed || pageIndex !== adapter.getCurrentPageIndex(this.reader)) {
			return; // only annotate the page the reader is actually on
		}
		// ONE consistent 口径, no double counting: `committed` ALREADY includes the
		// table text cells that were placed (they are items like any block), so
		// `placed` is just `committed`. Failures that must count as kept: blocks
		// that wouldn't fit (abandoned), blocks the service didn't translate
		// (untranslated), and table cells that failed to translate/place
		// (tableFailed). Intentionally-original content (data cells, figures,
		// metadata, tiny fragments) is neither placed nor a failure.
		const { placed, kept, segTotal, phase } = placementTally(s);
		// This page has now been translated → the idle ring shows ✓ (not ↻) for it.
		this.translatedPages.add(pageIndex);
		// Remember where the kept-original segments live so 「查看保留原文」can
		// jump straight to them; clear it once the page places everything.
		if (kept > 0) {
			this.lastPartial = { pageIndex, element };
		}
		else if (this.lastPartial?.pageIndex === pageIndex) {
			this.lastPartial = null;
		}
		this.pushOverlayProgress({
			phase,
			currentPage: pageIndex + 1,
			totalPages: adapter.getPageCount(this.reader),
			segTotal,
			segTranslated: segTotal, // translation itself is complete at this point
			segPlaced: placed,
			kept
		});
	}

	/**
	 * Something went wrong while opening: show it where the reader is looking
	 * instead of disappearing. Both surfaces get the message, because which one
	 * is visible depends on the mode that failed to apply.
	 */
	showOpenFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.split?.setPaneVisible(true);
		this.pushFailure(message);
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
		// The visible surface changed → re-route the top task to its capsule and
		// clear the one that just went away, so a live task follows the mode.
		this.renderTopTask();
		// …and carry the shared collapsed state onto the now-visible surface, so
		// a capsule shrunk in one mode stays shrunk after switching modes.
		this.syncCapsuleCollapsedState();
	}

	/**
	 * 完整 PDF 翻译: submit the attachment to the local BabelDOC bridge and
	 * attach the resulting 纯译文/双语 PDFs to the item. The compare view stays
	 * open as the instant preview while this runs in the background.
	 */
	async exportTranslatedPdf(): Promise<void> {
		if (this.exportingPdf) {
			this.pushExport('translating', { message: getString('papermirror-export-running').replace('%n%', '…') });
			return;
		}
		const item = adapter.getReaderItem(this.reader);
		const filePath = item ? await (item as unknown as { getFilePathAsync(): Promise<string | false> }).getFilePathAsync() : null;
		if (!item || !filePath) {
			this.pushExport('failed', { message: getString('papermirror-export-failed') });
			return;
		}
		this.exportingPdf = true;
		const report = (pct: number): void => {
			this.pushExport('translating', {
				pct,
				message: getString('papermirror-export-running').replace('%n%', String(Math.round(pct)))
			});
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
			// Export completion is shown ONCE, in the capsule — no extra toast.
			this.pushExport('done', { message: getString('papermirror-export-done') });
		}
		catch (e) {
			const message = e instanceof PaperMirrorError ? e.message : String(e);
			logger.warn(MODULE, 'exportTranslatedPdf failed', e);
			this.pushExport('failed', { message: `${getString('papermirror-export-failed')}: ${message}` });
		}
		finally {
			this.exportingPdf = false;
		}
	}

	/** PDF-export progress → the same capsule (task: export). */
	private pushExport(phase: OverlayProgress['phase'], opts?: { pct?: number; message?: string }): void {
		this.pushOverlayProgress({
			task: 'export',
			phase,
			currentPage: adapter.getCurrentPageIndex(this.reader) + 1,
			totalPages: adapter.getPageCount(this.reader),
			segTotal: 100,
			segTranslated: opts?.pct ?? 0,
			segPlaced: opts?.pct ?? 0,
			kept: 0,
			message: opts?.message
		});
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
		this.compressRounds.clear();
		this.compressPending.clear();
		this.pageProviderOffset.clear();
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
		// Per-block round counters are keyed `page-<n>-…`; clear this page's.
		const prefix = `page-${page}-`;
		for (const id of [...this.compressRounds.keys()]) {
			if (id.startsWith(prefix)) {
				this.compressRounds.delete(id);
			}
		}
		this.compressPending.delete(page);
		// Pool active → deal this page to the next engine before re-translating.
		if (this.pool.length > 1) {
			this.pageProviderOffset.set(page, ((this.pageProviderOffset.get(page) ?? 0) + 1) % this.pool.length);
			logger.info(MODULE, `刷新 page ${page + 1} → provider ${this.providerForPage(page)}`);
		}
		this.pane?.setBusy(true);
		try {
			// 普通刷新 (normal): bypass the PAGE cache but reuse qualified segments —
			// only untranslated / invalid / unfit segments re-request. The provider
			// rotation above means a pooled setup still gets a genuinely different
			// engine (different segment context ⇒ a real re-translation).
			await this.manager.retranslatePage(page, 'normal');
		}
		finally {
			this.pane?.setBusy(false);
		}
	}

	/** Capsule 取消: stop the current page's translation and mark it cancelled. */
	private cancelCurrentTranslation(): void {
		const page = adapter.getCurrentPageIndex(this.reader);
		this.manager?.cancelPage(page);
		this.compressPending.delete(page);
		this.pushOverlayProgress({
			phase: 'cancelled',
			currentPage: page + 1,
			totalPages: adapter.getPageCount(this.reader),
			segTotal: 0, segTranslated: 0, segPlaced: 0, kept: 0
		});
	}

	/**
	 * 刷新全部 (menu-bar button) — 强制全量: drop EVERY cached translation for
	 * this document — the in-memory page states, the on-disk page cache AND the
	 * per-segment store (clearAttachmentAllVersions removes the whole attachment
	 * dir, segments included) — so nothing is reused. Because translation is
	 * lazy, this re-runs the current page now; the rest re-translate as they are
	 * viewed. (The ring's 刷新本页 is the lighter 普通刷新 that reuses segments.)
	 */
	private async retranslateAll(): Promise<void> {
		if (!this.manager) {
			this.startTranslating();
			return;
		}
		this.compressRounds.clear();
		this.compressPending.clear();
		this.pageProviderOffset.clear();
		this.manager.resetAll();
		const item = adapter.getReaderItem(this.reader);
		if (item) {
			try {
				await cacheManager.clearAttachmentAllVersions(item.key);
			}
			catch (e) {
				logger.warn(MODULE, 'retranslateAll: cache clear failed', e);
			}
		}
		// No separate toast: the capsule immediately shows the current page
		// re-translating, which IS the confirmation that 刷新全部 took effect.
		if (getPref<boolean>('privacyNoticeAccepted', false)) {
			this.manager.setCurrentPage(adapter.getCurrentPageIndex(this.reader));
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
			this.flashNotice(getString('papermirror-toast-saved'));
		}
		else {
			this.pushFailure(getString('papermirror-status-error'));
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
			this.flashNotice(getString('papermirror-toast-copied'));
		}
		catch (e) {
			logger.warn(MODULE, 'Clipboard copy failed', e);
		}
	}

	/**
	 * 诊断导出: sanitized per-page diagnostics (statuses, request/retry/429
	 * counts, keep-origin reasons — NO text, NO keys) → clipboard as JSON.
	 */
	private copyDiagnostics(): void {
		if (!this.manager) {
			return;
		}
		try {
			const payload = {
				plugin: 'PaperMirror',
				generatedAt: new Date().toISOString(),
				...(this.manager.exportDiagnostics() as Record<string, unknown>)
			};
			Components.classes['@mozilla.org/widget/clipboardhelper;1']
				.getService(Components.interfaces.nsIClipboardHelper)
				.copyString(JSON.stringify(payload, null, 2));
			this.flashNotice('诊断已复制到剪贴板(脱敏,不含正文与密钥)');
		}
		catch (e) {
			logger.warn(MODULE, 'diagnostics copy failed', e);
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
			this.flashNotice(getString('papermirror-toast-saved'));
		}
		else {
			this.pushFailure(getString('papermirror-status-error'));
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
			// No toast: retranslateCurrent() makes the capsule show progress.
			await this.retranslateCurrent();
		}
		catch (e) {
			logger.warn(MODULE, 'clearCurrentCache failed', e);
			this.pushFailure(getString('papermirror-status-error'));
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
		for (const timer of this.taskHideTimers.values()) {
			clearTimeout(timer);
		}
		this.taskHideTimers.clear();
		this.tasks.clear();
		this.translatedPages.clear();
		this.lastPartial = null;
		this.disposePdfEvents?.();
		this.disposePdfEvents = null;
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
