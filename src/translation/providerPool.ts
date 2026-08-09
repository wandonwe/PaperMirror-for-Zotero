/**
 * Provider pool — 多服务商并行.
 *
 * One document, several configured providers, pages dealt round-robin. This
 * multiplies throughput by the number of independent services WITHOUT
 * touching any single provider\'s rate limits — which is also why the pool is
 * the only parallelism offered across accounts: rotating multiple keys of
 * the same provider is either pointless (keys share the account\'s limit) or
 * a terms-of-service violation (multiple accounts to evade limits), so
 * PaperMirror does not do it.
 *
 * Sharding is BY PAGE, deterministically, so a page\'s cache entry always
 * belongs to the same provider and re-opening the document hits the cache.
 */

/** The provider a page belongs to. `pool` must be non-empty and deduped. */
export function pickProviderForPage(pool: string[], pageIndex: number): string {
	if (!pool.length) {
		throw new Error('provider pool is empty');
	}
	if (pool.length === 1 || !Number.isFinite(pageIndex) || pageIndex < 0) {
		return pool[0]!;
	}
	return pool[pageIndex % pool.length]!;
}

/**
 * A provider's independent PAGE-concurrency capability — how many page tasks of
 * THIS provider may run at once, before the shared global cap. Keyed off type,
 * not a single global number, so a pool of a free engine + two LLMs is capped
 * per-lane (1 + 3 + 3) instead of by whatever the main provider happens to be.
 */
export interface ProviderCapability {
	id: string;
	/** LLM providers require a key; free MT engines and local models do not. */
	requiresApiKey: boolean;
	/** A local model (Ollama / localhost) — keep to 1, hardware-bound. */
	local: boolean;
}

/** Free machine-translation engines: one page lane (they fan out internally). */
const FREE_MT = new Set(['bing-free', 'google-free']);
/** Traditional paid MT (not prompt-driven) — a modest fixed lane. */
const PAID_MT = new Set(['deepl']);

/** Steady-state page concurrency for one provider. */
export function pageConcurrencyFor(cap: ProviderCapability): number {
	if (cap.local) {
		return 1; // local model: hardware-bound, one page at a time
	}
	if (FREE_MT.has(cap.id)) {
		return 1; // free engine already fans out ~3 requests internally
	}
	if (PAID_MT.has(cap.id)) {
		return 3; // DeepL-style paid MT
	}
	if (cap.requiresApiKey) {
		return 3; // cloud LLM default (advanced override is future work)
	}
	return 1; // unknown / keyless → conservative
}

/**
 * The whole pool's schedule: each provider's own lane cap, plus the global cap
 * (sum of lanes, clamped to a sane [2, 24]) so the pool multiplies throughput
 * without any single provider exceeding its own limit.
 */
export function poolConcurrencyPlan(caps: ProviderCapability[]): { globalMax: number; laneCaps: Record<string, number> } {
	const laneCaps: Record<string, number> = {};
	let sum = 0;
	for (const c of caps) {
		const n = pageConcurrencyFor(c);
		laneCaps[c.id] = n;
		sum += n;
	}
	return { globalMax: Math.max(2, Math.min(24, sum)), laneCaps };
}

/** Prefetch window: more independent providers ⇒ more future pages in flight. */
export function prefetchWindowFor(poolSize: number): { forward: number; backward: number } {
	return { forward: Math.max(1, Math.min(2 * poolSize, 12)), backward: 1 };
}

/** Primary first, extras after, duplicates removed, order stable. */
export function buildPool(primary: string, extras: string[]): string[] {
	const out = [primary];
	for (const id of extras) {
		if (id && !out.includes(id)) {
			out.push(id);
		}
	}
	return out;
}
