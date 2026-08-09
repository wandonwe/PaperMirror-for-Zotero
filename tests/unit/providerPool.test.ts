import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, pickProviderForPage, pageConcurrencyFor, poolConcurrencyPlan, prefetchWindowFor } from '../../src/translation/providerPool';

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

test('pageConcurrencyFor: per-provider-type lane caps', () => {
	assert.equal(pageConcurrencyFor({ id: 'bing-free', requiresApiKey: false, local: false }), 1);
	assert.equal(pageConcurrencyFor({ id: 'google-free', requiresApiKey: false, local: false }), 1);
	assert.equal(pageConcurrencyFor({ id: 'deepl', requiresApiKey: true, local: false }), 3);
	assert.equal(pageConcurrencyFor({ id: 'openai', requiresApiKey: true, local: false }), 3);
	assert.equal(pageConcurrencyFor({ id: 'ollama', requiresApiKey: false, local: true }), 1);
});

test('poolConcurrencyPlan: global = sum of lanes, clamped to [2,24]', () => {
	// Screenshot case: Google free + OpenAI + Gemini → 1 + 3 + 3 = 7.
	const plan = poolConcurrencyPlan([
		{ id: 'google-free', requiresApiKey: false, local: false },
		{ id: 'openai', requiresApiKey: true, local: false },
		{ id: 'gemini', requiresApiKey: true, local: false }
	]);
	assert.equal(plan.globalMax, 7);
	assert.deepEqual(plan.laneCaps, { 'google-free': 1, openai: 3, gemini: 3 });

	// A single free engine still floors the global at 2 (so prefetch can run).
	assert.equal(poolConcurrencyPlan([{ id: 'bing-free', requiresApiKey: false, local: false }]).globalMax, 2);

	// Many big LLMs cap at 24.
	const big = Array.from({ length: 10 }, (_, i) => ({ id: `llm${i}`, requiresApiKey: true, local: false }));
	assert.equal(poolConcurrencyPlan(big).globalMax, 24);
});

test('prefetchWindowFor: forward = min(2N, 12), backward = 1', () => {
	assert.deepEqual(prefetchWindowFor(1), { forward: 2, backward: 1 });
	assert.deepEqual(prefetchWindowFor(3), { forward: 6, backward: 1 });
	assert.deepEqual(prefetchWindowFor(9), { forward: 12, backward: 1 }); // clamped
});
