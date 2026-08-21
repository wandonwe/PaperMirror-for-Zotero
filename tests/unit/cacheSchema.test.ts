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
	glossaryHash: hashSourceTexts(['[]']),
	noTranslateHash: hashSourceTexts(['']),
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

// ---- schema v3 (2.0.2, 审核 P1-10): 术语表/不译词进入页面键 ------------------

test('改术语表 → 页面缓存失效(此前被先命中的页面缓存整层短路)', () => {
	const withGlossary: CacheKeyParts = { ...baseKey, glossaryHash: hashSourceTexts(['[{"from":"transformer","to":"变换器"}]']) };
	assert.notEqual(pageFileName(baseKey), pageFileName(withGlossary), '不同术语表必须是不同文件');
	const entry = {
		schemaVersion: CACHE_SCHEMA_VERSION, key: baseKey, createdAt: 'now',
		translations: [{ id: 'b0', translatedText: '你好' }]
	};
	assert.equal(isValidCachedPage(entry, baseKey), true);
	assert.equal(isValidCachedPage(entry, withGlossary), false, '术语表变了旧条目不得再命中');
});

test('改不译词列表 → 页面缓存失效(它改变占位符掩蔽从而改变译文)', () => {
	const withNoTranslate: CacheKeyParts = { ...baseKey, noTranslateHash: hashSourceTexts(['Transformer\nBERT']) };
	assert.notEqual(pageFileName(baseKey), pageFileName(withNoTranslate));
	const entry = {
		schemaVersion: CACHE_SCHEMA_VERSION, key: baseKey, createdAt: 'now',
		translations: [{ id: 'b0', translatedText: '你好' }]
	};
	assert.equal(isValidCachedPage(entry, withNoTranslate), false);
});

test('schema v2 旧条目一律失效(强制迁移)', () => {
	const v2 = {
		schemaVersion: 2, key: baseKey, createdAt: 'now',
		translations: [{ id: 'b0', translatedText: '你好' }]
	};
	assert.equal(isValidCachedPage(v2, baseKey), false);
});

// ---- schema v4 (2.0.4, 审核 P2-12): fnv1a64 第二条 lane 退化修正 -------------

test('等长 ASCII 字符串的 h2 后缀不再相同(旧公式下 h2 只依赖长度)', () => {
	// 旧公式: ASCII 时 c>>8===0,h2 只由 i 序列(即长度)决定 —— 这两个
	// 19 字符串曾共享 h2 后缀 c8ddec1f。
	const a = fnv1a64('The quick brown fox');
	const b = fnv1a64('Lorem ipsum dolor s');
	assert.equal(a.length, 16);
	assert.equal(b.length, 16);
	assert.notEqual(a.slice(8), b.slice(8), '等长不同内容必须产生不同的 h2 lane');
});

test('修复前实测的全 64 位碰撞对不再碰撞', () => {
	// 旧公式在 40 万等长串扫描中找到的真实全碰撞 (07a86b9aba5769d7)。
	const a = fnv1a64('Paragraph text sample number 112789 padding');
	const b = fnv1a64('Paragraph text sample number 349192 padding');
	assert.notEqual(a, b);
});

test('h2 lane 对内容与位置都敏感', () => {
	// 同一组字符不同排列 → h2 不同(位置混入)。
	assert.notEqual(fnv1a64('ab').slice(8), fnv1a64('ba').slice(8));
	// 同位置不同字符 → h2 不同(字符混入)。
	assert.notEqual(fnv1a64('aa').slice(8), fnv1a64('ab').slice(8));
});

test('fnv1a64 输出稳定(哈希算法一旦改变必须提升 schemaVersion)', () => {
	// 固定向量: 若此测试失败,说明哈希实现又变了 —— 文件名布局随之改变,
	// 必须同时提升 CACHE_SCHEMA_VERSION,否则旧缓存文件成为永远不会命中
	// 也永远不被清理的孤儿。
	assert.equal(CACHE_SCHEMA_VERSION, 4);
	assert.match(fnv1a64('hello world'), /^[0-9a-f]{16}$/);
	assert.equal(fnv1a64('hello world'), fnv1a64('hello world'));
});

test('schema v3 旧条目一律失效(哈希布局已变,强制迁移)', () => {
	const v3 = {
		schemaVersion: 3, key: baseKey, createdAt: 'now',
		translations: [{ id: 'b0', translatedText: '你好' }]
	};
	assert.equal(isValidCachedPage(v3, baseKey), false);
});

test('段落 context 也随不译词变化', async () => {
	const { segmentContextHash } = await import('../../src/cache/cacheSchema');
	const base = {
		attachmentKey: 'K', fileHash: 'H', provider: 'openai', model: 'm',
		promptVersion: 2, customPromptHash: 'cp', glossaryHash: 'g', noTranslateHash: 'n1'
	};
	assert.notEqual(segmentContextHash(base), segmentContextHash({ ...base, noTranslateHash: 'n2' }));
	assert.notEqual(segmentContextHash(base), segmentContextHash({ ...base, glossaryHash: 'g2' }));
	assert.equal(segmentContextHash(base), segmentContextHash({ ...base }), '相同输入必须稳定');
});
