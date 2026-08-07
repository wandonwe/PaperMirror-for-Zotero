import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a64, hashSourceTexts, attachmentDirName, pageFileName, isValidCachedPage, CACHE_SCHEMA_VERSION, type CacheKeyParts } from '../../src/cache/cacheSchema';

const baseKey: CacheKeyParts = {
	attachmentKey: 'ABCD1234',
	fileHash: 'deadbeef',
	pageIndex: 3,
	sourceLanguage: 'en',
	targetLanguage: 'zh-CN',
	provider: 'anthropic',
	model: 'claude-sonnet-4-5',
	promptVersion: 1,
	sourceTextHash: hashSourceTexts(['hello world'])
};

test('fnv1a64 is deterministic and differs on change', () => {
	assert.equal(fnv1a64('abc'), fnv1a64('abc'));
	assert.notEqual(fnv1a64('abc'), fnv1a64('abd'));
});

test('file hash change produces a different directory (invalidation)', () => {
	const a = attachmentDirName('KEY', 'hash1');
	const b = attachmentDirName('KEY', 'hash2');
	assert.notEqual(a, b);
});

test('model/lang/prompt change produces a different file name', () => {
	const base = pageFileName(baseKey);
	assert.notEqual(base, pageFileName({ ...baseKey, model: 'gpt-4o' }));
	assert.notEqual(base, pageFileName({ ...baseKey, targetLanguage: 'zh-TW' }));
	assert.notEqual(base, pageFileName({ ...baseKey, promptVersion: 2 }));
	assert.notEqual(base, pageFileName({ ...baseKey, sourceTextHash: 'other' }));
});

test('source text change invalidates via sourceTextHash', () => {
	assert.notEqual(hashSourceTexts(['a']), hashSourceTexts(['b']));
});

test('isValidCachedPage accepts a matching entry and rejects mismatches', () => {
	const entry = {
		schemaVersion: CACHE_SCHEMA_VERSION,
		key: baseKey,
		createdAt: '2026-01-01T00:00:00Z',
		translations: [{ id: 'page-3-block-0', translatedText: '你好' }]
	};
	assert.equal(isValidCachedPage(entry, baseKey), true);
	assert.equal(isValidCachedPage(entry, { ...baseKey, model: 'different' }), false);
	assert.equal(isValidCachedPage({ ...entry, schemaVersion: 999 }, baseKey), false);
});

test('cache key/file names never contain unsafe path characters', () => {
	const name = pageFileName({ ...baseKey, model: 'org/model:v1 beta' });
	assert.ok(!/[/:\\ ]/.test(name));
});
