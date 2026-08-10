import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, pickProviderForPage, laneBandFor, poolLanePlan, prefetchWindowFor, normalizeGlobalMax, normalizePerfMode } from '../../src/translation/providerPool';

test('pages deal round-robin across the pool, deterministically', () => {
	const pool = ['openai', 'deepseek', 'moonshot'];
	assert.equal(pickProviderForPage(pool, 0), 'openai');
	assert.equal(pickProviderForPage(pool, 1), 'deepseek');
	assert.equal(pickProviderForPage(pool, 2), 'moonshot');
	assert.equal(pickProviderForPage(pool, 3), 'openai');
	// Determinism is what keeps the cache aligned per page.
	assert.equal(pickProviderForPage(pool, 4), pickProviderForPage(pool, 4));
});

test('a single-provider pool always answers the primary', () => {
	assert.equal(pickProviderForPage(['openai'], 7), 'openai');
});

test('an unknown page index falls back to the primary', () => {
	assert.equal(pickProviderForPage(['a', 'b'], -1), 'a');
	assert.equal(pickProviderForPage(['a', 'b'], Number.NaN), 'a');
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

test('prefetchWindowFor: per-mode windows', () => {
	assert.deepEqual(prefetchWindowFor('stable', 3), { forward: 2, backward: 1 });
	assert.deepEqual(prefetchWindowFor('high', 3), { forward: 12, backward: 2 });
	assert.deepEqual(prefetchWindowFor('auto', 3), { forward: 6, backward: 1 }); // 2N
	assert.deepEqual(prefetchWindowFor('auto', 9), { forward: 10, backward: 1 }); // clamp 10
});

test('normalizeGlobalMax: 0/legacy → 12, clamp [1,24]', () => {
	assert.equal(normalizeGlobalMax(0), 12);
	assert.equal(normalizeGlobalMax(undefined), 12);
	assert.equal(normalizeGlobalMax(-5), 12);
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
