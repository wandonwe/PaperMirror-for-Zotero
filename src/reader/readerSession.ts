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
import { registerUrlCredentials } from '../security/logSanitizer';
import { getProvider, listProviders } from '../translation/providers/registry';
import { buildPool, pickProviderForPage, rankProvidersForPage, poolLanePlan, prefetchWindowFor, normalizePerfMode, normalizeGlobalMax, DEFAULT_PERF_MODE, GLOBAL_MAX_DEFAULT, type ProviderCapability } from '../translation/providerPool';
import { endpointHost, supportsCharBudget } from '../translation/providers/types';
import { canExplain, explainText, parseExplanationSections, type ExplanationSection } from '../translation/explainer';
import { TranslationManager, type PageTranslationState } from '../translation/translationManager';
import { PROMPT_VERSION } from '../translation/promptBuilder';
import { parseGlossaryJSON, serializeGlossary, dedupeLearnedTerms } from '../translation/glossary';
import { parseProviderProfiles, effectiveProviderConfig } from '../translation/providerProfiles';
import type { GlossaryRule, ProviderSettings, TranslationRequest, TranslationResponse } from '../types/models';
import { PaperMirrorError } from '../types/models';
import { TranslationPane, type PaneStrings } from '../ui/translationPane';
import { buildOriginalPage } from '../ui/translatedPageView';
import { buildStrictPage, revertStrictBlocks, settleStrictPage, shrinkStrictBlocks, expandStrictBlocks, applyCompressedStrict, planStrictRetry, strictPageStats, placementTally, auditStrictGeometry, probeStrictPlacement, flashKeptIndicator, type UnfitBlock } from '../ui/strictPageReplacement';
import { buildTranslatedPdf, type PageTranslationData } from '../pdfgen/translatedPdfBuilder';
import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import { getPref, setPref, registerPrefObserver, unregisterPrefObserver } from '../utils/prefs';
import { detectLanguage, defaultTargetFor, sourceCodeFor } from '../utils/languageDetector';
import { createSyncController, type SyncController } from './scrollSynchronizer';
import { PdfOverlay, type OverlayDisplayMode, type OverlayProgress } from './pdfOverlay';
import { taskPriority } from '../ui/statusCapsule';
import { createSplitView, type SplitViewHandles } from './splitView';
import { TextExtractor } from './textExtractor';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderLike, PageRender } from './zoteroReaderAdapter';
import { LruCache } from '../util/lru';

const MODULE = 'readerSession';
// 兜底轮询间隔 (2.2.9, 计划 第四批 item1 · PF-8): 页变化改为事件驱动
// (updateviewarea 每滚动帧触发 syncCurrentPage),轮询只兜事件失效的底
// (eventBus 不可得/事件被吞),350ms → 1500ms;窗口不可见时 tick 直接跳过。
const PAGE_POLL_MS = 1500;

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
		explainSelection: getString('papermirror-explain-selection'),
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
	/** visibilitychange 监听的解除器 (2.2.9, item1 不可见即停)。 */
	private disposeVisibility: (() => void) | null = null;
	private pageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	/** 缓存身份 pref 观察者 (2.0.9, 审核 P2-4) 与其去抖定时器。 */
	private identityPrefObservers: (symbol | string)[] = [];
	private identityRestartTimer: ReturnType<typeof setTimeout> | null = null;
	/** 菜单驱动的 quiesce 正在 apply() 时置位,阻止观察者二次重启。 */
	private applyingConfigChange = false;
	/**
	 * quiesce 窗口封口 (2.0.10, 审核 P3): resetAllAndWait 等待期间轮询/滚动
	 * 仍可 setCurrentPage 入队**新**任务 —— apply() 随后改 pref,该任务的
	 * persistPartial 会按新身份落盘旧配置段落(P1-9 的侧门)。置位期间
	 * 会话侧的 setCurrentPage 转发一律 no-op,restart 完成后放行。
	 */
	private quiescing = false;
	/** Provider pool (primary first). Rebuilt when translation (re)starts. */
	private pool: string[] = [];
	/** Real image rects per page (operator list), fetched once per document. */
	private imageRects = new Map<number, [number, number, number, number][] | null>();
	/**
	 * 底图位图 LRU (2.2.5, 计划 第三批 item6 · PF-4): 缓存 renderPageBitmap 得到的
	 * 独立底图,键 = `${page}@${宽度桶}`。切换页/回看/在原宽度重渲染时命中即复用
	 * 底图,buildStrictPage 只重建遮罩+文本层,省掉最贵的 pdf.js 整页 rasterize。
	 * 底图只随 (页, 宽度) 变,与译文/配置无关 → 无需失效,仅靠容量淘汰与 dispose。
	 * 容量取小(4):单张底图受 oversample 像素预算封顶(~3.2M px ≈ 13MB),4 张
	 * 够覆盖可视区+近邻回看(同宽度重建/对照切换/relayout 全部命中),内存上界
	 * ~50MB,dispose 全释放。
	 */
	private baseBitmaps = new LruCache<PageRender>(4);
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
	 * 被 compressPending 挡回的最近一次 settle (2.0.9, 审核 P2-10)。压缩请求
	 * 可飞 120s,期间页面因缩放/更新重渲染 —— 新渲染的 resolveStrictUnfit 被
	 * 入口闸挡回后此前**无人接力**: 不 shrink、不 revert、不 reportPlacement,
	 * 未适配块永远保持英文且不计 kept,胶囊停在「正在适配排版」。现在挡回时
	 * 记下待办,在飞压缩的 finally 里续跑(只保留最新一次;旧 token 由 live()
	 * 自然拦截)。
	 */
	private compressBlocked = new Map<number, { element: HTMLElement; unfit: UnfitBlock[]; token: number }>();
	/** 扫描/纯图页每页只提示一次。 */
	private scannedNoticeShown = new Set<number>();
	/** 几何安全复核结果按页留档(进诊断导出;只计数,无文本)。 */
	private geometryAudits = new Map<number, import('../ui/strictPageReplacement').GeometryAuditResult>();
	/** 每页最近一次 placement 统计 (2.0.10, 审核 P3): imageExcluded 等
	 *  「有意保留」类目此前不进任何诊断 —— 阈值收紧后该类目变大也无从发现。 */
	private placementStats = new Map<number, import('../ui/strictPageReplacement').StrictPageStats>();
	/** 每页 placement 探针 (审核: 封面标题空洞定位): 每块的 base 位图/遮罩取样
	 *  (baseInk/maskOpaque),分辨「底图缺字」与「遮罩误盖」。只几何+布尔,无文本。 */
	private placementProbe = new Map<number, import('../ui/strictPageReplacement').StrictProbeRow[]>();
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

	/** The engine responsible for a page, honouring the 刷新 rotation.
	 *  2.2.1 (计划 第三批 item1): 轮换取该页 HRW 降序榜的第 `offset` 名,而非
	 *  旧的 `pickProviderForPage(pool, pageIndex+offset)`——后者是为取模量身的
	 *  hack,一致性哈希下「页号+1」只是跳到另一个伪随机服务商、偶尔还转回原点。
	 *  按榜退让则确定:offset0=规范拥有者,offset1=次高分,依次熔断退让。 */
	private providerForPage(pageIndex: number): string {
		if (this.pool.length > 1) {
			const offset = this.pageProviderOffset.get(pageIndex) ?? 0;
			const rank = rankProvidersForPage(this.pool, pageIndex);
			return rank[offset % rank.length]!;
		}
		return getPref<string>('provider', 'bing-free');
	}

	/**
	 * 缓存身份用的**规范**引擎 (2.0.5, 审核 P2-16): 不含 pageProviderOffset。
	 * offset 是会话内瞬态路由(熔断换引擎、手动刷新轮换),重启即清零 ——
	 * 让它进缓存键曾造成: 熔断切到 B 后同一页 readCache 用 A 键、writeCache
	 * 用 B 键,写进去的译文下次打开(offset 归零 → A 键)永远读不回来,
	 * 页面缓存必然失效。缓存身份只随**持久配置**(provider 首选项、池成员)
	 * 变化: 同一页的读写键从此恒等,跨会话也稳定。混合来源的译文(切换前
	 * A 译了一半)存在该页的规范键下 —— 缓存返回的正是用户当时看到的内容。
	 */
	private canonicalProviderForPage(pageIndex: number): string {
		if (this.pool.length > 1) {
			return pickProviderForPage(this.pool, pageIndex);
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

	/** 本会话所属的主窗口 (2.0.4, 审核 P2-17) — 供按窗口维度销毁会话。
	 *  2.0.10 (审核 P3): 改用不带 getMainWindow 兜底的归属判定 —— 缺 _window
	 *  时如实返回 null,disposeWindow 的「保守保留」才名副其实。 */
	getMainWindow(): Window | null {
		try {
			return adapter.getOwnerWindowForReader(this.reader);
		}
		catch {
			return null;
		}
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
			onRetranslate: () => this.confirmClearCacheRetranslate(), // 菜单「清缓存重译全文」= 破坏性,先确认
			onRotateEngine: () => void this.rotateCurrentEngine(), // 菜单「换引擎重译本页」= 有池时轮换引擎真正重译
			onRefreshPage: () => void this.retranslateCurrent(), // 胶囊圆环 = 修复本页 (只补缺,不换引擎不清合格缓存)
			onCancelPage: () => this.cancelCurrentTranslation(), // 胶囊取消 = 停止翻译
			onViewPartial: () => this.viewKeptOriginal(), // 胶囊「查看保留原文」= 定位保留段落
			onDismiss: () => this.dismissTopTask(), // 胶囊 × = 关闭当前通知
			onCollapsedChange: (c) => this.setCapsuleCollapsed(c), // 折叠状态由会话统一管理
			onSaveNote: () => void this.saveSelectionToNote(),
			onShowDiagnostics: () => void this.copyDiagnostics(),
			onCopyCorpus: () => this.copyLayoutCorpus(),
			onSaveTerms: () => this.previewSaveLearnedTerms(), // 2.3.1 item3: 预览并保存到词汇表(不再只复制 TSV)
			// 「更多」菜单 (2.3.0, 第四批 item2 · WF-1): 导出/清缓存从控制台 API 搬上界面。
			onExportPdf: () => void this.exportTranslatedPdf(),
			onClearDocCache: () => this.confirmClearDocCache(),
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
		// open()×destroy 竞态闸 (2.0.7, 审核 P1-1): 上面的 await(以及下面的
		// prime,可达数秒)期间用户关标签/关窗口/禁用插件都会 destroy()。
		// 此前 open() 继续执行: 在销毁**之后**注册 disposePdfEvents 与
		// startPolling —— eventBus 监听与兜底轮询永不解除(tick 首行的
		// destroyed 检查只让它空转,不停止),每次「打开后迅速关闭」泄漏一条;
		// 隐私未接受分支还会对已置 null 的 split/pane 直接调用抛 TypeError。
		if (this.destroyed) {
			return;
		}

		await this.extractor.prime();
		if (this.destroyed) {
			return; // 同上: prime 期间被销毁,后续注册一律不做
		}

		if (!getPref<boolean>('privacyNoticeAccepted', false)) {
			const settings = await this.providerSettings();
			if (this.destroyed) {
				return; // P1-1: providerSettings 查密钥库最长 4s,期间可被销毁
			}
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
		// re-renders and zooms no longer force a rebuild. The stream drives
		// 同步滚动 (following the reader's position continuously) AND — 2.2.9,
		// item1 — 事件驱动的页同步: updateviewarea 每滚动帧触发 syncCurrentPage
		// (廉价比较、幂等),翻页当帧即被捕捉,350ms 轮询从此只是兜底。
		this.disposePdfEvents = adapter.onPdfRenderEvents(this.reader, (pageIndex) => {
			if (this.destroyed) {
				return;
			}
			if (!this.isWindowHidden()) {
				this.syncCurrentPage();
			}
			if (pageIndex !== null) {
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

		this.installIdentityPrefObservers();
		this.startPolling();
		logger.info(MODULE, `Session opened for tab ${this.reader.tabID}`);
	}

	/**
	 * 设置窗口的配置变更也走静默重启 (2.0.9, 审核 P2-4)。
	 *
	 * 缓存身份(settingsHash 六成分、customPrompt、glossary、noTranslate、
	 * provider/模型/语言)在**落盘时**现读 pref —— quiesceThenReconfigure 只
	 * 覆盖菜单栏换语言/换引擎两条路径,Preferences 窗口写 providerProfiles
	 * (温度/端点/推理强度)、术语表、不译词等时没有任何会话通知: 翻译中改
	 * 温度 → 该页后续请求用新配置、已完成 chunk 是旧配置产物 → 页面结束时
	 * 按**新** settingsHash 落盘,旧配置译文永久占据新身份,v5「改配置旧译文
	 * 失效」的意图被反向绕过。现在对每个参与身份的 pref 注册观察者,去抖后
	 * 走与菜单路径相同的 quiesce+restart(观察者只在 pref 已变之后收敛,变更
	 * 与收敛之间的窗口从「无限」缩到毫秒级)。
	 */
	private installIdentityPrefObservers(): void {
		const IDENTITY_PREFS = [
			'providerProfiles', 'customPrompt', 'glossaryGlobal', 'noTranslateList',
			'useContext', 'parallelProviders', 'provider', 'apiBaseURL', 'model',
			'sourceLanguage', 'targetLanguage'
		] as const;
		for (const key of IDENTITY_PREFS) {
			try {
				this.identityPrefObservers.push(registerPrefObserver(key, () => {
					// 菜单路径的 apply() 自己会 restart —— 它设 pref 触发的观察
					// 事件必须忽略,否则双重启。
					if (this.destroyed || this.applyingConfigChange) {
						return;
					}
					if (this.identityRestartTimer !== null) {
						clearTimeout(this.identityRestartTimer);
					}
					// 去抖: 关闭设置窗口常一次性落多个 pref,合并成一次重启。
					this.identityRestartTimer = setTimeout(() => {
						this.identityRestartTimer = null;
						if (this.destroyed) {
							return;
						}
						logger.info(MODULE, 'Cache-identity pref changed outside the menu; quiescing and restarting');
						void this.quiesceThenReconfigure(() => {
							// pref 已经变了,这里只把面板头部同步到新配置。
							const pid = getPref<string>('provider', 'bing-free');
							try {
								this.pane?.setProviderInfo(getProvider(pid).displayName, pid);
							}
							catch { /* 未知 provider id: 面板标签保持原样 */ }
							const src = getPref<string>('sourceLanguage', 'auto');
							const tgt = getPref<string>('targetLanguage', 'auto');
							this.pane?.setLanguageCodes(src, tgt);
							this.pane?.setLanguagePair(languageLabel(src), languageLabel(tgt));
						});
					}, 400);
				}));
			}
			catch (e) {
				logger.warn(MODULE, `identity pref observer failed for ${key}`, e);
			}
		}
	}

	private startTranslating(): void {
		// 先等池就绪再排任务 (2.0.10, 审核 P3): rebuildPool 内含 getApiKey,
		// 慢密钥库/首次解锁可达秒级 —— 此前 fire-and-forget,空窗内 pool 为
		// 空,canonicalProviderForPage/providerForPage 都退化为主引擎: 多服务
		// 商池的首屏页 readCache/writeCache 键与 lane 都落在错误引擎(上一
		// 会话写的是池内规范键 → 必然 miss 白重译)。
		void this.rebuildPool()
			.catch(() => { /* 池判定尽力而为 */ })
			.then(() => {
				if (!this.destroyed) {
					this.startTranslatingWithPool();
				}
			});
	}

	private startTranslatingWithPool(): void {
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
					const texts = blocks.map(b => b.sourceText);
					const parts = await this.cacheKey(pageIndex, texts);
					if (parts) {
						const hit = await cacheManager.readPage(parts);
						if (hit) {
							return hit;
						}
					}
					// 发送前查全服务商缓存 (2.2.1, 计划 第三批 item1 · Codex API-P1):
					// 规范键 miss 后,遍历池内其余已启用服务商各自的完整页缓存 ——
					// 只要**任一**服务商曾译过这页(上个会话主译的引擎、池变动前的
					// 拥有者、熔断换过的引擎),就直接复用、绝不重付费。跨会话/增删
					// 服务商后最常见的「白重译一整篇」由此根治。命中键与规范键不同
					// 不回写(读写键仍恒等,下次仍靠这层探测,成本只是几次文件存在性
					// 检查;getApiKey 已 memoize,构键几乎零开销)。
					if (this.pool.length > 1) {
						const canonical = parts?.provider;
						for (const pid of this.pool) {
							const alt = await this.cacheKey(pageIndex, texts, pid);
							if (!alt || alt.provider === canonical) {
								continue;
							}
							const hit = await cacheManager.readPage(alt);
							if (hit) {
								return hit;
							}
						}
					}
					return null;
				},
				writeCache: async (pageIndex, blocks, translations) => {
					const parts = await this.cacheKey(pageIndex, blocks.map(b => b.sourceText));
					if (parts) {
						// producedBy = 运行时引擎 (P3, 2.0.10, 仅诊断): 键是规范引擎的。
						await cacheManager.writePage(parts, translations, this.providerForPage(pageIndex));
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
		if (!this.quiescing) { // P3 (2.0.10): quiesce 封口
			this.manager.setCurrentPage(page);
		}
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
		// 注册 URL 内凭据 (2.1.0, 审核 S1): ?key=… 形式的密钥不经 getApiKey,
		// 在这里入库让 sanitizer 精确替换能命中它(诊断/日志/回显)。
		registerUrlCredentials(apiBaseURL);
		registerUrlCredentials((profile.apiPath ?? '').trim());
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

	private async cacheKey(pageIndex: number, texts: string[], providerId?: string): Promise<CacheKeyParts | null> {
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return null;
		}
		// 规范引擎,不是运行时引擎 (P2-16): 读写键必须恒等,见 canonicalProviderForPage。
		// providerId 省略 = 规范引擎(读写恒等);显式传入用于「发送前查全服务商缓存」
		// (2.2.1, item1)—— 用池内其它服务商各自的键探测同一页是否已被译过。
		const chosen = providerId ?? this.canonicalProviderForPage(pageIndex);
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
			// 代码常量,不读 promptVersion 首选项 (审核 P0): prefs.js 固定的 1
			// 曾把代码里的 v2 永远压回 v1,提示词升级从未真正让缓存失效。
			promptVersion: PROMPT_VERSION,
			// 自定义提示词 / 术语表 / 不译词都是译文身份的一部分 (v3):
			// 改了其中任何一个,旧译文都不该再命中。
			...this.configIdentity(),
			// 端点/高级参数/useContext 同为译文身份 (v5, 审核 P3)。
			settingsHash: this.settingsIdentityHash(settings),
			sourceTextHash: hashSourceTexts(texts)
		};
	}

	/**
	 * 会改变译文的**服务商配置**的折叠哈希 (v5, 审核 P3): 不同端点/代理后面
	 * 可能是完全不同的模型,温度与推理强度直接改变输出,useContext 改变请求
	 * 携带的上文 —— 任何一项变了,旧译文都不该再命中。页面键与段落 context 共用,
	 * 读写必然一致。
	 *
	 * maxOutputTokens **不**计入 (2.1.7, 计划 API-1): 它只是输出的安全上限、不
	 * 决定已完整译文的内容;而截断的译文本就被 isTruncatedTranslation 拦下、不
	 * 入缓存。此前把它计入 → 用户为解决个别截断把上限 4k 调到 8k,会作废整篇
	 * 页面+段落缓存全量重译一遍(数万 token 白烧)。移出后:调高上限只让个别
	 * 曾截断的段重译,其余照旧命中;调低的极端情形至多个别长段重译。
	 */
	private settingsIdentityHash(settings: { apiBaseURL?: string; apiPath?: string; reasoning?: string; maxOutputTokens?: number; temperature?: number }): string {
		return hashSourceTexts([
			settings.apiBaseURL ?? '',
			settings.apiPath ?? '',
			settings.reasoning ?? '',
			String(settings.temperature ?? ''),
			String(getPref<boolean>('useContext', true))
		]);
	}

	private loadGlossary(): GlossaryRule[] {
		return parseGlossaryJSON(getPref<string>('glossaryGlobal', '[]'));
	}

	/**
	 * 会改变译文的「配置身份」的哈希 (审核 P1-9/P1-10)。
	 *
	 * 集中在一处读取,页面键与段落 context 共用 —— 此前两个方法各自读 pref,
	 * 字段集合还不一致(段落有 glossaryHash、页面没有),既容易漂移,也让
	 * 「改了术语表/不译词旧译文应失效」的意图被先命中的页面缓存整层短路。
	 */
	private configIdentity(): { customPromptHash: string; glossaryHash: string; noTranslateHash: string } {
		return {
			customPromptHash: hashSourceTexts([getPref<string>('customPrompt', '')]),
			glossaryHash: hashSourceTexts([getPref<string>('glossaryGlobal', '[]')]),
			noTranslateHash: hashSourceTexts([String(getPref<string>('noTranslateList', '') ?? '')])
		};
	}

	/** Context parts scoping the per-segment store (see cacheSchema). */
	private async segmentContext(pageIndex: number): Promise<SegmentContextParts | null> {
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return null;
		}
		// 规范引擎 (P2-16): 段落 store 的读写 context 同样必须恒等。
		const settings = await this.providerSettingsFor(this.canonicalProviderForPage(pageIndex));
		return {
			attachmentKey: item.key,
			fileHash: this.fileHash || 'nohash',
			provider: settings.providerId,
			model: settings.model,
			promptVersion: PROMPT_VERSION,
			...this.configIdentity(),
			settingsHash: this.settingsIdentityHash(settings)
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
			// P2-19 (2.0.5): unfit 节点是 visibility:hidden 的译文 div,直接
			// 描边看不见 —— 改为按其几何画独立的可见标记层 (flashKeptIndicator)。
			// 只有**确实闪出了**至少一个标记才算完成;找到节点但一个都画不出
			// (旧代码在这种情况下也 return,把回退路径整个屏蔽)则继续走 pane。
			let flashed = 0;
			for (const box of boxes) {
				if (flashKeptIndicator(box)) {
					flashed++;
				}
			}
			if (flashed > 0) {
				boxes[0]?.scrollIntoView({ block: 'center' });
				return;
			}
		}
		// Overlay element gone or empty → let the pane locate them.
		// 覆盖模式下面板 display:none (2.0.10, 审核 P3): pane 的高亮同样不可见,
		// 构造处注释承诺的 "switch to pane + locate" 此前从未实现 —— 先切到
		// 左右对照再定位,用户才真的看得到保留原文在哪。
		if (this.viewMode === 'overlay') {
			this.setViewMode('split');
		}
		this.pane?.revealKeptOriginal(pageIndex);
	}

	/** 主窗口不可见(最小化/被遮挡切走)—— 不可见即停 (2.2.9, item1)。 */
	private isWindowHidden(): boolean {
		try {
			return this.getMainWindow()?.document?.hidden === true;
		}
		catch {
			return false;
		}
	}

	/**
	 * 当前页同步:页变化 → 翻译优先级/面板/胶囊跟进。事件驱动为主
	 * (updateviewarea 每滚动帧调用,比较廉价、幂等),兜底轮询为辅。
	 */
	private syncCurrentPage(): void {
		const page = adapter.getCurrentPageIndex(this.reader);
		if (page === this.lastPageIndex) {
			return;
		}
		this.lastPageIndex = page;
		// In 原文 mode nothing is displayed, so don't spend requests
		// translating pages the reader scrolls past.
		// quiescing 期间不入队 (P3, 2.0.10): 见 quiescing 字段注释。
		if (this.viewMode !== 'original' && !this.quiescing) {
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

	/** 兜底 tick(1.5s): 内存回收 + 分栏漂移看门狗 + 页同步兜底。 */
	private pollTick(): void {
		if (this.destroyed) {
			return;
		}
		// lastPartial 滞留释放 (2.0.6, 审核 P3): 页面重渲染/卸载后其 strict
		// 元素(带整页位图 canvas,约 26 MB)已脱离文档,却被 lastPartial
		// 一直引用而无法回收。已断开就放手 ——「查看保留原文」对断开元素
		// 本来就会走 pane 回退路径,不损失功能。(放在 hidden 检查之前:
		// 后台窗口更该回收内存。)
		if (this.lastPartial && !this.lastPartial.element.isConnected) {
			this.lastPartial = null;
		}
		// 不可见即停 (2.2.9, item1): 窗口不可见时不做布局看门狗、不做页同步 ——
		// 不触发 setCurrentPage 就不会产生新的翻译/预取请求;恢复可见由
		// visibilitychange 监听立即补一拍,轮询照常兜底。
		if (this.isWindowHidden()) {
			return;
		}
		// Sidebar opened/closed/resized → re-balance the split.
		this.split?.refreshLayout();
		this.syncCurrentPage();
	}

	private startPolling(): void {
		this.pollTimer = setInterval(() => this.pollTick(), PAGE_POLL_MS);
		// 恢复可见立即补一拍(不然要等最长 1.5s 的下一次兜底 tick)。
		try {
			const doc = this.getMainWindow()?.document;
			if (doc) {
				const onVisibility = (): void => {
					if (!this.destroyed && !doc.hidden) {
						this.pollTick();
					}
				};
				doc.addEventListener('visibilitychange', onVisibility);
				this.disposeVisibility = () => {
					try {
						doc.removeEventListener('visibilitychange', onVisibility);
					}
					catch { /* window may be gone */ }
				};
			}
		}
		catch { /* visibility tracking is best-effort */ }
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
		// 底图位图 LRU (2.2.5, item6): 同页同宽度已 rasterize 过就直接复用,免去
		// 最贵的 pdf.js 整页渲染;buildStrictPage 只重建遮罩+文本层。宽度取整分桶,
		// 缩放换宽度自然落到不同键、旧宽度条目由 LRU 淘汰。
		const bitmapKey = `${pageIndex}@${Math.round(width)}`;
		let render = this.baseBitmaps.get(bitmapKey) ?? null;
		if (!render) {
			// Supersample within a fixed pixel budget: sharp text without letting a
			// tall page allocate an enormous canvas.
			const oversample = Math.max(1, Math.min(1.8, Math.sqrt(3_200_000 / Math.max(1, width * width * 1.4))));
			render = await adapter.renderPageBitmap(this.reader, pageIndex, width, oversample);
			if (!current()) {
				return false;
			}
			if (render) {
				this.baseBitmaps.set(bitmapKey, render); // 只缓存独立 raster
			}
		}
		if (!render) {
			// Core rendering unavailable (compartment quirk, worker busy):
			// fall back to copying the LEFT viewer's canvas. It only exists for
			// pages near the left viewport, and comes at the left zoom rather
			// than the pane width — the element is scaled to fit below. 不缓存
			// (它是左视图 live canvas、宽度/缩放都不对,复用会错位)。
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
		// 扫描/纯图页提示 (BabelDOC detect_scanned_file 思想的用户侧一半):
		// 提取干净地得到 0 块时,这页不是"翻译失败"而是"没有可译文本"——
		// 明说一次,免得用户对着原样页面点圆环等翻译。每页只提示一次。
		if (state && state.status === 'done' && !state.blocks.length
			&& pageIndex === adapter.getCurrentPageIndex(this.reader)
			&& !this.scannedNoticeShown.has(pageIndex)) {
			this.scannedNoticeShown.add(pageIndex);
			this.flashNotice(`第 ${pageIndex + 1} 页未检测到可翻译文本(纯图或扫描页),已保留原样`);
		}
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
						const id = node.getAttribute('data-pm-block')?.split('::')[0];  // 段落拆分块 id 形如 <region>::pN,取区域 id
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
						const id = node.getAttribute('data-pm-block')?.split('::')[0];  // 段落拆分块 id 形如 <region>::pN,取区域 id
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
		// (0) 无损空白扩边优先 (2.2.2, 计划 第三批 item3): 在缩写/缩字之前,先把靠
		// 邻近安全空白就能放下的块无损救回 —— 不牺牲译文、不费一次 API。仍不适配
		// 的块才进入后续的「压缩→缩字→保留原文」。扩边幂等(已提交块跳过),
		// 递归回来时会对压缩后的更短文本再扩一次。
		const stillAfterExpand = new Set(expandStrictBlocks(element, unfit.map(u => u.id)));
		const remaining = unfit.filter(u => stillAfterExpand.has(u.id));
		if (!remaining.length) {
			this.reportPlacement(pageIndex, element);
			return;
		}
		const budgetCapable = supportsCharBudget(getProvider(this.providerForPage(pageIndex)));
		const plan = planStrictRetry(remaining, {
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
			// shrink-only 路径此前静默结束,页面的最终清点从未发生(1.1.0
			// 顺手补上的诚实计数缺口)——几何复核与 tally 都挂在 reportPlacement。
			if (!plan.compress.length && !this.compressPending.has(pageIndex)) {
				this.reportPlacement(pageIndex, element);
			}
			// 丢失唤醒补接力 (2.0.9, 审核 P2-10): 被在飞压缩挡回的渲染记下
			// 待办,压缩 finally 里续跑 —— 否则这次渲染的未适配块永远无人处理。
			else if (plan.compress.length && this.compressPending.has(pageIndex)) {
				this.compressBlocked.set(pageIndex, { element, unfit: remaining, token });
			}
			return;
		}
		this.compressPending.add(pageIndex);
		for (const id of plan.compress) {
			this.compressRounds.set(id, (this.compressRounds.get(id) ?? 0) + 1);
		}
		const entries = remaining.filter(u => plan.compress.includes(u.id));
		void this.manager.compressBlocks(pageIndex, entries)
			.then((accepted) => {
				if (!live()) {
					// 注意: compressPending 的清理在下面的 finally,不在这里 ——
					// 这条早退路径此前不清理,而 catch 分支清理,那个不对称正是
					// 缺陷本身 (审核 P1-6)。压缩请求可飞行 120 s,期间只要该页
					// 被重渲染或滚出可视区(releaseFarSlots / relayoutSlots),
					// live() 即为假,pageIndex 就永久留在 compressPending 里。
					// 此后该页任何渲染都被 resolveStrictUnfit 的入口闸挡回,且
					// 「无压缩计划」那条分支也因同一个标记恒假 —— reportPlacement
					// 永不执行: 几何复核不跑、tally 不产出、胶囊停在「正在适配
					// 排版」、未适配块永远显示英文且不计入 kept。只有手动
					// 「刷新本页」能恢复。
					return;
				}
				// Apply shorter retries in place; whatever still overflows (plus
				// any block the service failed to shorten) goes round again.
				const stillUnfit = applyCompressedStrict(element, accepted);
				const noProgress = entries.filter(e => !accepted.has(e.id));
				const next = [...stillUnfit, ...noProgress.filter(e => !stillUnfit.some(s => s.id === e.id))];
				// 这处 delete 必须留在递归调用之前,不能只靠下面的 finally ——
				// finally 在 then 体跑完之后才执行,而 resolveStrictUnfit 的入口
				// 就查 compressPending,届时下一轮会被自己挡回。
				this.compressPending.delete(pageIndex);
				if (next.length) {
					this.resolveStrictUnfit(pageIndex, element, next, token);
				}
				else {
					this.reportPlacement(pageIndex, element);
				}
			})
			.catch(() => {
				// 压缩请求异常退出也必须走一次最终清点 (1.2.2, 审核项): 否则
				// 几何复核与 placement tally 永不发生,胶囊停在「排版中」。
				// (清理交给 finally。)
				if (live()) {
					this.reportPlacement(pageIndex, element);
				}
			})
			.finally(() => {
				// 兜底清理 (审核 P1-6): 无论 then 早退、then 正常、还是 catch,
				// 这个标记都必须落地清除。Set.delete 幂等,与上面 then 里那次
				// 提前清除并存无害。
				this.compressPending.delete(pageIndex);
				// P2-10 (2.0.9): 压缩期间被挡回的最新渲染在这里接力 —— 旧 token
				// 由 resolveStrictUnfit 自己的 live() 拦截,无需在此判活。
				const blocked = this.compressBlocked.get(pageIndex);
				if (blocked) {
					this.compressBlocked.delete(pageIndex);
					if (!this.destroyed) {
						this.resolveStrictUnfit(pageIndex, blocked.element, blocked.unfit, blocked.token);
					}
				}
			});
	}

	/**
	 * Honest placement accounting (#6): after a page settles, log the full
	 * tally and — if any block could NOT be shown translated — surface a
	 * non-blocking note rather than silently leaving English on the page.
	 * "Translation complete" and "every block placed" are now distinct: the
	 * text was translated; some rectangles are mathematically too small for it.
	 */
	private reportPlacement(pageIndex: number, element: HTMLElement): void {
		// 几何安全复核 (1.1.0 目标架构第 5 步): FINAL 状态下审计一次;违例的
		// 块回退扩展/缩字重试,仍不适配则保留原文——处置结果反映进随后的
		// stats/tally,所以必须先审计后取数。
		try {
			const audit = auditStrictGeometry(element);
			if (audit) {
				this.geometryAudits.set(pageIndex, audit);
			}
			if (audit && audit.violations > 0) {
				logger.info(
					MODULE,
					`page ${pageIndex + 1} geometry audit: ${audit.violations} violation(s) → `
					+ `${audit.adjusted} re-fit within original box, ${audit.reverted} kept original`
				);
			}
		}
		catch (e) {
			logger.warn(MODULE, `geometry audit failed on page ${pageIndex + 1} (ignored)`, e);
		}
		const s = strictPageStats(element);
		if (!s) {
			return;
		}
		this.placementStats.set(pageIndex, s); // P3 (2.0.10): 供诊断导出
		// Placement 探针下热路径 (2.1.7, 计划 PF-2): 探针对每块每行做 getImageData
		// 采样底图/遮罩,只为诊断导出定位病因。此前每页 FINAL 无条件跑,普通用户
		// 从不导出诊断却白付数百次逐像素读取、拖长译文显现。现在仅在开启「调试
		// 日志」时对该页采样;关闭时零成本。
		if (getPref<boolean>('debugLogging', false)) {
			try {
				const probe = probeStrictPlacement(element);
				if (probe) {
					this.placementProbe.set(pageIndex, probe);
				}
			}
			catch (e) {
				logger.debug(MODULE, `placement probe failed on page ${pageIndex + 1} (ignored)`, e);
			}
		}
		logger.info(
			MODULE,
			`page ${pageIndex + 1} placement: ${s.committed}/${s.replaceable} shown, `
			+ `${s.abandoned} won't fit, ${s.untranslated} untranslated, `
			+ `${s.tableFailed} table-failed, ${s.tableIntentional} table-kept, `
			+ `${s.imageExcluded} on images, ${s.tooSmall} too small`
		);
		if (this.destroyed) {
			return;
		}
		// ONE consistent 口径, no double counting: `committed` ALREADY includes the
		// table text cells that were placed (they are items like any block), so
		// `placed` is just `committed`. Failures that must count as kept: blocks
		// that wouldn't fit (abandoned), blocks the service didn't translate
		// (untranslated), and table cells that failed to translate/place
		// (tableFailed). Intentionally-original content (data cells, figures,
		// metadata, tiny fragments) is neither placed nor a failure.
		const { placed, kept, segTotal, phase } = placementTally(s);
		// 记账先于「仅当前页」早退 (2.0.9, 审核 P2-11): 预取页(±1~2 页)在
		// 视口缓冲内 settle 时通常不是当前页 —— 旧实现连 translatedPages 与
		// lastPartial 一起跳过: 用户随后滚到该页,槽位已渲染不再触发 settle,
		// 常驻圆环显示「点击翻译本页」而该页实际已翻完;「查看保留原文」的
		// 直达定位也失效。胶囊推送(下方)仍只对当前页。
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
		if (pageIndex !== adapter.getCurrentPageIndex(this.reader)) {
			return; // only annotate (capsule) the page the reader is actually on
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
			// 导出恒走内置生成 (2.1.6): 零配置、无外部依赖、无网络面。此前的
			// 「完整 PDF 服务模式」(BabelDOC 本地 HTTP 桥接)连同其令牌/握手安全面
			// 一并移除 —— 无界面、少人用,且带来一整套本地服务攻击面。
			const { monoBytes, dualBytes } = await this.exportBuiltin(bytes, report);
			const parentID = (item as unknown as { parentItemID?: number }).parentItemID ?? undefined;
			const stem = (String(filePath).split(/[\\/]/).pop() || 'paper').replace(/\.pdf$/i, '');
			const saveOne = async (data: Uint8Array | null, suffix: string): Promise<void> => {
				if (!data) {
					return;
				}
				// 临时文件加固 (2.0.6, 审核 P3): 旧路径 `${stem}.${suffix}.pdf` 在
				// 共享 /tmp 里完全可预测 —— 共享主机上他人可预先占位/符号链接,
				// 或在删除前的窗口读取。文件名混入密码学随机成分;写入后立即
				// 收紧权限到 0600(尽力而为: 平台不支持时忽略,随机名仍是主防线)。
				const rand = (() => {
					try {
						const buf = new Uint8Array(12);
						(globalThis as { crypto?: { getRandomValues(b: Uint8Array): Uint8Array } }).crypto!.getRandomValues(buf);
						return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
					}
					catch {
						// crypto 不可用的兜底: 仍强于旧的完全固定名。
						return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
					}
				})();
				const tmp = PathUtils.join((PathUtils as unknown as { tempDir: string }).tempDir, `${stem}.${suffix}.${rand}.pdf`);
				await IOUtils.write(tmp, data);
				try {
					await (IOUtils as unknown as { setPermissions?(path: string, permissions: number): Promise<void> }).setPermissions?.(tmp, 0o600);
				}
				catch { /* 权限收紧尽力而为 */ }
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
		if (built.keptOriginal > 0) {
			// LO-1 (2.2.8): 放不下的块保留原文,不再涂白截断丢正文。
			logger.info(MODULE, `${built.keptOriginal} block(s) kept original in exported PDF (translation would not fit)`);
			this.flashNotice(`导出完成:${built.keptOriginal} 段译文放不下原区域,已保留原文(内容零丢失)`);
		}
		return { monoBytes: built.monoBytes, dualBytes: built.dualBytes };
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
		// 先静默 in-flight,再改配置 (审核 P1-9)。见 quiesceThenReconfigure。
		void this.quiesceThenReconfigure(() => {
			setPref('sourceLanguage', source);
			setPref('targetLanguage', target);
			this.pane?.setLanguageCodes(source, target);
			this.pane?.setLanguagePair(languageLabel(source), languageLabel(target));
		});
	}

	/** 菜单栏直接切换翻译服务 — same restart contract as a language switch. */
	private applyProviderPick(providerId: string): void {
		// 先静默 in-flight,再改配置 (审核 P1-9)。见 quiesceThenReconfigure。
		void this.quiesceThenReconfigure(() => {
			setPref('provider', providerId);
			// A provider carries its own base URL and model; stale per-provider
			// overrides from the previous engine must not leak into the new one.
			setPref('apiBaseURL', '');
			setPref('model', '');
			this.pane?.setProviderInfo(getProvider(providerId).displayName, providerId);
		});
	}

	/**
	 * 先让 in-flight 翻译**真正停下**,再改配置,最后重启 (审核 P1-9)。
	 *
	 * 缓存身份(provider/model/语言/提示词/术语表/不译词)不是在产出译文时快照
	 * 的,而是在**落盘时**现读 pref。而取消一个正在翻译的页面会走 persistPartial
	 * 把已完成的 chunk 写进段落库 —— 旧顺序是「先 setPref 再取消」,于是引擎 A
	 * 的译文被写进引擎 B 的段落库,重启后依然如此(用户切到 B 却一直读到 A 的
	 * 译文,只有强制重译才能摆脱)。语言切换同理会污染页面缓存。
	 *
	 * 把顺序倒过来 —— 静默 → 改配置 → 重启 —— 落盘就一定发生在旧身份下,
	 * 各归各的键,切回去还能命中。
	 */
	private async quiesceThenReconfigure(apply: () => void): Promise<void> {
		// P3 (2.0.10): 封口 —— 等待期间轮询不得再入队新任务。
		this.quiescing = true;
		try {
			const manager = this.manager;
			if (manager) {
				// 等所有 in-flight(含它们的 persistPartial 落盘)在**旧身份**下结束
				await manager.resetAllAndWait().catch(() => { /* 尽力而为 */ });
				if (this.destroyed || this.manager !== manager) {
					return;
				}
			}
			// P2-4 (2.0.9): apply() 里的 setPref 会触发身份 pref 观察者 —— 本路径
			// 自己就要 restart,置闸避免观察者再排一次。
			this.applyingConfigChange = true;
			try {
				apply();
			}
			finally {
				this.applyingConfigChange = false;
			}
			this.restartAfterConfigChange();
		}
		finally {
			this.quiescing = false;
		}
	}

	private restartAfterConfigChange(): void {
		this.compressRounds.clear();
		this.compressPending.clear();
		this.compressBlocked.clear();
		this.pageProviderOffset.clear();
		this.detectedSource = null;
		// 必须等 in-flight 真正结束再排新任务 (审核 P1-8): resetAll 只发 abort,
		// 旧任务要等 run() reject 后才离开 scheduler 的 active,紧跟其后的
		// setCurrentPage 会被 isScheduled 挡回 —— 换了服务商/语言之后当前页
		// 不会自动重翻,用户得手动点圆环。
		// P3 (2.0.10): rebuildPool 一并等 —— 池空窗内首个任务的缓存键/lane
		// 会落错引擎。
		const manager = this.manager;
		if (!manager) {
			void this.rebuildPool();
			return;
		}
		void Promise.all([
			this.rebuildPool().catch(() => { /* 尽力而为 */ }),
			manager.resetAllAndWait()
		]).then(() => {
			if (this.destroyed || this.manager !== manager) {
				return;
			}
			if (getPref<boolean>('privacyNoticeAccepted', false)) {
				manager.setCurrentPage(adapter.getCurrentPageIndex(this.reader));
			}
		});
	}

	/** 本页每块轮次计数清理(修复/换引擎共用)。 */
	private clearPageRounds(page: number): void {
		const prefix = `page-${page}-`;
		for (const id of [...this.compressRounds.keys()]) {
			if (id.startsWith(prefix)) {
				this.compressRounds.delete(id);
			}
		}
		this.compressPending.delete(page);
		this.compressBlocked.delete(page);
	}

	/**
	 * 修复本页 (2.1.10, 计划 item 4): 圆环默认动作。**只补缺失/无效/排版失败的
	 * 段**,复用段落库里合格的译文,**不轮换服务商、不清合格缓存**——一次点击
	 * 只为「把这页补齐」,不再像旧版那样在有池时默默换引擎+整页重付费。换引擎
	 * 重译是另一个显式动作(rotateCurrentEngine)。
	 */
	private async retranslateCurrent(): Promise<void> {
		if (!this.manager) {
			this.startTranslating();
			return;
		}
		const page = adapter.getCurrentPageIndex(this.reader);
		this.clearPageRounds(page);
		this.pane?.setBusy(true);
		try {
			await this.manager.retranslatePage(page, 'normal');
		}
		finally {
			this.pane?.setBusy(false);
		}
	}

	/**
	 * 换引擎重译本页 (2.1.10, 计划 item 4): 显式动作(菜单)。有池时把本页发给
	 * 下一家服务商并绕过段落库让新引擎**真正重译**(段落 context 用规范引擎、不含
	 * 轮换偏移,故 'normal' 会零请求读回旧译文——必须走 'rotate' 才真正换家)。
	 * 单引擎时无从换,退化为修复本页并提示。
	 */
	private async rotateCurrentEngine(): Promise<void> {
		if (!this.manager) {
			this.startTranslating();
			return;
		}
		const page = adapter.getCurrentPageIndex(this.reader);
		this.clearPageRounds(page);
		const rotated = this.pool.length > 1;
		if (rotated) {
			this.pageProviderOffset.set(page, ((this.pageProviderOffset.get(page) ?? 0) + 1) % this.pool.length);
			logger.info(MODULE, `换引擎重译 page ${page + 1} → provider ${this.providerForPage(page)}`);
		}
		else {
			this.flashNotice('只配置了一个翻译服务商,无法换引擎;已按「修复本页」重译');
		}
		this.pane?.setBusy(true);
		try {
			await this.manager.retranslatePage(page, rotated ? 'rotate' : 'normal');
		}
		finally {
			this.pane?.setBusy(false);
		}
	}

	/**
	 * 清缓存重译全文 (2.1.10, 计划 item 4): 破坏性动作,先确认。清掉本文档全部
	 * 页面+段落缓存并从头重译,已翻译内容会丢失。
	 */
	private confirmClearCacheRetranslate(): void {
		let ok = true;
		try {
			const prompt = (Services as unknown as { prompt?: { confirm(parent: unknown, title: string, text: string): boolean } }).prompt;
			const win = (Zotero as unknown as { getMainWindow?(): unknown }).getMainWindow?.() ?? null;
			ok = prompt ? prompt.confirm(win, '清缓存重译全文',
				'将清除本文档的全部页面与段落缓存并从头重译,已翻译内容会丢失。确定继续?') : true;
		}
		catch {
			ok = true; // 无法弹确认时不阻断(退化为直接执行)
		}
		if (ok) {
			void this.retranslateAll();
		}
	}

	/**
	 * 「更多」菜单「清除本文缓存」(2.3.0, 第四批 item2 · WF-1): 清本文档全部
	 * 页面+段落缓存但**不重译**(隐私/磁盘用途)—— 屏幕上已显示的译文保留在
	 * 内存,下次打开才重新翻译。与「重译…」菜单里的「清缓存重译全文」互补,
	 * 同样破坏性、同样先确认。
	 */
	private confirmClearDocCache(): void {
		let ok = true;
		try {
			const prompt = (Services as unknown as { prompt?: { confirm(parent: unknown, title: string, text: string): boolean } }).prompt;
			const win = (Zotero as unknown as { getMainWindow?(): unknown }).getMainWindow?.() ?? null;
			ok = prompt ? prompt.confirm(win, getString('papermirror-clear-cache'),
				'将删除本文档已缓存的全部译文(不影响当前屏幕显示;下次打开需重新翻译)。确定继续?') : true;
		}
		catch {
			ok = true;
		}
		if (!ok) {
			return;
		}
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return;
		}
		void cacheManager.clearAttachmentAllVersions(item.key)
			.then(() => this.flashNotice(getString('papermirror-toast-cache-cleared')))
			.catch((e) => {
				logger.warn(MODULE, 'clearDocCache failed', e);
				this.pushFailure(getString('papermirror-status-error'));
			});
	}

	/** Capsule 取消: stop the current page's translation and mark it cancelled. */
	private cancelCurrentTranslation(): void {
		const page = adapter.getCurrentPageIndex(this.reader);
		this.manager?.cancelPage(page);
		this.compressPending.delete(page);
		this.compressBlocked.delete(page);
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
		this.compressBlocked.clear();
		this.pageProviderOffset.clear();
		// 先等所有在飞任务真正解绕再清盘 (2.0.7, 审核 P2-3): resetAll() 只发
		// abort 不等待,被 abort 的任务要到下一个检查点才退出,其 persistPartial
		// 会把已完成段落 enqueue 落盘 —— 落在 clearAttachmentAllVersions 之后时,
		// 用户明确要求丢弃的译文复活,并被紧接着的 normal 运行当段落命中复用,
		// 「强制全量」不成立。resetAllAndWait 与 quiesceThenReconfigure 同构。
		await this.manager.resetAllAndWait();
		if (this.destroyed) {
			return;
		}
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
	 * counts, keep-origin reasons) → clipboard as JSON.
	 *
	 * 硬性不变量: NO source text, NO translations, NO keys (审核 P0-2)。
	 * 1.1.7 曾把「语料」并进这个按钮,于是一个叫「诊断」的动作会把整页原文
	 * 放进剪贴板 —— 用户在「提交诊断」的心智下不会预期这一点,粘进 issue 就
	 * 等于公开了未发表稿件。语料已拆回独立的「语料」按钮 (copyLayoutCorpus),
	 * 那个按钮的名字与提示都明说含原文,导出动作本身即知情授权。
	 */
	private async copyDiagnostics(): Promise<void> {
		if (!this.manager) {
			return;
		}
		try {
			// 引擎自检 (2.3.0, 第四批 item2 · WF-2): 随诊断产出每个已启用引擎的
			// 配置健康度 —— 纯本地检查(密钥是否已配、端点主机、模型、熔断轮换
			// 次数),**不发任何网络请求**,也绝不含密钥本体。
			const engines: Record<string, unknown>[] = [];
			const ids = this.pool.length ? this.pool : [getPref<string>('provider', 'bing-free')];
			for (const id of ids) {
				try {
					const s = await this.providerSettingsFor(id);
					let host = '';
					try {
						host = s.apiBaseURL ? new URL(s.apiBaseURL).host : '';
					}
					catch {
						host = '(invalid URL)';
					}
					engines.push({
						id,
						model: s.model || '(default)',
						endpointHost: host,
						keyConfigured: !!s.apiKey,
						requiresKey: !!getProvider(id)?.requiresApiKey
					});
				}
				catch (e) {
					engines.push({ id, selfCheckError: e instanceof Error ? e.message : String(e) });
				}
			}
			const payload = {
				plugin: 'PaperMirror',
				generatedAt: new Date().toISOString(),
				engines,
				// 会话内熔断/手动轮换过的页数(>0 说明有引擎不稳被换过)。
				engineRotations: this.pageProviderOffset.size,
				...(this.manager.exportDiagnostics() as Record<string, unknown>),
				// 几何安全复核结果 (1.1.2 诊断闭环): 页号 → 违例/调整/保留计数。
				geometryAudits: [...this.geometryAudits.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([page, r]) => ({ page: page + 1, ...r })),
				// 放置统计全类目 (P3, 2.0.10): committed 之外的「有意保留」口径
				// (imageExcluded/tooSmall/tableIntentional) 显式可见 —— 图像准入
				// 阈值收紧 (P2-15) 后误拒面变大能在这里被发现。纯计数,无文本。
				placement: [...this.placementStats.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([page, p]) => ({ page: page + 1, ...p })),
				// Placement 探针 (审核: 封面标题空洞): 每块 base 位图/遮罩取样。
				// baseInk=false → 底图就没画这些字 (独立 page.render 的字形/时序缺口,
				// 放弃兜底无原文可露); baseInk=true & maskOpaque 且非 committed →
				// 遮罩误盖真原文。只几何+布尔,无文本。
				placementProbe: [...this.placementProbe.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([page, rows]) => ({ page: page + 1, blocks: rows }))
			};
			Components.classes['@mozilla.org/widget/clipboardhelper;1']
				.getService(Components.interfaces.nsIClipboardHelper)
				.copyString(JSON.stringify(payload, null, 2));
			this.flashNotice('诊断已复制(仅脱敏指标;不含原文、译文与密钥)');
		}
		catch (e) {
			logger.warn(MODULE, 'diagnostics copy failed', e);
		}
	}

	/**
	 * 布局语料导出 (独立动作, 审核 P0-2): 当前页文本层 span → dump-spans 同格式
	 * JSON 进剪贴板,供回归测试语料与版面排障使用。
	 *
	 * 与「诊断」的区别必须对用户可见: 这份 JSON **含本页原文文本与坐标**,
	 * 所以按钮叫「语料」、提示明说含原文、复制后的 toast 再提醒一次。
	 * 仍然不含译文,也不含密钥。
	 */
	private copyLayoutCorpus(): void {
		try {
			const corpus = this.layoutCorpus();
			if (!corpus) {
				this.flashNotice('当前页没有可导出的文本层语料');
				return;
			}
			const payload = {
				plugin: 'PaperMirror',
				generatedAt: new Date().toISOString(),
				note: 'CONTAINS SOURCE TEXT of the current page (layout corpus for regression tests).',
				currentPageCorpus: corpus
			};
			Components.classes['@mozilla.org/widget/clipboardhelper;1']
				.getService(Components.interfaces.nsIClipboardHelper)
				.copyString(JSON.stringify(payload, null, 2));
			this.flashNotice('语料已复制 —— 含本页原文,分享前请确认可公开');
		}
		catch (e) {
			logger.warn(MODULE, 'corpus copy failed', e);
		}
	}

	/**
	 * 术语表出口 (1.1.2, 参照 BabelDOC automatic_term_extractor 的思想做成
	 * 增量形态): docMemory 边翻边学的「术语(ABBR)」对 → TSV 进剪贴板,
	 * 用户可直接粘贴进词汇表或表格里编辑。
	 */
	/** 上次「保存术语到词汇表」前的快照 —— 一键撤销 (2.3.1, item3 · WF-8)。 */
	private glossaryUndo: { json: string; added: number } | null = null;

	private copyTermsTsv(terms: { source: string; target: string }[]): void {
		try {
			const tsv = terms.map(t => `${t.source}\t${t.target}`).join('\n');
			Components.classes['@mozilla.org/widget/clipboardhelper;1']
				.getService(Components.interfaces.nsIClipboardHelper)
				.copyString(tsv);
			this.flashNotice(`已复制 ${terms.length} 条术语对照(TSV)`);
		}
		catch (e) {
			logger.warn(MODULE, 'term table copy failed', e);
		}
	}

	/**
	 * 「术语」名称与行为统一 (2.3.1, 计划 第四批 item3 · WF-8): 不再只复制 TSV,
	 * 而是**预览并保存到词汇表** —— 与既有词汇表去重、确认框预览、保存为
	 * 'suggested'(参考,不强制模型)、支持一键撤销;「编辑」在设置页词汇表
	 * 编辑器闭环。确认框如实提示: 词汇表是译文身份的一部分(glossaryHash 入
	 * 缓存键),保存会使本篇已缓存译文在下次打开时按新术语重译。
	 * 「仅复制 TSV」保留为确认框第二按钮(旧行为不丢)。
	 */
	private previewSaveLearnedTerms(): void {
		const terms = this.manager?.learnedTerms() ?? [];
		if (!terms.length) {
			this.flashNotice('本篇尚未学得术语对(翻译几页后再试)');
			return;
		}
		const existingJson = getPref<string>('glossaryGlobal', '[]');
		const existing = parseGlossaryJSON(existingJson);
		// 去重: 先对既有词汇表,再对本篇自身(纯函数,单测覆盖)。
		const fresh = dedupeLearnedTerms(existing, terms);
		const prompt = (Services as unknown as {
			prompt?: {
				confirm(parent: unknown, title: string, text: string): boolean;
				confirmEx?(parent: unknown, title: string, text: string, flags: number,
					b0: string | null, b1: string | null, b2: string | null,
					check: string | null, state: { value: boolean }): number;
			};
		}).prompt;
		const win = (Zotero as unknown as { getMainWindow?(): unknown }).getMainWindow?.() ?? null;
		if (!fresh.length) {
			// 全部已在词汇表 → 提供撤销上次保存(若有)。
			if (this.glossaryUndo && prompt?.confirm) {
				const undo = this.glossaryUndo;
				if (prompt.confirm(win, '术语已全部在词汇表中',
					`本篇学得的 ${terms.length} 条术语已全部在词汇表中。撤销上次保存的 ${undo.added} 条?`)) {
					setPref('glossaryGlobal', undo.json);
					this.glossaryUndo = null;
					this.flashNotice(`已撤销上次保存的 ${undo.added} 条术语`);
				}
			}
			else {
				this.flashNotice(`本篇学得的 ${terms.length} 条术语已全部在词汇表中(设置 → 词汇表可编辑)`);
			}
			return;
		}
		const PREVIEW_MAX = 12;
		const previewLines = fresh.slice(0, PREVIEW_MAX).map(t => `${t.source} → ${t.target}`);
		if (fresh.length > PREVIEW_MAX) {
			previewLines.push(`…等共 ${fresh.length} 条`);
		}
		const text = `本篇新学得 ${fresh.length} 条术语(已与词汇表现有 ${existing.length} 条去重):\n\n`
			+ previewLines.join('\n')
			+ '\n\n保存为「参考」术语(不强制模型);可在设置 → 词汇表中编辑,再点一次「术语」可撤销。'
			+ '\n注意:词汇表变化会使本篇已缓存译文在下次打开时按新术语重译。';
		let choice = 0; // 0=保存 1=仅复制TSV 2=取消
		try {
			if (prompt?.confirmEx) {
				// STD flags: (BUTTON_TITLE_IS_STRING=127) 每键位 <<0/8/16。
				const IS_STRING = 127;
				choice = prompt.confirmEx(win, '保存术语到词汇表', text,
					IS_STRING | (IS_STRING << 8) | (IS_STRING << 16),
					'保存到词汇表', '仅复制 TSV', '取消', null, { value: false });
			}
			else if (prompt?.confirm) {
				choice = prompt.confirm(win, '保存术语到词汇表', text) ? 0 : 2;
			}
		}
		catch {
			choice = 2; // 无法弹框时不做破坏性动作
		}
		if (choice === 1) {
			this.copyTermsTsv(terms);
			return;
		}
		if (choice !== 0) {
			return;
		}
		this.glossaryUndo = { json: existingJson, added: fresh.length };
		const merged = [...existing, ...fresh.map(t => ({ source: t.source, target: t.target, mode: 'suggested' as const }))];
		setPref('glossaryGlobal', serializeGlossary(merged));
		this.flashNotice(`已保存 ${fresh.length} 条术语到词汇表(设置中可编辑;再点「术语」可撤销)`);
	}

	/**
	 * 布局语料一键导出 (1.1.6): 当前页文本层 span → dump-spans 同格式 JSON
	 * 进剪贴板,免终端。注意与「诊断」不同:语料含本页原文文本与坐标(回归
	 * 测试需要),导出动作本身即用户授权;不含译文、不含密钥。
	 */
	private layoutCorpus(): unknown {
		try {
			const pageIndex = adapter.getCurrentPageIndex(this.reader);
			const page = adapter.getTextLayerItems(this.reader, pageIndex);
			if (!page || !page.items.length) {
				return null;
			}
			return {
				source: adapter.getReaderItem(this.reader)?.getDisplayTitle?.() ?? 'document',
				page: pageIndex + 1,
				pageWidth: page.pageWidth,
				pageHeight: page.pageHeight,
				items: page.items.map(i => ({ text: i.text, rect: i.rect, ...(i.fontSize ? { fontSize: i.fontSize } : {}) }))
			};
		}
		catch (e) {
			logger.warn(MODULE, 'corpus export failed', e);
			return null;
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
		if (this.identityRestartTimer !== null) {
			clearTimeout(this.identityRestartTimer);
			this.identityRestartTimer = null;
		}
		for (const id of this.identityPrefObservers) {
			try {
				unregisterPrefObserver(id);
			}
			catch { /* already gone */ }
		}
		this.identityPrefObservers = [];
		for (const timer of this.taskHideTimers.values()) {
			clearTimeout(timer);
		}
		this.taskHideTimers.clear();
		this.tasks.clear();
		this.translatedPages.clear();
		this.lastPartial = null;
		this.compressBlocked.clear(); // P2-10: 不再持有已卸载页元素
		this.placementStats.clear();
		this.baseBitmaps.clear(); // 释放缓存的底图 canvas
		this.disposePdfEvents?.();
		this.disposePdfEvents = null;
		this.disposeVisibility?.();
		this.disposeVisibility = null;
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
