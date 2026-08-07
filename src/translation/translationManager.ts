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
			maxConcurrent: Math.min(2, Math.max(1, options?.maxConcurrent ?? 2)),
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
		// Drop queued work for pages no longer near the viewport
		this.scheduler.cancelExcept(new Set([...wanted].map(p => `page-${p}`)));
		for (const page of wanted) {
			void this.ensurePage(page, page === pageIndex ? 10 : 1);
		}
	}

	/** Force re-translate a page, bypassing cache. */
	async retranslatePage(pageIndex: number): Promise<void> {
		this.pages.delete(pageIndex);
		this.scheduler.cancel(`page-${pageIndex}`);
		await this.ensurePage(pageIndex, 20, { bypassCache: true });
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

		// Protect formulas per block
		const protectedBlocks = blocks.map((block) => {
			const { text, placeholders } = protectFormulas(block.sourceText);
			return { block, text, placeholders };
		});

		const chunks = chunkBlocks(blocks);
		let previous: SourceBlock[] = [];
		const results: TranslatedBlock[] = [];

		for (const chunk of chunks) {
			if (signal.aborted) {
				throw new PaperMirrorError('CANCELLED', 'cancelled');
			}
			const request: TranslationRequest = {
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
			let received = new Map(response.translations.map(t => [t.id, t.translatedText]));

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
						received.set(t.id, t.translatedText);
					}
				}
				catch (e) {
					if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
						throw e;
					}
					logger.warn(MODULE, 'Missing-id retry failed', e);
				}
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
		await this.deps.writeCache(pageIndex, blocks, results);
	}
}
