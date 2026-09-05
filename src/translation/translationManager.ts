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

import type {
	GlossaryRule,
	SourceBlock,
	TranslatedBlock,
	TranslationRequest,
	TranslationResponse
} from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { isFormulaDenseRisk, stripProtectable } from '../reader/formulaGuard';
import { PlaceholderRegistry } from './placeholderRegistry';
import {
	hasMixedCopiedResidue,
	isTruncatedTranslation,
	longEnglishResidueSpans,
	looksLikeAuthorNameList
} from './residueRules';
import { capLearnedRules, matchRules, mergeGlossaries } from './glossary';
import { DocumentMemory, extractTermPairs } from './docMemory';
import { RequestScheduler } from './requestScheduler';
import { RequestGate } from './requestGate';
import { planChunks, trailingContext, type PlannedChunk } from './segmenter';
import { buildLayoutModules } from '../reader/layoutModules';
import { fnv1a64 } from '../cache/cacheSchema';
import { addUsage, emptyUsage, type TokenUsage } from './usageMeter';

const MODULE = 'translationManager';

/**
 * After the batch retry, EVERY still-missing block is salvaged one by one — a
 * single-block request cannot suffer id drift, so it converts almost every
 * survivor. There is no cap: leaving a block untranslated to save a request is
 * exactly the mixed-language page we are trying to eliminate. This soft ceiling
 * only switches on a warning when a provider is systematically dropping ids, so
 * the run is visible in the log rather than silently enormous.
 */
const SALVAGE_WARN_THRESHOLD = 24;

/**
 * How many single-block salvage requests run at once. A few in flight keeps a
 * long page from stalling on sequential round-trips; kept modest so free MT
 * engines are not rate-limited into failure.
 */
const SALVAGE_CONCURRENCY = 4;

/** 分级补救 tier-1 batch size: small enough that id drift is rare. */
const SALVAGE_BATCH_SIZE = 4;

/**
 * 熔断阈值: when more than this fraction of a chunk is still missing/invalid
 * after the batch + combined retry, the engine is misbehaving — the host is
 * told (onProviderUnstable) so it can reroute the page to a backup service.
 */
const UNSTABLE_MISSING_RATIO = 0.25;

/**
 * Scheduler priorities. The current visible page and its work always dominate
 * neighbour prefetch, so the page the reader is looking at is never queued
 * behind pages they have not scrolled to yet. Numeric gaps leave room to insert
 * finer tiers later without renumbering.
 */
const PRIORITY = {
	/** 重新翻译本页 — an explicit user action, the most urgent thing there is. */
	CURRENT_RETRANSLATE: 1000,
	/** The visible page's first translation. */
	CURRENT_PAGE: 900,
	/** The visible page's strict-layout compress-and-retry. */
	CURRENT_COMPRESS: 850,
	/** Prefetch: the next page is likelier to be read than the previous. */
	NEXT_PAGE: 100,
	PREVIOUS_PAGE: 80,
	SECOND_NEXT_PAGE: 20
} as const;

/**
 * Accept a response as a REAL translation, not an echo or a half-translation.
 * For a Chinese target a prose source (≥PROSE_WORD_GATE Latin words — a real
 * sentence, not a label or an acronym/numeric cell) must come back
 * predominantly Chinese; empty, echoed-English, and half-in-English responses
 * are rejected and routed through retry/salvage instead of stored as "done".
 * Short cells/labels and non-CJK targets have no cheap check and pass.
 */
export function looksTranslated(source: string, translated: string, targetLang: string): boolean {
	const t = translated.trim();
	if (!t) {
		return false;
	}
	if (!/^zh/i.test(targetLang)) {
		return true;
	}
	// PROSE-ONLY scoring (审核项: 统计密集行被误拒): citations, p-values, CIs and
	// formulas are byte-identical in source and translation BY DESIGN — counting
	// them as "untranslated Latin" rejected perfect translations of stats-dense
	// lines back to English. Both sides are stripped to their prose before any
	// ratio is computed; works whether the caller passes masked or raw text.
	const proseSource = stripProtectable(source);
	const proseWords = (proseSource.match(/[A-Za-z]{2,}/g) ?? []).length;
	if (proseWords < PROSE_WORD_GATE) {
		return true; // label / acronym / numeric cell — may legitimately be CJK-free
	}
	// 作者名单豁免 (retain-pdf): a byline legitimately stays Latin — rejecting
	// it buys a doomed retry on every page-1.
	if (looksLikeAuthorNameList(proseSource)) {
		return true;
	}
	const proseT = stripProtectable(t);
	// 截断硬判据 (retain-pdf quality.py): a long source answered with <15% of
	// its length is a tail/half output — the ratio test alone scores a short
	// all-Chinese fragment as "translated" and stored the loss silently.
	if (isTruncatedTranslation(proseSource, proseT)) {
		return false;
	}
	// 小样本验收 (1.1.8, Horst 2024 第 1 页 region-2/region-4 连拒): 比率是一个
	// 比例估计,分母越小噪声越大。一条 56–58 字符的标题/署名里保留 4–5 个专名
	// 与缩写是忠实翻译的常态,却足以把比率压到 0.45 以下 —— 同样的噪声在
	// 800/1783 字符的正文段落里根本不存在(同页那三段全部一次通过)。短源文
	// 因此换一把小样本安全的尺子;正文段落一律走下面原来的比率阈值,验收
	// 强度一个字都没动。
	if (proseSource.length <= SHORT_SOURCE_PROSE_CHARS) {
		return shortSourceTranslated(proseSource, proseT) && !hasMixedCopiedResidue(source, t);
	}
	// A PROSE source must come back predominantly Chinese. This rejects not
	// only echoed English (ratio 0) but a HALF-translated / mixed response,
	// which the old "contains any CJK" test accepted.
	if (targetLanguageRatio(proseT) < MIN_TARGET_RATIO) {
		return false;
	}
	// 混合残留硬判据 (retain-pdf): the ratio passes on a LONG paragraph whose
	// tail is still a copied English span — Chinese-dominant overall, one
	// clause silently untranslated. A ≥12-word span that is surface-identical
	// (or ≥0.82 similar) to the source is copied, not translated.
	if (hasMixedCopiedResidue(source, t)) {
		return false;
	}
	return true;
}

/**
 * context_bleed 校验 (参照 retain-pdf blocking issue): a translation that is
 * FAR longer than its source can support usually swallowed the injected
 * context (previous page tail / section heading) into the output. EN→ZH runs
 * ~1.1–1.6 hanzi per source word; 2.4× with a floor is safely above any
 * legitimate translation. Only meaningful when context was injected.
 */
export function looksContextBleed(source: string, translated: string, hadContext: boolean): boolean {
	if (!hadContext) {
		return false;
	}
	const words = (stripProtectable(source).match(/[A-Za-z]{2,}/g) ?? []).length;
	if (words < 8) {
		return false;
	}
	const cjk = (translated.match(CJK_RE) ?? []).length;
	return cjk > Math.max(80, words * 2.4);
}

/**
 * 翻译前估算排版容量: the character budget a block's ORIGINAL rectangles can
 * hold in the target script, sent with the FIRST request so most paragraphs fit
 * on the first try — instead of translate → measure-fail → compress → re-measure
 * round trips. Per line rect: width/font ≈ CJK columns; ×0.9 leaves margin for
 * the estimate being rough. Only prose body blocks with real geometry get a
 * budget, and only for CJK targets (Latin targets have no cheap width model).
 * Returns undefined when no sane estimate exists — the request simply omits it.
 */
export function initialCharBudget(block: SourceBlock, targetLang: string): number | undefined {
	if (!/^zh/i.test(targetLang)) {
		return undefined;
	}
	if (block.type !== 'paragraph' && block.type !== 'list') {
		return undefined;
	}
	const rects = block.lineRectsPdf;
	const font = block.fontSize ?? 0;
	if (!rects?.length || font <= 0) {
		return undefined;
	}
	let cols = 0;
	for (const r of rects) {
		const width = r[2] - r[0];
		if (width > 0) {
			cols += width / font;
		}
	}
	if (cols <= 0) {
		return undefined;
	}
	const budget = Math.floor(cols * 0.9);
	// A budget tighter than ~24 chars on real prose is noise, not guidance —
	// and would push the model into dropping facts. Skip it.
	return budget >= 24 ? budget : undefined;
}

/**
 * 段落级缓存 key: content + languages. Provider/model/prompt/glossary scoping
 * lives in the segment STORE the host injects (a different context reads a
 * different store), so the hash itself stays a pure content key.
 */
export function segmentHash(sourceText: string, sourceLang: string, targetLang: string): string {
	return fnv1a64(`${sourceText}\u0000${sourceLang}\u0000${targetLang}`);
}

/** Cap on residue re-translations per page — a safety valve against storms. */
const RESIDUE_MAX_PER_PAGE = 8;
/** 纯文本兜底: how many rejected blocks get a plain-mode rescue per page. */
const FINAL_RECOVERY_MAX = 4;
/** A run of this many consecutive plain-English words is untranslated prose. */
const RESIDUE_WORD_RUN = 6;

/**
 * 局部英文残留检测: does a (mostly-Chinese) translation still contain a run of
 * plain untranslated English prose? Six+ CONSECUTIVE lowercase English words is
 * essentially always a dropped clause — acronyms (ALLCAPS), drug/gene symbols
 * and proper nouns (Title-case) are excluded by the lowercase-only rule, URLs
 * and emails are stripped first, and a short Latin idiom ("in vitro", "et al")
 * is below the run threshold. Deliberately strict: a false positive costs one
 * wasted re-translation, so we only fire on a clear untranslated sentence.
 */
export function hasEnglishResidue(text: string): boolean {
	const cleaned = text.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+/gi, ' ');
	let run = 0;
	for (const tok of cleaned.split(/\s+/)) {
		const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
		if (/^[a-z]{2,}$/.test(w)) {
			run++;
			if (run >= RESIDUE_WORD_RUN) {
				return true;
			}
		}
		// 中性 token 不打断连跑 (2.5.12, wu2026-p4 实证): "with a standard ROI
		// area of 3 mm² for polyps ≥5 mm in diameter" 这段典型残留被 'a'(单字母
		// 不满足 {2,})、'ROI'(全大写)、'3'(纯数字)各重置一次,6 词连跑永远
		// 凑不满,夹生译文年久失修。数字/符号、单字母 (a, I)、全大写缩写
		// (ROI, CT, PCD-CT) 本就同时出现在残留英文与合格译文里,不是"已翻译"
		// 的证据 —— 既不计数也不重置。含 CJK 的 token 仍然重置: 中文字符才是
		// 真正的翻译证据,否则整段中文里零星散布的 6 个英文虚词会被误连成跑。
		else if (!/[㐀-鿿]/.test(tok)
			&& (w === '' || /^[A-Za-z]$/.test(w) || /^[A-Z]{2,}(?:-[A-Z0-9]+)*$/.test(w))) {
			// neutral: keep the run
		}
		else {
			run = 0;
		}
	}
	// 跨度规则 (retain-pdf _has_long_english_residue_span): a ≥10-word Latin
	// prose span — Title-Case words count too, which the lowercase run above
	// deliberately skips — that is NOT data-dense (NMR lines, numeric strings
	// stay exempt) is a dropped clause. Catches "The Results Showed That..."
	// style residue the run rule missed.
	return longEnglishResidueSpans(stripProtectable(cleaned), 10).length > 0;
}

/** CJK ideograph ranges used for the target-language ratio. */
const CJK_RE = /[㐀-鿿豈-﫿]/g;

/** A source with at least this many Latin words is prose worth validating. */
const PROSE_WORD_GATE = 6;
/** Below this CJK ratio on a prose source, the response was not really translated. */
const MIN_TARGET_RATIO = 0.45;

/**
 * 短源文分界 (1.1.8): 散文部分不超过这么多字符的块 —— 标题、小标题、署名行、
 * 图注标签 —— 走小样本安全的验收。真正的正文段落差着一个数量级(Horst 2024
 * 第 1 页的三段正文分别是 839 / 1783 / 1761 字符),永远走原来的比率阈值。
 */
const SHORT_SOURCE_PROSE_CHARS = 80;

/**
 * 「还没翻译的拉丁词」计数: 只算以小写字母开头的普通词。全大写缩写
 * (CT, PCD, MRI, MD, PhD) 与 Title-Case 专名 (Siemens, Naeotom, Siegel,
 * Ramirez-Giraldo) 在忠实译文里本来就该原样保留 —— 把它们算成「未翻译的
 * 拉丁词」正是短标题被反复拒收的直接原因。
 *
 * 注意首词效应: 句首的普通词也是 Title-Case, 所以这个计数在长段落上会偏低。
 * 它因此只用于 SHORT_SOURCE_PROSE_CHARS 以内的短块, 长段落仍用
 * targetLanguageRatio 的全量拉丁词计数。
 */
export function untranslatedLatinWords(text: string): number {
	return (text.match(/[A-Za-z][A-Za-z'-]+/g) ?? []).filter(w => /^[a-z]/.test(w)).length;
}

/**
 * 短源文的验收。两条,都比原来的比率判定更贴合小样本:
 *
 *  1. 专名直接放行: 源文里一个可译的普通词都没有(整块是人名、机构名、
 *     缩写、学位后缀 —— "Marilyn J. Siegel, MD • Juan Carlos Ramirez-Giraldo,
 *     PhD •" 就是这样的一行),那么原样返回就是正确答案,拒收只会白烧请求。
 *     这是 looksLikeAuthorNameList 的推广: 那条规则要求 ≥3 个人名分段,
 *     署名被拆到第二行只剩 2 个名字时就失效了。
 *  2. 否则仍看中文占比,但分母只数「还没翻译的普通词」。
 *
 * 关键不变量: 分子(中文字数)与原来一致,分母只会变小或不变,所以对短块
 * 而言这只可能把「拒」变成「收」,不可能反过来 —— 不存在新的误收路径。
 * 纯回声依然被拒: 回声里的普通词原封不动地留着,中文字数为 0,比率就是 0。
 */
function shortSourceTranslated(proseSource: string, proseTranslation: string): boolean {
	if (untranslatedLatinWords(proseSource) === 0) {
		return true;
	}
	const cjk = (proseTranslation.match(CJK_RE) ?? []).length;
	const residual = untranslatedLatinWords(proseTranslation);
	const denom = cjk + residual;
	if (denom === 0) {
		return false;
	}
	return cjk / denom >= MIN_TARGET_RATIO;
}

/**
 * Fraction of a Chinese translation that is actually Chinese: CJK characters
 * over (CJK characters + Latin words). A whole translation scores high (a few
 * embedded acronyms like PCCT/MRI are normal); a half-translated or mixed
 * response scores low; pure echoed English scores 0.
 */
function targetLanguageRatio(text: string): number {
	const cjk = (text.match(CJK_RE) ?? []).length;
	const latinWords = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
	const denom = cjk + latinWords;
	return denom === 0 ? 0 : cjk / denom;
}

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

export interface PageTranslationState {
	pageIndex: number;
	status: 'idle' | 'extracting' | 'translating' | 'done' | 'error' | 'no-text-layer';
	blocks: SourceBlock[];
	translations: Map<string, string>;
	error?: PaperMirrorError;
	fromCache?: boolean;
	/** When the 'extracting' phase began — guards against a stuck state. */
	extractingSince?: number;
	/**
	 * 页级诊断 (参照 retain-pdf translation_diagnostics): what this page's run
	 * actually cost. Feeds the 诊断导出 and the pane summary — screenshots stop
	 * being the only debugging channel.
	 */
	diagnostics?: PageDiagnostics;
	/**
	 * keep-origin 标记 (参照 retain-pdf dead-letter): block id → reason for
	 * blocks deliberately left in the original language — either the repair
	 * chain exhausted its budget ('unrecovered') or the segment failed twice
	 * before and is skipped to stop re-buying doomed requests
	 * ('repeated-failure'). 强制重译 clears the memory and tries again.
	 */
	keepOrigin?: Map<string, string>;
	/** 最近一次验收拒绝的原因 (仅原因码,无文本): validator | placeholder。 */
	rejectReasons?: Map<string, string>;
}

export interface PageDiagnostics {
	/** 逻辑批次数 (预算闸口径)。 */
	requests: number;
	/** 实际发出的 HTTP 尝试数,含请求级重试 (2.7.5);旧记录缺省。 */
	attempts?: number;
	salvage: number;
	rateLimited: number;
	timeouts: number;
	segmentHits: number;
	durationMs: number;
	fromCache: boolean;
	/** 占位符注册表 (1.1.2 诊断闭环): 本页签发 token 总数与校验拒绝次数。 */
	placeholderTokens?: number;
	placeholderRejected?: number;
	/** API token 用量 (2.7.0, 审核 F-2): 本页全部请求(含压缩重试/补救)的
	 *  服务商报告值之和;服务商不报用量时缺省。纯计数。 */
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
}

export interface TranslationDeps {
	/** Extract source blocks for a page (throws PaperMirrorError on failure). */
	extractPage(pageIndex: number): Promise<SourceBlock[]>;
	/**
	 * Fast current-page fallback that only reads the already-rendered text layer.
	 * Used after a PDF-worker extraction times out; it must not start another
	 * worker request for the same page.
	 */
	extractRenderedPage?(pageIndex: number): Promise<SourceBlock[]>;
	/** Perform one provider request. */
	translateRequest(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse>;
	/** Cache access; may be no-ops. */
	readCache(pageIndex: number, blocks: SourceBlock[]): Promise<TranslatedBlock[] | null>;
	writeCache(pageIndex: number, blocks: SourceBlock[], translations: TranslatedBlock[]): Promise<void>;
	/**
	 * 段落级缓存 (optional): batch-read/write individual segment translations by
	 * content hash. The page cache stays as the fast whole-page index; the
	 * segment store beneath it lets 普通刷新 re-request only the segments that
	 * actually changed or failed, and lets identical table cells / repeated
	 * paragraphs reuse their translation across pages.
	 */
	readSegments?(pageIndex: number, hashes: string[]): Promise<Map<string, string> | null>;
	writeSegments?(pageIndex: number, entries: { hash: string; translatedText: string }[]): Promise<void>;
	/**
	 * The provider LANE a page belongs to (its provider id). Lets the scheduler
	 * cap each provider independently and reserve a foreground slot for the
	 * current page's provider. Omitted → single shared lane (old behaviour).
	 */
	laneFor?(pageIndex: number): string;
	/** Config snapshot getters. */
	getLanguages(sampleText: string): { source: string; target: string };
	getDocumentTitle(): string;
	getGlossary(): GlossaryRule[];
	/** 不译词列表 — masked via placeholders before every request. */
	getNoTranslate?(): string[];
	useContext(): boolean;
	pageCount(): number;
}

export interface ManagerEvents {
	onPageUpdate(state: PageTranslationState): void;
	/**
	 * 熔断: fired at most once per page when a provider leaves >25% of a chunk
	 * untranslated after batch + retry. The host may switch this page's
	 * subsequent requests to a backup engine (provider pool rotation).
	 */
	onProviderUnstable?(pageIndex: number, missingRatio: number): void;
}

export class TranslationManager {
	private deps: TranslationDeps;
	private events: ManagerEvents;
	private scheduler: RequestScheduler;
	/** 每服务商「真实在途 HTTP 请求」闸 (2.1.8): 页面 lane 只限并发页数,页内
	 *  CHUNK_CONCURRENCY/补救仍会放大成 2N~4N 个请求打向同一服务商;此闸把每
	 *  服务商在途请求收到 ≈ 其页面并发上限,当前页请求优先出手。 */
	private requestGate = new RequestGate();
	private pages = new Map<number, PageTranslationState>();
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
	private usage = {
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
	/** 按页的 token 用量(页索引 0 起),诊断导出时并进 pages[].metrics。 */
	private pageTokens = new Map<number, TokenUsage>();

	/**
	 * 经计量的服务商调用 (2.7.0): 两条请求路径(整页运行与压缩重译/单块重译)
	 * 都从这里出去,响应里的用量按页累加。只碰数字,响应正文原样透传。
	 */
	private async meteredTranslate(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse> {
		const response = await this.deps.translateRequest(request, signal);
		if (response.usage) {
			this.usageReports++;
			addUsage(this.tokenUsage, response.usage);
			if (typeof request.pageIndex === 'number') {
				const page = this.pageTokens.get(request.pageIndex) ?? emptyUsage();
				addUsage(page, response.usage);
				this.pageTokens.set(request.pageIndex, page);
			}
		}
		else {
			this.usageMissing++;
		}
		return response;
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

	constructor(deps: TranslationDeps, events: ManagerEvents, options?: { maxConcurrent?: number; reservedForeground?: number; prefetch?: boolean; delayFn?: (ms: number) => Promise<void>; extractTimeoutMs?: number; prefetchDebounceMs?: number }) {
		this.deps = deps;
		this.events = events;
		this.extractTimeoutMs = options?.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS;
		this.prefetchEnabled = options?.prefetch ?? true;
		this.prefetchDebounceMs = Math.max(0, options?.prefetchDebounceMs ?? 500);
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
		for (const [lane, spec] of Object.entries(caps)) {
			const pageCap = typeof spec === 'number' ? spec : spec.max;
			this.requestGate.setCap(lane, Math.max(2, Math.floor(pageCap)));
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

	/**
	 * Strict in-place replacement's compress-and-retry: the listed blocks'
	 * translations did not fit their fixed rectangles, so they are re-requested
	 * WITH a character budget (the prompt demands denser phrasing, never
	 * dropped facts). A retry is ACCEPTED only when it is actually shorter than
	 * the translation it would replace — a service that echoes back the same or
	 * a longer string must not overwrite a good result and waste the round.
	 *
	 * Accepted translations are merged into the page state and cache and RETURNED
	 * (id → new text) so the caller can patch just those nodes in the live page.
	 * This does NOT notify/re-render the whole page — that would make every
	 * already-fitting block flicker English→Chinese on each compress round.
	 */
	async compressBlocks(pageIndex: number, entries: { id: string; maxChars: number }[]): Promise<Map<string, string>> {
		const accepted = new Map<string, string>();
		const state = this.pages.get(pageIndex);
		if (this.disposed || !state || state.status !== 'done' || !entries.length) {
			return accepted;
		}
		const wanted = new Map(entries.map(e => [e.id, e.maxChars]));
		const blocks = state.blocks.filter(b => wanted.has(b.id));
		if (!blocks.length) {
			return accepted;
		}
		const sampleText = blocks.map(b => b.sourceText).join('\n').slice(0, 4000);
		const { source, target } = this.deps.getLanguages(sampleText);
		try {
			await this.scheduler.enqueue(`page-${pageIndex}-compress`, PRIORITY.CURRENT_COMPRESS, async (signal) => {
				const protectedBlocks = blocks.map((block) => {
					const reg = PlaceholderRegistry.protect(block.sourceText, this.literalsFor(block), block.styleRuns);
					return { block, reg, text: reg.text };
				});
				const request: TranslationRequest = {
					pageIndex,
					sourceLanguage: source,
					targetLanguage: target,
					documentTitle: this.deps.getDocumentTitle(),
					previousContext: '',
					blocks: protectedBlocks.map(pb => ({
						id: pb.block.id,
						type: pb.block.type,
						text: pb.text,
						charBudget: wanted.get(pb.block.id)
					})),
					glossary: this.glossaryFor(blocks.map(b => b.sourceText))
				};
				const response = await this.requestGate.run(this.laneFor(pageIndex), true, () => this.meteredTranslate(request, signal), signal);
				for (const t of response.translations) {
					const pb = protectedBlocks.find(p => p.block.id === t.id);
					if (!pb || !t.translatedText.trim()) {
						continue;
					}
					const restored = pb.reg.restore(t.translatedText);
					const previous = state.translations.get(t.id);
					// Only accept a genuinely shorter retry; equal/longer output
					// cannot help it fit and would burn the result for nothing.
					if (previous !== undefined && restored.length >= previous.length) {
						continue;
					}
					state.translations.set(t.id, restored);
					accepted.set(t.id, restored);
				}
				if (accepted.size) {
					// 孤儿 compress 不落盘 (2.0.7, 审核 P2-2): 压缩请求可飞 120s,
					// 期间用户可能已「刷新本页」—— 新运行接管该页并写入了新缓存。
					// 此闭包捕获的是**旧** state: 若它已不是当前状态,写盘会用旧
					// 译文覆写刷新后的页面缓存与段落库(写队列串行、后写者胜),
					// 表现为「反复刷新反复回退」。
					if (this.pages.get(pageIndex) !== state) {
						logger.debug(MODULE, `Page ${pageIndex + 1}: compress finished after supersession; not persisted`);
						return;
					}
					logger.info(MODULE, `Page ${pageIndex + 1}: ${accepted.size} block(s) re-translated shorter under budget`);
					const all: TranslatedBlock[] = state.blocks
						.filter(b => state.translations.has(b.id))
						.map(b => ({ id: b.id, translatedText: state.translations.get(b.id)! }));
					// Only a COMPLETE page enters the page cache (审核 P1): this
					// path can run while some blocks are keep-origin — writing the
					// partial set used to freeze the page as a cache entry that hit
					// and went straight to done with those blocks left in English.
					const complete = state.blocks.every(b =>
						b.translationMode === 'preserve' || state.translations.has(b.id));
					if (complete) {
						await this.deps.writeCache(pageIndex, state.blocks, all);
					}
					// The SHORTER (fitting) version replaces the long one in the
					// segment store too, so a 普通刷新 does not resurrect a
					// translation that already failed placement once.
					if (this.deps.writeSegments) {
						const byId = new Map(blocks.map(b => [b.id, b]));
						// 同上 (2.5.9): 压缩任务跑在**前台 lane** 上,更不该拿
						// 槽位去等落盘。
						this.trackWrite(this.deps.writeSegments(pageIndex, [...accepted]
							.filter(([id]) => byId.has(id))
							.map(([id, text]) => ({
								hash: segmentHash(byId.get(id)!.sourceText, source, target),
								translatedText: text
							}))
						));
					}
				}
			}, { foreground: true, lane: this.laneFor(pageIndex) }); // compress serves the VISIBLE page's layout
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
				return accepted;
			}
			logger.warn(MODULE, 'compressBlocks failed', e);
		}
		return accepted;
	}

	/**
	 * Re-translate a page. Three strategies (刷新分级):
	 *  - 'normal' (圆环刷新本页): bypass the PAGE cache but reuse the segment
	 *    store — qualified segment translations come back instantly and only
	 *    untranslated / previously-invalid segments cost new requests.
	 *  - 'rotate' (2.0.8, 审核 P2-6 — 引擎轮换后的刷新): bypass the segment
	 *    store too, but keep the global 止损 memory. P2-16 之后段落 context 用
	 *    规范引擎(不含轮换偏移),轮换不再改变 context —— 'normal' 刷新会把
	 *    旧引擎的全部合格段落原样读回,零请求发向新引擎,「换一家重译」实质
	 *    失效。'rotate' 让新引擎真正重译本页,又不像 'force' 那样清全局止损。
	 *  - 'force' (强制重译): bypass both caches — every segment re-requests,
	 *    全局止损记忆一并清零。
	 */
	async retranslatePage(pageIndex: number, mode: 'normal' | 'rotate' | 'force' = 'normal'): Promise<void> {
		// 审核 P1: an EXPLICIT refresh of this page clears its blocks' 止损 memory
		// — the user asked for a retry, so the skipped segments get one. Cross-page
		// duplicates of the same hash on OTHER pages keep their memory.
		const prior = this.pages.get(pageIndex);
		if (prior?.blocks.length) {
			try {
				const sample = prior.blocks.map(b => b.sourceText).join('\n').slice(0, 4000);
				const { source, target } = this.deps.getLanguages(sample);
				for (const b of prior.blocks) {
					this.failedSegments.delete(segmentHash(b.sourceText, source, target));
				}
			}
			catch { /* language resolution is best-effort here */ }
		}
		this.pages.delete(pageIndex);
		this.unstableFired.delete(pageIndex); // a fresh run may report anew
		if (mode === 'force') {
			// 强制重译 gives every keep-origin segment a fresh chance, and drops the
			// page's zombie so a full-quality worker extraction may run again.
			this.failedSegments.clear();
			this.extractZombies.delete(pageIndex);
		}
		// 必须等旧任务真正结束再重新排 (审核 P1-8): cancel() 对运行中的任务只发
		// abort,它要等 run() reject 后才离开 active。此前这里是同步 cancel +
		// 立即 ensurePage,于是 ensurePage 的 isScheduled 仍为真而被挡回 ——
		// 页面状态已删、新任务没入队,该页彻底不翻译(用户表现: 点了圆环什么
		// 都没发生,必须再点一次)。
		await this.scheduler.cancelAndWait(`page-${pageIndex}`);
		// 同时取消在飞的 compress (2.0.7, 审核 P2-2): 它不在主键下,漏掉时其
		// 完成回调会用旧 state 覆写刷新后的缓存(写盘处另有身份校验兜底)。
		await this.scheduler.cancelAndWait(`page-${pageIndex}-compress`);
		if (this.disposed) {
			return;
		}
		await this.ensurePage(pageIndex, PRIORITY.CURRENT_RETRANSLATE, {
			bypassCache: true,
			bypassSegments: mode === 'force' || mode === 'rotate',
			foreground: true
		});
	}

	/**
	 * 单段重译 (右键"重译此段"): one block, one request, foreground priority.
	 * Clears the block's keep-origin mark and 止损 memory so the retry is real,
	 * updates state + caches, notifies once. Returns whether a valid
	 * translation landed.
	 */
	async retranslateBlock(pageIndex: number, blockId: string): Promise<boolean> {
		const state = this.pages.get(pageIndex);
		const block = state?.blocks.find(b => b.id === blockId);
		if (this.disposed || !state || !block) {
			return false;
		}
		const { source, target } = this.deps.getLanguages(block.sourceText);
		const reg = PlaceholderRegistry.protect(block.sourceText, this.literalsFor(block), block.styleRuns);
		const text = reg.text;
		this.failedSegments.delete(segmentHash(block.sourceText, source, target));
		try {
			return await this.scheduler.enqueue(`page-${pageIndex}-seg-${blockId}`, PRIORITY.CURRENT_RETRANSLATE, async (signal) => {
				// 2.7.5 (审核 P2): 单段重译也走计量入口 —— 此前绕过 meteredTranslate,
				// 一次重译的 token 从诊断里消失。
				const resp = await this.requestGate.run(this.laneFor(pageIndex), true, () => this.meteredTranslate({
					pageIndex,
					sourceLanguage: source,
					targetLanguage: target,
					documentTitle: this.deps.getDocumentTitle(),
					previousContext: '',
					blocks: [{ id: block.id, type: block.type, text }],
					glossary: this.glossaryFor([block.sourceText])
				}, signal), signal);
				const hit = resp.translations.find(t =>
					looksTranslated(block.sourceText, t.translatedText, target)
					&& reg.ok(t.translatedText));
				if (!hit) {
					return false;
				}
				const restored = reg.restore(hit.translatedText);
				state.translations.set(blockId, restored);
				state.keepOrigin?.delete(blockId);
				this.docMemory.learn(extractTermPairs(block.sourceText, restored));
				this.notify(state);
				if (this.deps.writeSegments) {
					await this.deps.writeSegments(pageIndex, [{
						hash: segmentHash(block.sourceText, source, target),
						translatedText: restored
					}]).catch(() => { /* best effort */ });
				}
				// preserve 块永远不会进 translations(表格数据单元格等按设计保留
				// 原文),所以完整性判据必须给它们豁免 —— 否则任何含表格的页面上
				// 这个条件恒假,「重译此段」的新译文永远写不进页面缓存
				// (审核 P2-11)。表现是: 重译当场生效,重开文档却又回到旧译文
				// (页面缓存完整命中后直接 done,根本不读段落库),反复重译反复丢失。
				// 与 compressBlocks 路径的判据保持一致。
				const pageComplete = state.blocks.every(b =>
					b.translationMode === 'preserve' || state.translations.has(b.id));
				if (pageComplete) {
					await this.deps.writeCache(pageIndex, state.blocks, state.blocks
						.filter(b => state.translations.has(b.id))
						.map(b => ({ id: b.id, translatedText: state.translations.get(b.id)! })))
						.catch(() => { /* best effort */ });
				}
				return true;
			}, { foreground: true, lane: this.laneFor(pageIndex), maxRetries: 0 });
		}
		catch (e) {
			if (!(e instanceof PaperMirrorError && e.code === 'CANCELLED')) {
				logger.warn(MODULE, `retranslateBlock failed for ${blockId}`, e);
			}
			return false;
		}
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
				.map(s => ({
					page: s.pageIndex + 1,
					status: s.status,
					error: s.error?.code ?? null,
					metrics: s.diagnostics
						? {
							...s.diagnostics,
							...((): Partial<PageDiagnostics> => {
								const t = this.pageTokens.get(s.pageIndex);
								return t
									? { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cachedInputTokens: t.cachedInputTokens }
									: {};
							})()
						}
						: null,
					blocks: s.blocks.map(b => ({
						id: b.id,
						type: b.type,
						chars: b.sourceText.length,
						// 'preserved' (2.3.7, 基线口径修正): preserve 块(数据单元格等)
						// **有意**不翻译,此前显示 'untranslated' —— 表格密集页看起来
						// 一片失败,实际全是保护性保留。诊断从此与 placement 的
						// tableIntentional 对得上号。
						state: s.translations.has(b.id)
							? 'translated'
							: b.translationMode === 'preserve'
								? 'preserved'
								: (s.keepOrigin?.get(b.id) ?? 'untranslated'),
						...(s.rejectReasons?.has(b.id) && !s.translations.has(b.id)
							? { lastReject: s.rejectReasons.get(b.id) }
							: {})
					}))
				})),
			docMemoryTerms: this.docMemory.size(),
			// 用量统计 (2.3.9): 纯计数,不含文本。比率现算,分母为 0 时省略。
			usage: {
				pageCacheLookups: this.usage.pageCacheLookups,
				pageCacheFullHits: this.usage.pageCacheFullHits,
				pageCachePartialHits: this.usage.pageCachePartialHits,
				...(this.usage.pageCacheLookups
					? { pageCacheHitRate: Number((this.usage.pageCacheFullHits / this.usage.pageCacheLookups).toFixed(3)) }
					: {}),
				segmentLookups: this.usage.segmentLookups,
				segmentHits: this.usage.segmentHits,
				...(this.usage.segmentLookups
					? { segmentHitRate: Number((this.usage.segmentHits / this.usage.segmentLookups).toFixed(3)) }
					: {}),
				prefetchedPages: this.usage.prefetchedPages.size,
				prefetchedUnviewed: this.usage.prefetchedUnviewed.size,
				// token 用量 (2.7.0, 审核 F-2): 服务商报告值之和;usageReports /
				// usageMissing 说明有多少请求带/不带用量字段(免费引擎多半不带)。
				inputTokens: this.tokenUsage.inputTokens,
				outputTokens: this.tokenUsage.outputTokens,
				cachedInputTokens: this.tokenUsage.cachedInputTokens,
				usageReports: this.usageReports,
				usageMissing: this.usageMissing
			}
		};
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
		await this.scheduler.cancelAllAndWait();
		// 已发出但还没落盘的段落写入也要等 (2.5.9): 它们不再阻塞调度槽,
		// 清盘前必须在这里收口,否则就是 2.0.7 修过的那条竞态。
		await this.flushPendingWrites();
		this.pages.clear();
		this.unstableFired.clear();
		this.docMemory.clear();
		// 同 resetAll (P3): 全量重置必须包含止损记忆。
		this.failedSegments.clear();
		this.extractZombies.clear();
	}

	cancelAll(): void {
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

	private notify(state: PageTranslationState): void {
		if (!this.disposed) {
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
		const existing = this.pages.get(pageIndex);
		if (existing && (existing.status === 'done' || existing.status === 'translating')) {
			return;
		}
		// A page may legitimately be mid-extraction — but a state STUCK there
		// past twice the extraction timeout is a zombie (the bug behind 每页必点
		// 圆环): fall through and replace it instead of early-returning forever.
		if (existing?.status === 'extracting'
			&& Date.now() - (existing.extractingSince ?? Date.now()) < this.extractTimeoutMs * 2) {
			return;
		}
		if (this.scheduler.isScheduled(jobKey)) {
			return;
		}

		const state: PageTranslationState = {
			pageIndex,
			status: 'extracting',
			blocks: [],
			translations: new Map(),
			extractingSince: Date.now()
		};
		const navigationAtStart = this.navigationGeneration;
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
			let blocks: SourceBlock[];
			try {
				const zombie = this.extractZombies.get(pageIndex);
				if (zombie && this.deps.extractRenderedPage) {
					// Never start a second PDF-worker extraction while the timed-out
					// one is still alive. The visible page can still be recovered from
					// its rendered text layer (timeout-guarded like any extraction).
					if (pageIndex !== this.currentPage) {
						this.pages.delete(pageIndex);
						return;
					}
					blocks = await this.renderedWithRetry(pageIndex);
					if (!blocks.length) {
						// 1.0.3 修复 (到页仍要点圆环): the user often ARRIVES at the
						// page before its text layer exists — the old code marked the
						// empty result "done" and the page could never auto-translate
						// again. Surface a retryable error instead.
						state.status = 'error';
						state.error = new PaperMirrorError('EXTRACTION_FAILED',
							`第 ${pageIndex + 1} 页文字层尚未就绪,稍后自动重试或点击刷新。`, { retryable: true });
						this.notify(state);
						return;
					}
				}
				else {
					blocks = await this.withExtractionSlot(pageIndex,
						() => this.withExtractTimeout(this.deps.extractPage(pageIndex), pageIndex));
				}
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
							blocks = rendered;
							logger.info(MODULE, `Page ${pageIndex + 1}: recovered timed-out extraction from rendered text layer`);
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
							return;
						}
					}
					else {
						if (this.pages.get(pageIndex) === state) {
							this.pages.delete(pageIndex);
						}
						logger.warn(MODULE, `Page ${pageIndex + 1}: extraction timed out after ${this.extractTimeoutMs} ms — released for automatic retry on next visit`);
						return;
					}
				}
				else {
					throw err; // real extraction errors keep their error/no-text-layer states
				}
			}
			if (this.disposed || this.pages.get(pageIndex) !== state) {
				return; // superseded while extracting
			}
			if (navigationAtStart !== this.navigationGeneration
				&& !this.wantedPages().includes(pageIndex)) {
				this.pages.delete(pageIndex);
				return;
			}
			state.blocks = blocks;
			if (!blocks.length) {
				state.status = 'done';
				this.notify(state);
				return;
			}

			await this.scheduler.enqueue(`page-${pageIndex}`, priority, async (signal) => {
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
					await this.translatePage(state, local.signal, { bypassPageCache: options?.bypassCache ?? false, bypassSegments: options?.bypassSegments ?? false }, heartbeat, blocks);
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
			}, {
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
				// Reset so a later visit retries silently
				if (this.pages.get(pageIndex) === state && state.status !== 'done') {
					this.pages.delete(pageIndex);
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

	/**
	 * 局部英文残留补译: re-translate ONLY the blocks whose (accepted) translation
	 * still contains an untranslated English clause. Single-block requests, capped
	 * per page; a retry replaces the block ONLY if it clears the residue, so we
	 * never churn a block into an equally-bad result. Patches state + results
	 * (which then flow to the caches) and notifies once — the page is not
	 * re-extracted or wholesale re-rendered.
	 */
	private async resolveEnglishResidue(
		state: PageTranslationState,
		blocks: SourceBlock[],
		results: TranslatedBlock[],
		source: string,
		target: string,
		signal: AbortSignal,
		translateFn: (req: TranslationRequest, sig: AbortSignal) => Promise<TranslationResponse>,
		canSpend?: () => boolean
	): Promise<void> {
		if (!/^zh/i.test(target)) {
			return; // the detector is English-into-Chinese specific
		}
		const suspects = blocks
			.filter(b => hasEnglishResidue(state.translations.get(b.id) ?? ''))
			.slice(0, RESIDUE_MAX_PER_PAGE);
		if (!suspects.length) {
			return;
		}
		logger.warn(MODULE, `Page ${state.pageIndex + 1}: ${suspects.length} block(s) with English residue → local re-translate`);
		let fixed = 0;
		for (const block of suspects) {
			if (signal.aborted) {
				throw new PaperMirrorError('CANCELLED', 'cancelled');
			}
			// Budget check INSIDE the loop: residue repair shares the page's request
			// cap and stops the moment it is exhausted (it used to be able to append
			// up to 8 uncounted serial round-trips after a page-cap hit).
			if (canSpend && !canSpend()) {
				logger.warn(MODULE, `Page ${state.pageIndex + 1}: request cap reached — stopping residue repair (${fixed} fixed)`);
				break;
			}
			const reg = PlaceholderRegistry.protect(block.sourceText, this.literalsFor(block), block.styleRuns);
			const text = reg.text;
			try {
				const resp = await translateFn({
					pageIndex: state.pageIndex,
					sourceLanguage: source,
					targetLanguage: target,
					documentTitle: this.deps.getDocumentTitle(),
					previousContext: '',
					blocks: [{ id: block.id, type: block.type, text }],
					glossary: this.glossaryFor([block.sourceText])
				}, signal);
				const hit = resp.translations.find(t => looksTranslated(block.sourceText, t.translatedText, target)
					&& reg.ok(t.translatedText));
				if (!hit) {
					continue;
				}
				const restored = reg.restore(hit.translatedText);
				// Replace ONLY when the retry actually cleared the residue.
				if (hasEnglishResidue(restored)) {
					continue;
				}
				state.translations.set(block.id, restored);
				const existing = results.find(r => r.id === block.id);
				if (existing) {
					existing.translatedText = restored;
				}
				else {
					results.push({ id: block.id, translatedText: restored });
				}
				fixed++;
			}
			catch (e) {
				if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
					throw e;
				}
				logger.warn(MODULE, `residue re-translate failed for ${block.id}`, e);
			}
		}
		if (fixed) {
			this.notify(state);
		}
	}

	private async translatePage(state: PageTranslationState, signal: AbortSignal, bypass: { bypassPageCache: boolean; bypassSegments: boolean }, heartbeat?: () => void, preBlocks?: SourceBlock[]): Promise<void> {
		const pageIndex = state.pageIndex;
		const beat = heartbeat ?? ((): void => { /* no idle watchdog (tests) */ });
		// 真实性能指标 (per page): how many provider round-trips this page cost
		// and how many were salvage. High salvage counts point at fragment-heavy
		// grouping or an id-dropping provider — the log tells which.
		// requestCount = 逻辑批次 (预算闸 canSpend 的口径); attemptCount = 实际发出的
		// HTTP 尝试 (含请求级重试, 2.7.5 审核 P2) —— 两次 429 后成功是 1 批 / 3 次。
		const metrics = { requestCount: 0, attemptCount: 0, salvageCount: 0, rateLimited: 0, timeouts: 0, startedAt: Date.now() };
		// 止损轮次序号 (P3): 本运行的发起顺序,见 failedSegments 注释。
		const runId = ++this.runSeq;
		const countedTranslate = async (request: TranslationRequest, sig: AbortSignal): Promise<TranslationResponse> => {
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
				metrics.attemptCount++;
				try {
					const response = await this.requestGate.run(
						lane, pageIndex === this.currentPage, () => this.meteredTranslate(request, sig), sig);
					beat(); // progress: a request finished → re-arm the idle watchdog
					this.scheduler.laneFeedback(lane, 'success');
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
						this.scheduler.laneFeedback(lane, 'rate');
					}
					else if (err.code === 'TIMEOUT') {
						metrics.timeouts++;
						this.scheduler.laneFeedback(lane, 'timeout');
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
		};

		// 1. Extract — normally already done OUTSIDE the provider lane by
		// ensurePage (preBlocks); the inline path remains for direct callers.
		const blocks = preBlocks ?? await this.deps.extractPage(pageIndex);
		beat();
		if (signal.aborted) {
			throw new PaperMirrorError('CANCELLED', 'cancelled');
		}
		state.blocks = blocks;
		if (!blocks.length) {
			state.status = 'done';
			this.notify(state);
			return;
		}
		const activeBlocks = blocks.filter(b => b.translationMode !== 'preserve');
		if (!activeBlocks.length) {
			state.status = 'done';
			this.notify(state);
			return;
		}

		const sampleText = activeBlocks.map(b => b.sourceText).join('\n').slice(0, 4000);
		const { source, target } = this.deps.getLanguages(sampleText);
		const glossary = this.glossaryFor(activeBlocks.map(b => b.sourceText));
		const sourceById = new Map(activeBlocks.map(b => [b.id, b.sourceText]));
		// Accept a response only if it is actually translated (not echoed English).
		const accept = (id: string, text: string): boolean =>
			text.trim().length > 0 && looksTranslated(sourceById.get(id) ?? '', text, target);

		// 2. Cache — a hit is only COMPLETE when every active block has a usable
		// translation (审核 P1): the file being valid never meant it covered the
		// page. A partial entry (e.g. written by the compress path while some
		// blocks were keep-origin) used to flip the page straight to done with
		// blocks silently left in English. Now: cached ids that no longer exist
		// are dropped, every entry must still pass the same accept() gate as a
		// live response, and an incomplete hit only PREFILLS — the rest of the
		// pipeline translates the missing blocks (toTranslate skips prefilled).
		if (!bypass.bypassPageCache) {
			this.usage.pageCacheLookups++;
			const cached = await this.deps.readCache(pageIndex, blocks);
			if (cached) {
				const cachedById = new Map(cached.map(t => [t.id, t.translatedText]));
				let usable = 0;
				for (const block of activeBlocks) {
					const text = cachedById.get(block.id);
					if (typeof text === 'string' && accept(block.id, text)) {
						state.translations.set(block.id, text);
						usable++;
					}
				}
				if (usable === activeBlocks.length) {
					this.usage.pageCacheFullHits++;
					state.status = 'done';
					state.fromCache = true;
					state.diagnostics = {
						requests: 0, salvage: 0, rateLimited: 0, timeouts: 0,
						segmentHits: 0, durationMs: Date.now() - metrics.startedAt, fromCache: true
					};
					this.notify(state);
					return;
				}
				if (usable) {
					this.usage.pageCachePartialHits++;
					logger.info(MODULE, `Page ${pageIndex + 1}: partial cache (${usable}/${activeBlocks.length}) — prefilled, translating the rest`);
					this.notify(state); // show reused blocks immediately
				}
			}
		}

		// 3. Translate chunk by chunk
		state.status = 'translating';
		this.notify(state);

		// 2.5 段落级缓存: prefill whatever segments this context has already
		// translated (content+language hash; provider/model scoping lives in the
		// store the host injects). 普通刷新 re-enters here with the page cache
		// bypassed but segments live, so only the segments that actually failed
		// or changed cost a request. 'force' skips this entirely.
		const segHash = (b: SourceBlock): string => segmentHash(b.sourceText, source, target);
		let segmentHits = 0;
		if (!bypass.bypassSegments && this.deps.readSegments) {
			this.usage.segmentLookups += activeBlocks.length;
			const cached = await this.deps.readSegments(pageIndex, activeBlocks.map(segHash)).catch(() => null);
			if (cached?.size) {
				for (const block of activeBlocks) {
					const hit = cached.get(segHash(block));
					if (hit !== undefined && accept(block.id, hit)) {
						state.translations.set(block.id, hit);
						segmentHits++;
					}
				}
				if (segmentHits) {
					this.usage.segmentHits += segmentHits;
					this.notify(state); // show reused segments immediately
				}
			}
		}
		// keep-origin 止损: segments that already failed two whole runs are left
		// in the original language instead of burning the same requests again.
		const keepOrigin = new Map<string, string>();
		state.keepOrigin = keepOrigin;
		const toTranslate = activeBlocks.filter((b) => {
			if (state.translations.has(b.id)) {
				return false;
			}
			if ((this.failedSegments.get(segHash(b))?.count ?? 0) >= 2) {
				keepOrigin.set(b.id, 'repeated-failure');
				return false;
			}
			return true;
		});
		// 同页相同内容去重 (2.3.5, 第四批 item7 · API-2): 同一页里 sourceText 完全
		// 相同的块(模板化表头/重复短语/密集表格)只把**代表块**送去翻译,其余
		// 同文块在代表译文到达时镜像共享 —— 省下重复块的输入+输出 token,零风险
		// (segHash = 内容+语言,与段落缓存同一把键)。代表失败时同文块同样保留
		// 原文,诚实计入 untranslated。
		const dupOf = new Map<string, string[]>();
		const uniqueToTranslate: SourceBlock[] = [];
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
				segmentHits, durationMs: Date.now() - metrics.startedAt, fromCache: false
			};
			this.notify(state);
			logger.info(MODULE, `Page ${pageIndex + 1}: fully served from the segment cache (${segmentHits} segment(s), 0 requests)`);
			if (pageIndex === this.currentPage) {
				this.schedulePrefetch();
			}
			// 不完整页不落页面缓存 (2.0.6, 审核 P3): keepOrigin 非空意味着有段落
			// 被止损跳过 —— 把这样的页写进页面缓存,下次打开会当作完整命中直接
			// 采用,被跳过的段落即使止损记忆早已清空也永远不再重试。与主路径
			// 「a page with unrecovered blocks is NOT cached」同一条规则。
			if (keepOrigin.size === 0) {
				await this.deps.writeCache(pageIndex, blocks, activeBlocks
					.filter(b => state.translations.has(b.id))
					.map(b => ({ id: b.id, translatedText: state.translations.get(b.id)! })));
			}
			return;
		}

		// Protect formulas / citations / statistics per block (+ 不译词列表) —
		// 占位符注册表 (1.1.0): 掩蔽/校验/还原共用同一实例,清单不可能串块。
		const protectedBlocks = uniqueToTranslate.map((block) => {
			const reg = PlaceholderRegistry.protect(block.sourceText, this.literalsFor(block), block.styleRuns);
			return { block, reg, text: reg.text };
		});
		// 占位符清单校验 (参照 retain-pdf): a model response that LOST a protected
		// token (or invented one) is treated as invalid — it flows into the same
		// retry/salvage chain as a missing id, instead of silently restoring into
		// a paragraph with the formula/citation gone.
		const regById = new Map(protectedBlocks.map(p => [p.block.id, p.reg]));
		// 拒绝原因埋点 (1.1.3): unrecovered 只说"没救回来",不说"为什么每次都被
		// 拒" —— 记住每块最近一次验收失败的原因码(validator = looksTranslated/
		// 完整性;placeholder = 清单校验),进诊断导出。
		state.rejectReasons = state.rejectReasons ?? new Map();
		const acceptResponse = (id: string, text: string): boolean => {
			// 'empty' 与 'validator' 分开 (1.1.8): 引擎带着 id 回了一个空串,
			// 和「回了英文回声被验收拒掉」是两种完全不同的故障 —— 前者要换
			// 请求形态(纯文本兜底),后者要换措辞。混成一个原因码时,诊断里
			// 一个 11 字符的块显示 lastReject: "validator" 会把人引向阈值,
			// 而阈值那条路对它根本不成立(散文词数不足 6,压根走不到比率判定)。
			if (!text.trim()) {
				state.rejectReasons!.set(id, 'empty');
				return false;
			}
			if (!accept(id, text)) {
				state.rejectReasons!.set(id, 'validator');
				return false;
			}
			const reg = regById.get(id);
			if (reg && !reg.ok(text)) {
				state.rejectReasons!.set(id, 'placeholder');
				return false;
			}
			return true;
		};

		// Plan requests: semantic modules are SOFT boundaries (context tags), the
		// character budget is the real request boundary — a page with many short
		// subheadings packs into 1–2 high-fill requests, not 4–8 half-empty ones.
		// 三分道: tables, very long paragraphs and formula-dense blocks are
		// isolated into single-block 'slow' chunks appended after the fast
		// batches — one hard block can no longer sink a whole batch (id drift,
		// truncation) or delay the fast batches that paint most of the page.
		const maskedById = new Map(protectedBlocks.map(p => [p.block.id, p.text]));
		const riskOf = (b: SourceBlock): boolean => {
			const ph = regById.get(b.id)?.count ?? 0;
			return b.type === 'table'
				|| b.sourceText.length > 2400
				|| ph >= 5
				// 评分路由 (retain-pdf segment_risk): 定义句 + 公式密集 + 占位符
				// 前置的组合比单纯计数更早识别高风险块。
				|| isFormulaDenseRisk(maskedById.get(b.id) ?? b.sourceText, ph);
		};
		const chunks = planChunks(uniqueToTranslate, buildLayoutModules(uniqueToTranslate), { riskOf });
		// Hard ceiling on requests for this page so a misbehaving engine can never
		// turn one page into a request storm: 2× the planned chunks, plus 2. Once
		// hit, salvage stops and the remaining blocks are left for 「刷新本页」.
		const pageRequestCap = chunks.length * 2 + 2;
		const canSpend = (): boolean => metrics.requestCount < pageRequestCap;
		/**
		 * 兜底预算 (1.1.8, Horst 2024 第 1 页实证): pageRequestCap 由 chunk 数
		 * 推导,单 chunk 的页面只有 4 次 —— 批次(1) + 缺 id 重试(1) + 两次
		 * 单块打捞(2) 就正好用尽,该页 metrics 记的就是 requests:4 / salvage:2。
		 * 于是纯文本兜底 —— 修复链里唯一不受 id 漂移与 JSON 损坏影响的一环 ——
		 * 永远轮不到,三个块直接落进 unrecovered。给它单独留一份不与打捞共享的
		 * 预算。上限是硬的: 整页最多多花 FINAL_RECOVERY_MAX 次请求,且该路径
		 * 自身还有 attempts >= FINAL_RECOVERY_MAX 的计数闸,两道闸都在。
		 */
		const canSpendFinal = (): boolean => metrics.requestCount < pageRequestCap + FINAL_RECOVERY_MAX;
		const results: TranslatedBlock[] = [];
		let untranslatedCount = 0;
		// API-2 镜像: 代表块的译文一到,同文重复块立即共享(渐进渲染同帧可见);
		// 结尾还有一次全量 sweep 兜住 salvage/纯文本兜底等晚到路径。
		const mirrorDuplicates = (repId: string): void => {
			const dups = dupOf.get(repId);
			if (!dups) {
				return;
			}
			const t = state.translations.get(repId);
			if (t === undefined) {
				return;
			}
			for (const d of dups) {
				if (!state.translations.has(d)) {
					state.translations.set(d, t);
					results.push({ id: d, translatedText: t });
				}
			}
		};

		// Context is derived from SOURCE text only (audit-verified: nothing in a
		// request reads a prior chunk's RESPONSE), so it is precomputable and the
		// chunks can safely run concurrently. Slow chunks sit OUT of reading
		// order at the tail, so they neither receive positional context nor
		// provide it — an isolated hard block doesn't need its neighbour's tail,
		// and a wrong neighbour is worse than none.
		// 同流才传上下文 (2.7.1): 单元格批不再收到正文段尾 —— 它的语境是表格
		// 标题 (moduleContext),正文尾句只是噪声与 token。
		const contexts = chunks.map((c, i) => (
			c.lane === 'fast' && i > 0 && chunks[i - 1]!.lane === 'fast' && chunks[i - 1]!.kind === c.kind
				? trailingContext(chunks[i - 1]!.blocks)
				: ''
		));
		// 跨页续接 (参照 retain-pdf continuation_hint, 受控消费): when the previous
		// page's last body paragraph ends mid-sentence, or this page opens like a
		// continuation, the tail is injected as chunk-0 context — SOURCE text
		// only, no cross-page block merging, so the per-page overlay contract and
		// the one-shot commit stay intact.
		if (this.deps.useContext() && contexts.length && !contexts[0] && chunks[0]!.lane === 'fast' && chunks[0]!.kind === 'prose' && pageIndex > 0) {
			const prev = this.pages.get(pageIndex - 1);
			const lastBody = [...(prev?.blocks ?? [])].reverse()
				.find(b => (b.type === 'paragraph' || b.type === 'list') && !b.isReference);
			const first = chunks[0]!.blocks[0];
			if (lastBody && first) {
				const tail = lastBody.sourceText.trim();
				const unfinished = !/[.!?。!?]["'”’)\]]*$/.test(tail);
				const continuing = /^[a-z,;)\]]/.test(first.sourceText.trim());
				// 几何收紧 (移植自 MinerU `para_split.py::__merge_2_text_blocks` 的
				// 两条条件, opendatalab/MinerU, Apache-2.0): (a) 上页末段的最后一行
				// 必须顶到块右边界(差 < 行高)——没顶满说明段落其实已结束;
				// (b) 两块宽度差 < min(两块宽)——宽度悬殊的多半不是同一段。
				const lastLine = lastBody.lineRectsPdf?.[lastBody.lineRectsPdf.length - 1];
				const blockRight = lastBody.boundingBox
					? lastBody.boundingBox.x + lastBody.boundingBox.width
					: undefined;
				const lineHeight = lastLine ? Math.max(4, lastLine[3] - lastLine[1]) : 0;
				const lastLineFull = !lastLine || blockRight === undefined
					|| (blockRight - lastLine[2]) < lineHeight;
				const w1 = lastBody.boundingBox?.width;
				const w2 = first.boundingBox?.width;
				const similarWidth = !w1 || !w2 || Math.abs(w1 - w2) < Math.min(w1, w2);
				if ((unfinished || continuing) && lastLineFull && similarWidth) {
					// API-7: 跨页尾同样收窄 600→300。
					contexts[0] = tail.length <= 300 ? tail : tail.slice(-300);
				}
			}
		}

		const runChunk = async (plan: PlannedChunk, chunkIndex: number): Promise<void> => {
			const chunk = plan.blocks;
			if (signal.aborted) {
				throw new PaperMirrorError('CANCELLED', 'cancelled');
			}
			const request: TranslationRequest = {
				pageIndex,
				sourceLanguage: source,
				targetLanguage: target,
				documentTitle: this.deps.getDocumentTitle(),
				previousContext: this.deps.useContext() ? contexts[chunkIndex]! : '',
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
			let response: TranslationResponse = { translations: [] };
			try {
				response = await countedTranslate(request, signal);
			}
			catch (e) {
				// The page task no longer retries wholesale, so a chunk's hard
				// failure must NOT abandon the page — treat its blocks as missing
				// (salvage may recover them; later chunks still run). Cancellation
				// still stops everything.
				if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
					throw e;
				}
				logger.warn(MODULE, `Chunk request failed on page ${pageIndex}; continuing`, e);
			}
			for (const t of response.translations) {
				if (acceptChunk(t.id, t.translatedText)) {
					received.set(t.id, t.translatedText);
				}
			}

			// Retry only missing ids once (spec 4.3)
			const missing = chunk.filter(b => !received.has(b.id));
			if (missing.length && canSpend()) {
				logger.debug(MODULE, `Retrying ${missing.length} missing block(s) on page ${pageIndex}`);
				const retryRequest: TranslationRequest = {
					...request,
					blocks: missing.map((b) => {
						const pb = protectedBlocks.find(p => p.block.id === b.id)!;
						return { id: b.id, type: b.type, text: pb.text };
					})
				};
				try {
					response = await countedTranslate(retryRequest, signal);
					for (const t of response.translations) {
						if (acceptChunk(t.id, t.translatedText)) {
							received.set(t.id, t.translatedText);
						}
					}
				}
				catch (e) {
					if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
						throw e;
					}
					logger.warn(MODULE, 'Missing-id retry failed', e);
				}
			}

			// 熔断信号: the batch + retry still left over a quarter of the chunk
			// missing or invalid — this engine is systematically dropping ids or
			// echoing. Tell the host ONCE per page so it can reroute the page's
			// remaining requests to the backup engine before we spend a pile of
			// salvage requests on a misbehaving service.
			const afterRetry = chunk.filter(b => !received.has(b.id));
			if (afterRetry.length && afterRetry.length / chunk.length > UNSTABLE_MISSING_RATIO
				&& !this.unstableFired.has(pageIndex)) {
				this.unstableFired.add(pageIndex);
				try {
					this.events.onProviderUnstable?.(pageIndex, afterRetry.length / chunk.length);
				}
				catch { /* host handler must not break translation */ }
			}

			// 分级补救 tier 1: still-missing blocks are retried in SMALL batches
			// (3–5 blocks — id drift is rare at this size) instead of jumping
			// straight to one request per block. Only the leftovers of the
			// grouped pass fall through to single-block salvage.
			if (afterRetry.length >= 3 && canSpend()) {
				for (let i = 0; i < afterRetry.length; i += SALVAGE_BATCH_SIZE) {
					if (signal.aborted) {
						throw new PaperMirrorError('CANCELLED', 'cancelled');
					}
					if (!canSpend()) {
						break;
					}
					const group = afterRetry.slice(i, i + SALVAGE_BATCH_SIZE).filter(b => !received.has(b.id));
					if (!group.length) {
						continue;
					}
					try {
						metrics.salvageCount++;
						const resp = await countedTranslate({
							...request,
							previousContext: '',
							blocks: group.map((b) => {
								const pb = protectedBlocks.find(p => p.block.id === b.id)!;
								return { id: b.id, type: b.type, text: pb.text };
							})
						}, signal);
						for (const t of resp.translations) {
							if (acceptResponse(t.id, t.translatedText)) {
								received.set(t.id, t.translatedText);
							}
						}
					}
					catch (e) {
						if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
							throw e;
						}
						logger.warn(MODULE, `Grouped salvage failed on page ${pageIndex}`, e);
					}
				}
			}

			// 分级补救 tier 2: any id STILL missing gets its own single-block
			// request. With exactly one block in the request the answer cannot
			// misalign. Without this pass the block silently stayed English and
			// the page rendered mixed-language (the JACC report).
			const stillMissing = chunk.filter(b => !received.has(b.id));
			if (stillMissing.length && canSpend()) {
				logger.warn(MODULE, `Salvaging ${stillMissing.length} block(s) on page ${pageIndex} (concurrency ${SALVAGE_CONCURRENCY})`);
				if (stillMissing.length > SALVAGE_WARN_THRESHOLD) {
					logger.warn(MODULE, `Page ${pageIndex + 1}: provider dropped ${stillMissing.length} ids — salvaging all, but this engine is misbehaving`);
				}
				// Salvage ALL missing ids, but in bounded-parallel waves rather
				// than strictly one-after-another: single-block requests can't
				// suffer id drift, and running a few at once keeps a long page
				// from stalling for a minute on sequential round-trips.
				const salvageOne = async (block: SourceBlock): Promise<void> => {
					if (!canSpend()) {
						return;
					}
					const pb = protectedBlocks.find(p => p.block.id === block.id)!;
					try {
						metrics.salvageCount++;
						const single = await countedTranslate(
							{ ...request, previousContext: '', blocks: [{ id: block.id, type: block.type, text: pb.text }] },
							signal
						);
						// One block in → whatever comes back IS its translation,
						// even if the model rewrote the id — but only if it is
						// actually translated, not the English echoed back, and no
						// protected token was lost or invented.
						const first = single.translations.find(t =>
							looksTranslated(block.sourceText, t.translatedText, target)
							&& pb.reg.ok(t.translatedText));
						if (first) {
							received.set(block.id, first.translatedText);
						}
						else if (single.translations.length) {
							state.rejectReasons?.set(block.id, 'salvage-validator');
						}
						else {
							// 死分支修复 (1.1.8): 这里原本是与上面条件完全相同的
							// 第二个 else if,永不可达 —— 于是「打捞请求回了个空
							// 数组」这一支从不落原因码,块的 lastReject 停在批次
							// 阶段的旧值上,诊断读起来就像打捞从没跑过。
							state.rejectReasons?.set(block.id, 'salvage-empty');
						}
					}
					catch (e) {
						if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
							throw e;
						}
						logger.warn(MODULE, `Salvage request failed for ${block.id}`, e);
					}
				};
				for (let i = 0; i < stillMissing.length; i += SALVAGE_CONCURRENCY) {
					if (signal.aborted) {
						throw new PaperMirrorError('CANCELLED', 'cancelled');
					}
					if (!canSpend()) {
						break;
					}
					const wave = stillMissing.slice(i, i + SALVAGE_CONCURRENCY);
					const settled = await Promise.allSettled(wave.map(salvageOne));
					// Propagate a cancellation raised inside the wave.
					for (const r of settled) {
						if (r.status === 'rejected' && r.reason instanceof PaperMirrorError && r.reason.code === 'CANCELLED') {
							throw r.reason;
						}
					}
				}
			}

			const unrecovered = chunk.filter(b => !received.has(b.id));
			if (unrecovered.length) {
				untranslatedCount += unrecovered.length;
				logger.warn(
					MODULE,
					`Page ${pageIndex + 1}: ${unrecovered.length} block(s) untranslated after salvage: ${unrecovered.map(b => b.id).join(', ')}`
				);
			}

			for (const block of chunk) {
				const raw = received.get(block.id);
				if (raw === undefined) {
					continue;
				}
				const pb = protectedBlocks.find(p => p.block.id === block.id)!;
				const restored = pb.reg.restore(raw);
				results.push({ id: block.id, translatedText: restored });
				state.translations.set(block.id, restored);
				mirrorDuplicates(block.id); // API-2: 同文块同帧共享
				// 术语记忆: harvest 「中文术语(ABBR)」 pairs this page established.
				this.docMemory.learn(extractTermPairs(block.sourceText, restored));
			}
			this.notify(state); // progressive rendering per chunk
		};

		// 增量持久化: whatever this page has ALREADY translated survives a
		// cancel/idle-timeout — the old behavior threw everything away, so page
		// flipping kept re-buying the same translations (audit item).
		// 返回写盘 promise 并在取消路径 await (2.0.7, 审核 P2-3): 此前
		// fire-and-forget —— 任务解绕后这笔写仍悬在队列里,resetAllAndWait
		// 等不到它,「刷新全部」的清盘与它竞态,被丢弃的译文复活。
		const persistPartial = (): Promise<void> => {
			if (!this.deps.writeSegments || !results.length) {
				return Promise.resolve();
			}
			return this.deps.writeSegments(pageIndex, results.map(r => ({
				hash: segmentHash(sourceById.get(r.id) ?? '', source, target),
				translatedText: r.translatedText
			}))).catch(() => { /* best-effort */ });
		};

		try {
		// Limited intra-page parallelism: a small worker pool pulls chunks in
		// order (当前页最多同时 CHUNK_CONCURRENCY 个批次). Mutations are append-only
		// per block id and the request cap is shared, so the guarantees match the
		// old serial loop at roughly half the wall-clock on multi-chunk pages.
		{
			let nextChunk = 0;
			const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, async () => {
				for (;;) {
					const i = nextChunk++;
					if (i >= chunks.length) {
						return;
					}
					await runChunk(chunks[i]!, i);
				}
			});
			const settled = await Promise.allSettled(workers);
			for (const r of settled) {
				if (r.status === 'rejected') {
					throw r.reason;
				}
			}
		}

		if (!results.length && !segmentHits) {
			throw new PaperMirrorError('BAD_RESPONSE', 'The translation service returned no usable translations.');
		}

		// 局部英文残留补译: a block that passed looksTranslated can still carry a
		// run of untranslated English mid-paragraph. Re-translate ONLY those
		// blocks (single-block requests, capped), patch their entries in place,
		// and merge into `results` so the fix reaches the cache — the page is not
		// re-extracted or re-rendered wholesale.
		if (canSpend()) {
			await this.resolveEnglishResidue(state, activeBlocks, results, source, target, signal, countedTranslate, canSpend);
		}

		// 纯文本兜底 (修复链路最后一环, 参照 retain-pdf final recovery): blocks the
		// whole JSON chain rejected get ONE more shot each in plain mode — the
		// answer is the bare translation, so id drift and JSON mangling cannot
		// fail it. Budgeted (≤4/page, shares the page request cap).
		{
			const unrecovered = toTranslate.filter(b => !state.translations.has(b.id));
			let attempts = 0;
			for (const block of unrecovered) {
				if (attempts >= FINAL_RECOVERY_MAX || !canSpendFinal()) {
					break;
				}
				if (signal.aborted) {
					throw new PaperMirrorError('CANCELLED', 'cancelled');
				}
				attempts++;
				const pb = protectedBlocks.find(p => p.block.id === block.id)!;
				try {
					const resp = await countedTranslate({
						pageIndex,
						sourceLanguage: source,
						targetLanguage: target,
						documentTitle: this.deps.getDocumentTitle(),
						previousContext: '',
						blocks: [{ id: block.id, type: block.type, text: pb.text }],
						glossary: this.glossaryFor([block.sourceText]),
						plain: true
					}, signal);
					const translatedHit = resp.translations.find(t =>
						looksTranslated(block.sourceText, t.translatedText, target));
					const hit = translatedHit && pb.reg.ok(translatedHit.translatedText) ? translatedHit : undefined;
					if (hit) {
						const restored = pb.reg.restore(hit.translatedText);
						state.translations.set(block.id, restored);
						results.push({ id: block.id, translatedText: restored });
						logger.info(MODULE, `Page ${pageIndex + 1}: plain-mode recovery rescued ${block.id}`);
					}
					else if (translatedHit && pb.reg.count > 0 && canSpendFinal()) {
						// 占位符降级重试 (2.5.12, wu2026 摘要实证): 译文本身合格
						// (looksTranslated 通过),只是占位符清单被模型排坏 ——
						// 掩码密集的块 (Likert 中位数 + 引用 + 统计式混在一段)
						// 每一轮都死在 reg.ok 上,整段永远留英。链路最后一环改为
						// 【不掩码】重发一次: 引用与统计式直接交给模型原样保留,
						// 只验 looksTranslated。这一块失去公式逐字节保证,但另一
						// 边的代价是整段不翻;只在掩码链已经失败后才走到这里。
						const bare = await countedTranslate({
							pageIndex,
							sourceLanguage: source,
							targetLanguage: target,
							documentTitle: this.deps.getDocumentTitle(),
							previousContext: '',
							blocks: [{ id: block.id, type: block.type, text: block.sourceText }],
							glossary: this.glossaryFor([block.sourceText]),
							plain: true
						}, signal);
						const bareHit = bare.translations.find(t =>
							looksTranslated(block.sourceText, t.translatedText, target));
						if (bareHit) {
							state.translations.set(block.id, bareHit.translatedText);
							results.push({ id: block.id, translatedText: bareHit.translatedText });
							logger.info(MODULE, `Page ${pageIndex + 1}: unmasked plain recovery rescued ${block.id} (placeholder chain had failed)`);
						}
						else {
							state.rejectReasons?.set(block.id, 'plain-placeholder');
						}
					}
					else if (resp.translations.length) {
						state.rejectReasons?.set(block.id, 'plain-validator');
					}
					else {
						// 同一处死分支 (1.1.8): 见上面 salvage 的说明。
						state.rejectReasons?.set(block.id, 'plain-empty');
					}
				}
				catch (e) {
					if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
						throw e;
					}
					logger.warn(MODULE, `plain-mode recovery failed for ${block.id}`, e);
				}
			}
			if (unrecovered.some(b => state.translations.has(b.id))) {
				this.notify(state);
			}
		}
		}
		catch (e) {
			await persistPartial(); // P2-3: 任务解绕前落盘完成,取消等待才等得到
			throw e;
		}

		// keep-origin 记账: whatever is STILL untranslated after the whole chain
		// increments its segment's failure count; at ≥2 future runs skip it.
		for (const block of toTranslate) {
			if (!state.translations.has(block.id)) {
				const h = segHash(block);
				const rec = this.failedSegments.get(h);
				// 并发轮次去重 (2.0.6, 审核 P3): 本次运行发起于上一次计数之前
				// (与记录时已在飞的运行同轮,同一段跨页并发失败)→ 不叠加。
				// 只有失败记录之后新发起的运行 (runId > rec.seq) 才算下一轮。
				if (!rec || runId > rec.seq) {
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
			mirrorDuplicates(rep);
		}
		untranslatedCount = toTranslate.filter(b => !state.translations.has(b.id)).length;

		state.status = 'done';
		state.diagnostics = {
			requests: metrics.requestCount,
			attempts: metrics.attemptCount,
			salvage: metrics.salvageCount,
			rateLimited: metrics.rateLimited,
			timeouts: metrics.timeouts,
			segmentHits,
			durationMs: Date.now() - metrics.startedAt,
			fromCache: false,
			// 注册表状态汇总 (仅计数,无文本 — 日志卫生基线)。
			placeholderTokens: protectedBlocks.reduce((n, p) => n + p.reg.count, 0),
			placeholderRejected: protectedBlocks.reduce((n, p) => n + p.reg.status.rejected, 0)
		};
		this.notify(state);
		// 指标: groupCount(翻译单元) / chunkCount(请求批次) / requestCount(总请求) /
		// salvageCount(逐块补救) / segmentHits(段落缓存命中).
		logger.info(
			MODULE,
			`Page ${pageIndex + 1} metrics: ${blocks.length} unit(s), ${segmentHits} from segment cache, `
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
		if (this.deps.writeSegments && results.length) {
			const byId = new Map(activeBlocks.map(b => [b.id, b]));
			// 登记而不等待 (2.5.9): 这一笔坐在调度槽里,await 它就是白占半秒
			// 以上(落盘有 500ms 合并窗口)。登记后 resetAllAndWait/dispose 仍
			// 等得到,2.0.7 的清盘竞态防线不受影响。
			this.trackWrite(this.deps.writeSegments(pageIndex, results
				.map(r => ({ hash: segHash(byId.get(r.id)!), translatedText: r.translatedText }))
			).catch(e => { logger.warn(MODULE, 'segment write failed', e); }));
		}
		// Only a COMPLETE page enters the cache. Caching a partial page would
		// freeze the mixed-language rendering: every revisit would hit the
		// cache and never retry the missing blocks. Left uncached, the next
		// visit (or 重新翻译) runs the whole pipeline again — with the segment
		// store still saving the segments that DID succeed.
		if (untranslatedCount === 0 && keepOrigin.size === 0) {
			// keepOrigin pages stay OUT of the page cache (审核 P1): caching one
			// froze its English segments forever — every revisit hit the cache and
			// the repair chain never ran again. Uncached, the segment store still
			// serves the good segments and the skipped ones get their chance the
			// moment 普通刷新 clears the 止损 memory below.
			const all: TranslatedBlock[] = activeBlocks
				.filter(b => state.translations.has(b.id))
				.map(b => ({ id: b.id, translatedText: state.translations.get(b.id)! }));
			await this.deps.writeCache(pageIndex, blocks, all);
		}
		else {
			logger.warn(MODULE, `Page ${pageIndex + 1} left uncached (${untranslatedCount} untranslated block(s)) so a revisit retries`);
		}
	}
}
