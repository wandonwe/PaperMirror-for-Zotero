/**
 * After a page is laid out: reporting placement results, the strict-fit
 * compress rounds for blocks that do not fit, collecting placement diagnostics
 * and auditing the final and partial geometry.
 *
 * Moved out of readerSession.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, using the session through a view
 * over the instance (only the members listed as writable are assigned).
 */
import { pageContentKey } from '../export/pageArchive';
import { getProvider } from '../translation/providers/registry';
import { supportsCharBudget } from '../translation/providers/types';
import { TranslationManager } from '../translation/translationManager';
import {
	revertStrictBlocks,
	shrinkStrictBlocks,
	expandStrictBlocks,
	applyCompressedStrict,
	planStrictRetry,
	strictPageStats,
	placementTally,
	auditStrictGeometry,
	probeStrictPlacement,
	strictAbandonedBlocks,
	type UnfitBlock
} from '../ui/strictPageReplacement';
import * as logger from '../utils/logger';
import { getPref } from '../utils/prefs';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderSession } from './readerSession';

const MODULE = 'readerSession';

/** What these functions use of the ReaderSession (5.1: a view over the instance, see ReaderSession.placementView; only the non-readonly members are written). */
export interface PlacementReportingView {
	readonly abandonedBlocks: ReaderSession['abandonedBlocks'];
	readonly archivePage: ReaderSession['archivePage'];
	readonly compressRounds: ReaderSession['compressRounds'];
	readonly destroyed: ReaderSession['destroyed'];
	readonly geometryAudits: ReaderSession['geometryAudits'];
	lastPartial: ReaderSession['lastPartial'];
	readonly ledger: ReaderSession['ledger'];
	readonly manager: ReaderSession['manager'];
	readonly pageNote: ReaderSession['pageNote'];
	readonly placementKeys: ReaderSession['placementKeys'];
	readonly placementProbe: ReaderSession['placementProbe'];
	readonly placementStats: ReaderSession['placementStats'];
	readonly providerForPage: ReaderSession['providerForPage'];
	readonly pushOverlayProgress: ReaderSession['pushOverlayProgress'];
	readonly reader: ReaderSession['reader'];
	readonly renderToken: ReaderSession['renderToken'];
	readonly translatedPages: ReaderSession['translatedPages'];
	readonly runStrictCompress: ReaderSession['runStrictCompress'];
	readonly resolveStrictUnfit: ReaderSession['resolveStrictUnfit'];
	readonly reportPlacement: ReaderSession['reportPlacement'];
	readonly collectPlacementDiagnostics: ReaderSession['collectPlacementDiagnostics'];
	readonly auditFinalGeometry: ReaderSession['auditFinalGeometry'];
	readonly auditPartialGeometry: ReaderSession['auditPartialGeometry'];
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
export function resolveStrictUnfit(ctx: PlacementReportingView, pageIndex: number, element: HTMLElement, unfit: UnfitBlock[], token: number): void {
	const live = (): boolean => !ctx.destroyed && element.isConnected && ctx.renderToken.get(pageIndex) === token;
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
		ctx.reportPlacement(pageIndex, element);
		return;
	}
	const budgetCapable = supportsCharBudget(getProvider(ctx.providerForPage(pageIndex)));
	const plan = planStrictRetry(remaining, {
		roundsFor: id => ctx.compressRounds.get(id) ?? 0,
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
	const compressPending = ctx.ledger.isCompressPending(pageIndex);
	if (!plan.compress.length || compressPending || !ctx.manager) {
		// shrink-only 路径此前静默结束,页面的最终清点从未发生(1.1.0
		// 顺手补上的诚实计数缺口)——几何复核与 tally 都挂在 reportPlacement。
		if (!plan.compress.length && !compressPending) {
			ctx.reportPlacement(pageIndex, element);
		}
		// 丢失唤醒补接力 (2.0.9, 审核 P2-10): 被在飞压缩挡回的渲染记下
		// 待办,压缩 finally 里续跑 —— 否则这次渲染的未适配块永远无人处理。
		else if (plan.compress.length && compressPending) {
			ctx.ledger.deferRender(pageIndex, { element, unfit: remaining, token });
		}
		// 5.0 (联网校验 3064/3384: 胶囊停在「正在适配 · 排版 0/N」): 这一趟只剩
		// 缩字/保留原文、却撞上一个属于旧渲染的在飞压缩 —— 两条分支都不成立,
		// 最终清点无人执行。登记一个空待办,压缩收尾时替这次渲染做清点。
		else if (compressPending) {
			ctx.ledger.deferRender(pageIndex, { element, unfit: [], token });
		}
		return;
	}
	ctx.runStrictCompress(pageIndex, element, remaining, plan.compress, token, live, ctx.manager);
}

/**
 * resolveStrictUnfit 拆出: 对这些块发一次页级压缩重译(同页最多一个在飞),
 * 结果就地套用;仍放不下的进入下一轮,全部处理完做最终清点。
 */
export function runStrictCompress(ctx: PlacementReportingView, pageIndex: number, element: HTMLElement, remaining: UnfitBlock[], compressIds: string[], token: number, live: () => boolean, manager: TranslationManager): void {
	const generation = ctx.ledger.beginCompress(pageIndex);
	if (!generation) return; // resolveStrictUnfit already checked; defensive
	// A render turned away during the previous round (released early to let
	// this round start) joins this round instead of being lost.
	ctx.ledger.adoptCarried(pageIndex);
	for (const id of compressIds) {
		ctx.compressRounds.set(id, (ctx.compressRounds.get(id) ?? 0) + 1);
	}
	const entries = remaining.filter(u => compressIds.includes(u.id));
	void manager.compressBlocks(pageIndex, entries)
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
			ctx.ledger.releaseCompress(pageIndex, generation);
			if (next.length) {
				ctx.resolveStrictUnfit(pageIndex, element, next, token);
			}
			else {
				ctx.reportPlacement(pageIndex, element);
			}
		})
		.catch(() => {
			// 压缩请求异常退出也必须走一次最终清点 (1.2.2, 审核项): 否则
			// 几何复核与 placement tally 永不发生,胶囊停在「排版中」。
			// (清理交给 finally。)
			if (live()) {
				ctx.reportPlacement(pageIndex, element);
			}
		})
		.finally(() => {
			// 兜底清理 (审核 P1-6): 无论 then 早退、then 正常、还是 catch,
			// 这个标记都必须落地清除。Set.delete 幂等,与上面 then 里那次
			// 提前清除并存无害。
			// 5.0: release only THIS generation. Before, this delete also wiped the
			// flag of a round that the then-branch had just started, so a third
			// render could start a concurrent compress for the same page.
			// P2-10 (2.0.9): 压缩期间被挡回的最新渲染在这里接力 —— 旧 token
			// 由 resolveStrictUnfit 自己的 live() 拦截,无需在此判活。若下一轮已
			// 经开始,被挡回的渲染已交给它(adoptCarried),这里拿到的是 null。
			const blocked = ctx.ledger.endCompress(pageIndex, generation) ?? ctx.ledger.takeCarried(pageIndex);
			if (blocked) {
				if (!ctx.destroyed && blocked.unfit.length) {
					ctx.resolveStrictUnfit(pageIndex, blocked.element, blocked.unfit, blocked.token);
				}
				else if (!ctx.destroyed && blocked.element.isConnected && ctx.renderToken.get(pageIndex) === blocked.token) {
					ctx.reportPlacement(pageIndex, blocked.element);
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
/**
 * 半成品页的几何审计 (2.8.2 第三批): 只跑审计本身(违例块回退/保留原文),
 * **不**写 geometryAudits —— 半成品的数字不该进诊断,终版渲染会写真的那份。
 */
export function auditPartialGeometry(ctx: PlacementReportingView, pageIndex: number, element: HTMLElement): void {
	try {
		auditStrictGeometry(element);
	}
	catch (e) {
		logger.debug(MODULE, `partial geometry audit failed on page ${pageIndex + 1} (ignored)`, e);
	}
}

export function reportPlacement(ctx: PlacementReportingView, pageIndex: number, element: HTMLElement): void {
  const state = ctx.manager?.getPageState(pageIndex);
  if (!state || element.getAttribute('data-pm-content-key') !== pageContentKey(state.blocks,state.translations)) return;
  ctx.placementKeys.set(pageIndex, pageContentKey(state.blocks,state.translations));
  ctx.placementProbe.delete(pageIndex);

	ctx.auditFinalGeometry(pageIndex, element);
	const s = strictPageStats(element);
	if (!s) {
		return;
	}
	ctx.placementStats.set(pageIndex, s); // P3 (2.0.10): 供诊断导出
	ctx.collectPlacementDiagnostics(pageIndex, element);
	ctx.archivePage(state, true);
	logger.info(
		MODULE,
		`page ${pageIndex + 1} placement: ${s.committed}/${s.replaceable} shown, `
		+ `${s.abandoned} won't fit, ${s.untranslated} untranslated, `
		+ `${s.tableFailed} table-failed, ${s.tableIntentional} table-kept, `
		+ `${s.imageExcluded} on images, ${s.tooSmall} too small`
	);
	if (ctx.destroyed) {
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
	ctx.translatedPages.add(pageIndex);
	// Remember where the kept-original segments live so 「查看保留原文」can
	// jump straight to them; clear it once the page places everything.
	if (kept > 0) {
		ctx.lastPartial = { pageIndex, element };
	}
	else if (ctx.lastPartial?.pageIndex === pageIndex) {
		ctx.lastPartial = null;
	}
	if (pageIndex !== adapter.getCurrentPageIndex(ctx.reader)) {
		return; // only annotate (capsule) the page the reader is actually on
	}
	ctx.pushOverlayProgress({
		phase,
		currentPage: pageIndex + 1,
		totalPages: adapter.getPageCount(ctx.reader),
		segTotal,
		segTranslated: segTotal, // translation itself is complete at this point
		segPlaced: placed,
		kept,
		...ctx.pageNote(pageIndex)
	});
}

/** reportPlacement 拆出: 终版几何安全复核(违例块回退或保留原文),必须先于取数。 */
export function auditFinalGeometry(ctx: PlacementReportingView, pageIndex: number, element: HTMLElement): void {
	// 几何安全复核 (1.1.0 目标架构第 5 步): FINAL 状态下审计一次;违例的
	// 块回退扩展/缩字重试,仍不适配则保留原文——处置结果反映进随后的
	// stats/tally,所以必须先审计后取数。
	try {
		const audit = auditStrictGeometry(element);
		if (audit) {
			ctx.geometryAudits.set(pageIndex, audit);
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
}

/** reportPlacement 拆出: 收放弃清单与轻量排版探针,供诊断导出。 */
export function collectPlacementDiagnostics(ctx: PlacementReportingView, pageIndex: number, element: HTMLElement): void {
	// 放弃清单 (2.7.0): 不采样像素、零成本,无论是否开调试日志都收。
	try {
		const abandoned = strictAbandonedBlocks(element);
		if (abandoned) {
			ctx.abandonedBlocks.set(pageIndex, abandoned);
		}
	}
	catch (e) {
		logger.debug(MODULE, `abandoned list failed on page ${pageIndex + 1} (ignored)`, e);
	}
	// Always archive lightweight placement measurements. Pixel sampling is
	// still debug-only; bitmapSampled=false distinguishes omitted samples.
	try {
		const probe = probeStrictPlacement(element, getPref<boolean>('debugLogging', false));
		if (probe) ctx.placementProbe.set(pageIndex, probe);
	}
	catch (e) {
		logger.debug(MODULE, `placement probe failed on page ${pageIndex + 1} (ignored)`, e);
	}
}
