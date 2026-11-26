/**
 * The translation manager's diagnostics: per-page rows (timing, tokens,
 * reject reasons), the session summary (usage, attempts, hedges, validation
 * failures) and the page export, plus extraction timing records.
 *
 * Moved out of translationManager.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, reading the manager through a
 * read-only ManagerDiagnosticsView.
 */
import type { SourceBlock } from '../types/models';
import { digestRows, diagnosticRows } from './pageBlockDigest';
import { MAX_RELEASES, PageDiagnostics, PageTranslationState } from './translationManagerTypes';
import type { TranslationManager } from './translationManager';

export function countsOf<K extends string>(counter: Map<K, number>): Record<string, number> {
	return Object.fromEntries([...counter].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

/** What these functions read of the TranslationManager (5.1: read-only view, see TranslationManager.diagnosticsView). */
export interface ManagerDiagnosticsView {
	readonly attemptErrors: TranslationManager['attemptErrors'];
	readonly deps: TranslationManager['deps'];
	readonly hedges: TranslationManager['hedges'];
	readonly httpAttempts: TranslationManager['httpAttempts'];
	readonly pageTiming: TranslationManager['pageTiming'];
	readonly pageTokens: TranslationManager['pageTokens'];
	readonly pages: TranslationManager['pages'];
	readonly paramHeals: TranslationManager['paramHeals'];
	readonly released: TranslationManager['released'];
	readonly renderRetryBlocked: TranslationManager['renderRetryBlocked'];
	readonly scopeGaps: TranslationManager['scopeGaps'];
	readonly tokenUsage: TranslationManager['tokenUsage'];
	readonly usage: TranslationManager['usage'];
	readonly usageMissing: TranslationManager['usageMissing'];
	readonly usageReports: TranslationManager['usageReports'];
	readonly validationFailures: TranslationManager['validationFailures'];
	readonly pageDiagnosticsRow: TranslationManager['pageDiagnosticsRow'];
	readonly sessionDiagnostics: TranslationManager['sessionDiagnostics'];
	readonly exportPageDiagnostics: TranslationManager['exportPageDiagnostics'];
	readonly recordExtraction: TranslationManager['recordExtraction'];
}

/**
 * 单页诊断 (2.8.6, 导出方案 P1): 与整份导出**走同一个** `pageDiagnosticsRow`,
 * 于是"一次性导出"与"逐页流式导出"永远是同一份口径。页不存在时返回 null ——
 * 导出器把它记成缺失,不静默跳过。
 */
export function exportPageDiagnostics(ctx: ManagerDiagnosticsView, pageIndex: number): unknown | null {
	const state = ctx.pages.get(pageIndex);
	if (state) {
		return ctx.pageDiagnosticsRow(state);
	}
	// 2.9.0: 释放过的页**有**一行,内容就是"它为什么没有内容"。
	// 此前这里返回 null,导出器把它记成读失败 —— 而真相是它从来没被翻译。
	const release = ctx.released.get(pageIndex);
	return release
		? {
			page: pageIndex + 1,
			status: 'released',
			error: null,
			releaseReason: release.reason,
			releaseCount: release.count,
			renderRetries: release.renderRetries,
			// 「盲目轮询的配额用完了」—— 不等于"彻底不再尝试":
			// `textlayerrendered` 事件仍会唤醒它,用户真翻到这一页也会无条件再抽。
			exhausted: release.count >= MAX_RELEASES,
			blocks: [],
			blockSource: 'none'
		}
		: null;
}

export function pageDiagnosticsRow(ctx: ManagerDiagnosticsView, s: PageTranslationState): Record<string, unknown> {
	return {
		page: s.pageIndex + 1,
				status: s.status,
				error: s.error?.code ?? null,
				// 2.8.3: 完整内容已卸(冷页省内存)—— 块表为空是这个原因,
				// 不是"这页没有可译内容"。
				...(s.evicted ? { evicted: true } : {}),
				metrics: s.diagnostics
					? {
						...s.diagnostics,
						...((): Partial<PageDiagnostics> => {
							const t = ctx.pageTokens.get(s.pageIndex);
							return t
								? { inputTokens: t.inputTokens, outputTokens: t.outputTokens, cachedInputTokens: t.cachedInputTokens }
								: {};
						})(),
						// 2.8.4 (性能第五批): 排队 / 抽取 / 首字三段计时。
						...((): Partial<PageDiagnostics> => {
							const t = ctx.pageTiming.get(s.pageIndex);
							if (!t) {
								return {};
							}
							return {
								extractMs: t.extractMs,
								...(typeof t.queuedMs === 'number' ? { queuedMs: t.queuedMs } : {}),
								...(t.firstTextAt ? { firstTextMs: t.firstTextAt - t.requestedAt } : {}),
								// 2.8.15: 抽取内部分段 —— extractMs 的去向。
								...(t.extractPhases ? { extractPhases: t.extractPhases } : {})
							};
						})()
					}
					: null,
				// 2.8.5 (P0): 活块与摘要走**同一个**函数 —— 逐块状态的判定规则只有
				// 一份,不会"内存里算一套、摘要里算另一套"。'preserved' 的口径
				// 沿用 2.3.7:preserve 块(数据单元格等)是**有意**不翻译,不该
				// 报成 untranslated。
				blocks: diagnosticRows(s.blocks.length ? digestRows(s) : (s.blockDigest?.blocks ?? [])),
				// 这一页的逐块明细是现算的还是卸载前拍下的 —— 空块表不再需要靠猜。
				blockSource: s.blocks.length ? 'live' : (s.blockDigest ? 'digest' : 'none'),
				...(s.blockDigest && !s.blocks.length
					? { blockDigestRun: s.blockDigest.runId, blockDigestRevision: s.blockDigest.revision }
					: {}),
				...(s.extractPath ? { extractPath: s.extractPath } : {})
	};
}

/** 会话级汇总(用量、引擎轮换等)—— 与逐页数据分开,导出时单独成一行。 */
export function sessionDiagnostics(ctx: ManagerDiagnosticsView): Record<string, unknown> {
	return {
		// 用量统计 (2.3.9): 纯计数,不含文本。比率现算,分母为 0 时省略。
		usage: {
			pageCacheLookups: ctx.usage.pageCacheLookups,
			pageCacheFullHits: ctx.usage.pageCacheFullHits,
                displayRestores: ctx.usage.displayRestores,
                resumedPages: ctx.usage.resumedPages,
                supplementBlocks: ctx.usage.supplementBlocks,
                repeatedBlockSubmissions: ctx.usage.repeatedBlockSubmissions,
			pageCachePartialHits: ctx.usage.pageCachePartialHits,
			...(ctx.usage.pageCacheLookups
				? { pageCacheHitRate: Number((ctx.usage.pageCacheFullHits / ctx.usage.pageCacheLookups).toFixed(3)) }
				: {}),
			segmentLookups: ctx.usage.segmentLookups,
			segmentHits: ctx.usage.segmentHits,
			...(ctx.usage.segmentLookups
				? { segmentHitRate: Number((ctx.usage.segmentHits / ctx.usage.segmentLookups).toFixed(3)) }
				: {}),
			prefetchedPages: ctx.usage.prefetchedPages.size,
			prefetchedUnviewed: ctx.usage.prefetchedUnviewed.size,
			// token 用量 (2.7.0, 审核 F-2): 服务商报告值之和;usageReports /
			// usageMissing 说明有多少请求带/不带用量字段(免费引擎多半不带)。
			inputTokens: ctx.tokenUsage.inputTokens,
			outputTokens: ctx.tokenUsage.outputTokens,
			cachedInputTokens: ctx.tokenUsage.cachedInputTokens,
			usageReports: ctx.usageReports,
			usageMissing: ctx.usageMissing,
			// 2.7.7: 真实 HTTP 尝试 (含适配器自愈重试) 与校验失败次数。
			httpAttempts: ctx.httpAttempts,
			validationFailures: ctx.validationFailures,
			// 5.0: 当前页对冲请求次数 / 备选先回来的次数。
			hedgesLaunched: ctx.hedges.launched,
			hedgesWon: ctx.hedges.won,
			// 2.8.4 (性能第五批): 此刻还持有完整内容的页数("热页面")。
			// 它与 pageRetention 的上限一起看 —— 上限是否合适,先看这个数字。
			hotPages: [...ctx.pages.values()].filter(p => p.evicted !== true).length,
			retainedPages: ctx.pages.size,
			// 2.9.0: 释放过的页 —— `released` 是"释放过至少一次"的总数,
			// `releasedPending` 是**此刻仍然没有页状态**的,也就是用户真的
			// 会看到一片英文的那几页。后者不为 0 就是一条必须解释的事实。
			// 2.9.2: 本次会话完全没碰过、却夹在碰过的页之间的页号。
			// 「中间有洞」这件事必须自己跳出来,不该靠人肉比对页号才发现。
			...((): Record<string, unknown> => {
				const gaps = ctx.scopeGaps();
				return gaps.length ? { untouchedGaps: gaps } : {};
			})(),
			...(ctx.released.size
				? {
					released: ctx.released.size,
					releasedPending: [...ctx.released.keys()].filter(p => !ctx.pages.has(p)).length,
					// 2.9.2: 由 `textlayerrendered` 事件(而不是盲目轮询)发起的重抽次数。
					renderRetries: [...ctx.released.values()].reduce((n, r) => n + r.renderRetries, 0),
					// 2.9.4: 补回被哪一道闸挡掉了 —— 没有它就只能猜。
					...(ctx.renderRetryBlocked.size ? { renderRetryBlocked: countsOf(ctx.renderRetryBlocked) } : {}),
					releaseReasons: countsOf(new Map(
						[...ctx.released.values()].reduce((acc, r) => {
							acc.set(r.reason, (acc.get(r.reason) ?? 0) + 1);
							return acc;
						}, new Map<string, number>())
					))
				}
				: {}),
			// 2.7.9: 多出来的尝试都去哪了 —— 按枚举计数,空表则省略。
			...(ctx.paramHeals.size ? { paramHeals: countsOf(ctx.paramHeals) } : {}),
			...(ctx.attemptErrors.size ? { attemptErrors: countsOf(ctx.attemptErrors) } : {})
		}
	};
}

/** ensurePage 拆出: 记下抽取路径、抽取分阶段耗时与计时起点;返回抽取完成时刻。 */
export function recordExtraction(ctx: ManagerDiagnosticsView, pageIndex: number, state: PageTranslationState, blocks: SourceBlock[], requestedAt: number): number {
	state.blocks = blocks;
	// 2.8.5 (P0): 记下这一页走的抽取路径 —— 语料重解析对不上时,
	// "路径不同"是最可能的原因,此前连问都问不出来。
	try {
		const path = ctx.deps.extractPathOf?.(pageIndex);
		if (path) {
			state.extractPath = path;
		}
	}
	catch { /* 记不到就不记,绝不影响翻译 */ }
	const extractedAt = Date.now();
	let extractPhases: NonNullable<PageDiagnostics['extractPhases']> | undefined;
	try {
		extractPhases = ctx.deps.extractPhasesOf?.(pageIndex);
	}
	catch { /* 量不到就不量,绝不影响翻译 */ }
	ctx.pageTiming.set(pageIndex, {
		requestedAt,
		extractMs: extractedAt - requestedAt,
		firstTextAt: 0,
		...(extractPhases ? { extractPhases } : {})
	});
	return extractedAt;
}
