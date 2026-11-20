import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiChatExtras } from '../../src/translation/providers/advancedParams';
import { geminiGenerationConfig } from '../../src/translation/providers/geminiNative';
import { advancedBody } from '../../src/translation/providers/anthropic';
import { openaiDefaultThinkingFloor } from '../../src/translation/providers/modelFamilies';
import type { ProviderSettings } from '../../src/types/models';

// 用户 2026-11-20: 「能否所有模型默认都不思考」—— 能关的关,关不掉的取最低档。
const s = (model: string, extra: Partial<ProviderSettings> = {}): ProviderSettings => ({ apiKey: 'k', model, ...extra } as ProviderSettings);

test('Gemini 2.5 Flash / Flash-Lite turn thinking off when no effort is set; 2.5 Pro takes its 128 minimum', () => {
	assert.deepEqual(geminiGenerationConfig(s('gemini-2.5-flash')).thinkingConfig, { thinkingBudget: 0 });
	assert.deepEqual(geminiGenerationConfig(s('gemini-2.5-flash-lite')).thinkingConfig, { thinkingBudget: 0 });
	assert.deepEqual(geminiGenerationConfig(s('gemini-2.5-pro')).thinkingConfig, { thinkingBudget: 128 });
	// 「自动」still hands the decision to the model.
	assert.deepEqual(geminiGenerationConfig(s('gemini-2.5-flash', { reasoning: 'auto' })).thinkingConfig, { thinkingBudget: -1 });
	// An explicit effort is the user's decision: no override.
	assert.equal(geminiGenerationConfig(s('gemini-2.5-flash', { reasoning: 'high' })).thinkingConfig, undefined);
	// Gemini 3+/4 keep their minimum levels; 2.0 gets nothing it would reject.
	assert.deepEqual(geminiGenerationConfig(s('gemini-3.8-flash')).thinkingConfig, { thinkingLevel: 'low' });
	assert.equal(geminiGenerationConfig(s('gemini-2.0-flash')).thinkingConfig, undefined);
});

test('OpenAI models that think by default get their floor; GPT-5.1+ default none needs nothing', () => {
	assert.equal(openaiDefaultThinkingFloor('gpt-5-nano'), 'minimal');
	assert.equal(openaiDefaultThinkingFloor('gpt-5'), 'minimal');
	assert.equal(openaiDefaultThinkingFloor('openai/gpt-5-mini'), 'minimal');
	assert.equal(openaiDefaultThinkingFloor('o4-mini'), 'low');
	assert.equal(openaiDefaultThinkingFloor('gpt-5.4-nano'), null);
	assert.equal(openaiDefaultThinkingFloor('gpt-4.1'), null);
	assert.equal(openaiChatExtras(s('gpt-5-nano'), 'openai').reasoning_effort, 'minimal');
	assert.equal(openaiChatExtras(s('o3'), 'openai').reasoning_effort, 'low');
	assert.equal(openaiChatExtras(s('gpt-5.4-nano'), 'openai').reasoning_effort, undefined);
	assert.equal(openaiChatExtras(s('gpt-6-luna'), 'openai').reasoning_effort, 'none');
	assert.equal(openaiChatExtras(s('gpt-6.2-sol'), 'openai').reasoning_effort, 'low');
	assert.equal(openaiChatExtras(s('gpt-5-nano', { reasoning: 'high' }), 'openai').reasoning_effort, 'high');
});

test('Ollama asks for no thinking by default through reasoning_effort none', () => {
	assert.equal(openaiChatExtras(s('qwen3.5'), 'ollama').reasoning_effort, 'none');
	assert.equal(openaiChatExtras(s('qwen3.5', { reasoning: 'disabled' }), 'ollama').reasoning_effort, 'none');
	assert.equal(openaiChatExtras(s('qwen3.5', { reasoning: 'auto' }), 'ollama').reasoning_effort, undefined);
	assert.equal(openaiChatExtras(s('qwen3.5', { reasoning: 'low' }), 'ollama').reasoning_effort, 'low');
});

test('every other provider already defaults to off or its minimum', () => {
	assert.deepEqual(openaiChatExtras(s('deepseek-flash'), 'deepseek').thinking, { type: 'disabled' });
	assert.equal(openaiChatExtras(s('qwen3.7-plus'), 'qwen').enable_thinking, false);
	assert.equal(openaiChatExtras(s('deepseek-ai/DeepSeek-V4-Flash'), 'siliconflow').enable_thinking, false);
	assert.deepEqual(openaiChatExtras(s('glm-4.7-flash'), 'zhipu').thinking, { type: 'disabled' });
	assert.equal(openaiChatExtras(s('glm-5.3'), 'zhipu').reasoning_effort, 'low');
	assert.equal(openaiChatExtras(s('kimi-k3'), 'moonshot').reasoning_effort, 'low');
	assert.equal(openaiChatExtras(s('openai/gpt-oss-120b'), 'groq').reasoning_effort, 'low');
	assert.deepEqual(advancedBody(s('claude-haiku-5-5'), 4096).thinking, { type: 'disabled' });
	assert.deepEqual(advancedBody(s('claude-sonnet-5-5'), 4096).thinking, { type: 'between_tools' });
	assert.deepEqual(advancedBody(s('claude-opus-5-5'), 4096).output_config, { effort: 'low' });
	assert.equal(advancedBody(s('claude-sonnet-4-5'), 4096).thinking, undefined);
});
