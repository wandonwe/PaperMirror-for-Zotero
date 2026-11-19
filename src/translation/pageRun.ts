/**
 * 一次页面翻译运行的状态 (5.0 重构, 从 TranslationManager.translatePage 拆出)。
 *
 * translatePage 原来是一个近 900 行的函数,二十多个局部变量和闭包在请求、
 * 分批、补救、纯文本兜底、收尾之间共享。现在这些共享状态集中在 PageRun 里,
 * 各阶段是管理器上的独立方法,显式拿到同一个 run:
 *
 *   preparePage → planPage → runChunks(runChunk) → 残留补译 → recoverPlain → finalizePage
 *
 * PageRun 只依赖纯函数(验收、占位符注册表),不碰 Zotero、调度器或缓存;
 * 那些仍由管理器负责。行为与拆分前逐行一致。
 */

import type { GlossaryRule, SourceBlock, TranslatedBlock, TranslationResponse } from '../types/models';
import type { PlaceholderRegistry } from './placeholderRegistry';
import type { PlannedChunk } from './segmenter';
import type { PageTranslationState, RequestTiming } from './translationManager';
import { looksTranslated, referenceRejectReason, translationRejectReason } from './translationValidation';

export interface ProtectedBlock {
	block: SourceBlock;
	reg: PlaceholderRegistry;
	text: string;
}

export class PageRun {
	/**
	 * 真实性能指标 (per page): requestCount = 逻辑批次 (预算闸 canSpend 的口径);
	 * attemptCount = 实际发出的 HTTP 尝试 (含请求级重试, 2.7.5 审核 P2) ——
	 * 两次 429 后成功是 1 批 / 3 次。requestTimings (2.11.0): 每个请求一条,
	 * 门内等了多久、发出去之后等了多久,"等名额"和"等服务端"分得开。
	 */
	readonly metrics = {
		requestCount: 0, attemptCount: 0, salvageCount: 0, rateLimited: 0, timeouts: 0,
		startedAt: Date.now(),
		requestTimings: [] as RequestTiming[]
	};
	/** 5.0: 整句降级为分栏翻译的段落 —— 显示,但不进段落库/页缓存(存于页状态)。 */
	get provisional(): Set<string> {
		return this.state.provisional ?? (this.state.provisional = new Set());
	}
	/** 本次运行新得到的译文(写段落库用)。 */
	readonly results: TranslatedBlock[] = [];
	untranslatedCount = 0;
	segmentHits = 0;

	// ---- preparePage 填入 ----
	blocks!: SourceBlock[];
	activeBlocks!: SourceBlock[];
	source!: string;
	target!: string;
	glossary!: GlossaryRule[];
	sourceById!: Map<string, string>;
	sourceBlockById!: Map<string, SourceBlock>;
	refById!: Set<string>;
	keepOrigin!: Map<string, string>;
	toTranslate!: SourceBlock[];
	/** 同页同文去重 (API-2): 代表块 id → 同文块 id。 */
	dupOf!: Map<string, string[]>;
	uniqueToTranslate!: SourceBlock[];
	segHash!: (b: SourceBlock) => string;

	// ---- planPage 填入 ----
	protectedBlocks!: ProtectedBlock[];
	regById!: Map<string, PlaceholderRegistry>;
	chunks!: PlannedChunk[];
	contexts!: string[];
	pageRequestCap = 0;

	constructor(
		readonly state: PageTranslationState,
		readonly signal: AbortSignal,
		readonly beat: () => void,
		/** 止损轮次序号 (P3): 本运行的发起顺序,见 failedSegments 注释。 */
		readonly runId: number,
		/** 纯文本兜底单独的预算 (见 canSpendFinal)。 */
		private readonly finalRecoveryMax: number
	) {}

	get pageIndex(): number {
		return this.state.pageIndex;
	}

	protectedFor(id: string): ProtectedBlock {
		return this.protectedBlocks.find(p => p.block.id === id)!;
	}

	/** 响应里标了 provisionalIds 的段落记为临时;同一段后来拿到正式译文则撤销。 */
	readonly noteProvisional = (response: TranslationResponse): void => {
		const set = this.provisional;
		const marked = new Set(response.provisionalIds ?? []);
		for (const row of response.translations) {
			if (marked.has(row.id)) set.add(row.id);
			else set.delete(row.id);
		}
	};

	/** Accept a response only if it is actually translated (not echoed English). */
	readonly accept = (id: string, text: string): boolean =>
		text.trim().length > 0 && looksTranslated(this.sourceById.get(id) ?? '', text, this.target, { isReference: this.refById.has(id) });

	/**
	 * 拒绝原因埋点 (1.1.3): unrecovered 只说"没救回来",不说"为什么每次都被
	 * 拒" —— 记住每块最近一次验收失败的原因码,进诊断导出。
	 */
	readonly noteReject = (id: string, reason: string): void => {
		this.state.rejectReasons!.set(id, reason);
		this.state.rejectHistory!.set(id, [...(this.state.rejectHistory!.get(id) ?? []), reason].slice(-8));
	};

	readonly rejectedResponse = (id: string, text: string, phase: string): string => {
		const source = this.sourceById.get(id) ?? '';
		if (!this.refById.has(id)) return `${phase}:${translationRejectReason(source, text, this.target) ?? 'integrity'}`;
		return referenceRejectReason(source, text, phase);
	};

	/**
	 * 'empty' 与 'validator' 分开 (1.1.8): 引擎带着 id 回了一个空串,和「回了
	 * 英文回声被验收拒掉」是两种完全不同的故障 —— 前者要换请求形态(纯文本
	 * 兜底),后者要换措辞。占位符清单校验 (参照 retain-pdf): 丢了或多出受保护
	 * 记号的响应与缺 id 一样走重试/补救链。
	 */
	readonly acceptResponse = (id: string, text: string): boolean => {
		if (!text.trim()) {
			this.noteReject(id, 'empty');
			return false;
		}
		const reg = this.regById.get(id);
		const restored = reg ? reg.restore(text) : text;
		if (!this.accept(id, restored)) {
			this.noteReject(id, this.rejectedResponse(id, restored, 'validator'));
			return false;
		}
		if (reg && !reg.ok(text)) {
			this.noteReject(id, reg.status.last?.missing.length ? 'placeholder:missing' : 'placeholder:unexpected');
			return false;
		}
		return true;
	};

	/**
	 * Hard ceiling on requests for this page so a misbehaving engine can never
	 * turn one page into a request storm. Once hit, salvage stops and the
	 * remaining blocks are left for 「刷新本页」.
	 */
	readonly canSpend = (): boolean => this.metrics.requestCount < this.pageRequestCap;

	/**
	 * 兜底预算 (1.1.8, Horst 2024 第 1 页实证): pageRequestCap 由 chunk 数推导,
	 * 单 chunk 的页面只有 4 次,纯文本兜底永远轮不到。给它单独留一份不与打捞
	 * 共享的预算;该路径自身还有 attempts 计数闸,两道闸都在。
	 */
	readonly canSpendFinal = (): boolean => this.metrics.requestCount < this.pageRequestCap + this.finalRecoveryMax;

	/**
	 * API-2 镜像: 代表块的译文一到,同文重复块立即共享(渐进渲染同帧可见);
	 * 收尾还有一次全量 sweep 兜住 salvage/纯文本兜底等晚到路径。
	 */
	readonly mirrorDuplicates = (repId: string): void => {
		const dups = this.dupOf.get(repId);
		if (!dups) {
			return;
		}
		const t = this.state.translations.get(repId);
		if (t === undefined) {
			return;
		}
		for (const d of dups) {
			if (!this.state.translations.has(d)) {
				this.state.translations.set(d, t);
				this.results.push({ id: d, translatedText: t });
			}
		}
	};
}
