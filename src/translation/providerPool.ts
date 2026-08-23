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
 *
 * 稳定映射 (2.2.1, 计划 第三批 item1 · Codex API-P1): 分配用 **rendezvous / HRW**
 * (最高随机权重)哈希,不再 `pageIndex % pool.length`。取模的致命处是**池一变全
 * 盘重排**:加一个服务商、删一个、甚至只改顺序,几乎每一页的规范引擎都换人 →
 * 页缓存键全变 → 整篇 miss 白重译。HRW 只让**受影响的那约 1/N 页**换人:
 *   - 加服务商 X:只有「X 对其恰好评分最高」的页迁到 X,其余不动;
 *   - 删服务商 Y:只有原属 Y 的页各自独立迁到自己的次高分服务商,其余不动;
 *   - 改顺序:零变化(评分只认 id 与页号,与池内位置无关)。
 * 每页对每个服务商算一个确定性分数,分最高者拥有该页;`rankProvidersForPage`
 * 给出整条降序榜,`pickProviderForPage` 取榜首,熔断/手动轮换取第 N 名。
 */

/** FNV-1a(32-bit)over `${id}#${page}` —— 纯、确定、无依赖,只需相对大小可比。 */
function hrwScore(providerId: string, pageIndex: number): number {
	const s = providerId + '#' + pageIndex;
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * 该页所有服务商的**降序榜**(评分最高在前)。同分以 id 字典序打破,保证完全
 * 确定。榜首 = 规范拥有者;第 1、2… 名供熔断/轮换按序退让。`pool` 需非空去重。
 */
export function rankProvidersForPage(pool: string[], pageIndex: number): string[] {
	const page = Number.isFinite(pageIndex) && pageIndex >= 0 ? pageIndex : 0;
	return [...pool].sort((a, b) => {
		const sa = hrwScore(a, page);
		const sb = hrwScore(b, page);
		if (sa !== sb) {
			return sb - sa;
		}
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

/** The provider a page belongs to. `pool` must be non-empty and deduped. */
export function pickProviderForPage(pool: string[], pageIndex: number): string {
	if (!pool.length) {
		throw new Error('provider pool is empty');
	}
	if (pool.length === 1) {
		return pool[0]!;
	}
	return rankProvidersForPage(pool, pageIndex)[0]!;
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
export type PerfMode = 'stable' | 'auto' | 'high' | 'custom';

export const DEFAULT_PERF_MODE: PerfMode = 'auto';

export function normalizePerfMode(value: unknown): PerfMode {
	return value === 'stable' || value === 'high' || value === 'custom' ? value : 'auto';
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

export type ProviderKind = 'free' | 'paid-mt' | 'local' | 'llm' | 'unknown';

/** The provider "kind" that decides its band and its custom-range limits. */
export function providerKind(cap: ProviderCapability): ProviderKind {
	return providerType(cap);
}

/**
 * The custom-mode range for a provider: the min/max a user may set, whether the
 * field is LOCKED (free engines are fixed at 1), and the default value for a
 * newly-enabled provider. Cloud LLM 1–6 (default 3); paid-MT 1–4 (default 3);
 * local 1–2 (default 1); free fixed 1.
 */
export function customLaneRange(cap: ProviderCapability): { min: number; max: number; locked: boolean; default: number } {
	switch (providerType(cap)) {
		case 'llm':
			return { min: 1, max: 6, locked: false, default: 3 };
		case 'paid-mt':
			return { min: 1, max: 4, locked: false, default: 3 };
		case 'local':
			return { min: 1, max: 2, locked: false, default: 1 };
		default: // free / unknown
			return { min: 1, max: 1, locked: true, default: 1 };
	}
}

/** A custom-mode lane band from the user's value, clamped to the provider range. */
export function customBandFor(cap: ProviderCapability, value: number | undefined): LaneBand {
	const range = customLaneRange(cap);
	const raw = Number.isFinite(value) ? Math.round(value as number) : range.default;
	const fixed = Math.max(range.min, Math.min(range.max, raw));
	// Fixed (initial === max) — no dynamic growth — but min 1 so safe throttling
	// (a 429/timeout) can still drop the lane; recovery caps back at the value.
	return { min: 1, initial: fixed, max: fixed };
}

/**
 * Per-type, per-mode lane bands. Free engines are always a single lane; cloud
 * LLMs grow to 6 in auto and sit at 6 in high; local models stay tiny. The min
 * is the adaptive floor (a 429 can always drop a lane toward 1). Custom mode
 * needs the user's per-provider value, so use poolLanePlan(caps, 'custom',
 * values) — laneBandFor('custom') falls back to each type's default.
 */
export function laneBandFor(cap: ProviderCapability, mode: PerfMode): LaneBand {
	const type = providerType(cap);
	if (mode === 'custom') {
		return customBandFor(cap, customLaneRange(cap).default);
	}
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
 * ceiling and dynamic growth). In 'custom' mode `customValues` supplies each
 * provider's user-set value. The global ceiling is a SEPARATE user setting.
 */
export function poolLanePlan(caps: ProviderCapability[], mode: PerfMode, customValues?: Record<string, number>): { laneBands: Record<string, LaneBand>; initialSum: number } {
	const laneBands: Record<string, LaneBand> = {};
	let initialSum = 0;
	for (const c of caps) {
		const band = mode === 'custom'
			? customBandFor(c, customValues?.[c.id])
			: laneBandFor(c, mode);
		laneBands[c.id] = band;
		initialSum += band.initial;
	}
	return { laneBands, initialSum: Math.max(1, initialSum) };
}

/**
 * Prefetch window per mode (2.1.9, 优化计划 item 2 自适应预取): 大幅收窄,只提前
 * 翻**很可能被读到**的页,减少用户从不浏览的页产生的请求。
 *   - stable(省流): forward 1 —— 只当前页 + 下一页。
 *   - auto: 顺读渐扩,单引擎 1、随池到 3(此前 min(2N,10) 过激,一进页就抢译
 *     多达 10 页,快速跳页时几乎全是无效请求)。
 *   - high(高速): forward 5(此前固定 12,远超实际阅读需要)。
 * backward 一律 1(上一页便宜,顺手)。
 */
export function prefetchWindowFor(mode: PerfMode, poolSize: number): { forward: number; backward: number } {
	if (mode === 'stable') {
		return { forward: 1, backward: 1 };
	}
	if (mode === 'high') {
		return { forward: 5, backward: 1 };
	}
	return { forward: Math.max(1, Math.min(poolSize, 3)), backward: 1 };
}

/** Global ceiling setting: 2–24. Two slots are required to guarantee that one
 * background prefetch can never occupy the current page's only slot. */
// 2.1.7 (计划 止血): 默认 12→8。两层请求级调度落地前先降并行页峰值,减少
// 429/浪费(「12 个并行页」≠ 12 个 API 请求,普通阶段可达 ~24)。上限 24 不变,
// 想拉高的用户仍可自设。
export const GLOBAL_MAX_DEFAULT = 8;
export const GLOBAL_MAX_MIN = 2;
export const GLOBAL_MAX_MAX = 24;

/** Migrate a stored value: 0/absent → default, clamp to [2,24]. */
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
