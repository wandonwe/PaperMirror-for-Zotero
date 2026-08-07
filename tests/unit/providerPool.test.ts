import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, pickProviderForPage } from '../../src/translation/providerPool';

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
