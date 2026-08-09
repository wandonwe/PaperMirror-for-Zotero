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
import { fnv1a64 } from '../cache/cacheSchema';

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
	const proseWords = (source.match(/[A-Za-z]{2,}/g) ?? []).length;
	if (proseWords < PROSE_WORD_GATE) {
		return true; // label / acronym / numeric cell — may legitimately be CJK-free
	}
	// A PROSE source must come back predominantly Chinese. This rejects not
	// only echoed English (ratio 0) but a HALF-translated / mixed response,
	// which the old "contains any CJK" test accepted.
	return targetLanguageRatio(t) >= MIN_TARGET_RATIO;
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

/** CJK ideograph ranges used for the target-language ratio. */
const CJK_RE = /[㐀-鿿豈-﫿]/g;

/** A source with at least this many Latin words is prose worth validating. */
const PROSE_WORD_GATE = 6;
/** Below this CJK ratio on a prose source, the response was not really translated. */
const MIN_TARGET_RATIO = 0.45;

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
	/**
	 * 段落级缓存 (optional): batch-read/write individual segment translations by
	 * content hash. The page cache stays as the fast whole-page index; the
	 * segment store beneath it lets 普通刷新 re-request only the segments that
	 * actually changed or failed, and lets identical table cells / repeated
	 * paragraphs reuse their translation across pages.
	 */
	readSegments?(pageIndex: number, hashes: string[]): Promise<Map<string, string> | null>;
	writeSegments?(pageIndex: number, entries: { hash: string; translatedText: string }[]): Promise<void>;
	/** Config snapshot getters. */
	getLanguages(sampleText: string): { source: string; target: string };
	getDocumentTitle(): string;
	getGlossary(): GlossaryRule[];
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
	private pages = new Map<number, PageTranslationState>();
	private disposed = false;
	private currentPage = 0;
	private prefetchEnabled = true;
	/** Pages whose provider has already been reported unstable (fire once). */
	private unstableFired = new Set<number>();

	constructor(deps: TranslationDeps, events: ManagerEvents, options?: { maxConcurrent?: number; prefetch?: boolean; delayFn?: (ms: number) => Promise<void> }) {
		this.deps = deps;
		this.events = events;
		this.prefetchEnabled = options?.prefetch ?? true;
		this.scheduler = new RequestScheduler({
			// Up to 6: LLM providers at tier-1 rate limits handle several
			// page-sized requests in flight; the free engines stay at 2 (the
			// session clamps before it gets here).
			maxConcurrent: Math.min(6, Math.max(1, options?.maxConcurrent ?? 2)),
			// Reserve ONE slot for the current page so background prefetch can
			// never occupy every slot and make the visible page wait for a
			// neighbour to finish. Even at the free engines' 2 slots, prefetch is
			// capped at 1 and a foreground page always has a slot to start in.
			reservedForeground: 1,
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
		// 1. Drop queued/running work for pages that left the prefetch window, so
		//    a fast run of scrolls does not leave the current page stuck behind
		//    stale prefetches holding the slots — but KEEP the compress-and-retry
		//    tasks of pages still wanted: cancelling those on every scroll wasted
		//    the strict renderer's budget rounds and long blocks reverted.
		const keep = new Set<string>();
		for (const p of wanted) {
			keep.add(`page-${p}`);
			keep.add(`page-${p}-compress`);
		}
		this.scheduler.cancelExcept(keep);
		// 2. 优先翻译当前页 (ALWAYS): if the page was already queued as a background
		//    prefetch, promote it to the foreground reserved slot instead of
		//    returning early (the bug: a queued prefetch kept its low priority
		//    forever); otherwise create it as a foreground task. Either way it now
		//    owns a reserved slot and cannot wait on a neighbour.
		const key = `page-${pageIndex}`;
		if (this.scheduler.isQueued(key)) {
			this.scheduler.promote(key, PRIORITY.CURRENT_PAGE, true);
		}
		else {
			void this.ensurePage(pageIndex, PRIORITY.CURRENT_PAGE, { foreground: true });
		}
		// 3. Neighbour prefetch is enqueued ONLY once the current page is done
		//    (here if it was already cached/done; otherwise translatePage triggers
		//    it on completion).
		if (this.pages.get(pageIndex)?.status === 'done') {
			this.prefetchNeighbours();
		}
	}

	/** Prefetch the pages around the current one — only once it is itself done. */
	private prefetchNeighbours(): void {
		if (this.disposed || !this.prefetchEnabled) {
			return;
		}
		// Hard guard: NEVER add background prefetch while the current page is
		// still unfinished — it must not compete for slots with the visible page.
		if (this.pages.get(this.currentPage)?.status !== 'done') {
			return;
		}
		for (const page of this.wantedPages()) {
			if (page === this.currentPage) {
				continue;
			}
			const priority = page === this.currentPage + 1 ? PRIORITY.NEXT_PAGE
				: page === this.currentPage - 1 ? PRIORITY.PREVIOUS_PAGE
					: PRIORITY.SECOND_NEXT_PAGE;
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
					// The SHORTER (fitting) version replaces the long one in the
					// segment store too, so a 普通刷新 does not resurrect a
					// translation that already failed placement once.
					if (this.deps.writeSegments) {
						const byId = new Map(blocks.map(b => [b.id, b]));
						await this.deps.writeSegments(pageIndex, [...accepted]
							.filter(([id]) => byId.has(id))
							.map(([id, text]) => ({
								hash: segmentHash(byId.get(id)!.sourceText, source, target),
								translatedText: text
							}))
						).catch(() => { /* best effort */ });
					}
				}
			}, { foreground: true }); // compress serves the VISIBLE page's layout
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
	 * Re-translate a page. Two strategies (刷新分级):
	 *  - 'normal' (圆环刷新本页): bypass the PAGE cache but reuse the segment
	 *    store — qualified segment translations come back instantly and only
	 *    untranslated / previously-invalid segments cost new requests.
	 *  - 'force' (强制重译): bypass both caches — every segment re-requests.
	 */
	async retranslatePage(pageIndex: number, mode: 'normal' | 'force' = 'normal'): Promise<void> {
		this.pages.delete(pageIndex);
		this.unstableFired.delete(pageIndex); // a fresh run may report anew
		this.scheduler.cancel(`page-${pageIndex}`);
		await this.ensurePage(pageIndex, PRIORITY.CURRENT_RETRANSLATE, {
			bypassCache: true,
			bypassSegments: mode === 'force',
			foreground: true
		});
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
		// [current, next, previous] — the next page is the likeliest to be read.
		// current+2 is deliberately dropped: on the free engines (low concurrency)
		// prefetching two pages ahead rarely pays off and steals a slot.
		const pages = [this.currentPage, this.currentPage + 1, this.currentPage - 1];
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

	async ensurePage(pageIndex: number, priority: number, options?: { bypassCache?: boolean; bypassSegments?: boolean; foreground?: boolean }): Promise<void> {
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
						this.translatePage(state, signal, { bypassPageCache: options?.bypassCache ?? false, bypassSegments: options?.bypassSegments ?? false }),
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
			}, { foreground: options?.foreground ?? false });
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

	private async translatePage(state: PageTranslationState, signal: AbortSignal, bypass: { bypassPageCache: boolean; bypassSegments: boolean }): Promise<void> {
		const pageIndex = state.pageIndex;
		// 真实性能指标 (per page): how many provider round-trips this page cost
		// and how many were salvage. High salvage counts point at fragment-heavy
		// grouping or an id-dropping provider — the log tells which.
		const metrics = { requestCount: 0, salvageCount: 0, startedAt: Date.now() };
		const countedTranslate = async (request: TranslationRequest, sig: AbortSignal): Promise<TranslationResponse> => {
			metrics.requestCount++;
			return this.deps.translateRequest(request, sig);
		};

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
		if (!bypass.bypassPageCache) {
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

		// 2.5 段落级缓存: prefill whatever segments this context has already
		// translated (content+language hash; provider/model scoping lives in the
		// store the host injects). 普通刷新 re-enters here with the page cache
		// bypassed but segments live, so only the segments that actually failed
		// or changed cost a request. 'force' skips this entirely.
		const segHash = (b: SourceBlock): string => segmentHash(b.sourceText, source, target);
		let segmentHits = 0;
		if (!bypass.bypassSegments && this.deps.readSegments) {
			const cached = await this.deps.readSegments(pageIndex, blocks.map(segHash)).catch(() => null);
			if (cached?.size) {
				for (const block of blocks) {
					const hit = cached.get(segHash(block));
					if (hit !== undefined && accept(block.id, hit)) {
						state.translations.set(block.id, hit);
						segmentHits++;
					}
				}
				if (segmentHits) {
					this.notify(state); // show reused segments immediately
				}
			}
		}
		const toTranslate = blocks.filter(b => !state.translations.has(b.id));
		if (!toTranslate.length) {
			state.status = 'done';
			this.notify(state);
			logger.info(MODULE, `Page ${pageIndex + 1}: fully served from the segment cache (${segmentHits} segment(s), 0 requests)`);
			if (pageIndex === this.currentPage) {
				this.prefetchNeighbours();
			}
			await this.deps.writeCache(pageIndex, blocks, blocks
				.filter(b => state.translations.has(b.id))
				.map(b => ({ id: b.id, translatedText: state.translations.get(b.id)! })));
			return;
		}

		// Protect formulas per block
		const protectedBlocks = toTranslate.map((block) => {
			const { text, placeholders } = protectFormulas(block.sourceText);
			return { block, text, placeholders };
		});

		const chunks = chunkBlocks(toTranslate);
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
					// 首次请求即携带排版预算: most paragraphs then fit on the first
					// pass, skipping the translate→measure-fail→compress round trip.
					return { id: b.id, type: b.type, text: pb.text, charBudget: initialCharBudget(b, target) };
				}),
				glossary
			};

			let response = await countedTranslate(request, signal);
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
					response = await countedTranslate(retryRequest, signal);
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
			if (afterRetry.length >= 3) {
				for (let i = 0; i < afterRetry.length; i += SALVAGE_BATCH_SIZE) {
					if (signal.aborted) {
						throw new PaperMirrorError('CANCELLED', 'cancelled');
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
							if (accept(t.id, t.translatedText)) {
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
						metrics.salvageCount++;
						const single = await countedTranslate(
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

		if (!results.length && !segmentHits) {
			throw new PaperMirrorError('BAD_RESPONSE', 'The translation service returned no usable translations.');
		}

		state.status = 'done';
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
			this.prefetchNeighbours();
		}
		// Newly translated segments enter the segment store regardless of page
		// completeness — a good segment is a good segment; only the PAGE index
		// below requires completeness.
		if (this.deps.writeSegments && results.length) {
			const byId = new Map(blocks.map(b => [b.id, b]));
			await this.deps.writeSegments(pageIndex, results
				.map(r => ({ hash: segHash(byId.get(r.id)!), translatedText: r.translatedText }))
			).catch(e => logger.warn(MODULE, 'segment write failed', e));
		}
		// Only a COMPLETE page enters the cache. Caching a partial page would
		// freeze the mixed-language rendering: every revisit would hit the
		// cache and never retry the missing blocks. Left uncached, the next
		// visit (or 重新翻译) runs the whole pipeline again — with the segment
		// store still saving the segments that DID succeed.
		if (untranslatedCount === 0) {
			const all: TranslatedBlock[] = blocks
				.filter(b => state.translations.has(b.id))
				.map(b => ({ id: b.id, translatedText: state.translations.get(b.id)! }));
			await this.deps.writeCache(pageIndex, blocks, all);
		}
		else {
			logger.warn(MODULE, `Page ${pageIndex + 1} left uncached (${untranslatedCount} untranslated block(s)) so a revisit retries`);
		}
	}
}
