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
