/**
 * Re-translation the user asks for: shortening blocks that do not fit
 * (compress), re-translating one block, and re-translating a whole page.
 *
 * Moved out of translationManager.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, reading the manager through a
 * read-only ManualRetranslationView.
 */
import { numericPowerIssue } from './numericPowers';
import { technicalUnitIssue } from './technicalUnits';
import type { TranslatedBlock, TranslationRequest } from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { PlaceholderRegistry } from './placeholderRegistry';
import { looksTranslated } from './translationValidation';
import { extractTermPairs } from './docMemory';
import { blockSegmentHash, noteProvisionalIn, pageCacheRows, PRIORITY } from './translationManagerTypes';
import type { TranslationManager } from './translationManager';

const MODULE = 'translationManager';

/** What these functions read of the TranslationManager (5.1: read-only view, see TranslationManager.retranslationView). */
export interface ManualRetranslationView {
	readonly deps: TranslationManager['deps'];
	readonly disposed: TranslationManager['disposed'];
	readonly docMemory: TranslationManager['docMemory'];
	readonly ensurePage: TranslationManager['ensurePage'];
	readonly extractZombies: TranslationManager['extractZombies'];
	readonly failedSegments: TranslationManager['failedSegments'];
	readonly glossaryFor: TranslationManager['glossaryFor'];
	readonly laneFor: TranslationManager['laneFor'];
	readonly literalsFor: TranslationManager['literalsFor'];
	readonly meteredTranslate: TranslationManager['meteredTranslate'];
	readonly notify: TranslationManager['notify'];
	readonly pages: TranslationManager['pages'];
	readonly persistPage: TranslationManager['persistPage'];
	readonly released: TranslationManager['released'];
	readonly requestGate: TranslationManager['requestGate'];
	readonly scheduler: TranslationManager['scheduler'];
	readonly trackWrite: TranslationManager['trackWrite'];
	readonly unstableFired: TranslationManager['unstableFired'];
	readonly compressBlocks: TranslationManager['compressBlocks'];
	readonly retranslateBlock: TranslationManager['retranslateBlock'];
	readonly retranslatePage: TranslationManager['retranslatePage'];
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
export async function compressBlocks(ctx: ManualRetranslationView, pageIndex: number, entries: { id: string; maxChars: number }[]): Promise<Map<string, string>> {
	const accepted = new Map<string, string>();
	const state = ctx.pages.get(pageIndex);
	if (ctx.disposed || !state || state.status !== 'done' || !entries.length) {
		return accepted;
	}
	const wanted = new Map(entries.map(e => [e.id, e.maxChars]));
	const blocks = state.blocks.filter(b => wanted.has(b.id));
	if (!blocks.length) {
		return accepted;
	}
	const sampleText = blocks.map(b => b.sourceText).join('\n').slice(0, 4000);
	const { source, target } = ctx.deps.getLanguages(sampleText);
	try {
		await ctx.scheduler.enqueue(`page-${pageIndex}-compress`, PRIORITY.CURRENT_COMPRESS, async (signal) => {
			const protectedBlocks = blocks.map((block) => {
				const reg = PlaceholderRegistry.protect(block.sourceText, ctx.literalsFor(block), block.styleRuns);
				return { block, reg, text: reg.text };
			});
			const request: TranslationRequest = {
				pageIndex,
				sourceLanguage: source,
				targetLanguage: target,
				documentTitle: ctx.deps.getDocumentTitle(),
				previousContext: '',
				blocks: protectedBlocks.map(pb => ({
					id: pb.block.id,
					type: pb.block.type,
					text: pb.text,
					charBudget: wanted.get(pb.block.id)
				})),
				glossary: ctx.glossaryFor(blocks.map(b => b.sourceText)),
				// 5.0 (校验 r22, 3036 p5): a shorter reference is still a reference —
				// only the title translates. Without the rule the model shortened
				// "5. Choi MH, MacKenzie JD, Dalinka MK. Imaging features of …" to
				// "5. 晶体性关节病影像学", dropping authors, journal and pages.
				referenceContent: blocks.some(b => b.isReference)
			};
			const response = await ctx.requestGate.run(ctx.laneFor(pageIndex), true, () => ctx.meteredTranslate(request, signal), signal);
			const marked = new Set(response.provisionalIds ?? []);
			for (const t of response.translations) {
				const pb = protectedBlocks.find(p => p.block.id === t.id);
				if (!pb || !t.translatedText.trim()) {
					continue;
				}
				if (!pb.reg.ok(t.translatedText)) continue;
				const restored = pb.reg.restore(t.translatedText);
				if (technicalUnitIssue(pb.block.sourceText, restored) || numericPowerIssue(pb.block.sourceText, restored)) continue;
				// Same acceptance as the first translation for a reference: authors,
				// journal and numbers stay as written.
				if (pb.block.isReference && !looksTranslated(pb.block.sourceText, restored, target, { isReference: true })) continue;
				const previous = state.translations.get(t.id);
				// Only accept a genuinely shorter retry; equal/longer output
				// cannot help it fit and would burn the result for nothing.
				if (previous !== undefined && restored.length >= previous.length) {
					continue;
				}
				state.translations.set(t.id, restored);
				accepted.set(t.id, restored);
			}
			// 5.0 审核: 压缩结果同样可能是分栏降级的临时译文;临时的不进缓存。
			noteProvisionalIn(state, { translations: [], provisionalIds: [...marked] }, accepted.keys());
			if (accepted.size) {
				// 孤儿 compress 不落盘 (2.0.7, 审核 P2-2): 压缩请求可飞 120s,
				// 期间用户可能已「刷新本页」—— 新运行接管该页并写入了新缓存。
				// 此闭包捕获的是**旧** state: 若它已不是当前状态,写盘会用旧
				// 译文覆写刷新后的页面缓存与段落库(写队列串行、后写者胜),
				// 表现为「反复刷新反复回退」。
				if (ctx.pages.get(pageIndex) !== state) {
					logger.debug(MODULE, `Page ${pageIndex + 1}: compress finished after supersession; not persisted`);
					return;
				}
				logger.info(MODULE, `Page ${pageIndex + 1}: ${accepted.size} block(s) re-translated shorter under budget`);
				const all: TranslatedBlock[] = pageCacheRows(state, state.blocks);
				// Only a COMPLETE page enters the page cache (审核 P1): this
				// path can run while some blocks are keep-origin — writing the
				// partial set used to freeze the page as a cache entry that hit
				// and went straight to done with those blocks left in English.
				const complete = state.blocks.every(b =>
					b.translationMode === 'preserve' || state.translations.has(b.id));
				if (complete) {
					await ctx.persistPage(state, all);
				}
				// The SHORTER (fitting) version replaces the long one in the
				// segment store too, so a 普通刷新 does not resurrect a
				// translation that already failed placement once.
				if (ctx.deps.writeSegments) {
					const byId = new Map(blocks.map(b => [b.id, b]));
					// 同上 (2.5.9): 压缩任务跑在**前台 lane** 上,更不该拿
					// 槽位去等落盘。
					ctx.trackWrite(ctx.deps.writeSegments(pageIndex, [...accepted]
						.filter(([id]) => byId.has(id) && !state.provisional?.has(id))
						.map(([id, text]) => ({
							hash: blockSegmentHash(byId.get(id)!, source, target),
							translatedText: text
						}))
					));
				}
			}
		}, { foreground: true, lane: ctx.laneFor(pageIndex) }); // compress serves the VISIBLE page's layout
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
export async function retranslatePage(ctx: ManualRetranslationView, pageIndex: number, mode: 'normal' | 'rotate' | 'force' = 'normal'): Promise<void> {
	// 审核 P1: an EXPLICIT refresh of this page clears its blocks' 止损 memory
	// — the user asked for a retry, so the skipped segments get one. Cross-page
	// duplicates of the same hash on OTHER pages keep their memory.
	const prior = ctx.pages.get(pageIndex);
	if (prior?.blocks.length) {
		try {
			const sample = prior.blocks.map(b => b.sourceText).join('\n').slice(0, 4000);
			const { source, target } = ctx.deps.getLanguages(sample);
			for (const b of prior.blocks) {
				ctx.failedSegments.delete(blockSegmentHash(b, source, target));
			}
		}
		catch { /* language resolution is best-effort here */ }
	}
	ctx.pages.delete(pageIndex);
	ctx.unstableFired.delete(pageIndex); // a fresh run may report anew
	// 2.9.0: 用户亲手点的重译要**清掉释放计数** —— 自动重试有界(MAX_RELEASES)
	// 是为了不空转,不该用来挡住用户自己发起的那一次。
	ctx.released.delete(pageIndex);
	if (mode === 'force') {
		// 强制重译 gives every keep-origin segment a fresh chance, and drops the
		// page's zombie so a full-quality worker extraction may run again.
		ctx.failedSegments.clear();
		ctx.extractZombies.delete(pageIndex);
	}
	// 必须等旧任务真正结束再重新排 (审核 P1-8): cancel() 对运行中的任务只发
	// abort,它要等 run() reject 后才离开 active。此前这里是同步 cancel +
	// 立即 ensurePage,于是 ensurePage 的 isScheduled 仍为真而被挡回 ——
	// 页面状态已删、新任务没入队,该页彻底不翻译(用户表现: 点了圆环什么
	// 都没发生,必须再点一次)。
	await ctx.scheduler.cancelAndWait(`page-${pageIndex}`);
	// 同时取消在飞的 compress (2.0.7, 审核 P2-2): 它不在主键下,漏掉时其
	// 完成回调会用旧 state 覆写刷新后的缓存(写盘处另有身份校验兜底)。
	await ctx.scheduler.cancelAndWait(`page-${pageIndex}-compress`);
	await Promise.all((prior?.blocks ?? []).map(block =>
		ctx.scheduler.cancelAndWait(`page-${pageIndex}-seg-${block.id}`)));
	if (ctx.disposed) {
		return;
	}
	await ctx.ensurePage(pageIndex, PRIORITY.CURRENT_RETRANSLATE, {
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
export async function retranslateBlock(ctx: ManualRetranslationView, pageIndex: number, blockId: string): Promise<boolean> {
	const state = ctx.pages.get(pageIndex);
	const block = state?.blocks.find(b => b.id === blockId);
	if (ctx.disposed || !state || !block) {
		return false;
	}
	const { source, target } = ctx.deps.getLanguages(block.sourceText);
	const reg = PlaceholderRegistry.protect(block.sourceText, ctx.literalsFor(block), block.styleRuns);
	const text = reg.text;
	ctx.failedSegments.delete(blockSegmentHash(block, source, target));
	try {
		return await ctx.scheduler.enqueue(`page-${pageIndex}-seg-${blockId}`, PRIORITY.CURRENT_RETRANSLATE, async (signal) => {
			const live = (): boolean => !ctx.disposed && !signal.aborted && ctx.pages.get(pageIndex) === state;
			if (!live()) return false;
			// 2.7.5 (审核 P2): 单段重译也走计量入口 —— 此前绕过 meteredTranslate,
			// 一次重译的 token 从诊断里消失。
			const resp = await ctx.requestGate.run(ctx.laneFor(pageIndex), true, () => ctx.meteredTranslate({
				pageIndex,
				sourceLanguage: source,
				targetLanguage: target,
				documentTitle: ctx.deps.getDocumentTitle(),
				previousContext: '',
				blocks: [{ id: block.id, type: block.type, text }],
				glossary: ctx.glossaryFor([block.sourceText])
			}, signal), signal);
			if (!live()) return false;
			const hit = resp.translations.find(t =>
				reg.ok(t.translatedText)
				&& looksTranslated(block.sourceText, reg.restore(t.translatedText), target, { isReference: block.isReference }));
			if (!hit) {
				return false;
			}
			const restored = reg.restore(hit.translatedText);
			state.cached = false; // The replacement is not durable yet.
			state.translations.set(blockId, restored);
			noteProvisionalIn(state, resp, [blockId]);
			const provisional = state.provisional?.has(blockId) ?? false;
			state.keepOrigin?.delete(blockId);
			ctx.docMemory.learn(extractTermPairs(block.sourceText, restored));
			ctx.notify(state);
			if (ctx.deps.writeSegments && !provisional) {
				await ctx.deps.writeSegments(pageIndex, [{
					hash: blockSegmentHash(block, source, target),
					translatedText: restored
				}]).catch(() => { /* best effort */ });
			}
			if (!live()) return false;
			// preserve 块永远不会进 translations(表格数据单元格等按设计保留
			// 原文),所以完整性判据必须给它们豁免 —— 否则任何含表格的页面上
			// 这个条件恒假,「重译此段」的新译文永远写不进页面缓存
			// (审核 P2-11)。表现是: 重译当场生效,重开文档却又回到旧译文
			// (页面缓存完整命中后直接 done,根本不读段落库),反复重译反复丢失。
			// 与 compressBlocks 路径的判据保持一致。
			const pageComplete = state.blocks.every(b =>
				b.translationMode === 'preserve' || state.translations.has(b.id));
			if (pageComplete) {
				await ctx.persistPage(state, pageCacheRows(state, state.blocks));
			}
			return live();
		}, { foreground: true, lane: ctx.laneFor(pageIndex), maxRetries: 0 });
	}
	catch (e) {
		if (!(e instanceof PaperMirrorError && e.code === 'CANCELLED')) {
			logger.warn(MODULE, `retranslateBlock failed for ${blockId}`, e);
		}
		return false;
	}
}
