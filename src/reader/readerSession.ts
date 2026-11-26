import { contextualSourceText } from '../translation/sourceContinuity';
import { ContinuationUnitStore } from '../translation/continuationUnitStore';
import { idleProgressFor, ROTATED_TABLE_NOTE } from '../ui/statusCapsule';
import { temporaryPageArchive, pageContentKey } from '../export/pageArchive';
import { showUnplacedTranslations } from '../ui/unplacedTranslations';
/**
 * Per-reader-tab session: split view + pane + extraction + translation +
 * sync + notes, with complete teardown.
 */

import * as cacheManager from '../cache/cacheManager';
import { hashSourceTexts, type CacheKeyParts, type SegmentContextParts } from '../cache/cacheSchema';
import { buildAttachmentSelectURI, saveExplanationNote } from '../notes/noteService';
import { getApiKey, providersWithSavedKeys } from '../security/credentialStore';
import { configuredProviderIds } from '../translation/providerAvailability';
import { registerUrlCredentials } from '../security/logSanitizer';
import { getProvider, listProviders } from '../translation/providers/registry';
import {
	buildPool,
	pickProviderForPage,
	routeProviderForPage,
	fastestProvider,
	rankProvidersForPage,
	poolLanePlan,
	prefetchWindowFor,
	normalizePerfMode,
	normalizeGlobalMax,
	DEFAULT_PERF_MODE,
	GLOBAL_MAX_DEFAULT,
	type ProviderCapability
} from '../translation/providerPool';
import { endpointHost } from '../translation/providers/types';
import { type ExplanationSection } from '../translation/explainer';
import {
	TranslationManager,
	type ManagerEvents,
	type PageTranslationState,
	type TranslateHooks,
	type TranslationDeps
} from '../translation/translationManager';
import { PROMPT_VERSION } from '../translation/promptBuilder';
import { PageLedger } from './pageLedger';
import { joinPlacementOutcome } from './diagnosticsJoin';
import { type EngineExportRow } from '../export/endpointKind';
import type { DiagnosticsExportSource } from '../export/diagnosticsJsonl';
import type { CorpusExportSource, TranslationSource, TranslationMissing } from '../export/corpusJsonl';
import { ExportStageError } from '../export/diagnosticsJsonl';
import { type ExportKind } from '../export/exportNaming';
import { stageLabel, type PickerHandle } from '../export/fileSink';
import { parseGlossaryJSON } from '../translation/glossary';
import { parseProviderProfiles, effectiveProviderConfig } from '../translation/providerProfiles';
import type {
	GlossaryRule,
	ProviderSettings,
	SourceBlock,
	TranslatedBlock,
	TranslationRequest,
	TranslationResponse
} from '../types/models';
import { PaperMirrorError } from '../types/models';
import { TranslationPane, type PageRenderResult, type PaneStrings } from '../ui/translationPane';
import { buildOriginalPage } from '../ui/translatedPageView';
import { buildStrictPage, settleStrictPage, placementTally, flashKeptIndicator, type UnfitBlock } from '../ui/strictPageReplacement';
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
import { type AutoExplanationWatcher } from './autoExplainSelection';
import {
	corpusExportSource,
	diagnosticsExportSource,
	copyDiagnostics,
	corpusTranslations,
	pageSpans,
	copyLayoutCorpus,
	runExportInner,
	resolveSavePath,
	createSavePicker,
	confirmCorpusPrivacy,
	engineSelfCheck,
	type SessionExportView
} from './sessionExports';
import { saveSelectionToNote, previewSaveLearnedTerms, copyTermsTsv, copyExplanation, type SessionNotesView } from './sessionNotes';
import { exportTranslatedPdf, exportBuiltin, type SessionPdfExportView } from './sessionPdfExport';
import {
	runStrictCompress,
	resolveStrictUnfit,
	reportPlacement,
	collectPlacementDiagnostics,
	auditFinalGeometry,
	auditPartialGeometry,
	type PlacementReportingView
} from './placementReporting';
import { explainSelection, watchAutomaticExplanation, type SessionExplanationsView } from './sessionExplanations';

const MODULE = 'readerSession';

/**
 * 页底图缓存的像素预算 (2.5.3)。16M 像素 ≈ 64MB @4B/px —— 比原来「4 条 ×
 * 最坏 3.2M px」的 ~50MB 略高,但换来的是回看命中率:窄栏/中等缩放下一张
 * 底图往往只有 1–2M 像素,同样的内存能多存一倍以上的页。
 */
const BASE_BITMAP_PIXEL_BUDGET = 16_000_000;

/**
 * 立刻释放 canvas 的后备存储 —— 把宽高清零比等 GC 回收几十 MB 的位图靠谱。
 * 只对我们自己 rasterize 出来的独立底图调用;左视图的 live canvas 从不入缓存。
 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
	try {
		canvas.width = 0;
		canvas.height = 0;
	}
	catch {
		// canvas 已被文档丢弃: 无所谓,GC 会收
	}
}
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
		privacyAccept: getString('papermirror-privacy-accept'),
		// 2.10.0: 这几条原先是 translationPane.ts 里写死的简体中文,
		// en-US 与 zh-TW 用户同样看到简体。
		switchLanguage: getString('papermirror-switch-language'),
		switchProvider: getString('papermirror-switch-provider'),
		terms: getString('papermirror-terms'),
		termsTip: getString('papermirror-terms-tip'),
		more: getString('papermirror-more'),
		configureProvider: getString('papermirror-configure-provider'),
		configureProviderTip: getString('papermirror-configure-provider-tip')
	};
}

/** Human display name for a language code (for the header pill). */
function languageLabel(code: string): string {
	switch (code) {
		case 'en': return 'English';
		case 'zh': case 'zh-CN': return '简体中文';
		case 'zh-TW': return '繁體中文';
		case 'ja': return '日本語';
		case 'ko': return '한국어';
		case 'de': return 'Deutsch';
		case 'fr': return 'Français';
		case 'es': return 'Español';
		case 'ru': return 'Русский';
		case 'auto': return getString('papermirror-lang-auto');
		default: return code;
	}
}

/**
 * 用户不译词表 (首选项 noTranslateList,每行一条,# 开头为注释,≥2 字)。
 * 2.7.8 起三处共用: 提示词掩蔽、抽取期表格短格证据、严格排版期表格短格证据。
 */
function readNoTranslateList(): string[] {
	return String(getPref<string>('noTranslateList', '') ?? '')
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(l => l.length >= 2 && !l.startsWith('#'));
}

export class ReaderSession {
	private reader: ReaderLike;
	private onClosed: () => void;
	private split: SplitViewHandles | null = null;
	private pane: TranslationPane | null = null;
	private extractor: TextExtractor;
	/** 5.1: the read-only view the sessionExports functions get (a getter, so it also exists on sessions built without the constructor). */
	private get exportView(): SessionExportView {
		const self = this;
		return {
			get abandonedBlocks() { return self.abandonedBlocks; },
			get cacheKey() { return self.cacheKey.bind(self); },
			get exportPins() { return self.exportPins; },
			get extractor() { return self.extractor; },
			get flashNotice() { return self.flashNotice.bind(self); },
			get geometryAudits() { return self.geometryAudits; },
			get layoutCorpus() { return self.layoutCorpus.bind(self); },
			get manager() { return self.manager; },
			get pageArchive() { return self.pageArchive; },
			get pageProviderOffset() { return self.pageProviderOffset; },
			get pane() { return self.pane; },
			get placementProbe() { return self.placementProbe; },
			get placementStats() { return self.placementStats; },
			get pool() { return self.pool; },
			get providerSettingsFor() { return self.providerSettingsFor.bind(self); },
			get reader() { return self.reader; },
			get revealFn() { return self.revealFn.bind(self); },
			get viewMode() { return self.viewMode; },
			get corpusExportSource() { return self.corpusExportSource.bind(self); },
			get diagnosticsExportSource() { return self.diagnosticsExportSource.bind(self); },
			get copyDiagnostics() { return self.copyDiagnostics.bind(self); },
			get corpusTranslations() { return self.corpusTranslations.bind(self); },
			get pageSpans() { return self.pageSpans.bind(self); },
			get copyLayoutCorpus() { return self.copyLayoutCorpus.bind(self); },
			get runExportInner() { return self.runExportInner.bind(self); },
			get resolveSavePath() { return self.resolveSavePath.bind(self); },
			get createSavePicker() { return self.createSavePicker.bind(self); },
			get confirmCorpusPrivacy() { return self.confirmCorpusPrivacy.bind(self); },
			get engineSelfCheck() { return self.engineSelfCheck.bind(self); }
		};
	}
	/** 5.1: the view the sessionNotes functions get (a getter, so it also exists on instances built without the constructor). */
	private get notesView(): SessionNotesView {
		const self = this;
		return {
			get flashNotice() { return self.flashNotice.bind(self); },
			get glossaryUndo() { return self.glossaryUndo; },
			set glossaryUndo(value) { self.glossaryUndo = value; },
			get lastExplanation() { return self.lastExplanation; },
			get manager() { return self.manager; },
			get pane() { return self.pane; },
			get pushFailure() { return self.pushFailure.bind(self); },
			get reader() { return self.reader; },
			get saveSelectionToNote() { return self.saveSelectionToNote.bind(self); },
			get previewSaveLearnedTerms() { return self.previewSaveLearnedTerms.bind(self); },
			get copyTermsTsv() { return self.copyTermsTsv.bind(self); },
			get copyExplanation() { return self.copyExplanation.bind(self); }
		};
	}
	/** 5.1: the view the sessionPdfExport functions get (a getter, so it also exists on instances built without the constructor). */
	private get pdfExportView(): SessionPdfExportView {
		const self = this;
		return {
			get exportingPdf() { return self.exportingPdf; },
			set exportingPdf(value) { self.exportingPdf = value; },
			get flashNotice() { return self.flashNotice.bind(self); },
			get manager() { return self.manager; },
			get pushExport() { return self.pushExport.bind(self); },
			get reader() { return self.reader; },
			get setCapsuleCollapsed() { return self.setCapsuleCollapsed.bind(self); },
			get startTranslating() { return self.startTranslating.bind(self); },
			get waitForPage() { return self.waitForPage.bind(self); },
			get exportTranslatedPdf() { return self.exportTranslatedPdf.bind(self); },
			get exportBuiltin() { return self.exportBuiltin.bind(self); }
		};
	}
	/** 5.1: the view the placementReporting functions get (a getter, so it also exists on instances built without the constructor). */
	private get placementView(): PlacementReportingView {
		const self = this;
		return {
			get abandonedBlocks() { return self.abandonedBlocks; },
			get archivePage() { return self.archivePage; },
			get compressRounds() { return self.compressRounds; },
			get destroyed() { return self.destroyed; },
			get geometryAudits() { return self.geometryAudits; },
			get lastPartial() { return self.lastPartial; },
			set lastPartial(value) { self.lastPartial = value; },
			get ledger() { return self.ledger; },
			get manager() { return self.manager; },
			get pageNote() { return self.pageNote.bind(self); },
			get placementKeys() { return self.placementKeys; },
			get placementProbe() { return self.placementProbe; },
			get placementStats() { return self.placementStats; },
			get providerForPage() { return self.providerForPage.bind(self); },
			get pushOverlayProgress() { return self.pushOverlayProgress.bind(self); },
			get reader() { return self.reader; },
			get renderToken() { return self.renderToken; },
			get translatedPages() { return self.translatedPages; },
			get runStrictCompress() { return self.runStrictCompress.bind(self); },
			get resolveStrictUnfit() { return self.resolveStrictUnfit.bind(self); },
			get reportPlacement() { return self.reportPlacement.bind(self); },
			get collectPlacementDiagnostics() { return self.collectPlacementDiagnostics.bind(self); },
			get auditFinalGeometry() { return self.auditFinalGeometry.bind(self); },
			get auditPartialGeometry() { return self.auditPartialGeometry.bind(self); }
		};
	}
	/** 5.1: the view the sessionExplanations functions get (a getter, so it also exists on instances built without the constructor). */
	private get explanationsView(): SessionExplanationsView {
		const self = this;
		return {
			get assertProviderEndpointAllowed() { return self.assertProviderEndpointAllowed.bind(self); },
			get autoExplainPrefObserver() { return self.autoExplainPrefObserver; },
			set autoExplainPrefObserver(value) { self.autoExplainPrefObserver = value; },
			get destroyed() { return self.destroyed; },
			get disposeAutoExplain() { return self.disposeAutoExplain; },
			set disposeAutoExplain(value) { self.disposeAutoExplain = value; },
			get disposeOriginalDoubleClick() { return self.disposeOriginalDoubleClick; },
			set disposeOriginalDoubleClick(value) { self.disposeOriginalDoubleClick = value; },
			get explainCache() { return self.explainCache; },
			get explanationIsAutomatic() { return self.explanationIsAutomatic; },
			set explanationIsAutomatic(value) { self.explanationIsAutomatic = value; },
			get explanationRequest() { return self.explanationRequest; },
			set explanationRequest(value) { self.explanationRequest = value; },
			get isWindowHidden() { return self.isWindowHidden.bind(self); },
			get lastExplanation() { return self.lastExplanation; },
			set lastExplanation(value) { self.lastExplanation = value; },
			get localOnlyPrefObserver() { return self.localOnlyPrefObserver; },
			set localOnlyPrefObserver(value) { self.localOnlyPrefObserver = value; },
			get manager() { return self.manager; },
			get pane() { return self.pane; },
			get providerEndpointAllowed() { return self.providerEndpointAllowed.bind(self); },
			get providerSettings() { return self.providerSettings.bind(self); },
			get reader() { return self.reader; },
			get resolveLanguages() { return self.resolveLanguages.bind(self); },
			get viewMode() { return self.viewMode; },
			get explainSelection() { return self.explainSelection.bind(self); },
			get watchAutomaticExplanation() { return self.watchAutomaticExplanation.bind(self); }
		};
	}
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
	private disposePdfScrollIntent: (() => void) | null = null;
	/** 2.9.2: 只订阅 `textlayerrendered` —— 释放过的页在这一刻被捡回来。 */
	private disposeTextLayerEvents: (() => void) | null = null;
	/** visibilitychange 监听的解除器 (2.2.9, item1 不可见即停)。 */
	private disposeVisibility: (() => void) | null = null;
	/** 2.10.0: 主题变更订阅 —— 开着窗格切主题时窗格要跟着变。 */
	private disposeTheme: (() => void) | null = null;
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
	/** 5.0: the single source of truth for per-page state (see pageLedger.ts). */
	private readonly ledger = new PageLedger<HTMLElement, UnfitBlock>();
	/** Real image rects per page (operator list), fetched once per document. */
	private imageRects = this.ledger.view<[number, number, number, number][] | null>('imageRects');
	/**
	 * 底图位图 LRU (2.2.5, 计划 第三批 item6 · PF-4): 缓存 renderPageBitmap 得到的
	 * 独立底图,键 = `${page}@${宽度桶}`。切换页/回看/在原宽度重渲染时命中即复用
	 * 底图,buildStrictPage 只重建遮罩+文本层,省掉最贵的 pdf.js 整页 rasterize。
	 * 底图只随 (页, 宽度) 变,与译文/配置无关 → 无需失效,仅靠容量淘汰与 dispose。
	 *
	 * 按像素计容 (2.5.3): 原来按**条数**取 4 —— 上限只能照最坏的一张定
	 * (整页 ~3.2M px ≈ 13MB × 4 ≈ 50MB),于是窄栏那种一张只有几十万像素的
	 * 情形也只敢存 4 张。往回翻超过 4 页必然落空,要整页重新 rasterize
	 * (getPage 轮询 5s + 渲染 12s 的预算),回看时先转一会儿圈才出译文。
	 * 现在预算 = 16M 像素(≈64MB @4B/px):最坏情形 5 张,常见的窄栏/中等
	 * 缩放下 7–10 张,内存上界反而比原来更可控。淘汰即把 canvas 尺寸清零,
	 * 不等 GC。
	 */
	private baseBitmaps = new LruCache<PageRender>(
		BASE_BITMAP_PIXEL_BUDGET,
		(_key, render) => releaseCanvas(render.canvas),
		(render) => Math.max(1, render.canvas.width * render.canvas.height)
	);
	/** 讲解结果缓存 (2.3.5, item7 · API-8): 段落+引擎/模型/语言 → 解析节。 */
	private explainCache = new LruCache<ExplanationSection[]>(20);
	private disposeAutoExplain: AutoExplanationWatcher | null = null;
	private disposeOriginalDoubleClick: (() => void) | null = null;
	private autoExplainPrefObserver: symbol | string | null = null;
	private localOnlyPrefObserver: symbol | string | null = null;
	private explanationRequest: AbortController | null = null;
	private explanationIsAutomatic = false;
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
	// 5.0: compress in-flight / turned-away renders live in the page ledger's
	// state machine (beginCompress / deferRender / releaseCompress / endCompress).
	/**
	 * 被 compressPending 挡回的最近一次 settle (2.0.9, 审核 P2-10)。压缩请求
	 * 可飞 120s,期间页面因缩放/更新重渲染 —— 新渲染的 resolveStrictUnfit 被
	 * 入口闸挡回后此前**无人接力**: 不 shrink、不 revert、不 reportPlacement,
	 * 未适配块永远保持英文且不计 kept,胶囊停在「正在适配排版」。现在挡回时
	 * 记下待办,在飞压缩的 finally 里续跑(只保留最新一次;旧 token 由 live()
	 * 自然拦截)。
	 */
	/** 扫描/纯图页每页只提示一次。 */
	private scannedNoticeShown = this.ledger.flag('scannedNoticeShown');
	/** 排版失败提示每页只弹一次 (2.5.2) —— 这条路径现在会自动重试。 */
	private strictFailNoticeShown = this.ledger.flag('strictFailNoticeShown');
	/** 几何安全复核结果按页留档(进诊断导出;只计数,无文本)。 */
	private geometryAudits = this.ledger.view<import('../ui/strictPageReplacement').GeometryAuditResult>('geometryAudits');
	/** 每页最近一次 placement 统计 (2.0.10, 审核 P3): imageExcluded 等
	 *  「有意保留」类目此前不进任何诊断 —— 阈值收紧后该类目变大也无从发现。 */
	private placementStats = this.ledger.view<import('../ui/strictPageReplacement').StrictPageStats>('placementStats');
	/** 每页 placement 探针 (审核: 封面标题空洞定位): 每块的 base 位图/遮罩取样
	 *  (baseInk/maskOpaque),分辨「底图缺字」与「遮罩误盖」。只几何+布尔,无文本。 */
	private pageArchive = temporaryPageArchive();
 private continuationUnits = new ContinuationUnitStore();
 private placementKeys = this.ledger.view<string>('placementKeys');
	private placementProbe = this.ledger.view<import('../ui/strictPageReplacement').StrictProbeRow[]>('placementProbe');
	/** 放弃清单 (2.7.0, 审核 B-1): 页索引 → 放弃块 id + 原因枚举串,无文本。 */
	private abandonedBlocks = this.ledger.view<import('../ui/strictPageReplacement').AbandonedBlock[]>('abandonedBlocks');
	/**
	 * 导出中的逐页短时保护 (2.8.6, 导出方案 P1)。
	 *
	 * 导出器读某页之前把它放进来、读完立刻拿掉,`isPageInUse` 因而在这一瞬间
	 * 报"在用",2.8.3 的淘汰就不会正好在这时把它卸掉。**不是全局暂停淘汰** ——
	 * 那样长文档导出时内存会一路上涨,把第四批省下来的又吃回去。
	 */
	private exportPins = this.ledger.flag('exportPins');
	/**
	 * Per-page render generation. Bumped at the start of every renderDocPage;
	 * an async render (or its settle/compress callbacks) that discovers a newer
	 * generation for its page aborts instead of overwriting the live slot — no
	 * stale render can flash an old page in after a newer one has been shown.
	 */
	private renderToken = this.ledger.view<number>('renderToken');
	/**
	 * 刷新-driven engine rotation. With a provider pool active, hitting 刷新 on
	 * a page bumps its offset so the RE-translation is dealt to the NEXT
	 * engine in the pool — a page that came out poorly on one service gets a
	 * genuinely different translator, not the same one again.
	 */
	private pageProviderOffset = this.ledger.view<number>('pageProviderOffset');
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
	private translatedPages = this.ledger.flag('translatedPages');
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
			if (offset === 0) {
				// 2.12.0 按实测速度加权分页。真机实测同一篇文档里
				// google-free 约 6000 字符/秒、gemini 约 200 —— 等额分页会让
				// 慢的那家连着吃掉一整段连续阅读。权重来自**本会话自己的测量**
				// (只计成功请求),样本不足时全是 1,行为与 2.11.2 完全一致。
				//
				// 只在 offset === 0 时加权:offset 非零意味着熔断/手动轮换正在
				// 让这一页退让,那时要的是"下一名"这个确定的序,不是重新按权重挑。
				// 5.0: 当前页给最快的引擎,临近页避开慢引擎(routeProviderForPage)。
				return routeProviderForPage(this.pool, pageIndex,
					this.manager?.currentPageIndex() ?? pageIndex, this.manager?.providerThroughput() ?? {});
			}
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
			includeReferences: getPref<boolean>('translateReferences', true),
			noTranslate: () => readNoTranslateList()
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

		const pane = this.createPaneAndOverlay(this.split, title);

		this.sync = createSyncController({
			scrollPaneToPage: pageIndex => this.pane?.scrollToPage(pageIndex),
			scrollPaneToPosition: (pageIndex, fraction) => this.pane?.setPdfScrollFraction(pageIndex, fraction),
			scrollPdfToPosition: (pageIndex, fraction) => { adapter.setPageScrollFraction(this.reader, pageIndex, fraction); },
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

		// 5.0: 全篇样式在后台先开算(逐页轻量读文字),与首页渲染并行;
		// 首次抽取最多等它 6 秒。
		void this.extractor.ensureDocumentStyle();
		await this.extractor.prime();
		if (this.destroyed) {
			return; // 同上: prime 期间被销毁,后续注册一律不做
		}
		this.watchAutomaticExplanation();

		if (!await this.showPrivacyOrStart(this.split, pane)) {
			return;
		}

		this.subscribePdfEvents();

		this.installIdentityPrefObservers();
		this.startPolling();
		logger.info(MODULE, `Session opened for tab ${this.reader.tabID}`);
	}

	/** open() 拆出: 建译文面板与覆盖层,接好回调、主题、偏好与引擎菜单。 */
	private createPaneAndOverlay(split: SplitViewHandles, title: string): TranslationPane {
		this.pane = new TranslationPane(split.paneHost, title || 'PDF', paneStrings(), {
			onExplainBlock: (pageIndex, blockId) => {
				const state = this.manager?.getPageState(pageIndex);
				const source = state?.blocks.find(b => b.id === blockId)?.sourceText ?? '';
				void this.explainSelection(source);
			},
			onCopyExplanation: () => this.copyExplanation(),
			onDismissExplanation: () => {
				this.explanationRequest?.abort();
				this.explanationRequest = null;
				this.disposeAutoExplain?.suppressCurrentSelection();
			},
			onSaveExplanationNote: () => void this.saveExplanationToNote(),
			// 菜单栏「解析」: explains the current PDF selection, or the
			// highlighted 译文 block, or asks the reader to select text first.
			onExplainSelection: () => void this.explainSelection(),
			onToggleSync: enabled => this.setSyncEnabled(enabled),
			onRetranslate: () => this.confirmClearCacheRetranslate(), // 菜单栏刷新按钮「清缓存重译全文」= 破坏性,先确认
			onRefreshPage: () => void this.retranslateCurrent(), // 胶囊圆环 = 修复本页 (只补缺,不换引擎不清合格缓存)
			onCancelPage: () => this.cancelCurrentTranslation(), // 胶囊取消 = 停止翻译
			onViewPartial: () => this.viewKeptOriginal(), // 胶囊「查看保留原文」= 定位保留段落
			onDismiss: () => this.dismissTopTask(), // 胶囊 × = 关闭当前通知
			onCollapsedChange: (c) => this.setCapsuleCollapsed(c), // 折叠状态由会话统一管理
			onSaveNote: () => void this.saveSelectionToNote(),
			onShowDiagnostics: () => void this.copyDiagnostics(),
			onCopyCorpus: () => this.copyLayoutCorpus(),
			onExportDiagnosticsFile: () => void this.runExport('diagnostics'),
			onExportCorpusFile: () => void this.runExport('corpus'),
			onSaveTerms: () => this.previewSaveLearnedTerms(), // 2.3.1 item3: 预览并保存到词汇表(不再只复制 TSV)
			onExportPdf: () => void this.exportTranslatedPdf(), // 菜单栏「导出」(2.3.8 从「更多」搬回工具条)
			onOpenSettings: () => this.openSettings(),
			onToggleViewKind: kind => this.applyPaneViewKind(kind, { persist: true }),
			onPickLanguages: (source, target) => this.applyLanguagePick(source, target),
			onPickProvider: providerId => this.applyProviderPick(providerId),
			loadProviderChoices: () => this.configuredProviderChoices(),
			onClose: () => this.close(),
			onSwapSides: () => this.swapSides(),
			onBlockClick: (pageIndex, _blockId) => this.sync?.onPaneNavigated(pageIndex),
			onScrolledToPage: pageIndex => this.sync?.onPaneNavigated(pageIndex),
			onScrollIntent: () => this.sync?.guard.takeControl('pane'),
			onScrollPosition: (pageIndex, fraction) => this.sync?.onPanePositionChanged(pageIndex, fraction),
			onAcceptPrivacy: () => {
				setPref('privacyNoticeAccepted', true);
				this.applyViewMode();
				this.startTranslating();
			}
		});
		this.pane.setTheme(adapter.isDarkTheme(this.reader) ? 'dark' : 'light');
		// 此前主题只在这里读一次,之后窗格永远停在建立时的那个主题 ——
		// 开着窗格切换系统/Zotero 主题,Zotero 其余界面当场变,窗格不变。
		this.disposeTheme = adapter.watchTheme(this.reader, (dark) => {
			this.pane?.setTheme(dark ? 'dark' : 'light');
		});
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
		// 覆盖层与面板共用同一个页面渲染器 (3.1.0):同一页在两种模式下同一套排版。
		this.overlay.setPageRenderer((pageIndex, host, width, signal) => this.renderDocPage(pageIndex, host, width, signal));
		this.overlay.setDisplayMode(getPref<OverlayDisplayMode>('overlayDisplayMode', 'dim-original'));
		this.overlay.setPeekOnHover(getPref<boolean>('overlayPeekHover', true));
		this.pane.setArticleFontSize(getPref<number>('articleFontSize', 16));
		// 整页对照: the pane shows the whole document; each page renders as
		// the original until its translation completes, then swaps.
		this.pane.setPageRenderer((pageIndex, slot, width, signal) => this.renderDocPage(pageIndex, slot, width, signal));
		this.installDocumentLayout();
		// 左右对照 = 原文左 / 版面级重排的整页译文右. 文章流 stays one click
		// away in the pane header for anyone who wants plain continuous text.
		this.pane.setViewKind(getPref<'page' | 'article'>('paneView', 'page'));
		{
			const providerId = getPref<string>('provider', 'bing-free');
			// 5.0: 菜单只列已设置的引擎。先用同步可得的信息(免费引擎 + 当前
			// 引擎 + 端点/本地配置)占位,凭据库查完再替换;每次打开菜单还会重取。
			this.pane.setProviderChoices(this.providerChoicesFrom(new Set()), providerId);
			void this.configuredProviderChoices().then(choices => {
				this.pane?.setProviderChoices(choices, getPref<string>('provider', 'bing-free'));
			}).catch(() => { /* 保留占位清单 */ });
			this.pane.setProviderInfo(getProvider(providerId).displayName, providerId);
			const prefSource = getPref<string>('sourceLanguage', 'auto');
			const prefTarget = getPref<string>('targetLanguage', 'auto');
			this.pane.setLanguageCodes(prefSource, prefTarget);
			this.pane.setLanguagePair(languageLabel(prefSource), languageLabel(prefTarget));
		}
		return this.pane;
	}

	/**
	 * open() 拆出: 隐私说明未接受时先展示说明,否则应用视图并开始翻译。
	 * 返回 false 表示等待期间会话已被销毁,调用方必须停止后续注册。
	 */
	private async showPrivacyOrStart(split: SplitViewHandles, pane: TranslationPane): Promise<boolean> {
		if (!getPref<boolean>('privacyNoticeAccepted', false)) {
			const settings = await this.providerSettings();
			if (this.destroyed) {
				return false; // P1-1: providerSettings 查密钥库最长 4s,期间可被销毁
			}
			const provider = getProvider(getPref<string>('provider', 'bing-free'));
			// The notice lives in the pane, so it must be on screen to be read.
			split.setPaneVisible(true);
			pane.showPrivacyNotice(endpointHost(settings, provider.defaultBaseURL));
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
		return true;
	}

	/** open() 拆出: 订阅 PDF.js 的滚动、渲染与文本层事件。 */
	private subscribePdfEvents(): void {
		// PDF.js events: the pane renders its pages itself now, so left-side
		// re-renders and zooms no longer force a rebuild. The stream drives
		// 同步滚动 (following the reader's position continuously) AND — 2.2.9,
		// item1 — 事件驱动的页同步: updateviewarea 每滚动帧触发 syncCurrentPage
		// (廉价比较、幂等),翻页当帧即被捕捉,350ms 轮询从此只是兜底。
		this.disposePdfScrollIntent = adapter.onPdfScrollIntent(this.reader, () => this.sync?.guard.takeControl('pdf'));
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
			if (this.sync?.enabled && this.sync.guard.shouldPropagate('pdf')) {
				const current = adapter.getCurrentPageIndex(this.reader);
				this.pane?.setPdfPageGap(adapter.getPageGap(this.reader, current));
				const fraction = adapter.getPageScrollFraction(this.reader, current);
				if (fraction !== null) {
					this.sync.onPdfPositionChanged(current, fraction);
				}
			}
		});

		// 2.9.2: 文本层渲染完的那一刻,把释放过的页立刻捡回来。
		//
		// 2.9.1 让抽取遇到"没渲染"时立刻放手(抽取人均 864 ms → 139 ms),但同一份
		// 日志里 `text-layer-not-rendered` 释放 29 → 52、`releasedPending` 8 → 27 ——
		// 因为**预取本来就发生在页面渲染之前**,不等就几乎必然落空。靠翻页轮询去
		// 补是在猜"现在渲染好了吗";而 PDF.js 自己会在渲染完时发这个事件,那是
		// 确定的信号。在这一刻重抽,命中率接近 100%,一次配额都不浪费。
		//
		// 单独订阅 `textlayerrendered`:上面那个订阅收的是全部渲染事件,分不出
		// 是哪一种,而 `pagerendered`(画布画完)早于文本层,拿它当信号会又一次落空。
		this.disposeTextLayerEvents = adapter.onPdfRenderEvents(this.reader, (pageIndex) => {
			if (this.destroyed || pageIndex === null) {
				return;
			}
			this.manager?.onPageRendered(pageIndex);
		}, ['textlayerrendered']);
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
			this.translationDeps(),
			this.translationEvents(),
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

	/** startTranslatingWithPool 拆出: 翻译管理器依赖的宿主能力(抽取、请求、缓存、调度)。 */
	private translationDeps(): TranslationDeps {
		return {
			extractPage: pageIndex => this.extractor.extractPage(pageIndex),
			extractRenderedPage: pageIndex => this.extractor.extractRenderedPage(pageIndex),
			extractPathOf: pageIndex => this.extractor.extractPathFor(pageIndex),
			extractPhasesOf: pageIndex => this.extractor.extractPhasesFor(pageIndex),
			translateRequest: (request, signal, hooks) => this.translateRequest(request, signal, hooks),
                restoreSnapshot: async pageIndex => {
                    const saved = await this.pageArchive.get(pageIndex);
                    if (!saved?.blocks?.length || !saved.translations?.length) return null;
                    const diagnostics = saved.diagnostics as {status?: string; metrics?: PageTranslationState['diagnostics']} | undefined;
                    const translations = new Map(saved.translations.map(t => [t.id, t.translatedText]));
                    const blocks = saved.blocks as SourceBlock[];
                    return {pageIndex, blocks, translations,
                        status:diagnostics?.status === 'done' ? 'done' : 'idle',
                        diagnostics:diagnostics?.metrics,
                        cached:blocks.every(b => b.translationMode === 'preserve' || translations.has(b.id))};
                },
			readCache: (pageIndex, blocks) => this.readPageCacheAnyProvider(pageIndex, blocks),
			writeCache: async (pageIndex, blocks, translations) => {
				const parts = await this.cacheKey(pageIndex, blocks.map(contextualSourceText), undefined, blocks.map(b=>b.sourceText).join('\n').slice(0,2000));
				if (parts) {
					// producedBy = 运行时引擎 (P3, 2.0.10, 仅诊断): 键是规范引擎的。
					return await cacheManager.writePage(parts, translations, this.providerForPage(pageIndex));
				}
				return false;
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
			getNoTranslate: () => readNoTranslateList(),
			// 内存淘汰的"在用"判据 (2.8.3, 性能第四批): 当前阅读页、面板上
			// 仍挂着内容的页、以及正在重建的页,都不许被卸掉完整内容。
			isPageInUse: (pageIndex: number) =>
				pageIndex === adapter.getCurrentPageIndex(this.reader)
				|| this.pane?.hasMountedPage(pageIndex) === true
				// 2.8.6 (导出方案 P1): 导出器正在读的那一页也算在用 —— 逐页短时
				// 保护,读完立即释放,不在整个导出期间全局暂停淘汰。
				|| this.exportPins.has(pageIndex),
			useContext: () => getPref<boolean>('useContext', true),
    continuityIdentity: () => this.continuityNamespace(),
			pageCount: () => adapter.getPageCount(this.reader),
			// Each page's provider LANE — lets the scheduler cap providers
			// independently and reserve a foreground slot for the current one.
			laneFor: (pageIndex: number) => this.providerForPage(pageIndex),
			poolSize: () => this.pool.length,
			// 5.0 对冲: 只找测得最快、且不是当前这家的大模型;没有数据就不对冲。
			hedgeProviderFor: (_pageIndex: number, current: string) =>
				this.pool.length > 1 ? fastestProvider(this.pool, this.manager?.providerThroughput() ?? {}, current) : ''
		};
	}

	/** startTranslatingWithPool 拆出: 管理器回调(页面更新、引擎熔断)。 */
	private translationEvents(): ManagerEvents {
		return {
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
		};
	}

	/**
	 * 读页缓存: 先用规范引擎的键;没有再探测池里其他服务商各自的整页缓存
	 * (2.2.1, 发送前查全服务商缓存),任一家译过就直接复用。
	 */
	private async readPageCacheAnyProvider(pageIndex: number, blocks: SourceBlock[]): Promise<TranslatedBlock[] | null> {
			const texts = blocks.map(contextualSourceText);
     const sample = blocks.map(b=>b.sourceText).join('\n').slice(0,2000);
			const parts = await this.cacheKey(pageIndex, texts, undefined, sample);
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
					const alt = await this.cacheKey(pageIndex, texts, pid, sample);
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
		}
		const source = prefSource !== 'auto' ? prefSource : this.detectedSource;
		const target = prefTarget !== 'auto'
			? prefTarget
			: defaultTargetFor(/^zh(?:-|$)/i.test(source) ? 'zh' : source === 'en' ? 'en' : 'other');
		// Display the same effective pair sent to providers; explicit choices win.
		this.pane?.setLanguagePair(languageLabel(source), languageLabel(target));
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

	/** Shared by page translation and manual/automatic deep analysis. */
	private providerEndpointAllowed(settings: ProviderSettings, defaultBaseURL: string): boolean {
		return !getPref<boolean>('localOnlyMode', false)
			|| /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(endpointHost(settings, defaultBaseURL));
	}

	private assertProviderEndpointAllowed(settings: ProviderSettings, defaultBaseURL: string): void {
		if (!this.providerEndpointAllowed(settings, defaultBaseURL)) {
			throw new PaperMirrorError('HTTP_INSECURE', 'Local-only mode is enabled; configure a localhost endpoint.', { retryable: false });
		}
	}

	private async translateRequest(request: TranslationRequest, signal: AbortSignal, hooks?: TranslateHooks): Promise<TranslationResponse> {
		const chosen = hooks?.provider && this.pool.includes(hooks.provider)
			? hooks.provider
			: typeof request.pageIndex === 'number'
				? this.providerForPage(request.pageIndex)
				: getPref<string>('provider', 'bing-free');
		const settings = await this.providerSettingsFor(chosen);
		const provider = getProvider(settings.providerId);
		if (provider.requiresApiKey && !settings.apiKey) {
			throw new PaperMirrorError('NO_API_KEY', getString('papermirror-error-no-api-key'), { retryable: false });
		}
		this.assertProviderEndpointAllowed(settings, provider.defaultBaseURL);
  // A sentence boundary is a translation unit, even when the display retains
  // separate page/column blocks. MT services without structured part output
  // keep their existing contract; language-model providers translate the parts
  // together and the response is assembled back into the original block IDs.
		// Scale the request timeout with the PAYLOAD: a fixed 60 s was fine for a
		// one-block salvage but structurally too short for an 8000-char batch on a
		// slow/thinking model (whose honest generation time is 70–200 s) — the old
		// behavior was timeout → retry → same timeout → page dies "stuck". Rule:
		// base + 12 ms per source char, capped at 120 s (the manager's idle
		// watchdog is 150 s, so a full-length request can never trip it).
  const translateRaw = (outgoing:TranslationRequest, activeSignal:AbortSignal=signal):Promise<TranslationResponse> => {
   const payloadChars = outgoing.blocks.reduce((n, b) => n + b.text.length + (b.continuationUnit?.source.length ?? 0), 0);
   const scaled = Math.min(120000, Math.max(settings.timeoutMs, 20000 + payloadChars * 12));
   return provider.translate(outgoing, { ...settings, timeoutMs: scaled }, { signal:activeSignal, onAttempt: hooks?.onAttempt, onUsage: hooks?.onUsage, onParamHeal: hooks?.onParamHeal })
    .finally(()=>{hooks?.onProgress?.();});
  };
  if (['bing-free','google-free','deepl'].includes(provider.id)) return translateRaw(request);
  // Explicit settings scope the shared unit; dynamic learned terms must not
  // split one sentence back into independent translations on adjacent pages.
  const namespace = this.continuityNamespace();
  return this.continuationUnits.translate(request, translateRaw, signal, namespace,
   {
    noTranslate:readNoTranslateList(), glossary:this.loadGlossary(), onProgress:hooks?.onProgress,
    readUnit:async key => {
     const parts=await this.segmentContext(0);
     if(!parts)return null;
     const stored=(await cacheManager.readSegments(parts,[key])).get(key);
     if(!stored)return null;
     try {
      const parsed:unknown=JSON.parse(stored);
      return Array.isArray(parsed) && parsed.every(t=>typeof t==='string') ? parsed as string[] : null;
     } catch {return null;}
    },
    writeUnit:async (key,translations) => {
     const parts=await this.segmentContext(0);
     if(!parts)throw new PaperMirrorError('CACHE_CORRUPT','完整源句译文未能持久保存，请重试。',{retryable:true});
     const encoded=JSON.stringify(translations);
     await cacheManager.writeSegments(parts,[{hash:key,translatedText:encoded}]);
     const persisted=(await cacheManager.readSegments(parts,[key])).get(key);
     if(persisted!==encoded)throw new PaperMirrorError('CACHE_CORRUPT','完整源句译文未能持久保存，请重试。',{retryable:true});
    }
   });
	}

	private async cacheKey(pageIndex: number, texts: string[], providerId?: string, sourceSample?:string): Promise<CacheKeyParts | null> {
		const item = adapter.getReaderItem(this.reader);
		if (!item) {
			return null;
		}
		// 规范引擎,不是运行时引擎 (P2-16): 读写键必须恒等,见 canonicalProviderForPage。
		// providerId 省略 = 规范引擎(读写恒等);显式传入用于「发送前查全服务商缓存」
		// (2.2.1, item1)—— 用池内其它服务商各自的键探测同一页是否已被译过。
		const chosen = providerId ?? this.canonicalProviderForPage(pageIndex);
		const settings = await this.providerSettingsFor(chosen);
		const { source, target } = this.resolveLanguages(sourceSample ?? texts.join('\n').slice(0, 2000));
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

 private continuityNamespace():string {
  return hashSourceTexts([
   JSON.stringify(this.configIdentity()),getPref<string>('providerProfiles','{}'),
   getPref<string>('provider','bing-free'),getPref<string>('parallelProviders','[]'),
   String(getPref<boolean>('useContext',true))
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

 private archivePage(state: PageTranslationState, placement=false): void {
  this.pageArchive.put(state.pageIndex, pageContentKey(state.blocks,state.translations), {
   spans:null, spansMissing:'missing:not-rendered', blocks:state.blocks, blocksSource:'archived',
   diagnostics: (placement ? joinPlacementOutcome([this.manager?.exportPageDiagnostics(state.pageIndex)] as Parameters<typeof joinPlacementOutcome>[0],this.abandonedBlocks)[0] : this.manager?.exportPageDiagnostics(state.pageIndex)) as Record<string,unknown>,
   check:{structureMatch:'as-translated',blocksCompared:state.blocks.length},
   translations:[...state.translations].map(([id,translatedText])=>({id,translatedText})),translationSource:'archived',
   ...(placement ? {placement: {stats:this.placementStats.get(state.pageIndex),abandoned:this.abandonedBlocks.get(state.pageIndex),geometryAudit:this.geometryAudits.get(state.pageIndex)}} : {}),
   ...(placement && this.placementProbe.has(state.pageIndex) ? {probe:this.placementProbe.get(state.pageIndex)} : {})
  }, placement);
 }
 private resetPageArchive(): void {
  this.continuationUnits.clear();
  void this.pageArchive.close();this.pageArchive=temporaryPageArchive();
  this.ledger.resetPlacementAll();
 }
	private onPageUpdate(state: PageTranslationState): void {
		if (this.destroyed) {
			return;
		}
  const key = pageContentKey(state.blocks, state.translations);
  if (this.placementKeys.get(state.pageIndex) !== key) {
   this.ledger.resetPlacement(state.pageIndex);
  }
  if (state.blocks.length && (state.status === 'done' || state.status === 'error' || (state.status === 'idle' && state.translations.size > 0))) this.archivePage(state);
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
		const stats = this.placementStats.get(pageIndex);
		return idleProgressFor(pageIndex + 1, adapter.getPageCount(this.reader),
			this.translatedPages.has(pageIndex), stats ? placementTally(stats) : undefined, this.pageNote(pageIndex).note);
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
		const pageIndex = topPage ? topPage - 1 : adapter.getCurrentPageIndex(this.reader);
		const state = this.manager?.getPageState(pageIndex);
  const failures = this.abandonedBlocks.get(pageIndex) ?? [];
  const rows = failures.flatMap(f => {
   const id=f.id.replace(/::p\d+$/, '');
   const b = state?.blocks.find(b => b.id === id), t = state?.translations.get(id);
   return b && t && f.reason !== 'echo' ? [{ source: b.sourceText, translation: t, reason: f.reason }] : [];
  });
  const doc = this.getMainWindow()?.document;
  if (doc && showUnplacedTranslations(doc, rows, pageIndex + 1)) return;
  // Bring the PDF (and thus any on-page overlay) to the right page first.
		adapter.navigateToPage(this.reader, pageIndex);
		if (target?.pageIndex === pageIndex && target.element.isConnected) {
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
			}
		}
		// 3.0.0「查看完整译文」:保留原文的段落,译文并没有丢 —— 文章流视图
		// (translationPane 的 'article')是完整的、从不裁剪。定位闪烁之后,把面板切到
		// 文章流并滚到这一页,用户直接读译文,而不是只看到"哪里没放下"。
		// 覆盖模式下面板 display:none (2.0.10, 审核 P3),先切到左右对照。
		if (this.viewMode === 'overlay') {
			this.setViewMode('split');
		}
		// 3.0.2: 不写偏好 —— 这是一次"去看译文",不是用户改了默认视图;
		// 工具条上的视图按钮 / 「更多」菜单随时能切回整页对照。
		this.applyPaneViewKind('article', { persist: false, pageIndex });
	}

	/**
	 * 切换面板视图 (3.0.2)。`pane.setViewKind` 只换壳:它清空文章流的每一节、
	 * 清空页槽,然后**等** `renderPage` 再送状态进来。整页对照有 `initPageList`
	 * 自己把槽建回来;文章流没有 —— 3.0.0 的「查看译文」切过去之后什么都不送,
	 * 右侧就一直空白(用户截图)。这里把已有的每页状态重新喂一遍,和
	 * applyOverlay 对覆盖层做的一样;然后滚到要看的页。
	 */
	private applyPaneViewKind(
		kind: 'page' | 'article',
		opts: { persist: boolean; pageIndex?: number }
	): void {
		if (opts.persist) {
			setPref('paneView', kind);
		}
		if (!this.pane) {
			return;
		}
		const changed = this.pane.getViewKind() !== kind;
		this.pane.setViewKind(kind);
		if (kind === 'article' && changed) {
			const count = adapter.getPageCount(this.reader);
			for (let p = 0; p < Math.max(count, 1); p++) {
				const state = this.manager?.getPageState(p);
				if (state && state.blocks.length) {
					this.pane.renderPage(state);
				}
			}
		}
		const target = opts.pageIndex ?? adapter.getCurrentPageIndex(this.reader);
		this.pane.scrollToPage(target);
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
	private async renderDocPage(pageIndex: number, slot: HTMLElement, width: number, signal?: AbortSignal): Promise<PageRenderResult> {
		// Claim this render's generation up front; any older render still in its
		// async tail will see a newer token and bow out before touching the slot.
		const token = (this.renderToken.get(pageIndex) ?? 0) + 1;
		this.renderToken.set(pageIndex, token);
		// 取消并进世代闸 (2.8.0 第一批): current() 是这条路径上**唯一**的"我还
		// 该不该动这个槽"判据 —— 把 signal 折进来,于是每一处已有的检查点
		// (每次 await 之后、每次提交 DOM 之前) 自动同时是取消检查点。
		const current = (): boolean => !this.destroyed
			&& this.renderToken.get(pageIndex) === token
			&& signal?.aborted !== true;
		if (!current()) {
			return false;
		}
		// The bitmap remains in the PDF's intrinsic orientation. Overlay-only
		// viewer turns happen AFTER strict fitting, so they may reuse this raster.
		// Keep exact widths: rounding could reuse a slightly different viewport
		// and leave masks out of alignment at fractional zoom levels.
		const render = await this.pageBitmap(pageIndex, width, current);
		if (render === 'stale') {
			return false;
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
		const state = await this.manager?.restoreForDisplay(pageIndex);
		if (!current()) return false;
		// 扫描/纯图页提示 (BabelDOC detect_scanned_file 思想的用户侧一半):
		// 提取干净地得到 0 块时,这页不是"翻译失败"而是"没有可译文本"——
		// 明说一次,免得用户对着原样页面点圆环等翻译。每页只提示一次。
		if (state && state.status === 'done' && !state.blocks.length
			&& pageIndex === adapter.getCurrentPageIndex(this.reader)
			&& !this.scannedNoticeShown.has(pageIndex)) {
			this.scannedNoticeShown.add(pageIndex);
			this.flashNotice(`第 ${pageIndex + 1} 页未检测到可翻译文本(纯图或扫描页),已保留原样`);
		}
		// 增量显示 (2.7.10): 途中也可以重建 —— 已到的块画译文,没到的保持原文。
		// 但半成品页**不**做压缩重试、不报排版统计、不弹排版失败提示: 那些都是
		// 对"这页最终结果"的判断,对着一个还在长的页面做只会白花请求、误报数字。
		const partial = !!(state && (state.status === 'translating' || state.status === 'idle' || state.status === 'extracting') && state.blocks.length && state.translations.size);
		if (state && (state.status === 'done' || partial) && state.blocks.length) {
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
					imageRectsPdf: this.imageRects.get(pageIndex) ?? undefined,
					noTranslate: readNoTranslateList()
				});
			}
			catch (e) {
				if (partial) {
					// 半成品重建失败无所谓: 保持原文,译完那一趟还会再来一次。
					logger.debug(MODULE, `partial buildStrictPage failed on page ${pageIndex + 1}`, e);
					return false;
				}
				logger.error(MODULE, `buildStrictPage threw on page ${pageIndex + 1}; showing original`, e);
				this.setTask('translation', null);
				// 每页只提示一次 (2.5.2): 这条路径现在会被自动重试,若每次都弹
				// 提示,一页确定性失败就要连刷三条。
				if (!this.strictFailNoticeShown.has(pageIndex)) {
					this.strictFailNoticeShown.add(pageIndex);
					this.flashNotice(`第 ${pageIndex + 1} 页排版失败,已保留原文(可刷新本页重试)`);
				}
			}
			if (built) {
				if (!current()) {
					return false;
				}
				if (!current()) {
					return false; // 取消后绝不提交 DOM
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
					if (partial) {
						// 半成品页仍然要过**几何审计** (2.8.2 第三批): 墨迹闸与
						// 跨块碰撞检查是"这一块能不能显示"的判据,对半成品页同样
						// 成立 —— 违例的块由审计回退,绝不带着叠印显示出去。
						// 跳过的只有两件事: 压缩重试(对着还在长的页面重试会白花
						// 请求)与统计入账(会把半成品的数字当成终值报上去)。
						this.auditPartialGeometry(pageIndex, element);
						return;
					}
					if (!unfit.length) {
						this.reportPlacement(pageIndex, element);
						return;
					}
					this.resolveStrictUnfit(pageIndex, element, unfit, token);
				});
				this.wireBlockInteractions(built.element, slot, state, pageIndex);
				return partial ? 'partial' : 'translated';
			}
		}
		// 画原文兜底。但「这页本来就没有译文」和「这页有译文、只是这一趟没重建
		// 出来」是两回事 (2.5.2): 后者必须让面板知道可以再试,否则一次偶发失败
		// 就把该页整个会话钉死在英文 —— 用户看到的正是"往回翻译文消失"。
		const degraded = !!(state && state.status === 'done' && state.blocks.length);
		if (!current()) {
			return false; // 取消后绝不提交 DOM
		}
		slot.replaceChildren(applyFit(buildOriginalPage(doc, render)));
		return degraded ? 'degraded' : 'original';
	}

	/**
	 * renderDocPage 拆出: 取这一页的底图。优先用本会话缓存的独立 raster(按页、宽度、
	 * 固有旋转区分),否则让内核渲染;内核不可用时退回复制左侧视图的画布。
	 * 'stale' 表示渲染期间这一趟已被更新的渲染或取消取代。
	 */
	private async pageBitmap(pageIndex: number, width: number, current: () => boolean): Promise<adapter.PageRender | null | 'stale'> {
		const intrinsicRotation = adapter.getPageIntrinsicRotation(this.reader, pageIndex);
		const bitmapKey = `${pageIndex}@${width}#${intrinsicRotation}`;
		let render = this.baseBitmaps.get(bitmapKey) ?? null;
		if (!render) {
			// Supersample within a fixed pixel budget: sharp text without letting a
			// tall page allocate an enormous canvas.
			const oversample = Math.max(1, Math.min(1.8, Math.sqrt(3_200_000 / Math.max(1, width * width * 1.4))));
			render = await adapter.renderPageBitmap(this.reader, pageIndex, width, oversample);
			if (!current()) {
				return 'stale';
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
		return render;
	}

	/** renderDocPage 拆出: 译文块的单击(聚焦)、双击(深度讲解)、右键(重译此段)。 */
	private wireBlockInteractions(element: HTMLElement, slot: HTMLElement, state: PageTranslationState, pageIndex: number): void {
		// A single click on translated text must be INERT reading behaviour:
		// it only moves the focus highlight. The old handler ran 深度讲解 +
		// a scroll-to-top + a PDF navigation on every innocent click — the
		// reader clicked a paragraph and the whole layout convulsed.
		// 深度讲解 is now a deliberate DOUBLE-click.
		for (const node of Array.from(element.querySelectorAll('[data-pm-block]'))) {
			const focusBlock = (): void => {
				const scope = slot.closest('.pm-scroll') ?? element;
				for (const other of Array.from(scope.querySelectorAll('.pm-repage-block.pm-focused'))) {
					other.classList.remove('pm-focused');
				}
				node.classList.add('pm-focused');
			};
			node.addEventListener('click', focusBlock);
			node.addEventListener('dblclick', () => {
				focusBlock();
				const id = node.getAttribute('data-pm-block');
				const block = state.blocks.find(b => b.id === id)
					?? state.blocks.find(b => b.id === id?.replace(/::p\d+$/, ''));
				if (block?.sourceText.trim()) void this.explainSelection(block.sourceText);
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
	}

	/** Moved to placementReporting.ts (5.1). */
	private resolveStrictUnfit(pageIndex: number, element: HTMLElement, unfit: UnfitBlock[], token: number): void {
		return resolveStrictUnfit(this.placementView, pageIndex, element, unfit, token);
	}

	/** Moved to placementReporting.ts (5.1). */
	private runStrictCompress(pageIndex: number, element: HTMLElement, remaining: UnfitBlock[], compressIds: string[], token: number, live: () => boolean, manager: TranslationManager): void {
		return runStrictCompress(this.placementView, pageIndex, element, remaining, compressIds, token, live, manager);
	}

	/** Moved to placementReporting.ts (5.1). */
	private auditPartialGeometry(pageIndex: number, element: HTMLElement): void {
		return auditPartialGeometry(this.placementView, pageIndex, element);
	}

	/** Moved to placementReporting.ts (5.1). */
	private reportPlacement(pageIndex: number, element: HTMLElement): void {
		return reportPlacement(this.placementView, pageIndex, element);
	}

	/** 5.0: a rotated table is kept original by policy — say so instead of silently skipping it. */
	private pageNote(pageIndex: number): { note?: string } {
		return this.extractor.hasRotatedTable(pageIndex) ? { note: ROTATED_TABLE_NOTE } : {};
	}

	/** Moved to placementReporting.ts (5.1). */
	private auditFinalGeometry(pageIndex: number, element: HTMLElement): void {
		return auditFinalGeometry(this.placementView, pageIndex, element);
	}

	/** Moved to placementReporting.ts (5.1). */
	private collectPlacementDiagnostics(pageIndex: number, element: HTMLElement): void {
		return collectPlacementDiagnostics(this.placementView, pageIndex, element);
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
		if (this.pane && this.split) {
			this.pane.setExplanationHost(this.viewMode === 'split'
				? this.split.paneHost : this.split.explanationHost);
		}
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
				this.pane?.setSurfaceActive(false);
				this.applyOverlay(false, false);
				break;
			case 'overlay':
				this.split?.setPaneVisible(false);
				// 先停面板的泵,再开覆盖层 (3.1.0):两者共用渲染世代,不能同时泵同一页。
				this.pane?.setSurfaceActive(false);
				this.applyOverlay(true, false);
				break;
			case 'split':
				this.split?.setPaneVisible(true);
				this.pane?.setSurfaceActive(true);
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

	/** Moved to sessionPdfExport.ts (5.1). */
	exportTranslatedPdf(): Promise<void> {
		return exportTranslatedPdf(this.pdfExportView);
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

	/** Moved to sessionPdfExport.ts (5.1). */
	private exportBuiltin(
		sourceBytes: Uint8Array,
		report: (pct: number) => void
	): Promise<{ monoBytes: Uint8Array | null; dualBytes: Uint8Array | null }> {
		return exportBuiltin(this.pdfExportView, sourceBytes, report);
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

	/** 菜单栏「翻译服务」的候选: 只含已设置的引擎(见 providerAvailability)。 */
	private providerChoicesFrom(withKey: ReadonlySet<string>): { id: string; displayName: string }[] {
		const all = listProviders();
		const ids = new Set(configuredProviderIds({
			providers: all.map(p => ({ id: p.id, requiresApiKey: p.requiresApiKey })),
			withKey,
			profiles: parseProviderProfiles(getPref<string>('providerProfiles', '{}')),
			current: getPref<string>('provider', 'bing-free')
		}));
		return all.filter(p => ids.has(p.id)).map(p => ({ id: p.id, displayName: p.displayName }));
	}

	private async configuredProviderChoices(): Promise<{ id: string; displayName: string }[]> {
		return this.providerChoicesFrom(await providersWithSavedKeys());
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
		this.ledger.resetCompressAll();
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
   this.resetPageArchive();
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
		this.ledger.resetCompress(page);
	}

	/**
	 * 修复本页 (2.1.10, 计划 item 4): 圆环默认动作。**只补缺失/无效/排版失败的
	 * 段**,复用段落库里合格的译文,**不轮换服务商、不清合格缓存**——一次点击
	 * 只为「把这页补齐」,不再像旧版那样在有池时默默换引擎+整页重付费。
	 * (2.3.8: 手动「换引擎重译本页」入口随菜单精简移除;引擎不稳时的自动换家
	 * 仍在 onProviderUnstable 熔断里。)
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

	/** Capsule 取消: stop the current page's translation and mark it cancelled. */
	private cancelCurrentTranslation(): void {
		const page = adapter.getCurrentPageIndex(this.reader);
		this.manager?.cancelPage(page);
		this.ledger.resetCompress(page);
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
		this.ledger.resetCompressAll();
		this.pageProviderOffset.clear();
		// 先等所有在飞任务真正解绕再清盘 (2.0.7, 审核 P2-3): resetAll() 只发
		// abort 不等待,被 abort 的任务要到下一个检查点才退出,其 persistPartial
		// 会把已完成段落 enqueue 落盘 —— 落在 clearAttachmentAllVersions 之后时,
		// 用户明确要求丢弃的译文复活,并被紧接着的 normal 运行当段落命中复用,
		// 「强制全量」不成立。resetAllAndWait 与 quiesceThenReconfigure 同构。
		await this.manager.resetAllAndWait();
 this.resetPageArchive();
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

	/** Moved to sessionNotes.ts (5.1). */
	private saveSelectionToNote(): Promise<void> {
		return saveSelectionToNote(this.notesView);
	}

	/** Moved to sessionExplanations.ts (5.1). */
	private watchAutomaticExplanation(): void {
		return watchAutomaticExplanation(this.explanationsView);
	}

	/** Moved to sessionExplanations.ts (5.1). */
	explainSelection(explicitText?: string, automatic = false): Promise<void> {
		return explainSelection(this.explanationsView, explicitText, automatic);
	}

	/** Moved to sessionNotes.ts (5.1). */
	private copyExplanation(): void {
		return copyExplanation(this.notesView);
	}

	/** Moved to sessionExports.ts (5.1). */
	private engineSelfCheck(): Promise<EngineExportRow[]> {
		return engineSelfCheck(this.exportView);
	}

	/** Moved to sessionExports.ts (5.1). */
	diagnosticsExportSource(pluginVersion: string): Promise<DiagnosticsExportSource> {
		return diagnosticsExportSource(this.exportView, pluginVersion);
	}

	/**
	 * 「更多」菜单的两个导出入口 (2.8.8, 导出方案 P3)。
	 *
	 * 流程: (语料才有)隐私确认 → 选择保存位置 → 逐页写入 → 成功后「显示文件」。
	 *
	 * 四条不肯让步的规矩,都在这个方法里:
	 *
	 *   1. **保存对话框取消 = 直接结束** —— 不写文件、不回落别的目录、不提示成功;
	 *   2. **对话框拉不起来时先问再写**,绝不自动把含全文的语料写到别处;
	 *   3. **失败只报失败并指明阶段**,失败后绝不提示成功,半份文件顺手删掉;
	 *   4. 导出期间**不发任何翻译请求、不清缓存、不刷新翻译** —— 有副作用的只有
	 *      逐页短时 pin 与写文件。
	 */
	private async runExport(kind: ExportKind): Promise<void> {
		try {
			await this.runExportInner(kind);
		}
		catch (e) {
			// 兜底: 调用方是 `void this.runExport(...)`,漏出去的 rejection 会被
			// 静默吞掉 —— 2.8.10 真机上"点了 Save 却毫无反应"就有它一份。
			// 导出可以失败,但**不能没有回音**。
			logger.warn(MODULE, 'export failed outside the write loop', e);
			this.flashNotice(`导出失败(${e instanceof ExportStageError ? stageLabel(e.stage) : '未知阶段'})`);
		}
	}

	/** Moved to sessionExports.ts (5.1). */
	private runExportInner(kind: ExportKind): Promise<void> {
		return runExportInner(this.exportView, kind);
	}

	/** Moved to sessionExports.ts (5.1). */
	private confirmCorpusPrivacy(): boolean {
		return confirmCorpusPrivacy(this.exportView);
	}

	/** Moved to sessionExports.ts (5.1). */
	private resolveSavePath(fileName: string, kind: ExportKind): Promise<string | null> {
		return resolveSavePath(this.exportView, fileName, kind);
	}

	/** Moved to sessionExports.ts (5.1). */
	private createSavePicker(fileName: string, title: string, win: unknown): PickerHandle | null {
		return createSavePicker(this.exportView, fileName, title, win);
	}

	/** `Zotero.File.reveal` 不一定存在 —— 拿不到就返回 undefined,由调用方回落到路径提示。 */
	private revealFn(): ((path: string) => void) | undefined {
		const file = (Zotero as unknown as { File?: { reveal?(path: string): void } }).File;
		return typeof file?.reveal === 'function' ? (path: string) => file.reveal!(path) : undefined;
	}

	/** Moved to sessionExports.ts (5.1). */
	corpusExportSource(pluginVersion: string): Promise<CorpusExportSource> {
		return corpusExportSource(this.exportView, pluginVersion);
	}

	/** Moved to sessionExports.ts (5.1). */
	private corpusTranslations(
		pageIndex: number,
		state: PageTranslationState | undefined,
		rebuilt: SourceBlock[]
	): Promise<{
		translations: { id: string; translatedText: string }[] | null;
		translationSource?: TranslationSource;
		translationsMissing?: TranslationMissing;
	}> {
		return corpusTranslations(this.exportView, pageIndex, state, rebuilt);
	}

	/** Moved to sessionExports.ts (5.1). */
	private pageSpans(pageIndex: number): unknown | null {
		return pageSpans(this.exportView, pageIndex);
	}

	/** Moved to sessionExports.ts (5.1). */
	private copyDiagnostics(): Promise<void> {
		return copyDiagnostics(this.exportView);
	}

	/** Moved to sessionExports.ts (5.1). */
	private copyLayoutCorpus(): void {
		return copyLayoutCorpus(this.exportView);
	}

	/**
	 * 术语表出口 (1.1.2, 参照 BabelDOC automatic_term_extractor 的思想做成
	 * 增量形态): docMemory 边翻边学的「术语(ABBR)」对 → TSV 进剪贴板,
	 * 用户可直接粘贴进词汇表或表格里编辑。
	 */
	/** 上次「保存术语到词汇表」前的快照 —— 一键撤销 (2.3.1, item3 · WF-8)。 */
	private glossaryUndo: { json: string; added: number } | null = null;

	/** Moved to sessionNotes.ts (5.1). */
	private copyTermsTsv(terms: { source: string; target: string }[]): void {
		return copyTermsTsv(this.notesView, terms);
	}

	/** Moved to sessionNotes.ts (5.1). */
	private previewSaveLearnedTerms(): void {
		return previewSaveLearnedTerms(this.notesView);
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
		this.explanationRequest?.abort();
		this.explanationRequest = null;
		this.disposeAutoExplain?.();
		this.disposeAutoExplain = null;
		this.disposeOriginalDoubleClick?.();
		this.disposeOriginalDoubleClick = null;
		if (this.autoExplainPrefObserver !== null) {
			try { unregisterPrefObserver(this.autoExplainPrefObserver); } catch { /* best-effort */ }
			this.autoExplainPrefObserver = null;
		}
		if (this.localOnlyPrefObserver !== null) {
			try { unregisterPrefObserver(this.localOnlyPrefObserver); } catch { /* best-effort */ }
			this.localOnlyPrefObserver = null;
		}
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
		// 5.0: every per-page record goes (elements held by deferred renders,
		// render tokens, notices, image rects … — before, only some were cleared).
		this.ledger.dispose();
		this.baseBitmaps.clear(); // 释放缓存的底图 canvas
		this.disposePdfScrollIntent?.();
		this.disposePdfScrollIntent = null;
		this.disposePdfEvents?.();
		this.disposePdfEvents = null;
		this.disposeTextLayerEvents?.();
		this.disposeTextLayerEvents = null;
		this.disposeTheme?.();
		this.disposeTheme = null;
		this.disposeVisibility?.();
		this.disposeVisibility = null;
		this.overlay?.destroy();
		this.overlay = null;
		this.manager?.dispose();
 void this.pageArchive.close();this.continuationUnits.clear();
		this.manager = null;
		this.pane?.destroy();
		this.pane = null;
		this.split?.destroy();
		this.split = null;
		logger.info(MODULE, `Session destroyed for tab ${this.reader.tabID}`);
	}
}
