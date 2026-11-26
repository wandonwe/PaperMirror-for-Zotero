/**
 * The translation manager's recovery chain for blocks a chunk request did not
 * translate: the missing-id retry, grouped then single-block salvage, the
 * English-residue re-translate, and the plain-mode last resort.
 *
 * Moved out of translationManager.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, with the few manager members it used
 * passed in as a RecoveryContext.
 */
import type { GlossaryRule, SourceBlock, TranslatedBlock, TranslationRequest, TranslationResponse } from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { PlaceholderRegistry } from './placeholderRegistry';
import { looksTranslated, hasEnglishResidue, looksLikeReferenceEntry } from './translationValidation';
import { PageRun } from './pageRun';
import { PageTranslationState } from './translationManagerTypes';

const MODULE = 'translationManager';

/** What the recovery chain uses of the translation manager. */
export interface RecoveryContext {
	request(run: PageRun, request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse>;
	documentTitle(): string;
	glossaryFor(texts: string[]): GlossaryRule[];
	literalsFor(block: SourceBlock): string[];
	notify(state: PageTranslationState): void;
}

/**
 * After the batch retry, EVERY still-missing block is salvaged one by one — a
 * single-block request cannot suffer id drift, so it converts almost every
 * survivor. There is no cap: leaving a block untranslated to save a request is
 * exactly the mixed-language page we are trying to eliminate. This soft ceiling
 * only switches on a warning when a provider is systematically dropping ids, so
 * the run is visible in the log rather than silently enormous.
 */
export const SALVAGE_WARN_THRESHOLD = 24;

/**
 * How many single-block salvage requests run at once. A few in flight keeps a
 * long page from stalling on sequential round-trips; kept modest so free MT
 * engines are not rate-limited into failure.
 */
export const SALVAGE_CONCURRENCY = 4;

/** 分级补救 tier-1 batch size: small enough that id drift is rare. */
export const SALVAGE_BATCH_SIZE = 4;

/** Cap on residue re-translations per page — a safety valve against storms. */
export const RESIDUE_MAX_PER_PAGE = 8;

/** 纯文本兜底: how many rejected blocks get a plain-mode rescue per page. */
export const FINAL_RECOVERY_MAX = 4;

/**
 * 局部英文残留补译: re-translate ONLY the blocks whose (accepted) translation
 * still contains an untranslated English clause. Single-block requests, capped
 * per page; a retry replaces the block ONLY if it clears the residue, so we
 * never churn a block into an equally-bad result. Patches state + results
 * (which then flow to the caches) and notifies once — the page is not
 * re-extracted or wholesale re-rendered.
 */
export async function resolveEnglishResidue(ctx: RecoveryContext, 
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
		// 5.0: 已按「保持原文」接受的参考文献条目不再当残留重译。
		.filter(b => !(b.isReference && looksLikeReferenceEntry(b.sourceText)))
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
		const reg = PlaceholderRegistry.protect(block.sourceText, ctx.literalsFor(block), block.styleRuns);
		const text = reg.text;
		try {
			const resp = await translateFn({
				pageIndex: state.pageIndex,
				sourceLanguage: source,
				targetLanguage: target,
				documentTitle: ctx.documentTitle(),
				previousContext: '',
				blocks: [{ id: block.id, type: block.type, text }],
				glossary: ctx.glossaryFor([block.sourceText])
			}, signal);
			const hit = resp.translations.find(t => reg.ok(t.translatedText)
				&& looksTranslated(block.sourceText, reg.restore(t.translatedText), target, { isReference: block.isReference }));
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
		ctx.notify(state);
	}
}

/** runChunk 拆出: 整批请求一次,缺失的 id 再整批重试一次(spec 4.3)。 */
export async function requestChunkOnce(ctx: RecoveryContext, run: PageRun, request: TranslationRequest, chunk: SourceBlock[], received: Map<string, string>,
	acceptChunk: (id: string, text: string) => boolean): Promise<void> {
	const { signal, pageIndex, protectedBlocks, canSpend } = run;
	let response: TranslationResponse = { translations: [] };
	try {
		response = await ctx.request(run, request, signal);
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
			response = await ctx.request(run, retryRequest, signal);
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
}

// 分级补救 tier 1: still-missing blocks are retried in SMALL batches
// (3–5 blocks — id drift is rare at this size) instead of jumping
// straight to one request per block. Only the leftovers of the
// grouped pass fall through to single-block salvage.
export async function salvageGrouped(ctx: RecoveryContext, run: PageRun, request: TranslationRequest, afterRetry: SourceBlock[], received: Map<string, string>): Promise<void> {
	const { signal, pageIndex, metrics, protectedBlocks, canSpend, acceptResponse } = run;
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
				const resp = await ctx.request(run, {
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
}

// 分级补救 tier 2: any id STILL missing gets its own single-block
// request. With exactly one block in the request the answer cannot
// misalign. Without this pass the block silently stayed English and
// the page rendered mixed-language (the JACC report).
export async function salvageSingles(ctx: RecoveryContext, run: PageRun, request: TranslationRequest, stillMissing: SourceBlock[], received: Map<string, string>): Promise<void> {
	const { signal, pageIndex, metrics, target, protectedBlocks, canSpend, noteReject, rejectedResponse } = run;
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
				const single = await ctx.request(run, 
					{ ...request, previousContext: '', blocks: [{ id: block.id, type: block.type, text: pb.text }] },
					signal
				);
				// One block in → whatever comes back IS its translation,
				// even if the model rewrote the id — but only if it is
				// actually translated, not the English echoed back, and no
				// protected token was lost or invented.
				const first = single.translations.find(t =>
					pb.reg.ok(t.translatedText)
					&& looksTranslated(block.sourceText, pb.reg.restore(t.translatedText), target, { isReference: block.isReference, keepAsName: run.nameCellIds.has(block.id) }));
				if (first) {
					received.set(block.id, first.translatedText);
				}
				else if (single.translations.length) {
					// 5.0: the reason is computed on the RESTORED text, as acceptance
					// is. On the masked text every protected keV/kVp looked missing, so
					// the diagnostics reported 'technical-unit' for unrelated failures.
					const raw = single.translations[0]?.translatedText ?? '';
					noteReject(block.id, rejectedResponse(block.id, pb.reg.restore(raw), 'salvage-validator'));
				}
				else {
					// 死分支修复 (1.1.8): 这里原本是与上面条件完全相同的
					// 第二个 else if,永不可达 —— 于是「打捞请求回了个空
					// 数组」这一支从不落原因码,块的 lastReject 停在批次
					// 阶段的旧值上,诊断读起来就像打捞从没跑过。
					noteReject(block.id, 'salvage-empty');
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
}

// 纯文本兜底 (修复链路最后一环, 参照 retain-pdf final recovery): blocks the
// whole JSON chain rejected get ONE more shot each in plain mode — the
// answer is the bare translation, so id drift and JSON mangling cannot
// fail it. Budgeted (≤4/page, shares the page request cap).
export async function recoverPlain(ctx: RecoveryContext, run: PageRun): Promise<void> {
	const { state, signal, pageIndex, source, target, toTranslate, protectedBlocks, canSpendFinal, noteReject, rejectedResponse } = run;
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
			const resp = await ctx.request(run, {
				pageIndex,
				sourceLanguage: source,
				targetLanguage: target,
				documentTitle: ctx.documentTitle(),
				previousContext: '',
				blocks: [{ id: block.id, type: block.type, text: pb.text }],
				glossary: ctx.glossaryFor([block.sourceText]),
				plain: true
			}, signal);
			const translatedHit = resp.translations.find(t =>
				looksTranslated(block.sourceText, pb.reg.restore(t.translatedText), target, { isReference: block.isReference, keepAsName: run.nameCellIds.has(block.id) }));
			const hit = translatedHit && pb.reg.ok(translatedHit.translatedText) ? translatedHit : undefined;
			if (hit) {
				const restored = pb.reg.restore(hit.translatedText);
				state.translations.set(block.id, restored);
				run.results.push({ id: block.id, translatedText: restored });
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
				const bare = await ctx.request(run, {
					pageIndex,
					sourceLanguage: source,
					targetLanguage: target,
					documentTitle: ctx.documentTitle(),
					previousContext: '',
					blocks: [{ id: block.id, type: block.type, text: block.sourceText }],
					glossary: ctx.glossaryFor([block.sourceText]),
					plain: true
				}, signal);
				const bareHit = bare.translations.find(t =>
					looksTranslated(block.sourceText, t.translatedText, target, { isReference: block.isReference, keepAsName: run.nameCellIds.has(block.id) }));
				if (bareHit) {
					state.translations.set(block.id, bareHit.translatedText);
					run.results.push({ id: block.id, translatedText: bareHit.translatedText });
					logger.info(MODULE, `Page ${pageIndex + 1}: unmasked plain recovery rescued ${block.id} (placeholder chain had failed)`);
				}
				else {
					noteReject(block.id, 'plain-placeholder');
				}
			}
			else if (resp.translations.length) {
				const raw = resp.translations[0]?.translatedText ?? '';
				noteReject(block.id, rejectedResponse(block.id, pb.reg.restore(raw), 'plain-validator'));
			}
			else {
				// 同一处死分支 (1.1.8): 见上面 salvage 的说明。
				noteReject(block.id, 'plain-empty');
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
		ctx.notify(state);
	}
}
