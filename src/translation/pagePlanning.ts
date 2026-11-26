/**
 * Page preparation steps of the translation manager: filling a page from the
 * page cache and the segment store, and planning which blocks are translated,
 * kept or shared with identical blocks, and in which chunks.
 *
 * Moved out of translationManager.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, reading the manager through a
 * read-only PagePlanningView.
 */
import { policyStampFor } from './promptPolicies';
import { isNumericPowerLiteral } from './numericPowers';
import { isTechnicalUnitLiteral } from './technicalUnits';
import type { SourceBlock } from '../types/models';
import * as logger from '../utils/logger';
import { isFormulaDenseRisk } from '../reader/formulaGuard';
import { PlaceholderRegistry } from './placeholderRegistry';
import { planChunks, trailingContext } from './segmenter';
import { buildLayoutModules } from '../reader/layoutModules';
import { PageRun } from './pageRun';
import type { TranslationManager } from './translationManager';

const MODULE = 'translationManager';

/** What these functions read of the TranslationManager (5.1: read-only view, see TranslationManager.planningView). */
export interface PagePlanningView {
	readonly deps: TranslationManager['deps'];
	readonly notify: TranslationManager['notify'];
	readonly usage: TranslationManager['usage'];
	readonly literalsFor: TranslationManager['literalsFor'];
	readonly prefillFromPageCache: TranslationManager['prefillFromPageCache'];
	readonly prefillFromSegments: TranslationManager['prefillFromSegments'];
	readonly planPage: TranslationManager['planPage'];
}

// 2. Cache — a hit is only COMPLETE when every active block has a usable
// translation (审核 P1): the file being valid never meant it covered the
// page. A partial entry (e.g. written by the compress path while some
// blocks were keep-origin) used to flip the page straight to done with
// blocks silently left in English. Now: cached ids that no longer exist
// are dropped, every entry must still pass the same accept() gate as a
// live response, and an incomplete hit only PREFILLS — the rest of the
// pipeline translates the missing blocks (toTranslate skips prefilled).
/** 返回 true 表示整页缓存完整命中,这一页已完成。 */
export async function prefillFromPageCache(ctx: PagePlanningView, run: PageRun): Promise<boolean> {
	const { state, metrics, pageIndex, blocks, activeBlocks, accept } = run;
	ctx.usage.pageCacheLookups++;
	const cached = await ctx.deps.readCache(pageIndex, blocks);
	if (cached) {
		const cachedById = new Map(cached.map(t => [t.id, t.translatedText]));
		const cachedProvisional = new Set(cached.filter(t => t.provisional).map(t => t.id));
		const cachedPolicy = new Map(cached.map(t => [t.id, t.policy ?? '']));
		let usable = 0;
		let stale = 0;
		for (const block of activeBlocks) {
			const text = cachedById.get(block.id);
			// 5.0: a row produced under an older version of a prompt rule that
			// concerns this block is dropped; only those blocks are re-translated.
			if (typeof text === 'string' && cachedPolicy.get(block.id) !== policyStampFor(block)) { stale++; continue; }
			if (typeof text === 'string' && accept(block.id, text)) {
				state.translations.set(block.id, text);
				// Still provisional: never promoted into the segment store.
				if (cachedProvisional.has(block.id)) run.provisional.add(block.id);
				usable++;
			}
		}
		if (usable === activeBlocks.length) {
			ctx.usage.pageCacheFullHits++;
			state.status = 'done';
			state.fromCache = true;
			// 整页缓存命中 = 译文就在缓存里 (2.8.3): 这一页当然可以再被
			// 卸掉。漏了这一条,"翻回旧页"复原出来的页会被永久钉在内存
			// 里,来回翻几次就把上限彻底架空。
			state.cached = true;
			state.diagnostics = {
				requests: 0, salvage: 0, rateLimited: 0, timeouts: 0,
				segmentHits: 0, durationMs: Date.now() - metrics.startedAt, fromCache: true
			};
			ctx.notify(state);
			return true;
		}
		if (usable) {
			ctx.usage.pageCachePartialHits++;
			logger.info(MODULE, `Page ${pageIndex + 1}: partial cache (${usable}/${activeBlocks.length}${stale ? `, ${stale} under an older prompt rule` : ''}) — prefilled, translating the rest`);
			ctx.notify(state); // show reused blocks immediately
		}
	}
	return false;
}

// 2.5 段落级缓存: prefill whatever segments this context has already
// translated (content+language hash; provider/model scoping lives in the
// store the host injects). 普通刷新 re-enters here with the page cache
// bypassed but segments live, so only the segments that actually failed
// or changed cost a request. 'force' skips this entirely.
export async function prefillFromSegments(ctx: PagePlanningView, run: PageRun): Promise<void> {
	const { state, pageIndex, activeBlocks, accept, segHash } = run;
	if (!ctx.deps.readSegments) {
		return;
	}
	ctx.usage.segmentLookups += activeBlocks.length;
	const cached = await ctx.deps.readSegments(pageIndex, activeBlocks.map(segHash)).catch(() => null);
	if (cached?.size) {
		for (const block of activeBlocks) {
			const hit = cached.get(segHash(block));
			if (hit !== undefined && accept(block.id, hit)) {
				state.translations.set(block.id, hit);
				run.segmentHits++;
			}
		}
		if (run.segmentHits) {
			ctx.usage.segmentHits += run.segmentHits;
			ctx.notify(state); // show reused segments immediately
		}
	}
}

/** 第 3 步: 占位符保护与请求分批(快道 / 慢道),定出本页请求上限。 */
export function planPage(ctx: PagePlanningView, run: PageRun): void {
	const { state } = run;
	// Protect formulas / citations / statistics per block (+ 不译词列表) —
	// 占位符注册表 (1.1.0): 掩蔽/校验/还原共用同一实例,清单不可能串块。
	run.protectedBlocks = run.uniqueToTranslate.map((block) => {
		const reg = PlaceholderRegistry.protect(block.sourceText, ctx.literalsFor(block), block.styleRuns);
		return { block, reg, text: reg.text };
	});
	// 占位符清单校验 (参照 retain-pdf): a model response that LOST a protected
	// token (or invented one) is treated as invalid — it flows into the same
	// retry/salvage chain as a missing id, instead of silently restoring into
	// a paragraph with the formula/citation gone.
	const regById = run.regById = new Map(run.protectedBlocks.map(p => [p.block.id, p.reg]));
	state.rejectReasons = state.rejectReasons ?? new Map();
	state.rejectHistory = new Map();

	// Plan requests: semantic modules are SOFT boundaries (context tags), the
	// character budget is the real request boundary — a page with many short
	// subheadings packs into 1–2 high-fill requests, not 4–8 half-empty ones.
	// 三分道: tables, very long paragraphs and formula-dense blocks are
	// isolated into single-block 'slow' chunks appended after the fast
	// batches — one hard block can no longer sink a whole batch (id drift,
	// truncation) or delay the fast batches that paint most of the page.
	const maskedById = new Map(run.protectedBlocks.map(p => [p.block.id, p.text]));
	const riskOf = (b: SourceBlock): boolean => {
		const ph = regById.get(b.id)?.entries.filter(entry => !isTechnicalUnitLiteral(entry.original) && !isNumericPowerLiteral(entry.original)).length ?? 0;
		return b.type === 'table'
			|| b.sourceText.length > 2400
			|| ph >= 5
			// 评分路由 (retain-pdf segment_risk): 定义句 + 公式密集 + 占位符
			// 前置的组合比单纯计数更早识别高风险块。
			|| isFormulaDenseRisk(maskedById.get(b.id) ?? b.sourceText, ph);
	};
	const chunks = run.chunks = planChunks(run.uniqueToTranslate, buildLayoutModules(run.uniqueToTranslate), { riskOf });
	// Hard ceiling on requests for this page so a misbehaving engine can never
	// turn one page into a request storm: 2× the planned chunks, plus 2. Once
	// hit, salvage stops and the remaining blocks are left for 「刷新本页」.
	run.pageRequestCap = chunks.length * 2 + 2;

	// Context is derived from SOURCE text only (audit-verified: nothing in a
	// request reads a prior chunk's RESPONSE), so it is precomputable and the
	// chunks can safely run concurrently. Slow chunks sit OUT of reading
	// order at the tail, so they neither receive positional context nor
	// provide it — an isolated hard block doesn't need its neighbour's tail,
	// and a wrong neighbour is worse than none.
	// 同流才传上下文 (2.7.1): 单元格批不再收到正文段尾 —— 它的语境是表格
	// 标题 (moduleContext),正文尾句只是噪声与 token。
	run.contexts = chunks.map((c, i) => (
		c.lane === 'fast' && i > 0 && chunks[i - 1]!.lane === 'fast' && chunks[i - 1]!.kind === c.kind
			? trailingContext(chunks[i - 1]!.blocks)
			: ''
	));
	// Sentence-specific bidirectional context is prepared before cache lookup,
	// from complete source pages rather than the already-filtered chunks.
}
