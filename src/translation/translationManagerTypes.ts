/**
 * Types and pure helpers of the translation manager: the per-page translation
 * state with its segment hashes, provisional and cache rows and first-request
 * budget; the manager's dependencies, events, hooks, request timing and page
 * diagnostics rows; release reasons and limits.
 *
 * Split out of translationManager.ts in 5.1 without changing behaviour.
 */
import { policyStampFor } from './promptPolicies';
import type { GlossaryRule, RejectedParam, SourceBlock, TranslatedBlock, TranslationRequest, TranslationResponse } from '../types/models';
import { PaperMirrorError } from '../types/models';
import { contextualSourceText } from './sourceContinuity';
import { fnv1a64 } from '../cache/cacheSchema';
import { type TokenUsage } from './usageMeter';
import { type PageBlockDigest } from './pageBlockDigest';

/**
 * 5.0: 按响应更新页状态上的临时(分栏降级)标记: 响应里标了的加入,同一段拿到
 * 正式译文则移出。所有收译文的路径(主流程、压缩重译、单段重译)都走这里。
 */
export function noteProvisionalIn(state: Pick<PageTranslationState, 'provisional'>, response: TranslationResponse, ids?: Iterable<string>): void {
	const set = state.provisional ?? (state.provisional = new Set());
	const marked = new Set(response.provisionalIds ?? []);
	for (const id of ids ?? response.translations.map(t => t.id)) {
		if (marked.has(id)) set.add(id);
		else set.delete(id);
	}
}

/** 5.0: 页面里还有正在显示的临时译文 → 不写页缓存。 */
/**
 * Page-cache rows for the blocks that have a translation (5.0): provisional
 * (per-part) translations are kept, flagged, so a revisit shows them without
 * paying again; the flag keeps them out of the segment store after restore.
 */
export function pageCacheRows(state: Pick<PageTranslationState, 'provisional' | 'translations'>, blocks: Array<{ id: string; sourceText?: string; isReference?: boolean; tableId?: string; tableRow?: number }>): TranslatedBlock[] {
	return blocks
		.filter(b => state.translations.has(b.id))
		.map(b => {
			// 5.0: the prompt-policy stamp this row was produced under (see promptPolicies.ts).
			const policy = typeof b.sourceText === 'string' ? policyStampFor({ sourceText: b.sourceText, isReference: b.isReference, tableId: b.tableId, tableRow: b.tableRow }) : '';
			return {
				id: b.id,
				translatedText: state.translations.get(b.id)!,
				...(state.provisional?.has(b.id) ? { provisional: true as const } : {}),
				...(policy ? { policy } : {})
			};
		});
}

/**
 * 5.0 规则版本: 段落库的键。内容 + 语言(+ 续段上下文)之外,再并入与本块相关、
 * 版本 > 1 的规则戳 —— 与规则无关的块键不变(旧缓存照常命中),相关的块在规则
 * 升版后换键,旧译文不再被取到。
 */
export function blockSegmentHash(block: Pick<SourceBlock, 'sourceText' | 'continuationContext'> & { isReference?: boolean; tableId?: string; tableRow?: number }, sourceLang: string, targetLang: string): string {
	const base = segmentHash(block.sourceText, sourceLang, targetLang, block.continuationContext);
	const stamp = policyStampFor(block);
	return stamp ? fnv1a64(`${base}\u0001${stamp}`) : base;
}

export function hasShownProvisional(state: Pick<PageTranslationState, 'provisional' | 'translations'>): boolean {
	for (const id of state.provisional ?? []) {
		if (state.translations.has(id)) return true;
	}
	return false;
}

/**
 * 页被"释放等重试"的原因 (2.9.0 真机第三轮)。
 *
 * ## 为什么必须有这个枚举
 *
 * 代码里有**五处**会把一页的状态从 `this.pages` 里删掉,然后指望"用户翻过去时
 * 自然会重抽":抽取僵尸、抽取超时、文本层未渲染(2.8.13)、导航取代、请求取消。
 * 每一处都只写一行 `logger`,**页从此在 `exportScope()` 里凭空消失** —— 不是
 * 标成失败,是整行不见。
 *
 * 真机 51 页那一轮:第 **36、41、45** 页不在 scope 里,而它们两侧的页都处理过。
 * 同一份日志里 `attemptErrors.CANCELLED = 36`。用户看到的是"这几页一个字没译",
 * 而诊断文件里连一行记账都没有 —— 这正是这个项目从第一天起就定下的
 * 「**不许静默漏页**」被破掉的地方。
 *
 * ## 两件事必须同时做
 *
 *   1. **记账**:释放不等于消失。释放过的页留在 `released` 里,`exportScope()`
 *      如实报 `status: 'released'` + 原因 + 次数。哪怕补不回来,至少看得见;
 *   2. **补回**:"等用户翻过去"这个指望有个洞 —— 单向顺读时用户**只经过一次**,
 *      如果释放发生在他已经走过之后,就再也没有第二次。所以下一次翻页时
 *      主动把近处释放过的页重新入队。
 *
 * 重试**有界**(`MAX_RELEASES`):超过次数的页转成可重试的错误状态,用户看得见
 * 刷新入口,而不是无限重试或永远沉默。
 */
export type ReleaseReason =
	/** 抽取僵尸还活着,非当前页不再起第二次 PDF-worker 抽取。 */
	| 'extract-zombie'
	/** 抽取超时。 */
	| 'extract-timeout'
	/** 文本层还没渲染 (2.8.13) —— "看不见",不是"没文字"。 */
	| 'text-layer-not-rendered'
	/** 抽取期间用户翻走了,这页已不在预取窗口内。 */
	| 'navigation-superseded'
	/** 请求被取消(多半是导航取代)。 */
	| 'cancelled';

/** 盲目轮询补回时,同一页最多释放几次 —— 绝不无限重试。 */
export const MAX_RELEASES = 3;

/** 盲目轮询补回的距离:只补当前页附近的,不回头扫整篇文档。 */
export const RELEASE_RETRY_RADIUS = 3;

/**
 * **事件驱动**补回的上限 (2.9.2)。与 `MAX_RELEASES` 是两套预算,故意分开:
 * 翻页轮询是在猜"现在渲染好了吗",猜错要付配额,所以给得紧;
 * `textlayerrendered` 是 PDF.js 自己说"渲染好了",是确定的信号 ——
 * 在那一刻重抽命中率接近 100%,不该被猜错的配额拖累。
 * 留一个很小的上限只为防病态:文本层都出来了还抽不到,再试也是重复同一个失败。
 */
export const MAX_RENDER_RETRIES = 2;

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
export function segmentHash(sourceText: string, sourceLang: string, targetLang: string, continuationContext?: SourceBlock['continuationContext']): string {
 const identity = contextualSourceText({ sourceText, continuationContext } as SourceBlock);
	return fnv1a64(`${identity}\u0000${sourceLang}\u0000${targetLang}`);
}

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
	/**
	 * 5.0: 跨页整句降级为分栏翻译的段落(显示但不进缓存,下次打开重试整句)。
	 * 挂在页状态上而不是单次运行上: 压缩重译、单段重译、续跑都要看到它。
	 */
	provisional?: Set<string>;
	/** 最近一次验收拒绝的原因 (仅原因码,无文本): validator | placeholder。 */
	rejectReasons?: Map<string, string>;
	rejectHistory?: Map<string, string[]>;
	/**
	 * 译文修订号 (2.8.2, 性能第三批): 每次 notify 之前算一遍译文指纹,内容
	 * **真的变了**才 +1。页视图据此决定要不要在译完之前先把已到的译文画上,
	 * 并保证同一修订版本只渲染一次。
	 *
	 * 为什么不用"已到块数": 原地重译(单块 replay、逐块补救、缓存回填)块数
	 * 不变而内容变了,按块数判会漏;同一批结果被重复通知时按块数判又会白
	 * 重建一次。指纹在 notify 这一处算,任何写入路径都自动被覆盖 —— 不必在
	 * 九个 `translations.set` 现场各记一次,漏一处就是一个不会报错的静默 bug。
	 */
	translationRevision?: number;
	/**
	 * 译文已可靠落进**页面缓存** (2.8.3, 性能第四批)。只有它为真的已完成页
	 * 才可能被卸掉完整内容 —— 卸一个没落盘的页就是丢掉唯一的一份译文。
	 * 有未译块或 keepOrigin 的页按设计不写页面缓存,于是永远不会被淘汰。
	 */
	cached?: boolean;
	/**
	 * 完整内容(blocks / translations)已被卸掉,只剩轻量状态 (2.8.3)。
	 * 用户翻回来时 `ensurePage` 重新抽取 + 读页面缓存复原,零 API 请求。
	 */
	evicted?: boolean;
	/**
	 * 逐块诊断摘要 (2.8.5, 导出方案 P0): 淘汰完整内容**之前**拍下的定长明细。
	 * 只含枚举与计数,没有原文/译文/异常原文。有了它,被卸掉内容的页在诊断里
	 * 仍然有逐块状态 —— "空块表"不再需要靠猜是"这页没内容"还是"省内存省掉了"。
	 */
	blockDigest?: PageBlockDigest;
	/**
	 * 这一页的块是走哪条抽取路径产出的 (2.8.5, 导出方案 P0):
	 * chars(fork 字符流)/ text-layer(渲染文本层)/ plain-text(PDFWorker 纯文本)/
	 * rendered-recovery(超时后的当前页兜底)。语料重解析若走上另一条路径,
	 * 这是唯一能说清"为什么结构对不上"的字段 —— 此前根本没有记录。
	 */
	extractPath?: string;
}

/**
 * 一个翻译请求的时序切片 (2.11.0)。
 *
 * 2.11.1 起多一个 `provider`。这是这一组里**唯一**的字符串,理由要写清楚:
 * 2.11.0 的真机数据把「慢在等名额还是等服务端」答了 —— `gateMs` 在每个请求上
 * 都是 0 或 1,全部时间在 `sendMs`。但随之而来的问题现有字段仍答不了:
 * 快页(约 5300–9200 字符/秒)与慢页(约 515–585 字符/秒)差 **十几倍**,
 * 而快页的 5 个请求**一个都没报 token 用量**(`usageMissing: 5` 正好等于它们),
 * 同时 `engineRotations: 0`。是不是同一个引擎在服务,现在完全看不出来。
 *
 * 服务商 id 是枚举(`openai` / `bing-free` / `deepseek` …),不是端点、不是
 * 密钥、不是模型参数 —— summary 里本来就按 id 导出引擎清单。为防它日后变成
 * 一个什么都能塞的字段,privacy 闸对它做形状校验:只允许小写字母、数字和连字符。
 */
export interface RequestTiming {
	gateMs: number;
	sendMs: number;
	inFlightAtStart: number;
	foreground: boolean;
	attempt: number;
	blocks: number;
	chars: number;
	/** 服务商 id 枚举(非端点/非密钥);池只有一个成员时同样如实写出。 */
	provider: string;
	/** 本次请求时刻的池大小 —— 1 表示根本没走按页分配。 */
	poolSize: number;
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
	/**
	 * 时序三件套 (2.8.4, 性能第五批: 先量再改)。全是毫秒,不含任何文本。
	 *   queuedMs        从 ensurePage 被调用到调度器真正把这页跑起来 —— 当前页
	 *                   的"排队时间",它大说明并发/优先级有问题,不是模型慢。
	 *   extractMs       PDF 抽取耗时(不占服务商槽位,但会拖住首字)。
	 *   firstTextMs     从这页开始跑到**第一块译文到手** —— 这才是用户等待
	 *                   "第一个中文字"的时间;durationMs 是整页译完的时间。
	 * 三个数字合起来才回答得了"慢在哪一段",单看 durationMs 回答不了。
	 */
	queuedMs?: number;
	extractMs?: number;
	firstTextMs?: number;
	/**
	 * 请求级时序 (2.11.0, 真机第十一轮)。
	 *
	 * 2.10.2 的数据把一个缺口摆出来了:同一档输入大小的页,翻译阶段耗时
	 * 从 **248 ms 到 28136 ms** —— 差 113 倍,而 `queuedMs` 在每一个慢页上
	 * **都是 0**、`rateLimited` 和 `timeouts` 全是 0。
	 *
	 * 问题是 `queuedMs` 量的是"从 ensurePage 到调度器把这页跑起来",
	 * **不含请求闸的等待** —— `requestGate.run` 在 try 之前 await 取名额,
	 * 那一段时间此前谁也没记。于是「等名额」「等服务端」这两件事,
	 * 现有字段一个也分不开,113 倍的差异无从归因。
	 *
	 *   gateMs           在请求闸里等名额的时间
	 *   sendMs           拿到名额之后到响应回来的时间(真正的服务端往返)
	 *   inFlightAtStart  出手**之前**本 lane 上已有几个在飞
	 *   foreground       是不是当前页(前台有保留槽位,背景预取没有)
	 *   attempt          第几次尝试(0 是首次;重试会再记一条)
	 *   blocks / chars   这一批喂进去多少块、多少字符
	 *
	 * 纯观测:不改名额怎么给、给几个、等多久。
	 */
	requestTimings?: RequestTiming[];
	/**
	 * 抽取内部分段 (2.8.15, 真机第二轮)。`extractMs` 是个总数,回答不了"等在哪"。
	 * 实测 30 页里 15 页 extractMs 在 0.8–2.6 秒,而这些页**一次请求都没发**
	 * (`requests: 0, fromCache: true`)—— 慢在本地,不在网络;同一条路最快的页
	 * 只要 14 ms,所以那 2.6 秒是**等**,不是算。这几个数字把"等 PDFWorker 的
	 * char 流"(charsPathMs)、"等 PDF.js 把文本层渲染稳定"(textLayerWaitMs)
	 * 与"我们自己的 CPU 建块"(buildMs)分开 —— 不分开就只能猜该优化哪一边。
	 * 纯毫秒,不含任何文本。
	 */
	extractPhases?: {
		obstaclesMs: number;
		charsPathMs: number;
		textContentMs?: number;
		textLayerMs: number;
		textLayerWaitMs?: number;
		plainTextMs: number;
		buildMs: number;
		/** 5.0: 旋转排版正文字符数(旋转表格保留原文)。 */
		rotatedTextChars?: number;
		/** 5.0 全篇样式(数字,见 ExtractPhases)。 */
		documentStyleState?: number;
		documentStyleMs?: number;
		documentBodyPt?: number;
		referencesFirstPage?: number;
		referencesLastPage?: number;
	};
}

export interface TranslateHooks {
	onAttempt?: () => void;
	onUsage?: (usage: TokenUsage) => void;
	onParamHeal?: (param: RejectedParam) => void;
 onProgress?: () => void;
	/** 5.0 对冲请求: 指定由哪个服务商发出(不传 = 按页分配)。 */
	provider?: string;
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
	translateRequest(request: TranslationRequest, signal: AbortSignal, hooks?: TranslateHooks): Promise<TranslationResponse>;
	/**
	 * 这一页此刻还被用着吗 (2.8.3, 性能第四批): 正在渲染、或仍挂在面板上。
	 * 宿主实现;缺省视为"没在用"。内存淘汰绝不动正在用的页。
	 */
	isPageInUse?(pageIndex: number): boolean;
	/**
	 * 上一次抽取这一页走的是哪条路径 (2.8.5, 导出方案 P0)。宿主实现;缺省不记。
	 * 只在 extractPage 刚返回时问一次,之后随页状态存着。
	 */
	extractPathOf?(pageIndex: number): string | undefined;
	/** 2.8.15: 这一页抽取的分段耗时 —— 纯毫秒,回答 extractMs 花在哪一段。 */
	extractPhasesOf?(pageIndex: number): NonNullable<PageDiagnostics['extractPhases']> | undefined;
	/** Read an immutable session snapshot without starting translation work. */
	restoreSnapshot?(pageIndex: number): Promise<PageTranslationState | null>;
	/** Cache access; may be no-ops. */
	readCache(pageIndex: number, blocks: SourceBlock[]): Promise<TranslatedBlock[] | null>;
	writeCache(pageIndex: number, blocks: SourceBlock[], translations: TranslatedBlock[]): Promise<void | boolean>;
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
	/** 2.11.1: 当前服务商池大小 —— 1 表示根本没走按页分配。 */
	poolSize?(): number;
	/**
	 * 5.0 对冲: 当前页的请求迟迟不回时,另找一家(测得最快、且不是 `current`)
	 * 同时再发一次。返回 '' 表示没有合适的备选。
	 */
	hedgeProviderFor?(pageIndex: number, current: string): string;
	/** Config snapshot getters. */
	getLanguages(sampleText: string): { source: string; target: string };
	getDocumentTitle(): string;
	getGlossary(): GlossaryRule[];
	/** 不译词列表 — masked via placeholders before every request. */
	getNoTranslate?(): string[];
	useContext(): boolean;
 /** Stable full provider-pool/user-policy identity for shared source sentences. */
 continuityIdentity?(): string;
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

/**
 * Scheduler priorities. The current visible page and its work always dominate
 * neighbour prefetch, so the page the reader is looking at is never queued
 * behind pages they have not scrolled to yet. Numeric gaps leave room to insert
 * finer tiers later without renumbering.
 */
export const PRIORITY = {
	/** 重新翻译本页 — an explicit user action, the most urgent thing there is. */
	CURRENT_RETRANSLATE: 1000,
	/** The visible page's first translation. */
	CURRENT_PAGE: 900,
	/** The visible page's strict-layout compress-and-retry. */
	CURRENT_COMPRESS: 850,
	/** Prefetch: the next page is likelier to be read than the previous. */
	NEXT_PAGE: 100,
	PREVIOUS_PAGE: 80,
	SECOND_NEXT_PAGE: 20,
	/** 被释放的页补回来 (2.9.0) —— 比预取低,绝不跟当前页抢。 */
	RELEASED_RETRY: 10
} as const;
