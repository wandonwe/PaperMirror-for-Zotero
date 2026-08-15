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
	customPromptHash: hashSourceTexts(['']),
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

// ---- schema v2: 自定义提示词进入缓存身份 (1.3.0) ------------------------------

test('customPromptHash 改变 → 页面文件名与校验双双失效', () => {
	const withPrompt: CacheKeyParts = { ...baseKey, customPromptHash: hashSourceTexts(['请使用医学术语直译']) };
	assert.notEqual(pageFileName(baseKey), pageFileName(withPrompt), '不同提示词是不同文件');
	const entry = {
		schemaVersion: CACHE_SCHEMA_VERSION,
		key: baseKey,
		createdAt: 'now',
		translations: [{ id: 'b0', translatedText: '你好' }]
	};
	assert.equal(isValidCachedPage(entry, baseKey), true);
	assert.equal(isValidCachedPage(entry, withPrompt), false, '提示词变了旧条目不再命中');
});

test('schema v1 旧条目一律不再有效 (强制失效)', () => {
	const v1entry = {
		schemaVersion: 1,
		key: baseKey,
		createdAt: 'now',
		translations: [{ id: 'b0', translatedText: '你好' }]
	};
	assert.equal(isValidCachedPage(v1entry, baseKey), false);
});
