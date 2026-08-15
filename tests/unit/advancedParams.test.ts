import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReasoning, openaiChatExtras, supportsReasoningControl, isReasoningEffortRejection, reasoningEffortUnsupported, markReasoningEffortUnsupported } from '../../src/translation/providers/advancedParams';
import { PaperMirrorError } from '../../src/types/models';
import { resolveChatURL } from '../../src/translation/providers/urls';
import { geminiGenerateURL, geminiGenerationConfig } from '../../src/translation/providers/geminiNative';
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

test('gemini 深度思考 (native adapter): disabled→budget 0, auto→budget -1, default→omitted', () => {
	assert.deepEqual(
		geminiGenerationConfig(base({ reasoning: 'disabled' })),
		{ temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
	);
	assert.deepEqual(
		geminiGenerationConfig(base({ reasoning: 'auto' })),
		{ temperature: 0, thinkingConfig: { thinkingBudget: -1 } }
	);
	assert.deepEqual(geminiGenerationConfig(base({})), { temperature: 0 });
	// json mode + user-set advanced values flow into generationConfig
	assert.deepEqual(
		geminiGenerationConfig(base({ temperature: 0.5, maxOutputTokens: 4096 }), { json: true }),
		{ temperature: 0.5, maxOutputTokens: 4096, responseMimeType: 'application/json' }
	);
	// disabled/auto are Gemini-only vocabulary — OpenAI/OpenRouter never emit them.
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'disabled' }), 'openai'), {});
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'auto' }), 'openrouter'), {});
});

test('gemini native URL: model in the path; custom Base URL / apiPath override', () => {
	assert.equal(
		geminiGenerateURL(base({ model: 'gemini-2.5-flash' })),
		'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
	);
	assert.equal(
		geminiGenerateURL(base({ apiBaseURL: 'https://my-proxy.example', model: 'gemini-2.5-flash-lite' })),
		'https://my-proxy.example/v1beta/models/gemini-2.5-flash-lite:generateContent'
	);
	assert.equal(
		geminiGenerateURL(base({ apiBaseURL: 'https://gw.example', apiPath: '/custom/gemini' })),
		'https://gw.example/custom/gemini'
	);
});

test('reasoning_effort mapping: official levels for OpenAI/OpenRouter only', () => {
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'minimal' }), 'openai'), { reasoning_effort: 'minimal' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'xhigh' }), 'openai'), { reasoning_effort: 'xhigh' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'low' }), 'openrouter'), { reasoning_effort: 'low' });
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

// ---- 1.1.11: reasoning_effort 拒收自愈 ------------------------------------

test('isReasoningEffortRejection: 只认 400 且 message 带 reasoning_effort', () => {
	const real = new PaperMirrorError('UNKNOWN',
		'Unexpected API response (HTTP 400): {"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}',
		{ httpStatus: 400 });
	assert.equal(isReasoningEffortRejection(real), true);
	// 其它 400 (模型名错) 不算 —— 不该误触发剥参重试
	assert.equal(isReasoningEffortRejection(
		new PaperMirrorError('INVALID_MODEL', 'The API rejected the model name (HTTP 400): no such model', { httpStatus: 400 })), false);
	// 429 / 500 / 非错误都不算
	assert.equal(isReasoningEffortRejection(
		new PaperMirrorError('RATE_LIMITED', 'reasoning_effort mentioned but 429', { httpStatus: 429 })), false);
	assert.equal(isReasoningEffortRejection(new Error('reasoning_effort')), false);
	assert.equal(isReasoningEffortRejection(null), false);
});

test('reasoningEffortUnsupported 注册表: 按 (供应商, 模型) 记忆, 互不影响', () => {
	assert.equal(reasoningEffortUnsupported('openai', 'gpt-4o-unique-a'), false);
	markReasoningEffortUnsupported('openai', 'gpt-4o-unique-a');
	assert.equal(reasoningEffortUnsupported('openai', 'gpt-4o-unique-a'), true);
	// 不牵连同供应商的推理模型, 也不牵连别的供应商
	assert.equal(reasoningEffortUnsupported('openai', 'o3-unique-b'), false);
	assert.equal(reasoningEffortUnsupported('openrouter', 'gpt-4o-unique-a'), false);
});
