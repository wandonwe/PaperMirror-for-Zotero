/**
 * Per-attachment translation orchestration:
 *  - lazy per-page translation with prefetch (prev 1 / next 2)
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
import { protectFormulas, restoreFormulas } from '../reader/formulaGuard';
import { matchRules } from './glossary';
import { RequestScheduler } from './requestScheduler';
import { chunkBlocks, trailingContext } from './segmenter';

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

/**
 * Guard against a provider that returns the source text UNCHANGED (or otherwise
 * fails to translate) being accepted as a valid translation. For a Chinese
 * target a real translation of prose always contains CJK characters; English
 * echoed straight back has none. Only enforced on prose sources (≥3 alphabetic
 * words) so acronym/numeric cells like "PCCT (n=30)" — legitimately CJK-free —
 * are still accepted. Non-CJK targets have no cheap check, so they pass.
 */
export function looksTranslated(source: string, translated: string, targetLang: string): boolean {
	const t = translated.trim();
	if (!t) {
		return false;
	}
	if (!/^zh/i.test(targetLang)) {
		return true;
	}
	const proseWords = (source.match(/[A-Za-z]{2,}/g) ?? []).length;
	if (proseWords < 3) {
		return true; // acronym / numeric / symbol cell — may legitimately have no CJK
	}
	return /[㐀-鿿豈-﫿]/.test(t);
}

/**
 * Absolute ceiling for one page end to end (extraction + all chunks). Long
 * pages with several chunks are fine at 60 s per request; five minutes means
 * something is stuck, not slow.
 */
const PAGE_WATCHDOG_MS = 300000;

export interface PageTranslationState {
	pageIndex: number;
	status: 'idle' | 'extracting' | 'translating' | 'done' | 'error' | 'no-text-layer';
	blocks: SourceBlock[];
	translations: Map<string, string>;
	error?: PaperMirrorError;
	fromCache?: boolean;
}

export interface TranslationDeps {
	/** Extract source blocks for a page (throws PaperMirrorError on failure). */
	extractPage(pageIndex: number): Promise<SourceBlock[]>;
	/** Perform one provider request. */
	translateRequest(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResponse>;
	/** Cache access; may be no-ops. */
	readCache(pageIndex: number, blocks: SourceBlock[]): Promise<TranslatedBlock[] | null>;
	writeCache(pageIndex: number, blocks: SourceBlock[], translations: TranslatedBlock[]): Promise<void>;
	/** Config snapshot getters. */
	getLanguages(sampleText: string): { source: string; target: string };
	getDocumentTitle(): string;
	getGlossary(): GlossaryRule[];
	useContext(): boolean;
	pageCount(): number;
}

export interface ManagerEvents {
	onPageUpdate(state: PageTranslationState): void;
}

export class TranslationManager {
	private deps: TranslationDeps;
	private events: ManagerEvents;
	private scheduler: RequestScheduler;
	private pages = new Map<number, PageTranslationState>();
	private disposed = false;
	private currentPage = 0;
	private prefetchEnabled = true;

	constructor(deps: TranslationDeps, events: ManagerEvents, options?: { maxConcurrent?: number; prefetch?: boolean; delayFn?: (ms: number) => Promise<void> }) {
		this.deps = deps;
		this.events = events;
		this.prefetchEnabled = options?.prefetch ?? true;
		this.scheduler = new RequestScheduler({
			// Up to 6: LLM providers at tier-1 rate limits handle several
			// page-sized requests in flight; the free engines stay at 2 (the
			// session clamps before it gets here).
			maxConcurrent: Math.min(6, Math.max(1, options?.maxConcurrent ?? 2)),
			delayFn: options?.delayFn
		});
	}

	getPageState(pageIndex: number): PageTranslationState | undefined {
		return this.pages.get(pageIndex);
	}

	/** Called when the visible page changes. */
	setCurrentPage(pageIndex: number): void {
		if (this.disposed) {
			return;
		}
		this.currentPage = pageIndex;
		const wanted = this.wantedPages();
		// Drop queued work for pages no longer near the viewport — but keep the
		// compress-and-retry tasks of pages still wanted: cancelling those on
		// every scroll wasted the strict renderer's budget rounds and long
		// blocks ended up reverting to the original text.
		const keep = new Set<string>();
		for (const p of wanted) {
			keep.add(`page-${p}`);
			keep.add(`page-${p}-compress`);
		}
		this.scheduler.cancelExcept(keep);
		for (const page of wanted) {
			void this.ensurePage(page, page === pageIndex ? 10 : 1);
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
			await this.scheduler.enqueue(`page-${pageIndex}-compress`, 15, async (signal) => {
				const protectedBlocks = blocks.map((block) => {
					const { text, placeholders } = protectFormulas(block.sourceText);
					return { block, text, placeholders };
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
					glossary: matchRules(this.deps.getGlossary(), blocks.map(b => b.sourceText))
				};
				const response = await this.deps.translateRequest(request, signal);
				for (const t of response.translations) {
					const pb = protectedBlocks.find(p => p.block.id === t.id);
					if (!pb || !t.translatedText.trim()) {
						continue;
					}
					const restored = restoreFormulas(t.translatedText, pb.placeholders);
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
					logger.info(MODULE, `Page ${pageIndex + 1}: ${accepted.size} block(s) re-translated shorter under budget`);
					const all: TranslatedBlock[] = state.blocks
						.filter(b => state.translations.has(b.id))
						.map(b => ({ id: b.id, translatedText: state.translations.get(b.id)! }));
					await this.deps.writeCache(pageIndex, state.blocks, all);
				}
			});
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
				return accepted;
			}
			logger.warn(MODULE, 'compressBlocks failed', e);
		}
		return accepted;
	}

	/** Force re-translate a page, bypassing cache. */
	async retranslatePage(pageIndex: number): Promise<void> {
		this.pages.delete(pageIndex);
		this.scheduler.cancel(`page-${pageIndex}`);
		await this.ensurePage(pageIndex, 20, { bypassCache: true });
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
	}

	cancelAll(): void {
		this.scheduler.cancelAll();
	}

	dispose(): void {
		this.disposed = true;
		this.scheduler.dispose();
		this.pages.clear();
	}

	private wantedPages(): number[] {
		if (!this.prefetchEnabled) {
			return [this.currentPage];
		}
		const count = this.deps.pageCount();
		const pages = [this.currentPage, this.currentPage + 1, this.currentPage - 1, this.currentPage + 2];
		return pages.filter(p => p >= 0 && (count <= 0 || p < count));
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

	async ensurePage(pageIndex: number, priority: number, options?: { bypassCache?: boolean }): Promise<void> {
		if (this.disposed) {
			return;
		}
		const existing = this.pages.get(pageIndex);
		if (existing && (existing.status === 'done' || existing.status === 'translating' || existing.status === 'extracting')) {
			return;
		}
		if (this.scheduler.isScheduled(`page-${pageIndex}`)) {
			return;
		}

		const state: PageTranslationState = {
			pageIndex,
			status: 'extracting',
			blocks: [],
			translations: new Map()
		};
		this.pages.set(pageIndex, state);
		this.notify(state);

		try {
			await this.scheduler.enqueue(`page-${pageIndex}`, priority, async (signal) => {
				// Watchdog: NOTHING may keep a page in 「正在翻译」 forever. Every
				// stage below has its own timeout, but any future hang (a new
				// API, a platform quirk) still surfaces as a visible, retryable
				// error instead of an eternal spinner. The timer is cleared as
				// soon as the page settles, win or lose.
				let watchdog: ReturnType<typeof setTimeout> | null = null;
				try {
					await Promise.race([
						this.translatePage(state, signal, options?.bypassCache ?? false),
						new Promise<never>((_, reject) => {
							watchdog = setTimeout(() => reject(new PaperMirrorError(
								'TIMEOUT',
								`Page ${pageIndex + 1} did not finish within ${PAGE_WATCHDOG_MS / 1000} s. Use 重新翻译 to retry.`,
								{ retryable: true }
							)), PAGE_WATCHDOG_MS);
						})
					]);
				}
				finally {
					if (watchdog !== null) {
						clearTimeout(watchdog);
					}
				}
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
			state.status = error.code === 'NO_TEXT_LAYER' ? 'no-text-layer' : 'error';
			state.error = error;
			this.notify(state);
		}
	}

	private async translatePage(state: PageTranslationState, signal: AbortSignal, bypassCache: boolean): Promise<void> {
		const pageIndex = state.pageIndex;

		// 1. Extract
		const blocks = await this.deps.extractPage(pageIndex);
		if (signal.aborted) {
			throw new PaperMirrorError('CANCELLED', 'cancelled');
		}
		state.blocks = blocks;
		if (!blocks.length) {
			state.status = 'done';
			this.notify(state);
			return;
		}

		// 2. Cache
		if (!bypassCache) {
			const cached = await this.deps.readCache(pageIndex, blocks);
			if (cached) {
				for (const t of cached) {
					state.translations.set(t.id, t.translatedText);
				}
				state.status = 'done';
				state.fromCache = true;
				this.notify(state);
				return;
			}
		}

		// 3. Translate chunk by chunk
		state.status = 'translating';
		this.notify(state);

		const sampleText = blocks.map(b => b.sourceText).join('\n').slice(0, 4000);
		const { source, target } = this.deps.getLanguages(sampleText);
		const glossary = matchRules(this.deps.getGlossary(), blocks.map(b => b.sourceText));
		const sourceById = new Map(blocks.map(b => [b.id, b.sourceText]));
		// Accept a response only if it is actually translated (not echoed English).
		const accept = (id: string, text: string): boolean =>
			text.trim().length > 0 && looksTranslated(sourceById.get(id) ?? '', text, target);

		// Protect formulas per block
		const protectedBlocks = blocks.map((block) => {
			const { text, placeholders } = protectFormulas(block.sourceText);
			return { block, text, placeholders };
		});

		const chunks = chunkBlocks(blocks);
		let previous: SourceBlock[] = [];
		const results: TranslatedBlock[] = [];
		let untranslatedCount = 0;

		for (const chunk of chunks) {
			if (signal.aborted) {
				throw new PaperMirrorError('CANCELLED', 'cancelled');
			}
			const request: TranslationRequest = {
				pageIndex,
				sourceLanguage: source,
				targetLanguage: target,
				documentTitle: this.deps.getDocumentTitle(),
				previousContext: this.deps.useContext() ? trailingContext(previous) : '',
				blocks: chunk.map((b) => {
					const pb = protectedBlocks.find(p => p.block.id === b.id)!;
					return { id: b.id, type: b.type, text: pb.text };
				}),
				glossary
			};

			let response = await this.deps.translateRequest(request, signal);
			const received = new Map<string, string>();
			for (const t of response.translations) {
				if (accept(t.id, t.translatedText)) {
					received.set(t.id, t.translatedText);
				}
			}

			// Retry only missing ids once (spec 4.3)
			const missing = chunk.filter(b => !received.has(b.id));
			if (missing.length) {
				logger.debug(MODULE, `Retrying ${missing.length} missing block(s) on page ${pageIndex}`);
				const retryRequest: TranslationRequest = {
					...request,
					blocks: missing.map((b) => {
						const pb = protectedBlocks.find(p => p.block.id === b.id)!;
						return { id: b.id, type: b.type, text: pb.text };
					})
				};
				try {
					response = await this.deps.translateRequest(retryRequest, signal);
					for (const t of response.translations) {
						if (accept(t.id, t.translatedText)) {
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

			// Salvage: any id STILL missing gets its own single-block request.
			// LLM providers sometimes drop or rename ids in a batched response;
			// with exactly one block in the request the answer cannot misalign.
			// Without this pass the block silently stayed English and the page
			// rendered mixed-language (the JACC report).
			const stillMissing = chunk.filter(b => !received.has(b.id));
			if (stillMissing.length) {
				logger.warn(MODULE, `Salvaging ${stillMissing.length} block(s) on page ${pageIndex} (concurrency ${SALVAGE_CONCURRENCY})`);
				if (stillMissing.length > SALVAGE_WARN_THRESHOLD) {
					logger.warn(MODULE, `Page ${pageIndex + 1}: provider dropped ${stillMissing.length} ids — salvaging all, but this engine is misbehaving`);
				}
				// Salvage ALL missing ids, but in bounded-parallel waves rather
				// than strictly one-after-another: single-block requests can't
				// suffer id drift, and running a few at once keeps a long page
				// from stalling for a minute on sequential round-trips.
				const salvageOne = async (block: SourceBlock): Promise<void> => {
					const pb = protectedBlocks.find(p => p.block.id === block.id)!;
					try {
						const single = await this.deps.translateRequest(
							{ ...request, previousContext: '', blocks: [{ id: block.id, type: block.type, text: pb.text }] },
							signal
						);
						// One block in → whatever comes back IS its translation,
						// even if the model rewrote the id — but only if it is
						// actually translated, not the English echoed back.
						const first = single.translations.find(t =>
							looksTranslated(block.sourceText, t.translatedText, target));
						if (first) {
							received.set(block.id, first.translatedText);
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
				const restored = restoreFormulas(raw, pb.placeholders);
				results.push({ id: block.id, translatedText: restored });
				state.translations.set(block.id, restored);
			}
			this.notify(state); // progressive rendering per chunk
			previous = chunk;
		}

		if (!results.length) {
			throw new PaperMirrorError('BAD_RESPONSE', 'The translation service returned no usable translations.');
		}

		state.status = 'done';
		this.notify(state);
		// Only a COMPLETE page enters the cache. Caching a partial page would
		// freeze the mixed-language rendering: every revisit would hit the
		// cache and never retry the missing blocks. Left uncached, the next
		// visit (or 重新翻译) runs the whole pipeline again.
		if (untranslatedCount === 0) {
			await this.deps.writeCache(pageIndex, blocks, results);
		}
		else {
			logger.warn(MODULE, `Page ${pageIndex + 1} left uncached (${untranslatedCount} untranslated block(s)) so a revisit retries`);
		}
	}
}
