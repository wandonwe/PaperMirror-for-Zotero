import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReasoning, openaiChatExtras, supportsReasoningControl } from '../../src/translation/providers/advancedParams';
import { resolveChatURL } from '../../src/translation/providers/urls';
import type { ProviderSettings } from '../../src/types/models';

const base = (over: Partial<ProviderSettings>): ProviderSettings => ({
	providerId: 'x', apiBaseURL: '', apiKey: '', model: '', timeoutMs: 1000, ...over
});

test('normalizeReasoning keeps valid levels, drops anything else', () => {
	assert.equal(normalizeReasoning('minimal'), 'minimal');
	assert.equal(normalizeReasoning('high'), 'high');
	assert.equal(normalizeReasoning('off'), '');
	assert.equal(normalizeReasoning(undefined), '');
});

test('openaiChatExtras is EMPTY when nothing is set (zero regression)', () => {
	assert.deepEqual(openaiChatExtras(base({}), 'openai'), {});
	assert.deepEqual(openaiChatExtras(base({}), 'deepseek'), {});
});

test('openaiChatExtras: temperature passes through when set', () => {
	assert.deepEqual(openaiChatExtras(base({ temperature: 0 }), 'openai'), { temperature: 0 });
});

test('openaiChatExtras: max tokens key differs for the official OpenAI endpoint', () => {
	assert.deepEqual(openaiChatExtras(base({ maxOutputTokens: 500 }), 'openai'), { max_completion_tokens: 500 });
	assert.deepEqual(openaiChatExtras(base({ maxOutputTokens: 500 }), 'deepseek'), { max_tokens: 500 });
	// zero / negative is ignored
	assert.deepEqual(openaiChatExtras(base({ maxOutputTokens: 0 }), 'openai'), {});
});

test('openaiChatExtras: reasoning_effort only for supported providers, gemini minimal→none', () => {
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'minimal' }), 'openai'), { reasoning_effort: 'minimal' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'low' }), 'openrouter'), { reasoning_effort: 'low' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'minimal' }), 'gemini'), { reasoning_effort: 'none' });
	// providers not known to accept it → omitted (never risk a 400)
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'high' }), 'deepseek'), {});
});

test('supportsReasoningControl: LLM reasoning providers only', () => {
	assert.equal(supportsReasoningControl('openai'), true);
	assert.equal(supportsReasoningControl('gemini'), true);
	assert.equal(supportsReasoningControl('openrouter'), true);
	assert.equal(supportsReasoningControl('anthropic'), true);
	assert.equal(supportsReasoningControl('deepseek'), false);
	assert.equal(supportsReasoningControl('bing-free'), false);
});

test('resolveChatURL: custom apiPath overrides path building', () => {
	assert.equal(
		resolveChatURL('https://api.openai.com', 'https://api.openai.com', false, '/v1/chat/completions'),
		'https://api.openai.com/v1/chat/completions'
	);
	// leading slash added if missing
	assert.equal(resolveChatURL('https://x.example/', 'd', false, 'foo/bar'), 'https://x.example/foo/bar');
	// no apiPath → normal building (adds /v1/chat/completions)
	assert.equal(resolveChatURL('', 'https://api.openai.com', false), 'https://api.openai.com/v1/chat/completions');
});
