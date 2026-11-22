import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredProviderIds } from '../../src/translation/providerAvailability';
import { listProviders } from '../../src/translation/providers/registry';

/**
 * 5.0 (用户反馈「这里只有设置的才显示」): 菜单栏「翻译服务」只列已设置的引擎。
 */
const providers = listProviders().map(p => ({ id: p.id, requiresApiKey: p.requiresApiKey }));

test('全新安装: 只有两个免费引擎(当前为微软)', () => {
	const ids = configuredProviderIds({ providers, withKey: new Set(), profiles: {}, current: 'bing-free' });
	assert.deepEqual(ids, ['bing-free', 'google-free']);
});

test('保存了密钥的服务商才列出,保持注册表顺序', () => {
	const ids = configuredProviderIds({
		providers, withKey: new Set(['deepl', 'openai', 'deepseek']), profiles: {}, current: 'bing-free'
	});
	assert.deepEqual(ids, ['bing-free', 'google-free', 'openai', 'deepseek', 'deepl']);
});

test('只有模型/高级参数而没有密钥的服务商不列出', () => {
	const ids = configuredProviderIds({
		providers, withKey: new Set(), profiles: { gemini: { model: 'gemini-3.8-flash' }, anthropic: { reasoning: 'low' } }, current: 'bing-free'
	});
	assert.ok(!ids.includes('gemini') && !ids.includes('anthropic'));
});

test('端点类: 填了 Base URL 才列出(custom 无需密钥)', () => {
	const ids = configuredProviderIds({
		providers, withKey: new Set(),
		profiles: { custom: { apiBaseUrl: 'https://llm.example.org/v1' }, 'openai-compatible': { apiBaseUrl: '  ' } },
		current: 'bing-free'
	});
	assert.ok(ids.includes('custom'));
	assert.ok(!ids.includes('openai-compatible'), '空白地址不算已设置');
});

test('Ollama: 保存过配置才列出', () => {
	const base = { providers, withKey: new Set<string>(), current: 'bing-free' };
	assert.ok(!configuredProviderIds({ ...base, profiles: {} }).includes('ollama'));
	assert.ok(configuredProviderIds({ ...base, profiles: { ollama: {} } }).includes('ollama'));
});

test('当前选中的引擎即使未设置也必须列出(否则菜单没有勾选项)', () => {
	const ids = configuredProviderIds({ providers, withKey: new Set(), profiles: {}, current: 'anthropic' });
	assert.deepEqual(ids, ['bing-free', 'google-free', 'anthropic']);
});
