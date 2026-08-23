import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, pickProviderForPage, rankProvidersForPage, laneBandFor, poolLanePlan, prefetchWindowFor, normalizeGlobalMax, normalizePerfMode, customLaneRange, customBandFor } from '../../src/translation/providerPool';

test('page→provider is deterministic and every provider gets some pages', () => {
	const pool = ['openai', 'deepseek', 'moonshot'];
	// Deterministic per page — this is what keeps a page's cache aligned.
	for (let p = 0; p < 5; p++) {
		assert.equal(pickProviderForPage(pool, p), pickProviderForPage(pool, p));
	}
	// Coverage: across many pages every provider owns at least one.
	const owners = new Set(Array.from({ length: 60 }, (_, p) => pickProviderForPage(pool, p)));
	assert.deepEqual([...owners].sort(), [...pool].sort());
});

test('a single-provider pool always answers the primary', () => {
	assert.equal(pickProviderForPage(['openai'], 7), 'openai');
});

test('an invalid page index is deterministic (normalised to page 0)', () => {
	assert.equal(pickProviderForPage(['a', 'b'], -1), pickProviderForPage(['a', 'b'], 0));
	assert.equal(pickProviderForPage(['a', 'b'], Number.NaN), pickProviderForPage(['a', 'b'], 0));
});

// ---- 一致性哈希稳定映射 (2.2.1, 第三批 item1) --------------------------------

test('reordering the pool changes no page assignment (order-independent)', () => {
	for (let p = 0; p < 50; p++) {
		assert.equal(
			pickProviderForPage(['a', 'b', 'c'], p),
			pickProviderForPage(['c', 'a', 'b'], p),
			`page ${p} must not move when only the pool order changes`
		);
	}
});

test('adding a provider only ever moves a page ONTO the new provider', () => {
	const before = ['a', 'b', 'c'];
	const after = ['a', 'b', 'c', 'd'];
	let moved = 0;
	for (let p = 0; p < 300; p++) {
		const o = pickProviderForPage(before, p);
		const n = pickProviderForPage(after, p);
		if (o !== n) {
			moved++;
			// HRW invariant: a page can only migrate to the newcomer, never between
			// two incumbents.
			assert.equal(n, 'd', `page ${p} moved ${o}→${n}, not onto the new provider`);
		}
	}
	// And roughly 1/N migrate — nowhere near the near-total churn of modulo.
	assert.ok(moved > 0 && moved < 300 * 0.5, `expected ~1/4 to move, got ${moved}/300`);
});

test('removing a provider only remaps pages that belonged to it', () => {
	const before = ['a', 'b', 'c'];
	const after = ['a', 'b'];
	for (let p = 0; p < 300; p++) {
		const o = pickProviderForPage(before, p);
		const n = pickProviderForPage(after, p);
		if (o !== 'c') {
			assert.equal(n, o, `page ${p} owned by ${o} must not move when 'c' is removed`);
		}
		else {
			assert.ok(n === 'a' || n === 'b', `orphaned page ${p} must fall to a surviving provider`);
		}
	}
});

test('rankProvidersForPage is a best-first permutation of the pool', () => {
	const pool = ['a', 'b', 'c', 'd'];
	for (let p = 0; p < 10; p++) {
		const rank = rankProvidersForPage(pool, p);
		assert.equal(rank.length, pool.length);
		assert.deepEqual([...rank].sort(), [...pool].sort(), 'no dups, no drops');
		assert.equal(rank[0], pickProviderForPage(pool, p), 'head of the rank is the owner');
	}
});

test('buildPool keeps the primary first and dedupes', () => {
	assert.deepEqual(buildPool('openai', ['deepseek', 'openai', 'deepseek', '']), ['openai', 'deepseek']);
	assert.deepEqual(buildPool('openai', []), ['openai']);
});

test('laneBandFor: per-type bands vary by performance mode', () => {
	const free = { id: 'bing-free', requiresApiKey: false, local: false };
	const llm = { id: 'openai', requiresApiKey: true, local: false };
	const local = { id: 'ollama', requiresApiKey: false, local: true };
	// Free engines are one lane in every mode.
	assert.deepEqual(laneBandFor(free, 'stable'), { min: 1, initial: 1, max: 1 });
	assert.deepEqual(laneBandFor(free, 'high'), { min: 1, initial: 1, max: 1 });
	// Cloud LLM: stable fixed 2, auto 3→6, high fixed 6.
	assert.deepEqual(laneBandFor(llm, 'stable'), { min: 1, initial: 2, max: 2 });
	assert.deepEqual(laneBandFor(llm, 'auto'), { min: 1, initial: 3, max: 6 });
	assert.deepEqual(laneBandFor(llm, 'high'), { min: 1, initial: 6, max: 6 });
	// Local: stable 1, auto 1→2, high 2.
	assert.deepEqual(laneBandFor(local, 'auto'), { min: 1, initial: 1, max: 2 });
});

test('poolLanePlan: bands per provider + sum of initial caps', () => {
	// Screenshot case (auto): Google free + OpenAI + Gemini → 1 + 3 + 3 = 7 initial.
	const plan = poolLanePlan([
		{ id: 'google-free', requiresApiKey: false, local: false },
		{ id: 'openai', requiresApiKey: true, local: false },
		{ id: 'gemini', requiresApiKey: true, local: false }
	], 'auto');
	assert.equal(plan.initialSum, 7);
	assert.deepEqual(plan.laneBands.openai, { min: 1, initial: 3, max: 6 });
	assert.deepEqual(plan.laneBands['google-free'], { min: 1, initial: 1, max: 1 });
	// Stable lowers the LLM lanes: 1 + 2 + 2 = 5.
	assert.equal(poolLanePlan([
		{ id: 'google-free', requiresApiKey: false, local: false },
		{ id: 'openai', requiresApiKey: true, local: false },
		{ id: 'gemini', requiresApiKey: true, local: false }
	], 'stable').initialSum, 5);
});

test('prefetchWindowFor: per-mode windows (2.1.9 收窄)', () => {
	// 省流: 只当前 + 下一页。
	assert.deepEqual(prefetchWindowFor('stable', 3), { forward: 1, backward: 1 });
	// 高速: ≤5,不再固定 12。
	assert.deepEqual(prefetchWindowFor('high', 3), { forward: 5, backward: 1 });
	// auto: 顺读渐扩,单引擎 1、随池到 3。
	assert.deepEqual(prefetchWindowFor('auto', 1), { forward: 1, backward: 1 });
	assert.deepEqual(prefetchWindowFor('auto', 3), { forward: 3, backward: 1 });
	assert.deepEqual(prefetchWindowFor('auto', 9), { forward: 3, backward: 1 }); // clamp 3
});

test('normalizeGlobalMax: 0/legacy → 8 (2.1.7 默认降峰), clamp [2,24]', () => {
	assert.equal(normalizeGlobalMax(0), 8);
	assert.equal(normalizeGlobalMax(undefined), 8);
	assert.equal(normalizeGlobalMax(-5), 8);
	assert.equal(normalizeGlobalMax(1), 2);
	assert.equal(normalizeGlobalMax(3), 3);
	assert.equal(normalizeGlobalMax(99), 24);
});

test('normalizePerfMode: defaults to auto for anything unknown', () => {
	assert.equal(normalizePerfMode('stable'), 'stable');
	assert.equal(normalizePerfMode('high'), 'high');
	assert.equal(normalizePerfMode('auto'), 'auto');
	assert.equal(normalizePerfMode('nonsense'), 'auto');
	assert.equal(normalizePerfMode(undefined), 'auto');
});

test('normalizePerfMode accepts custom', () => {
	assert.equal(normalizePerfMode('custom'), 'custom');
});

test('customLaneRange: per-type limits, free locked', () => {
	assert.deepEqual(customLaneRange({ id: 'openai', requiresApiKey: true, local: false }), { min: 1, max: 6, locked: false, default: 3 });
	assert.deepEqual(customLaneRange({ id: 'deepl', requiresApiKey: true, local: false }), { min: 1, max: 4, locked: false, default: 3 });
	assert.deepEqual(customLaneRange({ id: 'ollama', requiresApiKey: false, local: true }), { min: 1, max: 2, locked: false, default: 1 });
	assert.deepEqual(customLaneRange({ id: 'bing-free', requiresApiKey: false, local: false }), { min: 1, max: 1, locked: true, default: 1 });
});

test('customBandFor: clamps to the provider range; undefined → default', () => {
	const llm = { id: 'openai', requiresApiKey: true, local: false };
	assert.deepEqual(customBandFor(llm, 4), { min: 1, initial: 4, max: 4 });
	assert.deepEqual(customBandFor(llm, 99), { min: 1, initial: 6, max: 6 }); // clamp to 6
	assert.deepEqual(customBandFor(llm, undefined), { min: 1, initial: 3, max: 3 }); // default 3
	// Free is always 1 regardless of the requested value.
	assert.deepEqual(customBandFor({ id: 'bing-free', requiresApiKey: false, local: false }, 5), { min: 1, initial: 1, max: 1 });
});

test('poolLanePlan(custom) uses the user values, free stays 1', () => {
	const caps = [
		{ id: 'openai', requiresApiKey: true, local: false },
		{ id: 'bing-free', requiresApiKey: false, local: false }
	];
	const plan = poolLanePlan(caps, 'custom', { openai: 5 });
	assert.equal(plan.laneBands.openai!.initial, 5);
	assert.equal(plan.laneBands['bing-free']!.initial, 1);
	assert.equal(plan.initialSum, 6);
});
