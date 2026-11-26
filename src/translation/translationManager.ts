import { productNameCells, tableHeadersByBlock, type TableHeaders } from './tableCellContext';
import { numericPowerIssue } from './numericPowers';
import { technicalUnitIssue } from './technicalUnits';
import type {
	GlossaryRule,
	PaperMirrorErrorCode,
	RejectedParam,
	SourceBlock,
	TranslatedBlock,
	TranslationRequest,
	TranslationResponse
} from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { PlaceholderRegistry } from './placeholderRegistry';
import { looksContextBleed } from './translationValidation';
import { capLearnedRules, matchRules, mergeGlossaries } from './glossary';
import { DocumentMemory, extractTermPairs } from './docMemory';
import { RequestScheduler } from './requestScheduler';
import { RequestGate } from './requestGate';
import { weightsFromThroughput, type ProviderThroughput } from './providerPool';
import { type PlannedChunk } from './segmenter';
import { buildContinuityContexts, pageContinuityNeeds, contextualSourceText } from './sourceContinuity';
import { fnv1a64 } from '../cache/cacheSchema';
import { addUsage, emptyUsage, type TokenUsage } from './usageMeter';
import { pagesToEvict, type RetainCandidate } from './pageRetention';
import { PageRun } from './pageRun';
import { buildPageDigest } from './pageBlockDigest';
/**
 * Per-attachment translation orchestration:
 *  - lazy per-page translation with a pool-sized prefetch window
 *  - per-provider (lane) concurrency: each provider runs its own pages in
 *    parallel up to its own cap, under a global cap = sum of lanes
 *  - formula protection, glossary matching, chunking
 *  - response validation with missing-id retry
 *  - cache read/write
 *  - cancellation on page flips and tab close
 *
 * Dependencies (extraction, provider, cache) are injected so the manager is
 * unit-testable without Zotero.
 */
import {
	MAX_RELEASES,
	MAX_RENDER_RETRIES,
	ManagerEvents,
	PageDiagnostics,
	PageTranslationState,
	RELEASE_RETRY_RADIUS,
	ReleaseReason,
	TranslateHooks,
	TranslationDeps,
	blockSegmentHash,
	initialCharBudget,
	pageCacheRows,
	segmentHash,
	PRIORITY
} from './translationManagerTypes';
import {
	resolveEnglishResidue,
	requestChunkOnce,
	salvageGrouped,
	salvageSingles,
	recoverPlain,
	FINAL_RECOVERY_MAX,
	type RecoveryContext
} from './chunkRecovery';
import {
	pageDiagnosticsRow,
	sessionDiagnostics,
	exportPageDiagnostics,
	recordExtraction,
	type ManagerDiagnosticsView
} from './managerDiagnostics';
import { compressBlocks, retranslateBlock, retranslatePage, type ManualRetranslationView } from './manualRetranslation';
import { prefillFromPageCache, prefillFromSegments, planPage, type PagePlanningView } from './pagePlanning';
export {
	MAX_RELEASES,
	MAX_RENDER_RETRIES,
	RELEASE_RETRY_RADIUS,
	blockSegmentHash,
	hasShownProvisional,
	initialCharBudget,
	noteProvisionalIn,
	pageCacheRows,
	segmentHash
} from './translationManagerTypes';
export type {
	ManagerEvents,
	PageDiagnostics,
	PageTranslationState,
	ReleaseReason,
	RequestTiming,
	TranslateHooks,
	TranslationDeps
} from './translationManagerTypes';

/** 兼容旧导入路径: 验收函数已移到 translationValidation.ts。 */
export {
	looksTranslated,
	looksContextBleed,
	hasEnglishResidue,
	looksLikeReferenceEntry,
	looksLikePersonNames,
	looksLikeCitationTail,
	untranslatedLatinWords,
	referenceRejectReason,
	translationRejectReason
} from './translationValidation';

const MODULE = 'translationManager';

/**
 * 熔断阈值: when more than this fraction of a chunk is still missing/invalid
 * after the batch + combined retry, the engine is misbehaving — the host is
 * told (onProviderUnstable) so it can reroute the page to a backup service.
 */
const UNSTABLE_MISSING_RATIO = 0.25;

/**
 * Absolute ceiling for one page end to end (extraction + all chunks). Long
 * pages with several chunks are fine at 60 s per request; five minutes means
 * something is stuck, not slow.
 */
/** IDLE watchdog: the page dies only when NO request completes for this long —
 *  a big multi-chunk page that keeps making progress is never killed (the old
 *  TOTAL-time watchdog killed pages whose every request succeeded). Must be ≥
 *  the max single-request timeout (readerSession scales it up to 120 s). */
const PAGE_IDLE_MS = 150000;

/** Per-request transient-error retries (network/timeout/rate-limit), replacing
 *  the old whole-page scheduler retry. Small and local so one blip doesn't fail
 *  a chunk, without ever re-running extraction. */
const REQUEST_RETRIES = 2;

/** 5.0: 当前页请求多久没回来就对冲(毫秒)。快引擎 1–2 秒一页,8 秒已是明显异常。 */
let HEDGE_AFTER_MS = 8000;

/** 测试用: 调整对冲等待。 */
export function setHedgeAfterMs(ms: number): void { HEDGE_AFTER_MS = ms; }

/** Chunks of ONE page dispatched concurrently. Audit-verified: nothing in a
 *  chunk's request depends on a previous chunk's RESPONSE (context comes from
 *  SOURCE text), so limited parallelism is safe and roughly halves page time. */
const CHUNK_CONCURRENCY = 2;

/** 提取阶段超时 (每页必点圆环 bug 修复): extraction of a not-yet-rendered page
 *  can hang indefinitely — since 0.9.22 it runs OUTSIDE the watchdogged lane
 *  job, so a hang pinned the page at 'extracting' forever (later visits
 *  early-returned and did nothing) and two hangs deadlocked the 2-slot
 *  extraction semaphore for every page after them. The timeout frees the slot
 *  and deletes the state so the next visit retries silently. */
const EXTRACT_TIMEOUT_MS = 20000;

/**
 * 服务商 id 的形状闸 (2.11.1)。
 *
 * `lane` 是运行期拼出来的字符串。今天它等于服务商 id,明天有人往里加个后缀
 * (`openai@custom-endpoint`、`openai#gw.corp.internal`)就会把端点带进一份
 * "可以放心贴进 issue"的诊断 —— 2.8.6 已经为 `endpointHost` 付过一次这个账。
 * 这里只放行枚举形状,别的一律记成 `other`:导出永远拿不到自由文本。
 */
function sanitizeProviderId(lane: string): string {
	return /^[a-z0-9-]{1,32}$/.test(lane) ? lane : 'other';
}

/**
 * 计量回调 (2.7.7, 外部审核 第一批): 由 meteredTranslate 传给服务商适配器。
 * onAttempt 在每次真正发出 HTTP 时触发(含适配器内部的参数自愈重试);
 * onUsage 在响应到手、译文校验**之前**触发,校验失败的响应同样计入用量。
 */
/** 枚举计数器的两个纯工具 (2.7.9): 只碰数字与枚举键。 */
function bump<K>(counter: Map<K, number>, key: K): void {
	counter.set(key, (counter.get(key) ?? 0) + 1);
}

export class TranslationManager {
	private deps: TranslationDeps;
	private events: ManagerEvents;
	private scheduler: RequestScheduler;
	/** 每服务商「真实在途 HTTP 请求」闸 (2.1.8): 页面 lane 只限并发页数,页内
	 *  CHUNK_CONCURRENCY/补救仍会放大成 2N~4N 个请求打向同一服务商;此闸把每
	 *  服务商在途请求收到 ≈ 其页面并发上限,当前页请求优先出手。 */
	private requestGate = new RequestGate();
	/** 5.1: what the chunkRecovery functions may use of the manager. */
	private readonly recovery: RecoveryContext = {
		request: (run, request, signal) => this.requestWithRetry(run, request, signal),
		documentTitle: () => this.deps.getDocumentTitle(),
		glossaryFor: texts => this.glossaryFor(texts),
		literalsFor: block => this.literalsFor(block),
		notify: state => this.notify(state)
	};
	/** 5.1: the read-only view the managerDiagnostics functions get (a getter, so it also exists on instances built without the constructor). */
	private get diagnosticsView(): ManagerDiagnosticsView {
		const self = this;
		return {
			get attemptErrors() { return self.attemptErrors; },
			get deps() { return self.deps; },
			get hedges() { return self.hedges; },
			get httpAttempts() { return self.httpAttempts; },
			get pageTiming() { return self.pageTiming; },
			get pageTokens() { return self.pageTokens; },
			get pages() { return self.pages; },
			get paramHeals() { return self.paramHeals; },
			get released() { return self.released; },
			get renderRetryBlocked() { return self.renderRetryBlocked; },
			get scopeGaps() { return self.scopeGaps.bind(self); },
			get tokenUsage() { return self.tokenUsage; },
			get usage() { return self.usage; },
			get usageMissing() { return self.usageMissing; },
			get usageReports() { return self.usageReports; },
			get validationFailures() { return self.validationFailures; },
			get pageDiagnosticsRow() { return self.pageDiagnosticsRow.bind(self); },
			get sessionDiagnostics() { return self.sessionDiagnostics.bind(self); },
			get exportPageDiagnostics() { return self.exportPageDiagnostics.bind(self); },
			get recordExtraction() { return self.recordExtraction.bind(self); }
		};
	}
	/** 5.1: the read-only view the manualRetranslation functions get (a getter, so it also exists on instances built without the constructor). */
	private get retranslationView(): ManualRetranslationView {
		const self = this;
		return {
			get deps() { return self.deps; },
			get disposed() { return self.disposed; },
			get docMemory() { return self.docMemory; },
			get ensurePage() { return self.ensurePage.bind(self); },
			get extractZombies() { return self.extractZombies; },
			get failedSegments() { return self.failedSegments; },
			get glossaryFor() { return self.glossaryFor.bind(self); },
			get laneFor() { return self.laneFor.bind(self); },
			get literalsFor() { return self.literalsFor.bind(self); },
			get meteredTranslate() { return self.meteredTranslate.bind(self); },
			get notify() { return self.notify.bind(self); },
			get pages() { return self.pages; },
			get persistPage() { return self.persistPage.bind(self); },
			get released() { return self.released; },
			get requestGate() { return self.requestGate; },
			get scheduler() { return self.scheduler; },
			get trackWrite() { return self.trackWrite.bind(self); },
			get unstableFired() { return self.unstableFired; },
			get compressBlocks() { return self.compressBlocks.bind(self); },
			get retranslateBlock() { return self.retranslateBlock.bind(self); },
			get retranslatePage() { return self.retranslatePage.bind(self); }
		};
	}
	/** 5.1: the read-only view the pagePlanning functions get (a getter, so it also exists on instances built without the constructor). */
	private get planningView(): PagePlanningView {
		const self = this;
		return {
			get deps() { return self.deps; },
			get notify() { return self.notify.bind(self); },
			get usage() { return self.usage; },
			get literalsFor() { return self.literalsFor.bind(self); },
			get prefillFromPageCache() { return self.prefillFromPageCache.bind(self); },
			get prefillFromSegments() { return self.prefillFromSegments.bind(self); },
			get planPage() { return self.planPage.bind(self); }
		};
	}
	private pages = new Map<number, PageTranslationState>();
 private pageCancelEpochs = new Map<number, number>();
 /** Only source extraction is shared; a context read never schedules translation. */
 private continuityReads = new Map<number, Promise<SourceBlock[]>>();

 /** Source-only cache preparation, also used by export recovery. Never calls
  * a provider or creates a neighbouring translation page. */
 async contextualizeSource(pageIndex: number, blocks: SourceBlock[]): Promise<SourceBlock[]> {
  if (!blocks.length) return blocks;
  if (!this.deps.useContext()) return blocks.some(b => b.continuationContext)
   ? blocks.map(({continuationContext: _old, ...source}) => source) : blocks;
  const needs = pageContinuityNeeds(blocks);
  let unavailable = false;
  const read = async (index: number, needed: boolean): Promise<SourceBlock[] | undefined> => {
   if (!needed || index < 0 || index >= this.deps.pageCount()) return undefined;
   const live = this.pages.get(index)?.blocks;
   if (live?.length) return live;
   let pending = this.continuityReads.get(index);
   if (!pending) {
    pending = this.withExtractionSlot(index, async () => {
     if (this.extractZombies.has(index)) return [];
     return this.withExtractTimeout(this.deps.extractPage(index), index);
    });
    this.continuityReads.set(index, pending);
   }
   try {
    const source = await pending;
    if (!source.length) unavailable = true;
    return source;
   } catch (error) {
    unavailable = true;
    logger.warn(MODULE, `Source continuation unavailable on page ${index + 1}`, error);
    return undefined;
   } finally {
    if (this.continuityReads.get(index) === pending) this.continuityReads.delete(index);
   }
  };
  const [previous, next] = await Promise.all([
   read(pageIndex - 1, needs.previous), read(pageIndex + 1, needs.next)
  ]);
  const contexts = buildContinuityContexts(blocks, { previous, next });
  const identity = this.deps.continuityIdentity?.();
  return blocks.map(block => {
   const { continuationContext: _old, ...source } = block;
   const context = contexts.get(block.id);
   // A failed neighbour read must not revive an old context-free translation.
   // Empty evidence also has a distinct identity; successful retry gets its
   // actual source evidence and therefore another identity.
   return context ? { ...source, continuationContext: {...context, ...(identity ? {identity} : {})} }
    : unavailable && block.translationMode !== 'preserve'
     ? { ...source, continuationContext: { before: '', after: '', ...(identity ? {identity} : {}) } } : source;
  });
 }
	/**
	 * 被"释放等重试"的页 (2.9.0)。**释放 ≠ 消失** —— 见 `ReleaseReason` 的注释:
	 * 此前五处删除都不留痕,真机上第 36/41/45 页因此整行从诊断里消失。
	 * 这张表既是记账(导出照实报),也是补回的依据(下次翻页时重新入队)。
	 * 上限就是文档页数,不会无界增长。
	 */
	private released = new Map<number, { reason: ReleaseReason; count: number; renderRetries: number }>();
	/**
	 * 渲染事件补回被**哪一道闸**挡掉了,各多少次 (2.9.4)。
	 *
	 * 装它的直接原因: 2.9.3 真机上第 42–45 页释放了 1/3/4/5 次、原因全是
	 * `text-layer-not-rendered`,而 `renderRetries` 全是 0 —— 补回一次都没发起,
	 * 可日志里**分不出是哪一道闸挡的**,只能猜。猜出来的结论不配写进代码。
	 * 纯计数,不含任何文本。
	 */
	private renderRetryBlocked = new Map<string, number>();
	/**
	 * 页 → 最近一次被用到的序号 (2.8.3, 性能第四批)。单调递增,只用来排先后,
	 * 不用时间戳: 同一毫秒内先后用到的页时间戳分不出先后。
	 */
	private pageTouch = new Map<number, number>();
	/**
	 * 页 → 本趟运行的时序 (2.8.4, 性能第五批)。只有毫秒数,随页级指标导出。
	 * `firstTextAt` 由 notify 顺手记下: 第一次看到这页有译文的时刻。
	 */
	private pageTiming = new Map<number, {
		requestedAt: number; extractMs: number; queuedMs?: number; firstTextAt: number;
		extractPhases?: NonNullable<PageDiagnostics['extractPhases']>;
	}>();
	private touchSeq = 0;
	/** 同时持有完整内容的已完成页上限(测试可注入)。 */
	private retainLimit: number | undefined;
	/**
	 * 已发出、尚未落盘的段落写入 (2.5.9)。
	 *
	 * 页完成路径上的段落写盘此前是 `await` 的,而它坐在**调度槽里面**:
	 * 落盘有 500ms 的合并节流窗口,于是每页翻完都要白占一个槽至少半秒,再加
	 * 整库序列化与落盘 —— 全局并发只有个位数时,这笔账很可观。
	 *
	 * 但也不能简单丢掉 await:2.0.7 (审核 P2-3) 记着,fire-and-forget 会让写盘
	 * 悬在队列里与「刷新全部」的清盘竞态,被丢弃的译文复活。所以改成**登记而
	 * 不等待** —— 任务立刻交还槽位,而 resetAllAndWait / dispose 仍能等到它。
	 */
	private pendingWrites = new Set<Promise<void>>();
	private pageWrites = new WeakMap<PageTranslationState, symbol>();
	private disposed = false;
	private currentPage = 0;
	private prefetchEnabled = true;
	/** Prefetch window (scales with the provider pool; set by the host). */
	private prefetchForward = 1;
	private prefetchBackward = 1;
	/** 用户当前的翻页方向 (2.3.2, item4): 1=向前读, -1=向回看。默认向前。 */
	private readDirection: 1 | -1 = 1;
	/**
	 * 用量统计计数器 (2.3.9, 计划 API-P1/WF-4 的观测子集): 只计数、零开销、
	 * 不进日志 —— 随诊断 JSON 的 usage 段导出,用于回答两个调参问题:
	 *   1. 缓存到底省了多少 —— 页缓存整页命中/部分命中,段落缓存查询/命中;
	 *   2. 预取浪费了多少 —— 后台预取翻译的页里,用户最终没读到的有几页。
	 * prefetchedUnviewed 按页去重;用户滚到该页时移出(不再算浪费)。
	 */
	private restoreEpoch = 0;
	private displayRestores = new Map<number, Promise<PageTranslationState | undefined>>();
	private requestedContent = new Set<string>();
	private usage = {
		displayRestores: 0,
		resumedPages: 0,
		supplementBlocks: 0,
		repeatedBlockSubmissions: 0,
		pageCacheLookups: 0,
		pageCacheFullHits: 0,
		pageCachePartialHits: 0,
		segmentLookups: 0,
		segmentHits: 0,
		prefetchedPages: new Set<number>(),
		prefetchedUnviewed: new Set<number>()
	};
	/** API token 用量总账 (2.7.0, 审核 F-2): 全部请求之和 + 报/不报用量的请求数。 */
	private tokenUsage: TokenUsage = emptyUsage();
	private usageReports = 0;
	private usageMissing = 0;

	/**
	 * 每家服务商的实测吞吐累计 (2.12.0) —— 只计**成功**的请求。
	 *
	 * 快速失败的引擎看上去会很"快":一个一直 4xx 的服务 sendMs 极小,不设这道
	 * 门就会把页越分越多给它。只有真的把译文拿回来了才计入。
	 */
	private providerSuccess = new Map<string, { samples: number; ms: number; chars: number }>();
	/** 收到响应但译文校验失败的次数 (2.7.7): BAD_RESPONSE,token 已计入。 */
	private validationFailures = 0;
	/** 真实 HTTP 尝试总数 (2.7.7): 经 onAttempt 计,适配器不支持时按调用计 1。 */
	private httpAttempts = 0;
	/**
	 * httpAttempts 的去向明细 (2.7.9): 尝试数减去响应数一直是个哑数字 ——
	 * "多发了 12 次"说不出是参数自愈还是请求失败。两个计数器按枚举分类补上:
	 *   paramHeals   适配器剥参重发 (temperature / reasoning_effort / thinking …)
	 *   attemptErrors 整个请求以错误告终,按 PaperMirrorErrorCode 计
	 * 都是枚举计数,不含任何文本 —— 与 diagnosticsPrivacy 的口径一致。
	 * 恒等式: httpAttempts ≈ usageReports + usageMissing + paramHeals + attemptErrors。
	 */
	private paramHeals = new Map<RejectedParam, number>();
	private attemptErrors = new Map<PaperMirrorErrorCode, number>();
	/** 按页的 token 用量(页索引 0 起),诊断导出时并进 pages[].metrics。 */
	private pageTokens = new Map<number, TokenUsage>();

	/**
	 * 经计量的服务商调用 (2.7.0): 两条请求路径(整页运行与压缩重译/单块重译)
	 * 都从这里出去,响应里的用量按页累加。只碰数字,响应正文原样透传。
	 */
	private async meteredTranslate(request: TranslationRequest, signal: AbortSignal, onAttempts?: (n: number) => void, heartbeat?:()=>void, provider?: string): Promise<TranslationResponse> {
  // Centralized here so missing-ID, slow-lane, residue, plain, compression and
  // single-block retries all retain the same immutable source evidence.
  const pageBlocks = this.pages.get(request.pageIndex ?? -1)?.blocks ?? [];
  const sourceById = new Map(pageBlocks.map(b => [b.id, b]));
  const useContext = this.deps.useContext();
  // 5.1: table cells carry their column / row headers (understanding only).
  const headers: Map<string, TableHeaders> = request.plain ? new Map() : tableHeadersByBlock(pageBlocks);
  if (!request.plain) for (const id of productNameCells(pageBlocks)) headers.set(id, { ...headers.get(id), productName: true });
  request = { ...request, blocks: request.blocks.map(block => {
   const {continuationContext: _old, protectedLiterals: _literals, sourceText: _sourceText, tableHeaders: _headers, ...rest} = block;
   const tableHeaders = headers.get(block.id);
   const textBlock = tableHeaders ? { ...rest, tableHeaders } : rest;
   const sourceBlock = sourceById.get(block.id);
   const context = useContext ? sourceBlock?.continuationContext : undefined;
   if (!context || !sourceBlock) return textBlock;
   const registry = PlaceholderRegistry.protect(sourceBlock.sourceText, this.literalsFor(sourceBlock), sourceBlock.styleRuns);
   const protectedLiterals = registry.text === block.text ? registry.entries.map(entry => ({...entry})) : [];
   return { ...textBlock, continuationContext: {before:context.before, after:context.after}, sourceText: sourceBlock.sourceText, protectedLiterals };
  }) };
		let attempts = 0;
		let reported = false;
		let cancelledBeforeSend = false;
  let cacheOnly = false;
		const record = (usage: TokenUsage): void => {
			reported = true;
			this.usageReports++;
			addUsage(this.tokenUsage, usage);
			if (typeof request.pageIndex === 'number') {
				const page = this.pageTokens.get(request.pageIndex) ?? emptyUsage();
				addUsage(page, usage);
				this.pageTokens.set(request.pageIndex, page);
			}
		};
		const hooks: TranslateHooks = {
			onAttempt: () => {
                heartbeat?.();
                attempts++;
                for (const block of request.blocks) {
                    const key = `${request.pageIndex}:${segmentHash(block.text, request.sourceLanguage, request.targetLanguage, block.continuationContext)}`;
                    if (this.requestedContent.has(key)) this.usage.repeatedBlockSubmissions++;
                    this.requestedContent.add(key);
                }
                if (this.requestedContent.size > 20000) {
                    for (const key of [...this.requestedContent].slice(0, 10000)) this.requestedContent.delete(key);
                }
            },
			onUsage: record,
			onParamHeal: param => bump(this.paramHeals, param),
   onProgress: heartbeat,
			...(provider ? { provider } : {})
		};
		try {
			const response = await this.deps.translateRequest(request, signal, hooks);
   cacheOnly = response.cacheOnly === true && attempts === 0;
			// 适配器已经经 onUsage 上报的不再重复累加 (一个响应只记一次);
			// 没走回调的 (免费引擎 / 测试桩) 沿用响应里的 usage 字段。
			if (!reported && !cacheOnly) {
				if (response.usage) {
					record(response.usage);
				}
				else {
					this.usageMissing++;
				}
			}
   // The old chunk-tail guard only covered the first block. Source sentence
   // evidence now follows each block through every retry path, so apply the
   // same conservative bleed check here, including single-ID salvage replies.
   return { ...response, translations: response.translations.filter(translation => {
    const block = request.blocks.length === 1
     ? sourceById.get(request.blocks[0]!.id) : sourceById.get(translation.id);
    const context = useContext ? block?.continuationContext : undefined;
    return !block || !context || !looksContextBleed(block.sourceText, translation.translatedText,
     !!(context.before || context.after));
   }) };
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'CANCELLED' && attempts === 0) {
				cancelledBeforeSend = true;
			}
			if (e instanceof PaperMirrorError && e.code === 'BAD_RESPONSE') {
				this.validationFailures++;
			}
			if (!reported && e instanceof PaperMirrorError && e.code === 'BAD_RESPONSE') {
				this.usageMissing++; // 收到了响应却没有用量字段
			}
			// 以错误告终的请求 (2.7.9): 只有在真的发出去过时才算一次"白发的尝试";
			// 排队期间取消的没占用任何 HTTP 尝试,不计。BAD_RESPONSE 已经作为
			// 响应计过 (usageMissing/usage),不重复计进 attemptErrors。
			if (attempts > 0 && e instanceof PaperMirrorError && e.code !== 'BAD_RESPONSE') {
				bump(this.attemptErrors, e.code);
			}
			throw e;
		}
		finally {
			// 适配器不支持 onAttempt (免费引擎 / 桩) 时,一次调用按一次尝试计;
			// 发出前就取消的 (attempts 仍为 0 且以 CANCELLED 结束) 不计。
			const n = attempts || (cancelledBeforeSend || cacheOnly ? 0 : 1);
			this.httpAttempts += n;
			onAttempts?.(n);
		}
	}
	/** Pages whose provider has already been reported unstable (fire once). */
	private unstableFired = new Set<number>();
	/**
	 * 止损记忆 (参照 retain-pdf english_residue_repeated): segment hash → how
	 * many whole-page runs left it untranslated. At ≥2 the segment is skipped
	 * (keep-origin) instead of re-buying the same doomed requests on every
	 * revisit. 强制重译 clears the map.
	 *
	 * `seq` 是计数时**已发起的最新运行序号** (2.0.6, 审核 P3): 并发页面此前
	 * 把同一段(页眉/重复题注跨页出现)一轮并发就打满阈值 2 —— 但那些运行
	 * **开始**于第一次失败被记下之前,不是「明知失败仍再试」的独立轮次。
	 * 序号不大于 `seq` 的运行(与记录时已在飞的运行同轮)不再叠加计数;
	 * 只有失败记录之后新发起的运行 (runId > seq) 才算下一轮。用单调序号
	 * 而非时间戳: 同一毫秒内先后发起的运行时间戳无法区分先后。
	 */
	private failedSegments = new Map<string, { count: number; seq: number }>();
	/** 单调递增的 translatePage 运行序号 (P3): 供止损轮次判定。 */
	private runSeq = 0;
	/**
	 * 文档术语记忆: abbreviation → 中文术语 pairs the accepted translations
	 * themselves established, re-injected as SUGGESTED rules on later requests
	 * so page 12 renders a term the way page 2 did. User glossary outranks it.
	 */
	private docMemory = new DocumentMemory();

	/** matched 注入: user glossary + document memory, hits only, 学得部分有上限。 */
	private glossaryFor(texts: string[]): GlossaryRule[] {
		const user = this.deps.getGlossary();
		const matched = matchRules(mergeGlossaries(user, this.docMemory.rules()), texts);
		// 上限只对**学得**的术语生效 (2.5.9): 用户词汇表是权威且条目有限,一条
		// 都不能裁;而 docMemory 攒到 200 条后,长文末尾一次请求可能多出两百行
		// 提示词。判断依据是「是不是用户那份里的」,不是 mode —— 用户自己也可以
		// 把某条设成 suggested。
		const userSources = new Set(user.map(r => r.source.toLowerCase()));
		return capLearnedRules(matched, userSources, texts);
	}

	/** 不译词字面量 for the placeholder mask. */
	private noTranslate(): string[] {
		try {
			return this.deps.getNoTranslate?.() ?? [];
		}
		catch {
			return [];
		}
	}

	/**
	 * 掩蔽字面量 = 用户不译词 + 字形级公式 RUN (glyphFormula, 移植自 pdf2zh
	 * vflag / BabelDOC formular_helper — 字体/码位证据比文本正则可靠)。
	 */
	private literalsFor(block: SourceBlock): string[] {
		const runs = block.formulaRuns ?? [];
		const user = this.noTranslate();
		return runs.length ? [...user, ...runs] : user;
	}
	/** Injected (tests) or real timer delay, for request-level retry backoff. */
	private delay: (ms: number) => Promise<void>;

	/**
	 * 可取消的退避等待 (2.7.5, 审核 P1): 429 的 Retry-After 可达两分钟,此前
	 * `await this.delay(wait)` 不看取消信号 —— 刷新 / 换服务商走 resetAllAndWait
	 * 要等所有任务真正解绕,于是被一个正在退避的请求拖住整段 Retry-After
	 * ("点了刷新还卡着")。这里把等待与 signal 绑定: 取消即刻以 CANCELLED 结束,
	 * 释放调度槽;未取消时仍完整遵守 Retry-After。注入的 delayFn (测试假时钟)
	 * 仍是计时来源,取消只是先于它落地。
	 */
	private delayUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted) {
			return Promise.reject(new PaperMirrorError('CANCELLED', 'cancelled'));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onAbort = (): void => {
				if (!settled) {
					settled = true;
					reject(new PaperMirrorError('CANCELLED', 'cancelled'));
				}
			};
			signal.addEventListener('abort', onAbort, { once: true } as AddEventListenerOptions);
			this.delay(ms).then(() => {
				signal.removeEventListener('abort', onAbort);
				if (!settled) {
					settled = true;
					resolve();
				}
			}, (e) => {
				signal.removeEventListener('abort', onAbort);
				if (!settled) {
					settled = true;
					reject(e);
				}
			});
		});
	}
	/** Extraction semaphore: at most 2 concurrent PDF extractions, current page first. */
	private extractActive = 0;
	private extractTimeoutMs = EXTRACT_TIMEOUT_MS;
	private extractWaiters: { pageIndex: number; resolve: () => void; reject: (error: PaperMirrorError) => void }[] = [];
	/** Extraction runs outside RequestScheduler, so navigation needs an independent stale-work guard. */
	private navigationGeneration = 0;
	/** Raw PDF extractions that outlived the manager timeout. One per page. */
	private extractZombies = new Map<number, Promise<SourceBlock[]>>();

	/** 预取去抖 (2.1.9, item 2): 快速跳页时不立刻发邻页预取,等用户停下再发。 */
	private prefetchDebounceMs: number;
	private prefetchTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(deps: TranslationDeps, events: ManagerEvents, options?: { maxConcurrent?: number; reservedForeground?: number; prefetch?: boolean; delayFn?: (ms: number) => Promise<void>; extractTimeoutMs?: number; prefetchDebounceMs?: number; retainLimit?: number }) {
		this.deps = deps;
		this.events = events;
		this.extractTimeoutMs = options?.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS;
		this.prefetchEnabled = options?.prefetch ?? true;
		this.prefetchDebounceMs = Math.max(0, options?.prefetchDebounceMs ?? 500);
		this.retainLimit = options?.retainLimit;
		this.delay = options?.delayFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.scheduler = new RequestScheduler({
			// The GLOBAL cap; the host (session) reconfigures it from the live
			// provider pool via setGlobalConcurrency / setLaneCaps. Per-provider
			// limiting is enforced by lane caps, not this single number.
			maxConcurrent: Math.max(1, options?.maxConcurrent ?? 2),
			// Reserve ONE slot for the current page so background prefetch can
			// never occupy every slot and make the visible page wait.
			reservedForeground: options?.reservedForeground ?? 1,
			delayFn: options?.delayFn
		});
	}

	getPageState(pageIndex: number): PageTranslationState | undefined {
		return this.pages.get(pageIndex);
	}

	/** Display restoration never enters the scheduler or calls a provider. */
	async restoreForDisplay(pageIndex: number): Promise<PageTranslationState | undefined> {
		const current = this.pages.get(pageIndex);
		if (current && !current.evicted) return current;
		if (!this.deps.restoreSnapshot || this.disposed) return current;
		const pending = this.displayRestores.get(pageIndex);
		if (pending) return pending;
		const epoch = this.restoreEpoch;
		const job = (async () => {
			let saved = await this.deps.restoreSnapshot!(pageIndex).catch(() => null);
			if (this.disposed || epoch !== this.restoreEpoch) return undefined;
			if (this.pages.get(pageIndex) !== current) return this.pages.get(pageIndex);
			if (!saved?.blocks.length) return current;
			const invalidUnits = saved.blocks.filter(block => {
				const text = saved!.translations.get(block.id);
				return text !== undefined && (technicalUnitIssue(block.sourceText, text) || numericPowerIssue(block.sourceText, text)) !== null;
			});
			if (invalidUnits.length) {
				const translations = new Map(saved.translations);
				for (const block of invalidUnits) translations.delete(block.id);
				saved = {...saved, translations, status:'idle', cached:false};
			}
			this.pages.set(pageIndex, saved);
			this.touchPage(pageIndex);
			this.usage.displayRestores++;
			return saved;
		})();
		this.displayRestores.set(pageIndex, job);
		try { return await job; }
		finally { if (this.displayRestores.get(pageIndex) === job) this.displayRestores.delete(pageIndex); }
	}

	/** 用到了这一页 —— 刷新它在 LRU 里的位置 (2.8.3)。 */
	private touchPage(pageIndex: number): void {
		this.pageTouch.set(pageIndex, ++this.touchSeq);
	}

	/**
	 * 卸掉冷页的**完整内容**,只留轻量状态 (2.8.3, 性能第四批)。
	 * 判据全在 pagesToEvict 里(纯函数,单测锁死);这里只负责取快照与执行。
	 */
	private evictColdPages(): void {
		const candidates: RetainCandidate[] = [...this.pages.values()].map(state => ({
			pageIndex: state.pageIndex,
			status: state.status,
			cached: state.cached === true,
			inUse: this.pageInUse(state.pageIndex),
			touchedAt: this.pageTouch.get(state.pageIndex) ?? 0,
			evicted: state.evicted === true
		}));
		for (const pageIndex of pagesToEvict(candidates, this.currentPage, { limit: this.retainLimit })) {
			const state = this.pages.get(pageIndex);
			if (!state) {
				continue;
			}
			// 卸之前先拍一份逐块摘要 (2.8.5, P0): 这是**唯一**还看得见 blocks 与
			// keepOrigin/rejectReasons 的时刻。摘要定长、无文本,随轻量状态活着,
			// 于是被卸过的页在诊断里仍然有逐块明细。
			state.blockDigest = buildPageDigest(state, this.runSeq, state.translationRevision ?? 0);
			// 轻量状态留着: 状态、页级指标、诊断都还在,导出诊断不会因为省内存
			// 而少掉几页;卸的只是 blocks(每块带行矩形数组)与 translations。
			state.blocks = [];
			state.translations = new Map();
			state.keepOrigin = undefined;
			state.rejectReasons = undefined;
			state.rejectHistory = undefined;
			state.evicted = true;
			this.revisions.delete(pageIndex);
			logger.debug(MODULE, `page ${pageIndex + 1}: full content evicted (cached, cold)`);
		}
	}

	private pageInUse(pageIndex: number): boolean {
		try {
			return this.deps.isPageInUse?.(pageIndex) === true;
		}
		catch {
			return true; // 问不出来就当作在用 —— 宁可多占内存,不冒丢译文的险
		}
	}

	/**
	 * 每家服务商的实测吞吐 (2.12.0)。给两处用:会话内的加权分页,以及诊断导出。
	 * 纯读,不带任何文本。
	 */
	providerThroughput(): Record<string, ProviderThroughput> {
		const out: Record<string, ProviderThroughput> = {};
		for (const [id, a] of this.providerSuccess) {
			out[id] = {
				samples: a.samples,
				charsPerSecond: a.ms > 0 ? Math.round(a.chars / (a.ms / 1000)) : 0
			};
		}
		return out;
	}

	/** 当前生效的分页权重 (2.12.0) —— 样本不足时全是 1,即与 2.11.2 行为一致。 */
	/** 对冲统计: 发了几次、备选先回来几次。 */
	private hedges = { launched: 0, won: 0 };

	/**
	 * 当前页请求的对冲 (5.0)。主请求超过 HEDGE_AFTER_MS 还没回来、池里有更快
	 * 的另一家时,同时让那家也翻一次,先拿到合格响应的用,另一个取消。
	 * 只对当前页、每个请求最多一次;代价是偶尔多花一次请求的额度。
	 * 主请求在定时器之前就失败 → 照常抛出,交给原有重试链;两个都失败 →
	 * 抛主请求的错误。
	 */
	private async hedgedTranslate(pageIndex: number, lane: string, request: TranslationRequest, sig: AbortSignal,
		onAttempts: (n: number) => void, beat: () => void): Promise<TranslationResponse> {
		const hedgeProvider = this.deps.hedgeProviderFor;
		if (!hedgeProvider || (this.deps.poolSize?.() ?? 1) < 2) {
			return this.meteredTranslate(request, sig, onAttempts, beat);
		}
		const link = (): AbortController => {
			const c = new AbortController();
			if (sig.aborted) c.abort();
			else sig.addEventListener('abort', () => c.abort(), { once: true });
			return c;
		};
		const primaryCtl = link();
		const primary = this.meteredTranslate(request, primaryCtl.signal, onAttempts, beat);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const fired = new Promise<'hedge'>(resolve => { timer = setTimeout(() => resolve('hedge'), HEDGE_AFTER_MS); });
		const settledPrimary = primary.then(r => ({ ok: true as const, r }), e => ({ ok: false as const, e }));
		const first = await Promise.race([settledPrimary, fired]);
		if (first !== 'hedge') {
			clearTimeout(timer);
			if (first.ok) return first.r;
			throw first.e;
		}
		const backup = hedgeProvider(pageIndex, lane);
		if (!backup || backup === lane || sig.aborted || pageIndex !== this.currentPage) {
			const r = await settledPrimary;
			if (r.ok) return r.r;
			throw r.e;
		}
		this.hedges.launched++;
		logger.info(MODULE, `Page ${pageIndex + 1}: request slow after ${HEDGE_AFTER_MS} ms on ${sanitizeProviderId(lane)} → hedging on ${sanitizeProviderId(backup)}`);
		const backupCtl = link();
		// 5.0 审核: 备选请求同样占备选服务商的请求名额(前台优先),不额外超出它的并发上限。
		const settledBackup = this.requestGate.run(backup, true,
			() => this.meteredTranslate(request, backupCtl.signal, onAttempts, beat, backup), backupCtl.signal)
			.then(r => ({ ok: true as const, r }), e => ({ ok: false as const, e }));
		const winner = await Promise.race([settledPrimary.then(x => ({ who: 'primary' as const, x })), settledBackup.then(x => ({ who: 'backup' as const, x }))]);
		if (winner.x.ok) {
			(winner.who === 'primary' ? backupCtl : primaryCtl).abort();
			if (winner.who === 'backup') this.hedges.won++;
			return winner.x.r;
		}
		const other = await (winner.who === 'primary' ? settledBackup : settledPrimary);
		if (other.ok) {
			if (winner.who === 'primary') this.hedges.won++;
			return other.r;
		}
		const p = await settledPrimary;
		throw p.ok ? other.e : p.e;
	}

	/** 当前阅读页(0 起)。供会话按「当前页优先」改派引擎。 */
	currentPageIndex(): number {
		return this.currentPage;
	}

	providerWeights(): Record<string, number> {
		return weightsFromThroughput(this.providerThroughput());
	}

	private laneFor(pageIndex: number): string {
		return this.deps.laneFor?.(pageIndex) ?? '';
	}

	/** GLOBAL concurrent page cap (host: sum of enabled providers' caps). */
	setGlobalConcurrency(n: number): void {
		this.scheduler.setGlobalMax(n);
	}

	/** Per-provider page caps/bands (host: from each provider's mode profile). */
	setLaneCaps(caps: Record<string, number | { min: number; initial: number; max: number }>): void {
		this.scheduler.configureLanes(caps);
		// 请求闸同步 (2.1.8): 每服务商真实在途请求上限 ≈ 其页面并发上限(而非
		// 被页内 chunk/补救放大成 ×2~×4)。下限 2 以便单页的两个 chunk 仍能并行。
		// 2.7.7: 起点用 initial 而非 max (与调度器一致),后续随 laneFeedback 同步。
		for (const [lane, spec] of Object.entries(caps)) {
			const pageCap = typeof spec === 'number' ? spec : spec.initial;
			this.requestGate.setCap(lane, Math.max(2, Math.floor(pageCap)));
		}
	}

	/**
	 * 一次请求结果同时反馈两层 (2.7.7, 外部审核 第一批): 页面调度器的 lane
	 * 自适应上限 (2.0.5 起就有: 429 减半、超时减一、连续 5 次成功加一) 和
	 * **请求闸的真实 HTTP 在途上限** —— 此前请求闸上限固定为 max(2, 页面 max),
	 * 调度器被 429 压到 1 并行页时,闸仍放行 4 个并发请求。现在闸上限跟着
	 * `laneCap` 走 (下限 2, 单页两个 chunk 仍可并行);429 带 Retry-After 时整个
	 * lane 进冷却,不只撞上的那一个请求退避。两层含义不同: 一个管并行页数,
	 * 一个管真实服务调用数,不用页面上限机械替代。
	 */
	private laneFeedback(lane: string, kind: 'rate' | 'timeout' | 'success', retryAfterMs?: number): void {
		this.scheduler.laneFeedback(lane, kind);
		const cap = this.scheduler.laneCap(lane);
		if (Number.isFinite(cap)) {
			this.requestGate.setCap(lane, Math.max(2, Math.floor(cap)));
		}
		if (kind === 'rate' && typeof retryAfterMs === 'number' && retryAfterMs > 0) {
			this.requestGate.cooldown(lane, Date.now() + retryAfterMs);
		}
	}

	/** 诊断:某 lane 见过的真实在途请求峰值(第二批 请求级调度可观测性)。 */
	requestPeak(lane: string): number {
		return this.requestGate.peakOf(lane);
	}

	/** Prefetch window: forward = min(2×poolSize, 12), backward = 1 (host-set). */
	setPrefetchWindow(forward: number, backward: number): void {
		this.prefetchForward = Math.max(0, Math.floor(forward));
		this.prefetchBackward = Math.max(0, Math.floor(backward));
	}

	/** Called when the visible page changes. */
	setCurrentPage(pageIndex: number): void {
		if (this.disposed) {
			return;
		}
		// 按方向备下一页 (2.3.2, 计划 第四批 item4 · Codex 工作流): 记录用户实际的
		// 翻页方向 —— 向后翻(回看/复查)时预取窗口跟着翻转,大窗口朝行进方向、
		// 小窗口朝身后。同页不动时保持既有方向。
		if (pageIndex !== this.currentPage) {
			this.readDirection = pageIndex > this.currentPage ? 1 : -1;
		}
		this.currentPage = pageIndex;
		this.touchPage(pageIndex);
		// 用户读到了这一页 → 它的预取(如有)没有浪费。
		this.usage.prefetchedUnviewed.delete(pageIndex);
		this.navigationGeneration++;
		const wanted = this.wantedPages();
		const wantedSet = new Set(wanted);
		const staleExtracts = this.extractWaiters.filter(w => !wantedSet.has(w.pageIndex));
		this.extractWaiters = this.extractWaiters.filter(w => wantedSet.has(w.pageIndex));
		for (const waiter of staleExtracts) {
			waiter.reject(new PaperMirrorError('CANCELLED', 'Superseded by navigation.'));
		}
		// 1. Drop queued/running work for pages that left the prefetch window, so
		//    a fast run of scrolls does not leave the current page stuck behind
		//    stale prefetches holding the slots — but KEEP the compress-and-retry
		//    tasks of pages still wanted: cancelling those on every scroll wasted
		//    the strict renderer's budget rounds and long blocks reverted.
		const keep = new Set<string>();
		const keepPrefixes: string[] = [];
		for (const p of wanted) {
			keep.add(`page-${p}`);
			keep.add(`page-${p}-compress`);
			// 单段重译 keys carry the block id — keep them by prefix so a scroll
			// no longer silently cancels a right-click retranslate (审核 P2).
			keepPrefixes.push(`page-${p}-seg-`);
		}
		this.scheduler.cancelExcept(keep, keepPrefixes);
		// 2. The visible page's provider LANE keeps a reserved foreground slot, so
		//    the current page can always start even amid same-lane prefetch.
		this.scheduler.setForegroundLane(this.laneFor(pageIndex));
		// 3. 优先翻译当前页 (ALWAYS): if the page was already queued as a background
		//    prefetch, promote it to the foreground instead of returning early
		//    (the bug: a queued prefetch kept its low priority forever); otherwise
		//    create it as a foreground task.
		const key = `page-${pageIndex}`;
		if (this.scheduler.isQueued(key)) {
			this.scheduler.promote(key, PRIORITY.CURRENT_PAGE, true);
		}
		else {
			void this.ensurePage(pageIndex, PRIORITY.CURRENT_PAGE, { foreground: true });
		}
		// 4. Prefetch neighbours NOW, not only after the current page finishes:
		//    with per-lane caps + the current lane's reserved slot, OTHER
		//    providers' pages translate in parallel while the current page runs,
		//    and same-lane prefetch only ever uses that provider's spare capacity.
		//    That is what actually makes a provider pool multiply throughput.
		//    去抖 (2.1.9): 快速跳页时不立刻发,停下才对最终页预取。
		this.schedulePrefetch();
		// 5. 补回释放过的页 (2.9.0)。放在预取之后: 它的优先级最低,绝不跟当前页
		//    或预取抢。这是"等用户翻过去"那个指望的兜底 —— 单向顺读只经过一次,
		//    没有兜底就等于没有第二次机会。
		this.retryReleasedPages();
		// 6. 冷页卸内容 (2.8.3): 翻页是内存该收一收的自然时机。
		this.evictColdPages();
	}

	/**
	 * 去抖预取 (2.1.9, item 2 自适应预取): 快速跳页/改向时,每次 setCurrentPage
	 * 先 cancelExcept 撤掉过期预取,再重置这个定时器 —— 用户还在翻页就不发邻页
	 * 请求,停下 ~500ms 才对**最终停留页**发预取。当前页本身仍立即翻译(不在这里
	 * 去抖)。debounce=0 时同步执行(测试/兼容)。
	 */
	private schedulePrefetch(): void {
		if (this.disposed || !this.prefetchEnabled) {
			return;
		}
		if (this.prefetchTimer !== null) {
			clearTimeout(this.prefetchTimer);
			this.prefetchTimer = null;
		}
		if (this.prefetchDebounceMs === 0) {
			this.prefetchNeighbours();
			return;
		}
		this.prefetchTimer = setTimeout(() => {
			this.prefetchTimer = null;
			if (!this.disposed) {
				this.prefetchNeighbours();
			}
		}, this.prefetchDebounceMs);
	}

	/** Prefetch the pages around the current one — only once it is itself done. */
	private prefetchNeighbours(): void {
		if (this.disposed || !this.prefetchEnabled) {
			return;
		}
		// No done-guard: prefetch is enqueued as BACKGROUND and the scheduler keeps
		// it off the current lane's reserved slot, so it can never make the visible
		// page wait — but it CAN fill other providers' lanes right away.
		for (const page of this.wantedPages()) {
			if (page === this.currentPage) {
				continue;
			}
			// Nearer pages first; the page AHEAD (行进方向, 2.3.2 item4) beats the
			// one behind — direction-relative, not fixed page-number order.
			const distance = Math.abs(page - this.currentPage);
			const priority = page === this.currentPage + this.readDirection ? PRIORITY.NEXT_PAGE
				: page === this.currentPage - this.readDirection ? PRIORITY.PREVIOUS_PAGE
					: Math.max(1, PRIORITY.SECOND_NEXT_PAGE - distance);
			void this.ensurePage(page, priority, { foreground: false });
		}
	}

	/** Moved to manualRetranslation.ts (5.1). */
	compressBlocks(pageIndex: number, entries: { id: string; maxChars: number }[]): Promise<Map<string, string>> {
		return compressBlocks(this.retranslationView, pageIndex, entries);
	}

	/** Moved to manualRetranslation.ts (5.1). */
	retranslatePage(pageIndex: number, mode: 'normal' | 'rotate' | 'force' = 'normal'): Promise<void> {
		return retranslatePage(this.retranslationView, pageIndex, mode);
	}

	/** Moved to manualRetranslation.ts (5.1). */
	retranslateBlock(pageIndex: number, blockId: string): Promise<boolean> {
		return retranslateBlock(this.retranslationView, pageIndex, blockId);
	}

	/**
	 * 诊断导出 (脱敏): per-page run metrics and per-block STATUS ONLY — no
	 * source text, no translations, no keys, no URLs. Safe to paste into an
	 * issue or a chat as-is.
	 */
	exportDiagnostics(): unknown {
		return {
			pages: [...this.pages.values()]
				.sort((a, b) => a.pageIndex - b.pageIndex)
				.map(s => this.pageDiagnosticsRow(s)),
			docMemoryTerms: this.docMemory.size(),
			...this.sessionDiagnostics()
		};
	}

	/**
	 * 导出范围 (2.8.6, 导出方案 P1): 冻结时刻的页清单,**只有状态,不含内容**。
	 * 导出器据此逐页读,不再重新枚举 `pages` —— 导出期间新完成的页不混进来。
	 */
	exportScope(): { pageIndex: number; status: string; evicted?: boolean }[] {
		const rows: { pageIndex: number; status: string; evicted?: boolean }[] = [...this.pages.values()]
			.map(s => ({ pageIndex: s.pageIndex, status: s.status as string, ...(s.evicted ? { evicted: true } : {}) }));
		// 2.9.0: 释放过、且此刻没有页状态的页**也要出现在清单里**。
		// 这是这个项目从第一天起的要求「不许静默漏页」—— 真机第 36/41/45 页
		// 整行从诊断里消失,正是因为释放只删状态、不留痕。补不回来也得看得见。
		for (const pageIndex of this.released.keys()) {
			if (!this.pages.has(pageIndex)) {
				rows.push({ pageIndex, status: 'released' });
			}
		}
		return rows.sort((a, b) => a.pageIndex - b.pageIndex);
	}

	/**
	 * 本次会话**完全没碰过**的页,夹在碰过的页之间 (2.9.2)。
	 *
	 * 导出清单只报"处理过的页",于是"这一页从来没进过流水线"这件事在文件里
	 * 长得跟"用户根本没读到这里"一模一样。真机 2.9.1 那轮:处理了第 8–88 页,
	 * 中间**第 9、25、26、27 页完全不在清单里** —— 它们既没有页状态,也不在
	 * `released` 里,说明 `ensurePage` 从头到尾没被调用过。
	 *
	 * 这个函数不解释原因(现有数据解释不了),只把事实摆出来: **中间有洞**。
	 * 没有它,下一轮还是只能靠人肉比对页号才发现。
	 */
	scopeGaps(): number[] {
		const touched = new Set<number>([...this.pages.keys(), ...this.released.keys()]);
		// 不设 size 闸: 0 页和 1 页时下面的区间本来就是空的,多一道闸只是多一条
		// 测不到的分支。区间由「碰过的最小页 → 最大页」定义,洞只可能在里面。
		const sorted = [...touched].sort((a, b) => a - b);
		const gaps: number[] = [];
		for (let p = (sorted[0] ?? 0) + 1; p < (sorted[sorted.length - 1] ?? 0); p++) {
			if (!touched.has(p)) {
				gaps.push(p);
			}
		}
		return gaps;
	}

	/** Moved to managerDiagnostics.ts (5.1). */
	exportPageDiagnostics(pageIndex: number): unknown | null {
		return exportPageDiagnostics(this.diagnosticsView, pageIndex);
	}

	/**
	 * 释放一页等重试 (2.9.0) —— **五处删除唯一的出口**。
	 *
	 * 此前五处各自 `this.pages.delete(pageIndex)` 然后写一行日志,页就从
	 * `exportScope()` 里凭空消失了。真机 51 页那轮的第 36/41/45 页就是这么没的:
   * 两侧的页都处理过,中间这几页整行不见,用户看到一片英文,诊断里零线索。
	 *
	 * 身份校验(`this.pages.get(pageIndex) === state`)保留自原实现: 迟到的失败
	 * 不得删掉别人已经重新建起来的状态。
	 */
	private releasePage(pageIndex: number, state: PageTranslationState, reason: ReleaseReason): void {
		if (this.pages.get(pageIndex) === state) {
			if (state.translations.size) {
				state.status = 'idle';
				this.notify(state);
			} else this.pages.delete(pageIndex);
		}
		const prior = this.released.get(pageIndex);
		const count = (prior?.count ?? 0) + 1;
		this.released.set(pageIndex, { reason, count, renderRetries: prior?.renderRetries ?? 0 });
		logger.info(MODULE, `Page ${pageIndex + 1}: released for retry (${reason}, ${count}/${MAX_RELEASES})`);
	}

	/**
	 * PDF.js 刚把这一页的文本层渲染出来 (2.9.1 真机 → 2.9.2)。
	 *
	 * ## 为什么必须由事件驱动
	 *
	 * 2.9.1 让抽取遇到"没渲染"时**立刻**放手(不再干等 2.5 秒),抽取耗时从人均
	 * 864 ms 降到 139 ms。但代价立刻出现在同一份日志里:
	 * `text-layer-not-rendered` 释放 **29 → 52**,`releasedPending` **8 → 27**,
	 * 21 页 `exhausted`。原因很直白 —— **预取本来就发生在页面渲染之前**,
	 * 以前那 2.5 秒的干等里 PDF.js 常常正好把页渲染完了,于是"歪打正着";
	 * 现在不等了,预取就几乎必然落空。
	 *
	 * 靠翻页去轮询补回是在**猜**"现在渲染好了吗",猜不中就消耗一次配额。而
	 * PDF.js 自己会在渲染完时发 `textlayerrendered` —— 那是确定的信号,不是猜。
	 * 在那一刻重抽,命中率接近 100%,一次配额都不浪费。
	 *
	 * 所以这条路**不消耗** `MAX_RELEASES`(那是给盲目轮询用的),自己有一个很小的
	 * 独立上限 `MAX_RENDER_RETRIES` 防病态:文本层都渲染出来了还抽不到,再试也
	 * 只是重复同一个失败。
	 */
	onPageRendered(pageIndex: number): void {
		if (this.disposed) {
			return;
		}
		const record = this.released.get(pageIndex);
		// 2.9.4: **每一道闸挡掉了多少次,如实计数**。
		//
		// 2.9.3 真机那轮出现了一件光看结果解释不了的事: 第 42–45 页(用户这一趟的
		// 起始几页)连续被释放 1/3/4/5 次,原因全是 `text-layer-not-rendered`,
		// 而 `renderRetries` **全是 0** —— 事件补回一次都没成功发起。原因闸放行了,
		// 那它就是被窗口闸、`pages.has` 或 `isScheduled` 挡掉的,可**日志里分不出是
		// 哪一道**,只能猜。猜出来的结论不配写进代码,所以先把闸装上计数器。
		if (!record) {
			return;
		}
		if (this.pages.has(pageIndex)) {
			bump(this.renderRetryBlocked, 'has-state');
			return;
		}
		if (record.renderRetries >= MAX_RENDER_RETRIES) {
			bump(this.renderRetryBlocked, 'budget-spent');
			return;
		}
		// 2.9.3: **只对"渲染时机"类的释放生效**。
		//
		// 2.9.2 真机 103 页那轮,尾部第 88–93 页释放了 **5–11 次**,原因多为
		// `cancelled`,`attemptErrors.CANCELLED` 涨到 58/174(33%),
		// `segmentHitRate` 从 0.851 掉到 0.479 —— 那不是重试,那是**抖动**:
		// 用户在末尾来回滚动 → `setCurrentPage` 的 cancelExcept 撤掉离开窗口的任务
		// → 释放(cancelled)→ 滚动中 `textlayerrendered` 对刚离开的页照样发
		// → 事件补回又把它拉起来 → 又被撤掉。**事件补回和导航取消打起来了。**
		//
		// 两类释放的语义本来就不同:
		//   `text-layer-not-rendered` = "当时看不见" —— 渲染完就该立刻重来,正是这个事件;
		//   `cancelled` / `navigation-superseded` = "**用户已经不在这页了**" ——
		//   该等他回来(翻页轮询 / 当前页那条无条件路径),不该被一个滚动事件拽起来。
		if (record.reason !== 'text-layer-not-rendered' && record.reason !== 'extract-timeout') {
			bump(this.renderRetryBlocked, 'reason');
			return;
		}
		// 距离闸 (2.9.4 放宽): 2.9.3 用的是 `wantedPages().includes(...)`,
		// 而预取窗口只有 **current ±1**,一共 3 页宽。渲染事件到达时用户常常已经
		// 走过两三页 —— 真机第 42–45 页正卡在这里。
		//
		// 收窄成这样是过头了: 渲染事件**本身就是**"这一页现在抽得到"的确定信息,
		// 它不需要再被预取窗口背书。真正要防的只有"拉起一页用户已经远离的内容",
		// 那用距离判断就够,半径与翻页轮询取同一个 `RELEASE_RETRY_RADIUS`。
		if (Math.abs(pageIndex - this.currentPage) > RELEASE_RETRY_RADIUS) {
			bump(this.renderRetryBlocked, 'too-far');
			return;
		}
		if (this.scheduler.isScheduled(`page-${pageIndex}`)) {
			bump(this.renderRetryBlocked, 'already-queued');
			return;
		}
		record.renderRetries++;
		logger.info(MODULE, `Page ${pageIndex + 1}: text layer rendered — retrying (${record.renderRetries}/${MAX_RENDER_RETRIES})`);
		void this.ensurePage(pageIndex, PRIORITY.RELEASED_RETRY, { foreground: false });
	}

	/**
	 * 把近处释放过的页补回来 (2.9.0)。
	 *
	 * "等用户翻过去时自然会重抽"这个指望有个洞: **单向顺读时用户只经过一次**。
	 * 释放如果发生在他已经走过之后,就再也没有第二次 —— 那一页这一趟永远不译。
	 * 所以每次翻页顺手把当前页附近释放过的页重新入队,优先级低于预取。
	 *
	 * 三条约束:
	 *   - 只补 `RELEASE_RETRY_RADIUS` 以内的,不回头扫整篇文档;
	 *   - 每页最多 `MAX_RELEASES` 次,**绝不无限重试**;
	 *   - 超次数的页留在表里(照样导出,`exhausted: true`),不再自动重试 ——
	 *     用户仍可手动重译,而不是被无声地耗着。
	 */
	private retryReleasedPages(): void {
		if (this.disposed || !this.released.size) {
			return;
		}
		for (const [pageIndex, record] of this.released) {
			if (record.count >= MAX_RELEASES) {
				continue; // 有界: 到次数就停,留着记账
			}
			if (Math.abs(pageIndex - this.currentPage) > RELEASE_RETRY_RADIUS) {
				continue;
			}
			if (this.pages.has(pageIndex) || this.scheduler.isScheduled(`page-${pageIndex}`)) {
				continue; // 已经被别的路径接手了
			}
			void this.ensurePage(pageIndex, PRIORITY.RELEASED_RETRY, { foreground: false });
		}
	}

	/** Moved to managerDiagnostics.ts (5.1). */
	private pageDiagnosticsRow(s: PageTranslationState): Record<string, unknown> {
		return pageDiagnosticsRow(this.diagnosticsView, s);
	}

	/** Moved to managerDiagnostics.ts (5.1). */
	private sessionDiagnostics(): Record<string, unknown> {
		return sessionDiagnostics(this.diagnosticsView);
	}

	/**
	 * 本篇学得的术语对 (自动抽取入口, 1.1.2 — automatic_term_extractor 思想的
	 * 增量形态): docMemory 从已接受译文里收的「中文术语(ABBR)」对,交给 UI
	 * 导出为可编辑的对照表。只读快照。
	 */
	learnedTerms(): { source: string; target: string }[] {
		return this.docMemory.rules().map(r => ({ source: r.source, target: r.target }));
	}

	/**
	 * Cancel a page's in-flight translation + compress work (the capsule 取消).
	 * Whatever has already landed stays; the page is not marked done, so a
	 * revisit re-runs it.
	 */
	cancelPage(pageIndex: number): void {
  this.pageCancelEpochs.set(pageIndex, (this.pageCancelEpochs.get(pageIndex) ?? 0) + 1);
		this.scheduler.cancel(`page-${pageIndex}`);
		this.scheduler.cancel(`page-${pageIndex}-compress`);
	}

	/**
	 * Forget every page's translation state (provider or language switched:
	 * existing translations are in the wrong language/engine now). In-flight
	 * work is cancelled; the persistent cache is untouched — it is keyed by
	 * provider+language, so the old entries simply stop matching.
	 */
	resetAll(): void {
		this.restoreEpoch++; this.displayRestores.clear(); this.requestedContent.clear(); this.continuityReads.clear();
		this.scheduler.cancelAll();
		this.pages.clear();
		this.unstableFired.clear();
		// Language/provider switch: remembered pairs are in the wrong language.
		this.docMemory.clear();
		// 止损与提取僵尸一并清 (2.0.6, 审核 P3): 刷新全部/换配置是比
		// retranslatePage('force') 更强的用户意图,曾经反而不清 —— 被止损
		// 跳过的段落在「全部重来」之后仍被跳过。
		this.failedSegments.clear();
		this.extractZombies.clear();
	}

	/**
	 * resetAll + 等所有 in-flight 任务真正解绕完 (审核 P1-8)。
	 * 配置切换必须用它:cancelAll 只发 abort,紧跟其后的 setCurrentPage 会被
	 * isScheduled 挡回,当前页不会自动重翻(用户表现: 换了服务商,当前页一直
	 * 停在旧译文或原文,得手动点圆环)。
	 */
	async resetAllAndWait(): Promise<void> {
		this.restoreEpoch++; this.displayRestores.clear(); this.requestedContent.clear(); this.continuityReads.clear();
		await this.scheduler.cancelAllAndWait();
		// 已发出但还没落盘的段落写入也要等 (2.5.9): 它们不再阻塞调度槽,
		// 清盘前必须在这里收口,否则就是 2.0.7 修过的那条竞态。
		await this.flushPendingWrites();
		this.restoreEpoch++; this.displayRestores.clear();
		this.pages.clear();
		this.unstableFired.clear();
		this.docMemory.clear();
		// 同 resetAll (P3): 全量重置必须包含止损记忆。
		this.failedSegments.clear();
		this.extractZombies.clear();
	}

	cancelAll(): void {
  for (const index of this.pages.keys()) this.pageCancelEpochs.set(index, (this.pageCancelEpochs.get(index) ?? 0) + 1);
		this.scheduler.cancelAll();
	}

	dispose(): void {
		this.disposed = true;
		if (this.prefetchTimer !== null) {
			clearTimeout(this.prefetchTimer);
			this.prefetchTimer = null;
		}
		for (const waiter of this.extractWaiters.splice(0)) {
			waiter.reject(new PaperMirrorError('CANCELLED', 'Manager disposed.'));
		}
		this.scheduler.dispose();
		this.requestGate.dispose();
		this.pages.clear();
		this.extractZombies.clear();
	}

	private wantedPages(): number[] {
		if (!this.prefetchEnabled) {
			return [this.currentPage];
		}
		const count = this.deps.pageCount();
		// Window scales with the provider pool (host sets forward/backward, 2.1.9):
		// more independent providers ⇒ more upcoming pages worth fetching in
		// parallel. 按方向 (2.3.2, item4): 「forward」是**行进方向**而非固定页号
		// 增向 —— 向回看时窗口翻转,大窗口朝用户正在去的方向,身后只留小窗口。
		// Current page first, then ahead (direction), then behind.
		const dir = this.readDirection;
		const pages = [this.currentPage];
		for (let d = 1; d <= this.prefetchForward; d++) {
			pages.push(this.currentPage + d * dir);
		}
		for (let d = 1; d <= this.prefetchBackward; d++) {
			pages.push(this.currentPage - d * dir);
		}
		return pages.filter(p => p >= 0 && (count <= 0 || p < count));
	}

	/**
	 * Run `fn` inside the extraction semaphore: at most 2 PDF extractions at a
	 * time (they contend on the same PDF.js worker anyway), the CURRENT page
	 * jumping the queue. Never a provider-lane slot — a page waiting on
	 * getPageData holds no translation capacity.
	 */
	/**
	 * Race an extraction against the phase timeout. A late raw promise is tracked
	 * by page until it settles, so production can use the rendered-layer fallback
	 * without starting a duplicate PDF-worker request.
	 */
	private withExtractTimeout(p: Promise<SourceBlock[]>, pageIndex: number): Promise<SourceBlock[]> {
		const ms = this.extractTimeoutMs;
		if (!(ms > 0)) {
			return p;
		}
		return new Promise<SourceBlock[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.extractZombies.set(pageIndex, p);
				p.finally(() => {
					if (this.extractZombies.get(pageIndex) === p) {
						this.extractZombies.delete(pageIndex);
					}
				}).catch(() => { /* orphaned promise must not surface as unhandled */ });
				reject(new PaperMirrorError('TIMEOUT', `Page ${pageIndex + 1} text extraction made no progress for ${Math.round(ms / 1000)} s.`, { retryable: true }));
			}, ms);
			p.then(
				(v) => { clearTimeout(timer); resolve(v); },
				(e) => { clearTimeout(timer); reject(e); }
			);
		});
	}

	/**
	 * Rendered-text-layer extraction with a short retry loop: the text layer of
	 * a page the user JUST scrolled to typically appears within a second — one
	 * immediate empty read must not condemn the page (1.0.3 到页点圆环修复).
	 */
	private async renderedWithRetry(pageIndex: number): Promise<SourceBlock[]> {
		for (let attempt = 0; attempt < 6; attempt++) {
			if (this.disposed || pageIndex !== this.currentPage) {
				return [];
			}
			const blocks = await this.withExtractTimeout(
				this.deps.extractRenderedPage!(pageIndex), pageIndex
			).catch(() => [] as SourceBlock[]);
			if (blocks.length) {
				return blocks;
			}
			await this.delay(500);
		}
		return [];
	}

	private async withExtractionSlot<T>(pageIndex: number, fn: () => Promise<T>): Promise<T> {
		// WHILE, not if (审核 P2): between a waiter's wake-up and its increment a
		// fresh caller could slip past the single check — the cap briefly ran 3.
		while (this.extractActive >= 2) {
			await new Promise<void>((resolve, reject) => {
				this.extractWaiters.push({
					pageIndex,
					resolve,
					reject: (error) => reject(error)
				});
			});
		}
		this.extractActive++;
		try {
			return await fn();
		}
		finally {
			this.extractActive--;
			if (this.extractWaiters.length) {
				let idx = this.extractWaiters.findIndex(w => w.pageIndex === this.currentPage);
				if (idx < 0) {
					idx = 0;
				}
				const next = this.extractWaiters.splice(idx, 1)[0]!;
				next.resolve();
			}
		}
	}

	/** 页 → {修订号, 上次通知时的译文指纹}。 */
	private revisions = new Map<number, { revision: number; fingerprint: string }>();

	/** 译文内容变了才前进修订号 —— 纯计数,不含文本。 */
	private bumpRevision(state: PageTranslationState): number {
		const parts: string[] = [];
		for (const [id, text] of state.translations) {
			parts.push(id, String(text.length), text);
		}
		const fingerprint = fnv1a64(parts.join('\u0001'));
		const previous = this.revisions.get(state.pageIndex);
		if (previous && previous.fingerprint === fingerprint) {
			return previous.revision;
		}
		const revision = (previous?.revision ?? 0) + 1;
		this.revisions.set(state.pageIndex, { revision, fingerprint });
		return revision;
	}

	private notify(state: PageTranslationState): void {
		if (!this.disposed) {
			state.translationRevision = this.bumpRevision(state);
			// 首字时刻 (2.8.4): 第一次看到这页有译文就记下来,之后不再改。
			// 放在 notify 里 = 任何产出译文的路径都被覆盖,不必逐个现场埋点。
			const timing = this.pageTiming.get(state.pageIndex);
			if (timing && timing.firstTextAt === 0 && state.translations.size > 0) {
				timing.firstTextAt = Date.now();
			}
			try {
				this.events.onPageUpdate(state);
			}
			catch (e) {
				logger.warn(MODULE, 'onPageUpdate handler failed', e);
			}
		}
	}

	/** 登记一笔写盘: 不阻塞调用方,但 flushPendingWrites 等得到。 */
	private trackWrite(p: Promise<void>): void {
		const tracked = p.catch(() => { /* best effort — 缓存失败不该影响翻译 */ });
		this.pendingWrites.add(tracked);
		void tracked.finally(() => { this.pendingWrites.delete(tracked); });
	}

	/** Only a confirmed page write may release the in-memory translation. */
	private async persistPage(state: PageTranslationState, translations: TranslatedBlock[]): Promise<void> {
		if (this.disposed || this.pages.get(state.pageIndex) !== state) return;
		state.cached = false;
		const revision = state.translationRevision;
		const write = Symbol('page-write');
		this.pageWrites.set(state, write);
		try {
			const persisted = await this.deps.writeCache(state.pageIndex, state.blocks, translations);
			if (!this.disposed && this.pages.get(state.pageIndex) === state
				&& state.translationRevision === revision && this.pageWrites.get(state) === write) {
				// Legacy injected stores resolve void on success; production returns
				// false for a missing key or failed disk write.
				state.cached = persisted !== false;
			}
		}
		catch (e) {
			logger.warn(MODULE, 'page write failed; keeping translations in memory', e);
		}
		finally {
			if (this.pageWrites.get(state) === write) this.pageWrites.delete(state);
		}
	}

	/** 等所有已发出的写盘真正落地(清盘/切配置前必须调用)。 */
	private async flushPendingWrites(): Promise<void> {
		// while: 等待期间可能又有新的写入登记进来。
		while (this.pendingWrites.size) {
			await Promise.all([...this.pendingWrites]);
		}
	}

	async ensurePage(pageIndex: number, priority: number, options?: { bypassCache?: boolean; bypassSegments?: boolean; foreground?: boolean }): Promise<void> {
		if (this.disposed) {
			return;
		}
  const cancelEpoch = this.pageCancelEpochs.get(pageIndex) ?? 0;
		const jobKey = `page-${pageIndex}`;
		// 「正在解绕的僵尸」必须先于所有早退判据识别出来 (2.5.8)。cancel() 对
		// 运行中的任务只发 abort 信号,它要等自己的 run() 结算才离开
		// scheduler.active —— 这期间页状态仍停在 'translating'、isScheduled 仍
		// 为真,下面每一条早退都会把它当成"正在好好跑"。于是导航取消过的那一页
		// 既不结束、也无法重新排期(promote 只对**排队中**的任务生效),用户翻
		// 回去只看到原文,而它还占着全局与 lane 的槽位。这里等它真正解绕完,
		// 再照常往下走。
		if (this.scheduler.isAbortedActive(jobKey)) {
			await this.scheduler.cancelAndWait(jobKey);
			if (this.disposed) {
				return;
			}
		}
		if (this.deps.restoreSnapshot && !options?.bypassCache && !options?.bypassSegments) await this.restoreForDisplay(pageIndex);
		if (this.disposed) return;
		const existing = this.pages.get(pageIndex);
		this.touchPage(pageIndex);
		if (this.pageAlreadyActive(existing, jobKey)) {
			return;
		}

		const resume = existing?.status === 'idle' && existing.translations.size > 0 && !options?.bypassCache && !options?.bypassSegments ? existing : undefined;
		if (resume) this.usage.resumedPages++;
		const state: PageTranslationState = {
			pageIndex,
			status: 'extracting',
			blocks: resume?.blocks ?? [],
			translations: new Map(resume?.translations),
			provisional: new Set(resume?.provisional),
			extractingSince: Date.now()
		};
		const navigationAtStart = this.navigationGeneration;
		// 2.8.4 (性能第五批): 排队/抽取/首字三段计时的起点。
		const requestedAt = Date.now();
		let extractedAt = requestedAt;
		this.pages.set(pageIndex, state);
		// 预取浪费计数 (2.3.9): 只有**显式后台预取**(foreground === false,即
		// schedulePrefetch 发起的邻页)进账 —— 导出等路径不带 foreground 选项,
		// 不算预取;当前页本身也不算。用户之后读到该页时从 unviewed 移出。
		if (options?.foreground === false && pageIndex !== this.currentPage) {
			this.usage.prefetchedPages.add(pageIndex);
			this.usage.prefetchedUnviewed.add(pageIndex);
		}
		this.notify(state);

		try {
			// PDF extraction runs OUTSIDE the provider lane (audit: a slow
			// getPageData used to occupy a provider slot for up to ~58s without a
			// single network request in flight). A small local semaphore (2,
			// current page first) bounds concurrent extractions instead.
			const extracted = await this.extractForPage(pageIndex, state, resume);
			if (!extracted) {
				return;
			}
			let blocks = extracted;
			if (this.disposed || this.pages.get(pageIndex) !== state) {
				return; // superseded while extracting
			}
   if ((this.pageCancelEpochs.get(pageIndex) ?? 0) !== cancelEpoch) {
    state.status = 'idle'; this.notify(state); return;
   }
			if (navigationAtStart !== this.navigationGeneration
				&& !this.wantedPages().includes(pageIndex)) {
				this.releasePage(pageIndex, state, 'navigation-superseded');
				return;
			}
			extractedAt = this.recordExtraction(pageIndex, state, blocks, requestedAt);
			if (!blocks.length) {
				state.status = 'done';
				this.notify(state);
				return;
			}
   const priorIdentities = new Map(blocks.map(b => [b.id, contextualSourceText(b)]));
			blocks = await this.contextualizeSource(pageIndex, blocks);
			if (this.disposed || this.pages.get(pageIndex) !== state) return;
   if ((this.pageCancelEpochs.get(pageIndex) ?? 0) !== cancelEpoch) {
    state.status = 'idle'; this.notify(state); return;
   }
   if (navigationAtStart !== this.navigationGeneration && !this.wantedPages().includes(pageIndex)) {
    this.releasePage(pageIndex, state, 'navigation-superseded'); return;
   }
   for (const block of blocks) {
    if (priorIdentities.get(block.id) !== contextualSourceText(block)) state.translations.delete(block.id);
   }
			state.blocks = blocks;

			const bypass = { bypassPageCache: options?.bypassCache ?? false, bypassSegments: options?.bypassSegments ?? false };
			await this.scheduler.enqueue(`page-${pageIndex}`, priority,
				signal => this.translateWithIdleWatchdog(pageIndex, state, signal, bypass, blocks, extractedAt), {
				foreground: options?.foreground ?? false,
				lane: this.laneFor(pageIndex),
				// A page task runs at MOST once. A retryable failure must NOT re-run
				// the whole translatePage (re-extract + re-translate everything) —
				// that was the 4×watchdog ≈ many-minutes hang. Transient network
				// blips are retried at the individual-request level instead, and
				// already-translated blocks are kept; the rest is left for 「刷新本页」.
				maxRetries: 0
			});
		}
		catch (e) {
			const error = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			if (error.code === 'CANCELLED') {
				// 2.9.0: 取消后照样重置,但**记账并主动补回**。真机那轮
				// `attemptErrors.CANCELLED = 36`,而三页从诊断里整行消失 ——
				// "a later visit retries silently" 里的 silently 正是问题本身:
				// 没有那次 visit 时,它就只是 silent。
				if (this.pages.get(pageIndex) === state && state.status !== 'done') {
					this.releasePage(pageIndex, state, 'cancelled');
				}
				return;
			}
			// 孤儿状态闸 (2.0.6, 审核 P3): retranslatePage 已经 delete 了这个
			// state 并发起新运行时,旧任务迟到的失败不得把错误推给 UI —— 否则
			// 正在正常重译的页面会闪出过期的错误胶囊。CANCELLED 分支早就有这个
			// 身份校验,错误分支此前没有。
			if (this.pages.get(pageIndex) !== state) {
				logger.debug(MODULE, `Page ${pageIndex + 1}: stale run failed after supersession; suppressed`, error.code);
				return;
			}
			state.status = error.code === 'NO_TEXT_LAYER' ? 'no-text-layer' : 'error';
			state.error = error;
			this.notify(state);
		}
	}

	/** ensurePage 拆出: 这一页已经完成、正在抽取或已在排队时不重复发起。 */
	private pageAlreadyActive(existing: PageTranslationState | undefined, jobKey: string): boolean {
		// 2.8.3: 被卸过内容的已完成页必须能重新装载 —— 否则用户翻回去只剩原文。
		// 走的是与"从未翻过的页"完全相同的路径: 重新抽取 + 读页面缓存,零 API。
		if (existing && (existing.status === 'done' || existing.status === 'translating')
			&& existing.evicted !== true) {
			return true;
		}
		// A page may legitimately be mid-extraction — but a state STUCK there
		// past twice the extraction timeout is a zombie (the bug behind 每页必点
		// 圆环): fall through and replace it instead of early-returning forever.
		if (existing?.status === 'extracting'
			&& Date.now() - (existing.extractingSince ?? Date.now()) < this.extractTimeoutMs * 2) {
			return true;
		}
		return this.scheduler.isScheduled(jobKey);
	}

	/** Moved to managerDiagnostics.ts (5.1). */
	private recordExtraction(pageIndex: number, state: PageTranslationState, blocks: SourceBlock[], requestedAt: number): number {
		return recordExtraction(this.diagnosticsView, pageIndex, state, blocks, requestedAt);
	}

	/**
	 * 抽取一页 (ensurePage 拆出): PDF 抽取跑在服务商 lane 之外,由本地小信号量
	 * (2 路,当前页优先) 限流;超时/文本层未渲染时按当前页或预取页分别处理。
	 * 返回 null 表示这一页已被处理(报错、释放待补回),调用方直接结束。
	 */
	private async extractForPage(pageIndex: number, state: PageTranslationState, resume: { blocks: SourceBlock[] } | undefined): Promise<SourceBlock[] | null> {
		try {
			const zombie = this.extractZombies.get(pageIndex);
			if (resume) { return resume.blocks; }
			else if (zombie && this.deps.extractRenderedPage) {
				// Never start a second PDF-worker extraction while the timed-out
				// one is still alive. The visible page can still be recovered from
				// its rendered text layer (timeout-guarded like any extraction).
				if (pageIndex !== this.currentPage) {
					this.releasePage(pageIndex, state, 'extract-zombie');
					return null;
				}
				const rendered = await this.renderedWithRetry(pageIndex);
				if (!rendered.length) {
					// 1.0.3 修复 (到页仍要点圆环): the user often ARRIVES at the
					// page before its text layer exists — the old code marked the
					// empty result "done" and the page could never auto-translate
					// again. Surface a retryable error instead.
					state.status = 'error';
					state.error = new PaperMirrorError('EXTRACTION_FAILED',
						`第 ${pageIndex + 1} 页文字层尚未就绪,稍后自动重试或点击刷新。`, { retryable: true });
					this.notify(state);
					return null;
				}
				return rendered;
			}
			return await this.withExtractionSlot(pageIndex,
				() => this.withExtractTimeout(this.deps.extractPage(pageIndex), pageIndex));
		}
		catch (extractError) {
			const err = extractError instanceof PaperMirrorError
				? extractError
				: new PaperMirrorError('UNKNOWN', String(extractError));
			if (err.code === 'TIMEOUT') {
				// If this is the visible page, recover immediately from the DOM
				// text layer. Otherwise forget the prefetch state; a later visit
				// will use the DOM without duplicating the live worker request.
				if (pageIndex === this.currentPage && this.deps.extractRenderedPage) {
					const rendered = await this.renderedWithRetry(pageIndex);
					if (rendered.length) {
						logger.info(MODULE, `Page ${pageIndex + 1}: recovered timed-out extraction from rendered text layer`);
						return rendered;
					}
					else {
						// The VISIBLE page has neither worker result nor text layer:
						// surface a retryable error instead of silently going idle
						// (审核 P2 — the silent delete re-created the "点击圆环" limbo
						// for exactly this page).
						state.status = 'error';
						state.error = new PaperMirrorError('EXTRACTION_FAILED',
							`第 ${pageIndex + 1} 页读取超时且文字层不可用,可用刷新重试。`, { retryable: true });
						this.notify(state);
						return null;
					}
				}
				else {
					logger.warn(MODULE, `Page ${pageIndex + 1}: extraction timed out after ${this.extractTimeoutMs} ms`);
					this.releasePage(pageIndex, state, 'extract-timeout');
					return null;
				}
			}
			else if (err.code === 'EXTRACTION_FAILED' && err.retryable) {
				// 文本层还没渲染 (2.8.13 真机)。这**不是**"这页没有可译内容",
				// 而是"现在看不见" —— 区别在于前者该标完成、后者必须重来。
				//
				// 真机 19 页里有 6 页栽在这上面: 预取在页面渲染之前抽了一次,
				// 抽到空,页面被永久标成"已完成",用户翻过去一个字都没译,也
				// 不会自动重试。导出时那几页重解析出 12–14 个块 —— 文字一直都在。
				if (pageIndex === this.currentPage) {
					state.status = 'error';
					state.error = err;
					this.notify(state);
					return null;
				}
				// 预取页: 忘掉这次结果,但**记账并主动补回** (2.9.0) —— 2.8.13 写的
				// 是"用户真翻过去时会重抽",而单向顺读时用户只经过一次,释放若发生
				// 在他走过之后就没有第二次。真机第 36/41/45 页正是这么整页消失的。
				this.releasePage(pageIndex, state, 'text-layer-not-rendered');
				return null;
			}
			else {
				throw err; // real extraction errors keep their error/no-text-layer states
			}
		}
	}

	/**
	 * 调度器里的一页任务: 带「空闲看门狗」的 translatePage (ensurePage 拆出)。
	 */
	private async translateWithIdleWatchdog(pageIndex: number, state: PageTranslationState, signal: AbortSignal,
		bypass: { bypassPageCache: boolean; bypassSegments: boolean }, blocks: SourceBlock[], extractedAt: number): Promise<void> {
		// 排队时间 = 抽取完到调度器真正让这页开跑 (2.8.4)。
		const timing = this.pageTiming.get(pageIndex);
		if (timing) {
			timing.queuedMs = Date.now() - extractedAt;
		}
		// IDLE watchdog with a REAL abort. The old Promise.race watchdog had
		// two structural bugs: (a) it measured TOTAL page time, so a big page
		// whose every request succeeded could still be killed; (b) it only
		// rejected the race — translatePage kept running as a zombie, issuing
		// requests past the freed scheduler slot, immune to 取消, and later
		// flipping the errored page back to done. Now: a LOCAL controller is
		// aborted either by the parent signal or when NO request completes
		// for PAGE_IDLE_MS — progress (each finished attempt / extraction)
		// re-arms the clock, so long pages live as long as they keep moving,
		// and a genuine hang dies quickly AND STOPS FOR REAL.
		const local = new AbortController();
		const onParentAbort = (): void => local.abort();
		signal.addEventListener('abort', onParentAbort, { once: true } as AddEventListenerOptions);
		let lastBeat = Date.now();
		let idleFired = false;
		const heartbeat = (): void => { lastBeat = Date.now(); };
		const idleTimer = setInterval(() => {
			if (Date.now() - lastBeat > PAGE_IDLE_MS) {
				idleFired = true;
				local.abort();
			}
		}, 5000);
		try {
			await this.translatePage(state, local.signal, bypass, heartbeat, blocks);
		}
		catch (e) {
			// An idle-abort must surface as TIMEOUT, not CANCELLED (which
			// would silently reset the page as if the user navigated away).
			if (idleFired && !signal.aborted && e instanceof PaperMirrorError && e.code === 'CANCELLED') {
				throw new PaperMirrorError(
					'TIMEOUT',
					`Page ${pageIndex + 1} made no progress for ${PAGE_IDLE_MS / 1000} s. Use 重新翻译 to retry.`,
					{ retryable: true }
				);
			}
			throw e;
		}
		finally {
			clearInterval(idleTimer);
			signal.removeEventListener('abort', onParentAbort);
		}
	}

	/** Moved to chunkRecovery.ts (5.1). */
	private resolveEnglishResidue(
		state: PageTranslationState,
		blocks: SourceBlock[],
		results: TranslatedBlock[],
		source: string,
		target: string,
		signal: AbortSignal,
		translateFn: (req: TranslationRequest, sig: AbortSignal) => Promise<TranslationResponse>,
		canSpend?: () => boolean
	): Promise<void> {
		return resolveEnglishResidue(this.recovery, state, blocks, results, source, target, signal, translateFn, canSpend);
	}

	private async translatePage(state: PageTranslationState, signal: AbortSignal, bypass: { bypassPageCache: boolean; bypassSegments: boolean }, heartbeat?: () => void, preBlocks?: SourceBlock[]): Promise<void> {
		const run = new PageRun(state, signal, heartbeat ?? ((): void => { /* no idle watchdog (tests) */ }), ++this.runSeq, FINAL_RECOVERY_MAX);
		if (!await this.preparePage(run, bypass, preBlocks)) {
			return;
		}
		this.planPage(run);
		try {
			await this.runChunks(run);
			if (!run.results.length && !run.segmentHits) {
				throw new PaperMirrorError('BAD_RESPONSE', 'The translation service returned no usable translations.');
			}
			// 局部英文残留补译: a block that passed looksTranslated can still carry a
			// run of untranslated English mid-paragraph. Re-translate ONLY those
			// blocks (single-block requests, capped), patch their entries in place,
			// and merge into `results` so the fix reaches the cache.
			if (run.canSpend()) {
				await this.resolveEnglishResidue(state, run.activeBlocks, run.results, run.source, run.target, signal,
					(request, sig) => this.requestWithRetry(run, request, sig), run.canSpend);
			}
			await this.recoverPlain(run);
		}
		catch (e) {
			await this.persistPartial(run); // P2-3: 任务解绕前落盘完成,取消等待才等得到
			throw e;
		}
		await this.finalizePage(run);
	}

	/**
	 * 一次逻辑请求,带请求级重试 (network/rate-limit; TIMEOUT 只重试一次 —— 已经
	 * 耗尽整段超时的请求通常还会超时)。当前页走对冲 (hedgedTranslate)。
	 */
	private async requestWithRetry(run: PageRun, request: TranslationRequest, sig: AbortSignal): Promise<TranslationResponse> {
		const { metrics, beat, pageIndex } = run;
		request = { ...request, referenceContent: request.blocks.some(b => run.refById.has(b.id)) };
		metrics.requestCount++;
		// Request-level retry (network/rate-limit; TIMEOUT retried ONCE — a
		// request that already burned its full timeout usually times out again,
		// and back-to-back full timeouts were the old "stuck for minutes" path).
		let lastError: unknown;
		for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
			if (sig.aborted) {
				throw new PaperMirrorError('CANCELLED', 'cancelled');
			}
			// 每次请求即时解析 lane (2.0.5, 审核 P2-16): 此前在页面开始时快照
			// 一次 —— 熔断 (onProviderUnstable) 把本页剩余请求切到引擎 B 之后,
			// B 的 429/timeout 仍反馈到 A 的 lane,去砍无辜引擎的自适应限流
			// 上限,而真正超载的 B 的 lane 学不到任何东西。translateRequest
			// 也是按请求时刻解析引擎的,两者现在同刻同源,必然一致。
			const lane = this.laneFor(pageIndex);
			try {
				const foreground = pageIndex === this.currentPage;
				const promptChars = request.blocks.reduce((n, b) => n + (b.text?.length ?? 0), 0);
				let succeeded = false;
				const response = await this.requestGate.run(
					lane, foreground,
					async () => {
						const r = foreground
							? await this.hedgedTranslate(pageIndex, lane, request, sig, n => { metrics.attemptCount += n; }, beat)
							: await this.meteredTranslate(request, sig, n => { metrics.attemptCount += n; }, beat);
						succeeded = true;
						return r;
					}, sig,
					t => {
						// 2.12.0: 只有成功的请求进吞吐统计(见 providerSuccess 注释)。
						if (succeeded && t.sendMs > 0 && promptChars > 0) {
							const id = sanitizeProviderId(lane);
							const acc = this.providerSuccess.get(id) ?? { samples: 0, ms: 0, chars: 0 };
							acc.samples++;
							acc.ms += t.sendMs;
							acc.chars += promptChars;
							this.providerSuccess.set(id, acc);
						}
						// 上限 40 条:一页正常只有个位数请求,留出余量又不让导出膨胀。
						if (metrics.requestTimings.length < 40) {
							metrics.requestTimings.push({
								gateMs: t.gateMs, sendMs: t.sendMs,
								inFlightAtStart: t.inFlightAtStart,
								foreground, attempt, blocks: request.blocks.length,
								chars: promptChars,
								// lane 就是这一页解析出来的服务商(laneFor → providerForPage)。
								provider: sanitizeProviderId(lane),
								poolSize: this.deps.poolSize?.() ?? 1
							});
						}
					});
				beat(); // progress: a request finished → re-arm the idle watchdog
				this.laneFeedback(lane, 'success');
				run.noteProvisional(response);
				return response;
			}
			catch (e) {
				beat(); // a settled (failed) attempt is progress too
				lastError = e;
				const err = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
				// Feed the REAL 429/timeout to the lane throttling — internal
				// retries used to swallow them and the adaptive caps went blind.
				if (err.code === 'RATE_LIMITED') {
					metrics.rateLimited++;
					this.laneFeedback(lane, 'rate', (err as PaperMirrorError & { retryAfterMs?: number }).retryAfterMs);
				}
				else if (err.code === 'TIMEOUT') {
					metrics.timeouts++;
					this.laneFeedback(lane, 'timeout');
				}
				const timeoutSpent = err.code === 'TIMEOUT' && attempt >= 1;
				if (err.code === 'CANCELLED' || !err.retryable || timeoutSpent || attempt === REQUEST_RETRIES) {
					throw err;
				}
				// Honest backoff: honour the server's Retry-After for a 429;
				// otherwise a real pause (≥1.5s), not the blind 400ms that
				// re-provoked the limit we just hit.
				const retryAfter = (err as PaperMirrorError & { retryAfterMs?: number }).retryAfterMs;
				const wait = err.code === 'RATE_LIMITED'
					? Math.max(retryAfter ?? 2500, 1500)
					: Math.min(2000, 400 * (attempt + 1));
				await this.delayUntilAbort(wait, sig);
			}
		}
		throw lastError instanceof Error ? lastError : new PaperMirrorError('UNKNOWN', String(lastError));
	}

	/**
	 * 第 1–2 步: 抽取、整页缓存、段落缓存、止损过滤与同文去重。返回 false
	 * 表示这一页已经完成(无可译块 / 整页缓存命中 / 全部来自段落缓存)。
	 */
	private async preparePage(run: PageRun, bypass: { bypassPageCache: boolean; bypassSegments: boolean }, preBlocks?: SourceBlock[]): Promise<boolean> {
		const { state, signal, beat, metrics, pageIndex } = run;
		// 1. Extract — normally already done OUTSIDE the provider lane by
		// ensurePage (preBlocks); the inline path remains for direct callers.
		const blocks = run.blocks = preBlocks ?? await this.contextualizeSource(pageIndex, await this.deps.extractPage(pageIndex));
		beat();
		if (signal.aborted) {
			throw new PaperMirrorError('CANCELLED', 'cancelled');
		}
		state.blocks = blocks;
		if (!blocks.length) {
			state.status = 'done';
			this.notify(state);
			return false;
		}
		const activeBlocks = run.activeBlocks = blocks.filter(b => b.translationMode !== 'preserve');
		if (!activeBlocks.length) {
			state.status = 'done';
			this.notify(state);
			return false;
		}

		const sampleText = activeBlocks.map(b => b.sourceText).join('\n').slice(0, 4000);
		const { source, target } = this.deps.getLanguages(sampleText);
		run.source = source;
		run.target = target;
		run.glossary = this.glossaryFor(activeBlocks.map(b => b.sourceText));
		run.sourceById = new Map(activeBlocks.map(b => [b.id, b.sourceText]));
		run.sourceBlockById = new Map(activeBlocks.map(b => [b.id, b]));
		run.refById = new Set(activeBlocks.filter(b => b.isReference).map(b => b.id));
		run.nameCellIds = productNameCells(this.pages.get(run.pageIndex)?.blocks ?? activeBlocks);

		if (!bypass.bypassPageCache && await this.prefillFromPageCache(run)) {
			return false;
		}

		// 3. Translate chunk by chunk
		state.status = 'translating';
		this.notify(state);

		const segHash = run.segHash = (b: SourceBlock): string => blockSegmentHash(b, source, target);
		if (!bypass.bypassSegments) {
			await this.prefillFromSegments(run);
		}
		// keep-origin 止损: segments that already failed two whole runs are left
		// in the original language instead of burning the same requests again.
		const keepOrigin = run.keepOrigin = new Map<string, string>();
		state.keepOrigin = keepOrigin;
		const toTranslate = run.toTranslate = activeBlocks.filter((b) => {
			if (state.translations.has(b.id)) {
				return false;
			}
			if ((this.failedSegments.get(segHash(b))?.count ?? 0) >= 2) {
				keepOrigin.set(b.id, 'repeated-failure');
				return false;
			}
			return true;
		});
		if (state.translations.size && toTranslate.length) this.usage.supplementBlocks += toTranslate.length;
		// 同页相同内容去重 (2.3.5, 第四批 item7 · API-2): 同一页里 sourceText 完全
		// 相同的块(模板化表头/重复短语/密集表格)只把**代表块**送去翻译,其余
		// 同文块在代表译文到达时镜像共享 —— 省下重复块的输入+输出 token,零风险
		// (segHash = 内容+语言,与段落缓存同一把键)。代表失败时同文块同样保留
		// 原文,诚实计入 untranslated。
		const dupOf = run.dupOf = new Map<string, string[]>();
		const uniqueToTranslate: SourceBlock[] = run.uniqueToTranslate = [];
		{
			const repByHash = new Map<string, string>();
			for (const b of toTranslate) {
				const h = segHash(b);
				const rep = repByHash.get(h);
				if (rep === undefined) {
					repByHash.set(h, b.id);
					uniqueToTranslate.push(b);
				}
				else {
					dupOf.set(rep, [...(dupOf.get(rep) ?? []), b.id]);
				}
			}
		}
		if (!toTranslate.length) {
			state.status = 'done';
			state.diagnostics = {
				requests: 0, salvage: 0, rateLimited: 0, timeouts: 0,
				segmentHits: run.segmentHits, durationMs: Date.now() - metrics.startedAt, fromCache: false
			};
			this.notify(state);
			logger.info(MODULE, `Page ${pageIndex + 1}: fully served from the segment cache (${run.segmentHits} segment(s), 0 requests)`);
			if (pageIndex === this.currentPage) {
				this.schedulePrefetch();
			}
			// 不完整页不落页面缓存 (2.0.6, 审核 P3): keepOrigin 非空意味着有段落
			// 被止损跳过 —— 把这样的页写进页面缓存,下次打开会当作完整命中直接
			// 采用,被跳过的段落即使止损记忆早已清空也永远不再重试。与主路径
			// 「a page with unrecovered blocks is NOT cached」同一条规则。
			if (keepOrigin.size === 0) {
				await this.persistPage(state, pageCacheRows(state, activeBlocks));
			}
			return false;
		}
		return true;
	}

	/** Moved to pagePlanning.ts (5.1). */
	private prefillFromPageCache(run: PageRun): Promise<boolean> {
		return prefillFromPageCache(this.planningView, run);
	}

	/** Moved to pagePlanning.ts (5.1). */
	private prefillFromSegments(run: PageRun): Promise<void> {
		return prefillFromSegments(this.planningView, run);
	}

	/** Moved to pagePlanning.ts (5.1). */
	private planPage(run: PageRun): void {
		return planPage(this.planningView, run);
	}

	// Limited intra-page parallelism: a small worker pool pulls chunks in
	// order (当前页最多同时 CHUNK_CONCURRENCY 个批次). Mutations are append-only
	// per block id and the request cap is shared, so the guarantees match the
	// old serial loop at roughly half the wall-clock on multi-chunk pages.
	private async runChunks(run: PageRun): Promise<void> {
		let nextChunk = 0;
		const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, run.chunks.length) }, async () => {
			for (;;) {
				const i = nextChunk++;
				if (i >= run.chunks.length) {
					return;
				}
				await this.runChunk(run, run.chunks[i]!, i);
			}
		});
		const settled = await Promise.allSettled(workers);
		for (const r of settled) {
			if (r.status === 'rejected') {
				throw r.reason;
			}
		}
	}

	/**
	 * 一个批次: 批量请求 → 缺 id 重试一次 → 熔断信号 → 小批补救 → 单块补救,
	 * 收下的译文还原占位符后立即渲染。
	 */
	private async runChunk(run: PageRun, plan: PlannedChunk, chunkIndex: number): Promise<void> {
		const { signal, pageIndex, source, target, glossary, sourceById, protectedBlocks, acceptResponse } = run;
		const chunk = plan.blocks;
		if (signal.aborted) {
			throw new PaperMirrorError('CANCELLED', 'cancelled');
		}
		const request: TranslationRequest = {
			pageIndex,
			sourceLanguage: source,
			targetLanguage: target,
			documentTitle: this.deps.getDocumentTitle(),
			previousContext: this.deps.useContext() ? run.contexts[chunkIndex]! : '',
			moduleContext: this.deps.useContext() ? (plan.moduleContext || undefined) : undefined,
			blocks: chunk.map((b) => {
				const pb = protectedBlocks.find(p => p.block.id === b.id)!;
				// 首次请求即携带排版预算: most paragraphs then fit on the first
				// pass, skipping the translate→measure-fail→compress round trip.
				return { id: b.id, type: b.type, text: pb.text, charBudget: initialCharBudget(b, target) };
			}),
			glossary
		};

		const received = new Map<string, string>();
		// context_bleed: with context injected, the FIRST block of the chunk is
		// the one the model tends to merge the context INTO — an over-long
		// first-block translation is rejected and re-earned context-free by
		// the salvage chain.
		const hadContext = !!(request.previousContext || request.moduleContext);
		const acceptChunk = (id: string, text: string): boolean =>
			acceptResponse(id, text)
			&& !(id === chunk[0]!.id && looksContextBleed(sourceById.get(id) ?? '', text, hadContext));
		await this.requestChunkOnce(run, request, chunk, received, acceptChunk);

		// 熔断信号: the batch + retry still left over a quarter of the chunk
		// missing or invalid — this engine is systematically dropping ids or
		// echoing. Tell the host ONCE per page so it can reroute the page's
		// remaining requests to the backup engine before we spend a pile of
		// salvage requests on a misbehaving service.
		const afterRetry = chunk.filter(b => !received.has(b.id));
		this.reportUnstableEngine(pageIndex, afterRetry.length, chunk.length);

		await this.salvageGrouped(run, request, afterRetry, received);
		await this.salvageSingles(run, request, chunk.filter(b => !received.has(b.id)), received);

		const unrecovered = chunk.filter(b => !received.has(b.id));
		if (unrecovered.length) {
			run.untranslatedCount += unrecovered.length;
			logger.warn(
				MODULE,
				`Page ${pageIndex + 1}: ${unrecovered.length} block(s) untranslated after salvage: ${unrecovered.map(b => b.id).join(', ')}`
			);
		}

		this.applyChunkResults(run, chunk, received);
		this.notify(run.state); // progressive rendering per chunk
	}

	/** Moved to chunkRecovery.ts (5.1). */
	private requestChunkOnce(run: PageRun, request: TranslationRequest, chunk: SourceBlock[], received: Map<string, string>,
		acceptChunk: (id: string, text: string) => boolean): Promise<void> {
		return requestChunkOnce(this.recovery, run, request, chunk, received, acceptChunk);
	}

	/** runChunk 拆出: 一批里超过四分之一缺失或不合格时,每页通知宿主一次以便换引擎。 */
	private reportUnstableEngine(pageIndex: number, missing: number, total: number): void {
		if (missing && missing / total > UNSTABLE_MISSING_RATIO && !this.unstableFired.has(pageIndex)) {
			this.unstableFired.add(pageIndex);
			try {
				this.events.onProviderUnstable?.(pageIndex, missing / total);
			}
			catch { /* host handler must not break translation */ }
		}
	}

	/** runChunk 拆出: 收下的译文还原占位符、写入页面状态、共享给同文块、学习术语。 */
	private applyChunkResults(run: PageRun, chunk: SourceBlock[], received: Map<string, string>): void {
		const { state, protectedBlocks } = run;
		for (const block of chunk) {
			const raw = received.get(block.id);
			if (raw === undefined) {
				continue;
			}
			const pb = protectedBlocks.find(p => p.block.id === block.id)!;
			const restored = pb.reg.restore(raw);
			run.results.push({ id: block.id, translatedText: restored });
			state.translations.set(block.id, restored);
			run.mirrorDuplicates(block.id); // API-2: 同文块同帧共享
			// 术语记忆: harvest 「中文术语(ABBR)」 pairs this page established.
			this.docMemory.learn(extractTermPairs(block.sourceText, restored));
		}
	}

	/** Moved to chunkRecovery.ts (5.1). */
	private salvageGrouped(run: PageRun, request: TranslationRequest, afterRetry: SourceBlock[], received: Map<string, string>): Promise<void> {
		return salvageGrouped(this.recovery, run, request, afterRetry, received);
	}

	/** Moved to chunkRecovery.ts (5.1). */
	private salvageSingles(run: PageRun, request: TranslationRequest, stillMissing: SourceBlock[], received: Map<string, string>): Promise<void> {
		return salvageSingles(this.recovery, run, request, stillMissing, received);
	}

	// 增量持久化: whatever this page has ALREADY translated survives a
	// cancel/idle-timeout — the old behavior threw everything away, so page
	// flipping kept re-buying the same translations (audit item).
	// 返回写盘 promise 并在取消路径 await (2.0.7, 审核 P2-3): 此前
	// fire-and-forget —— 任务解绕后这笔写仍悬在队列里,resetAllAndWait
	// 等不到它,「刷新全部」的清盘与它竞态,被丢弃的译文复活。
	private persistPartial(run: PageRun): Promise<void> {
		const durable = run.results.filter(r => !run.provisional.has(r.id));
		if (!this.deps.writeSegments || !durable.length) {
			return Promise.resolve();
		}
		return this.deps.writeSegments(run.pageIndex, durable.map(r => ({
			hash: blockSegmentHash(run.sourceBlockById.get(r.id) ?? { sourceText: run.sourceById.get(r.id) ?? '' }, run.source, run.target),
			translatedText: r.translatedText
		}))).catch(() => { /* best-effort */ });
	}

	/** Moved to chunkRecovery.ts (5.1). */
	private recoverPlain(run: PageRun): Promise<void> {
		return recoverPlain(this.recovery, run);
	}

	/** 收尾: 止损记账、同文 sweep、诊断、写段落库;完整页才进页缓存。 */
	private async finalizePage(run: PageRun): Promise<void> {
		const { state, pageIndex, metrics, blocks, activeBlocks, toTranslate, keepOrigin, dupOf, segHash, protectedBlocks, chunks } = run;
		// keep-origin 记账: whatever is STILL untranslated after the whole chain
		// increments its segment's failure count; at ≥2 future runs skip it.
		for (const block of toTranslate) {
			if (!state.translations.has(block.id)) {
				const h = segHash(block);
				const rec = this.failedSegments.get(h);
				// 并发轮次去重 (2.0.6, 审核 P3): 本次运行发起于上一次计数之前
				// (与记录时已在飞的运行同轮,同一段跨页并发失败)→ 不叠加。
				// 只有失败记录之后新发起的运行 (run.runId > rec.seq) 才算下一轮。
				if (!rec || run.runId > rec.seq) {
					// 近似 LRU (2.0.10, 审核 P3): Map.set 更新既有键不刷新插入序,
					// 500 上限裁剪按插入序删前半 —— 刚二次失败、正靠 count≥2 保护
					// 的热点段(页眉/重复题注)若首次失败发生得早会先被淘汰,止损
					// 归零重买注定失败的请求。先 delete 再 set 让最近失败的排到队尾。
					this.failedSegments.delete(h);
					this.failedSegments.set(h, { count: (rec?.count ?? 0) + 1, seq: this.runSeq });
				}
				keepOrigin.set(block.id, 'unrecovered');
			}
		}
		if (this.failedSegments.size > 500) {
			// Bounded memory: drop the oldest half (Map preserves insertion order).
			const keys = [...this.failedSegments.keys()].slice(0, 250);
			for (const k of keys) {
				this.failedSegments.delete(k);
			}
		}
		// API-2 收尾 sweep: salvage/纯文本兜底/残留修复等晚到路径接住的代表译文,
		// 在这里统一镜像给同文块 —— 然后才如实清点 untranslated。
		for (const rep of dupOf.keys()) {
			run.mirrorDuplicates(rep);
		}
		const untranslatedCount = run.untranslatedCount = toTranslate.filter(b => !state.translations.has(b.id)).length;

		state.status = 'done';
		state.diagnostics = {
			requests: metrics.requestCount,
			attempts: metrics.attemptCount,
			salvage: metrics.salvageCount,
			rateLimited: metrics.rateLimited,
			timeouts: metrics.timeouts,
			segmentHits: run.segmentHits,
			durationMs: Date.now() - metrics.startedAt,
			fromCache: false,
			// 2.11.0: 没有请求就不写这个字段,免得导出里塞满空数组。
			...(metrics.requestTimings.length ? { requestTimings: metrics.requestTimings } : {}),
			// 注册表状态汇总 (仅计数,无文本 — 日志卫生基线)。
			placeholderTokens: protectedBlocks.reduce((n, p) => n + p.reg.count, 0),
			placeholderRejected: protectedBlocks.reduce((n, p) => n + p.reg.status.rejected, 0)
		};
		this.notify(state);
		// 指标: groupCount(翻译单元) / chunkCount(请求批次) / requestCount(总请求) /
		// salvageCount(逐块补救) / segmentHits(段落缓存命中).
		logger.info(
			MODULE,
			`Page ${pageIndex + 1} metrics: ${blocks.length} unit(s), ${run.segmentHits} from segment cache, `
			+ `${chunks.length} chunk(s), ${metrics.requestCount} request(s), ${metrics.salvageCount} salvage, `
			+ `${untranslatedCount} untranslated, ${Date.now() - metrics.startedAt} ms`
		);
		// The visible page is done → now it is safe to prefetch its neighbours
		// (they were held back so they could not starve the current page).
		if (pageIndex === this.currentPage) {
			this.schedulePrefetch();
		}
		// Newly translated segments enter the segment store regardless of page
		// completeness — a good segment is a good segment; only the PAGE index
		// below requires completeness.
		if (this.deps.writeSegments && run.results.length) {
			const byId = new Map(activeBlocks.map(b => [b.id, b]));
			// 登记而不等待 (2.5.9): 这一笔坐在调度槽里,await 它就是白占半秒
			// 以上(落盘有 500ms 合并窗口)。登记后 resetAllAndWait/dispose 仍
			// 等得到,2.0.7 的清盘竞态防线不受影响。
			const durable = run.results.filter(r => !run.provisional.has(r.id));
			if (durable.length) {
				this.trackWrite(this.deps.writeSegments(pageIndex, durable
					.map(r => ({ hash: segHash(byId.get(r.id)!), translatedText: r.translatedText }))
				).catch(e => { logger.warn(MODULE, 'segment write failed', e); }));
			}
		}
		// Only a COMPLETE page enters the cache. Caching a partial page would
		// freeze the mixed-language rendering: every revisit would hit the
		// cache and never retry the missing blocks. Left uncached, the next
		// visit (or 重新翻译) runs the whole pipeline again — with the segment
		// store still saving the segments that DID succeed.
		const provisionalShown = activeBlocks.filter(b => run.provisional.has(b.id) && state.translations.has(b.id)).length;
		// 5.0 (联网校验: 9 篇里 8 篇、约 30 页): a page whose only flaw is
		// provisional (per-part) translations used to stay uncached, and every
		// revisit paid for the whole page again to get the same parts back.
		// It is cached now with those blocks flagged: shown on revisit, still
		// kept out of the segment store, replaced by 刷新本页.
		if (untranslatedCount === 0 && keepOrigin.size === 0) {
			// keepOrigin pages stay OUT of the page cache (审核 P1): caching one
			// froze its English segments forever — every revisit hit the cache and
			// the repair chain never ran again. Uncached, the segment store still
			// serves the good segments and the skipped ones get their chance the
			// moment 普通刷新 clears the 止损 memory below.
			const all: TranslatedBlock[] = pageCacheRows(state, activeBlocks);
			await this.persistPage(state, all);
			if (provisionalShown) logger.info(MODULE, `Page ${pageIndex + 1} cached with ${provisionalShown} provisional block(s)`);
		}
		else {
			logger.warn(MODULE, `Page ${pageIndex + 1} left uncached (${untranslatedCount} untranslated, ${provisionalShown} provisional block(s)) so a revisit retries`);
		}
	}

}
