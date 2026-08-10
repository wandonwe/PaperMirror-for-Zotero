import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReasoning, openaiChatExtras, supportsReasoningControl } from '../../src/translation/providers/advancedParams';
import { resolveChatURL } from '../../src/translation/providers/urls';
import type { ProviderSettings } from '../../src/types/models';

const base = (over: Partial<ProviderSettings>): ProviderSettings => ({
	providerId: 'x', apiBaseURL: '', apiKey: '', model: '', timeoutMs: 1000, ...over
});

test('normalizeReasoning keeps valid levels (incl. xhigh), drops anything else', () => {
	assert.equal(normalizeReasoning('minimal'), 'minimal');
	assert.equal(normalizeReasoning('high'), 'high');
	assert.equal(normalizeReasoning('xhigh'), 'xhigh');
	assert.equal(normalizeReasoning('off'), '');
	assert.equal(normalizeReasoning(undefined), '');
});

test('default temperature 0 for safe providers; openai/openrouter left alone', () => {
	// 温度默认 0(翻译更稳定)— but openai gpt-5.x / openrouter auto-routing only
	// accept the default temperature, so no default is injected there.
	assert.deepEqual(openaiChatExtras(base({}), 'deepseek'), { temperature: 0 });
	assert.deepEqual(openaiChatExtras(base({}), 'qwen'), { temperature: 0 });
	assert.deepEqual(openaiChatExtras(base({}), 'openai'), {});
	assert.deepEqual(openaiChatExtras(base({}), 'openrouter'), {});
});

test('openaiChatExtras: explicit temperature always passes through', () => {
	assert.deepEqual(openaiChatExtras(base({ temperature: 0 }), 'openai'), { temperature: 0 });
	assert.deepEqual(openaiChatExtras(base({ temperature: 0.7 }), 'deepseek'), { temperature: 0.7 });
});

test('openaiChatExtras: max tokens key differs for the official OpenAI endpoint', () => {
	assert.deepEqual(openaiChatExtras(base({ maxOutputTokens: 500 }), 'openai'), { max_completion_tokens: 500 });
	assert.deepEqual(
		openaiChatExtras(base({ maxOutputTokens: 500 }), 'deepseek'),
		{ temperature: 0, max_tokens: 500 }
	);
	// zero / negative is ignored
	assert.deepEqual(openaiChatExtras(base({ maxOutputTokens: 0 }), 'openai'), {});
});

test('gemini 深度思考: disabled→reasoning_effort none, auto→dynamic thinking budget', () => {
	assert.deepEqual(
		openaiChatExtras(base({ reasoning: 'disabled' }), 'gemini'),
		{ temperature: 0, reasoning_effort: 'none' }
	);
	assert.deepEqual(
		openaiChatExtras(base({ reasoning: 'auto' }), 'gemini'),
		{ temperature: 0, extra_body: { google: { thinking_config: { thinking_budget: -1 } } } }
	);
	// disabled/auto are Gemini-only vocabulary — OpenAI/OpenRouter never emit them.
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'disabled' }), 'openai'), {});
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'auto' }), 'openrouter'), {});
});

test('reasoning_effort mapping: official levels; gemini minimal→none, xhigh→high', () => {
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'minimal' }), 'openai'), { reasoning_effort: 'minimal' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'xhigh' }), 'openai'), { reasoning_effort: 'xhigh' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'low' }), 'openrouter'), { reasoning_effort: 'low' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'minimal' }), 'gemini'), { temperature: 0, reasoning_effort: 'none' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'xhigh' }), 'gemini'), { temperature: 0, reasoning_effort: 'high' });
	// providers not known to accept it → omitted (never risk a 400)
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'high' }), 'deepseek'), { temperature: 0 });
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
