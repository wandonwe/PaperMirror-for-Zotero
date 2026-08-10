import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiChatURL, anthropicMessagesURL, deeplTranslateURL, normalizeOpenAIBase } from '../../src/translation/providers/urls';
import { getProvider } from '../../src/translation/providers/registry';
import type { ProviderSettings } from '../../src/types/models';

const s = (apiBaseURL: string): ProviderSettings => ({
	providerId: 'x', apiBaseURL, apiKey: '', model: '', timeoutMs: 1000
});

test('openaiChatURL: appends /v1 and /chat/completions when missing', () => {
	assert.equal(openaiChatURL('', 'https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
	assert.equal(openaiChatURL('', 'https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
});

test('openaiChatURL: never doubles /v1 on a version-suffixed base', () => {
	assert.equal(openaiChatURL('https://api.openai.com/v1', 'https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
	assert.equal(openaiChatURL('https://api.openai.com/v1/', 'https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
	assert.equal(openaiChatURL('', 'https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
});

test('openaiChatURL: never doubles /chat/completions, honours noV1Suffix', () => {
	assert.equal(
		openaiChatURL('https://x.example/v1/chat/completions', 'https://x.example'),
		'https://x.example/v1/chat/completions'
	);
	assert.equal(
		openaiChatURL('', 'https://generativelanguage.googleapis.com/v1beta/openai', true),
		'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
	);
});

test('normalizeOpenAIBase strips trailing slashes', () => {
	assert.equal(normalizeOpenAIBase('https://api.openai.com/', 'x'), 'https://api.openai.com/v1');
});

test('anthropicMessagesURL: native path, no /v1/v1', () => {
	assert.equal(anthropicMessagesURL('', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
	assert.equal(anthropicMessagesURL('https://api.anthropic.com/v1', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
	assert.equal(anthropicMessagesURL('https://proxy/v1/messages', 'https://api.anthropic.com'), 'https://proxy/v1/messages');
});

test('deeplTranslateURL: native path, no /v2/v2', () => {
	assert.equal(deeplTranslateURL('https://api.deepl.com'), 'https://api.deepl.com/v2/translate');
	assert.equal(deeplTranslateURL('https://api.deepl.com/v2'), 'https://api.deepl.com/v2/translate');
	assert.equal(deeplTranslateURL('https://api.deepl.com/v2/translate'), 'https://api.deepl.com/v2/translate');
});

test('provider.endpointFor reflects the real transport URL', () => {
	assert.equal(getProvider('openai').endpointFor!(s('')), 'https://api.openai.com/v1/chat/completions');
	assert.equal(getProvider('anthropic').endpointFor!(s('')), 'https://api.anthropic.com/v1/messages');
	assert.equal(getProvider('deepl').endpointFor!(s('')), 'https://api.deepl.com/v2/translate');
	assert.equal(
		getProvider('gemini').endpointFor!(s('')),
		'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
	);
	// A custom base flows straight through the same builder.
	assert.equal(getProvider('openai').endpointFor!(s('https://mirror.example/v1')), 'https://mirror.example/v1/chat/completions');
});

test('free scrapers expose no configurable endpoint', () => {
	assert.equal(getProvider('bing-free').endpointFor, undefined);
	assert.equal(getProvider('google-free').endpointFor, undefined);
});
