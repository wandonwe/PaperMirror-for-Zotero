import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentOfficialModel } from '../../src/translation/providers/modelMigrations';
import { parseProviderProfiles } from '../../src/translation/providerProfiles';
import { openaiChatExtras, supportsReasoningControl } from '../../src/translation/providers/advancedParams';
import { advancedBody } from '../../src/translation/providers/anthropic';
import { geminiGenerationConfig } from '../../src/translation/providers/geminiNative';
import { MODEL_CATALOG } from '../../src/translation/providers/modelCatalog';
import type { ProviderSettings } from '../../src/types/models';
const settings = (model: string, more: Partial<ProviderSettings> = {}): ProviderSettings => ({ providerId: 'x', model, apiBaseURL: '', apiKey: '', timeoutMs: 1000, ...more });
test('retired official IDs migrate idempotently without rewriting proxies or aggregators', () => {
	for (const [p, old, next] of [['deepseek', 'deepseek-v4-flash', 'deepseek-flash'], ['moonshot', 'kimi-k2.5', 'kimi-k3'], ['gemini', 'gemini-2.0-flash', 'gemini-3.6-flash']] as const) {
		assert.equal(currentOfficialModel(p, old), next);
		assert.equal(currentOfficialModel(p, next), next);
		assert.equal(currentOfficialModel(p, old, 'https://proxy.example/v1'), old);
		assert.equal(currentOfficialModel(p, old, '', '/gateway'), old);
	}
	assert.equal(currentOfficialModel('deepseek', 'deepseek-v4-pro'), 'deepseek-v4-pro');
	assert.equal(currentOfficialModel('openrouter', 'deepseek/deepseek-v4-flash'), 'deepseek/deepseek-v4-flash');
	assert.equal(currentOfficialModel('deepseek', 'deepseek-v4-flash', 'https://api.deepseek.com/v1'), 'deepseek-flash');
	assert.equal(currentOfficialModel('deepseek', 'deepseek-v4-flash', 'https://api.deepseek.com.evil.test'), 'deepseek-v4-flash');
	const p = parseProviderProfiles(JSON.stringify({ deepseek: { model: 'deepseek-v4-flash' }, moonshot: { customModel: 'kimi-k2.5' } }));
	assert.equal(p.deepseek!.model, 'deepseek-flash'); assert.equal(p.moonshot!.customModel, 'kimi-k3');
});
test('Kimi generation parameters respect each model contract', () => {
	const k3 = openaiChatExtras(settings('kimi-k3', { maxOutputTokens: 2048 }), 'moonshot');
	assert.equal(k3.max_completion_tokens, 2048); assert.equal(k3.max_tokens, undefined);
	assert.equal(k3.temperature, undefined); assert.equal(k3.reasoning_effort, 'low');
	const k26 = openaiChatExtras(settings('kimi-k2.6'), 'moonshot');
	assert.deepEqual(k26.thinking, { type: 'disabled' }); assert.equal(k26.reasoning_effort, undefined);
	assert.throws(() => openaiChatExtras(settings('kimi-k3', { temperature: 0 }), 'moonshot'));
});
test('always-thinking GLM and Groq use supported effort at the top level', () => {
	for (const model of ['glm-5.3', 'glm-5.3-flash']) {
		const body = openaiChatExtras(settings(model), 'zhipu');
		assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'low');
	}
	assert.equal(openaiChatExtras(settings('openai/gpt-oss-120b', { reasoning: 'xhigh' }), 'groq').reasoning_effort, 'high');
	assert.equal(supportsReasoningControl('groq'), true);
});
test('Claude adaptive thinking replaces rejected manual budgets on current models', () => {
	const sonnet = advancedBody(settings('claude-sonnet-5', { reasoning: 'high' }), 4096);
	assert.deepEqual(sonnet.thinking, { type: 'adaptive' }); assert.deepEqual(sonnet.output_config, { effort: 'high' });
	assert.equal(sonnet.temperature, undefined);
	assert.deepEqual(advancedBody(settings('claude-sonnet-5'), 4096).thinking, { type: 'disabled' });
	assert.deepEqual(advancedBody(settings('claude-fable-5-1', { reasoning: 'disabled' }), 4096).thinking, { type: 'adaptive' });
	assert.throws(() => advancedBody(settings('claude-sonnet-5', { temperature: 0 }), 4096));
	assert.deepEqual(advancedBody(settings('claude-haiku-4-5', { reasoning: 'high' }), 4096).thinking, { type: 'enabled', budget_tokens: 2048 });
});
test('Gemini thinking controls use model-specific minimum and parameter names', () => {
	for (const [model, level] of [['gemini-3.8-flash', 'low'], ['gemini-3.7-flash', 'low'], ['gemini-3.5-flash', 'minimal']] as const)
		assert.deepEqual(geminiGenerationConfig(settings(model, { reasoning: 'disabled' })).thinkingConfig, { thinkingLevel: level });
	assert.deepEqual(geminiGenerationConfig(settings('gemini-2.5-pro', { reasoning: 'disabled' })).thinkingConfig, { thinkingBudget: 128 });
});
test('catalog removes retired Kimi but preserves active DeepSeek Pro', () => {
	assert.ok(!MODEL_CATALOG.moonshot!.models.some(m => m.id === 'kimi-k2.5'));
	assert.ok(MODEL_CATALOG.deepseek!.models.some(m => m.id === 'deepseek-v4-pro' && m.group === 'quality'));
	assert.ok(!MODEL_CATALOG.deepseek!.models.some(m => m.id === 'deepseek-v4-flash'));
});

 test('SiliconFlow GLM-5.3 does not inherit the generic thinking-off flag', () => {
 assert.equal(openaiChatExtras(settings('zai-org/GLM-5.3'),'siliconflow').enable_thinking,undefined);
 });
