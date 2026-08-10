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

/** 性能模式 — controls per-provider concurrency, prefetch reach and throttling. */
export type PerfMode = 'stable' | 'auto' | 'high';

export const DEFAULT_PERF_MODE: PerfMode = 'auto';

export function normalizePerfMode(value: unknown): PerfMode {
	return value === 'stable' || value === 'high' ? value : 'auto';
}

/**
 * A provider lane's concurrency BAND for a given mode: where it starts
 * (initial), how low adaptive throttling may drive it (min, the 429/timeout
 * floor), and how high sustained success may grow it (max). Stable and high
 * modes are effectively fixed (initial === max); auto mode grows within a range.
 */
export interface LaneBand {
	min: number;
	initial: number;
	max: number;
}

/** The provider "type" that decides its band. */
function providerType(cap: ProviderCapability): 'free' | 'paid-mt' | 'local' | 'llm' | 'unknown' {
	if (cap.local) {
		return 'local';
	}
	if (FREE_MT.has(cap.id)) {
		return 'free';
	}
	if (PAID_MT.has(cap.id)) {
		return 'paid-mt';
	}
	if (cap.requiresApiKey) {
		return 'llm';
	}
	return 'unknown';
}

/**
 * Per-type, per-mode lane bands. Free engines are always a single lane; cloud
 * LLMs grow to 6 in auto and sit at 6 in high; local models stay tiny. The min
 * is the adaptive floor (a 429 can always drop a lane toward 1).
 */
export function laneBandFor(cap: ProviderCapability, mode: PerfMode): LaneBand {
	const type = providerType(cap);
	if (type === 'free' || type === 'unknown') {
		return { min: 1, initial: 1, max: 1 };
	}
	if (type === 'local') {
		return mode === 'stable' ? { min: 1, initial: 1, max: 1 }
			: mode === 'high' ? { min: 1, initial: 2, max: 2 }
				: { min: 1, initial: 1, max: 2 }; // auto: 1→2
	}
	if (type === 'paid-mt') {
		return mode === 'stable' ? { min: 1, initial: 2, max: 2 }
			: mode === 'high' ? { min: 1, initial: 4, max: 4 }
				: { min: 1, initial: 3, max: 4 }; // auto: 3→4
	}
	// cloud LLM
	return mode === 'stable' ? { min: 1, initial: 2, max: 2 }
		: mode === 'high' ? { min: 1, initial: 6, max: 6 }
			: { min: 1, initial: 3, max: 6 }; // auto: 3→6
}

/**
 * The whole pool's lane plan for a mode: each provider's band, plus the sum of
 * INITIAL lane caps (the expected steady-state parallelism, before the global
 * ceiling and dynamic growth). The global ceiling is a SEPARATE user setting,
 * not derived here.
 */
export function poolLanePlan(caps: ProviderCapability[], mode: PerfMode): { laneBands: Record<string, LaneBand>; initialSum: number } {
	const laneBands: Record<string, LaneBand> = {};
	let initialSum = 0;
	for (const c of caps) {
		const band = laneBandFor(c, mode);
		laneBands[c.id] = band;
		initialSum += band.initial;
	}
	return { laneBands, initialSum: Math.max(1, initialSum) };
}

/** Prefetch window per mode: stable 2/1, auto min(2N,10)/1, high 12/2. */
export function prefetchWindowFor(mode: PerfMode, poolSize: number): { forward: number; backward: number } {
	if (mode === 'stable') {
		return { forward: 2, backward: 1 };
	}
	if (mode === 'high') {
		return { forward: 12, backward: 2 };
	}
	return { forward: Math.max(1, Math.min(2 * poolSize, 10)), backward: 1 };
}

/** Global ceiling setting: plain number, 1–24, default 12 (0/legacy → 12). */
export const GLOBAL_MAX_DEFAULT = 12;
export const GLOBAL_MAX_MIN = 1;
export const GLOBAL_MAX_MAX = 24;

/** Migrate a stored 最大并行页面数 value: 0/absent → 12, clamp to [1,24]. */
export function normalizeGlobalMax(value: unknown): number {
	const n = Math.round(Number(value));
	if (!Number.isFinite(n) || n <= 0) {
		return GLOBAL_MAX_DEFAULT;
	}
	return Math.max(GLOBAL_MAX_MIN, Math.min(GLOBAL_MAX_MAX, n));
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
