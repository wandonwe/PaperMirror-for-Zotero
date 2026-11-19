import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentOfficialModel } from '../../src/translation/providers/modelMigrations';
import { openaiChatExtras } from '../../src/translation/providers/advancedParams';
import { advancedBody } from '../../src/translation/providers/anthropic';
import { geminiGenerationConfig } from '../../src/translation/providers/geminiNative';
import { MODEL_CATALOG } from '../../src/translation/providers/modelCatalog';
import { getProvider } from '../../src/translation/providers/registry';
import type { ProviderSettings } from '../../src/types/models';

/** 5.0: 各引擎按 2026-11-19 官方文档更新 (docs/LLM-PROVIDERS-2026-11-19.md)。 */
const settings = (model: string, more: Partial<ProviderSettings> = {}): ProviderSettings => ({ providerId: 'x', model, apiBaseURL: '', apiKey: '', timeoutMs: 1000, ...more });

test('Claude Haiku 5.5 用 adaptive/disabled,绝不发 budget_tokens 或 temperature', () => {
	const off = advancedBody(settings('claude-haiku-5-5'), 4096);
	assert.deepEqual(off.thinking, { type: 'disabled' });
	assert.equal(off.temperature, undefined);
	const on = advancedBody(settings('claude-haiku-5-5', { reasoning: 'high' }), 4096);
	assert.deepEqual(on.thinking, { type: 'adaptive' });
	assert.deepEqual(on.output_config, { effort: 'high' });
	assert.throws(() => advancedBody(settings('claude-haiku-5-5', { temperature: 0 }), 4096));
});

test('Claude Sonnet 5.5 拒收 disabled → between_tools + effort low', () => {
	for (const model of ['claude-sonnet-5-5', 'claude-sonnet-5-5-20260928']) {
		const body = advancedBody(settings(model, { reasoning: 'disabled' }), 4096);
		assert.deepEqual(body.thinking, { type: 'between_tools' }, model);
		assert.deepEqual(body.output_config, { effort: 'low' });
	}
	// Sonnet 5 (日期快照)仍接受 disabled,不得误判为 5.5
	assert.deepEqual(advancedBody(settings('claude-sonnet-5-20260630'), 4096).thinking, { type: 'disabled' });
});

test('Opus 5.5 / Fable 5.2 关不掉思考 → adaptive + effort low;Opus 5 仍可 disabled', () => {
	for (const model of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-mythos-5-2']) {
		const body = advancedBody(settings(model), 4096);
		assert.deepEqual(body.thinking, { type: 'adaptive' }, model);
		assert.deepEqual(body.output_config, { effort: 'low' }, model);
	}
	assert.deepEqual(advancedBody(settings('claude-opus-5'), 4096).thinking, { type: 'disabled' });
	assert.deepEqual(advancedBody(settings('claude-opus-5-5', { reasoning: 'xhigh' }), 4096).output_config, { effort: 'xhigh' });
	// 旧模型照旧: Haiku 4.5 走预算思考,Sonnet 4.6 默认温度 0
	assert.equal(advancedBody(settings('claude-sonnet-4-6'), 4096).temperature, 0);
});

test('Gemini 4 Argon 用 thinkingLevel 且最低 low,绝不发 thinkingBudget', () => {
	assert.deepEqual(geminiGenerationConfig(settings('gemini-4-argon', { reasoning: 'disabled' })).thinkingConfig, { thinkingLevel: 'low' });
	assert.deepEqual(geminiGenerationConfig(settings('gemini-4-argon', { reasoning: 'xhigh' })).thinkingConfig, { thinkingLevel: 'high' });
	assert.deepEqual(geminiGenerationConfig(settings('gemini-3.6-flash', { reasoning: 'disabled' })).thinkingConfig, { thinkingLevel: 'minimal' });
	assert.deepEqual(geminiGenerationConfig(settings('gemini-3.5-flash-lite', { reasoning: 'minimal' })).thinkingConfig, { thinkingLevel: 'minimal' });
	assert.deepEqual(geminiGenerationConfig(settings('gemini-2.5-flash', { reasoning: 'disabled' })).thinkingConfig, { thinkingBudget: 0 });
});

test('GPT-6 没有 minimal: Luna/Terra → none,Astra/Sol → low(含 OpenRouter 别名)', () => {
	assert.equal(openaiChatExtras(settings('gpt-6-luna', { reasoning: 'minimal' }), 'openai').reasoning_effort, 'none');
	assert.equal(openaiChatExtras(settings('gpt-6.1-terra', { reasoning: 'minimal' }), 'openai').reasoning_effort, 'none');
	assert.equal(openaiChatExtras(settings('gpt-6.2-sol', { reasoning: 'minimal' }), 'openai').reasoning_effort, 'low');
	assert.equal(openaiChatExtras(settings('openai/gpt-6.2-astra', { reasoning: 'minimal' }), 'openrouter').reasoning_effort, 'low');
	assert.equal(openaiChatExtras(settings('gpt-6.2-sol', { reasoning: 'high' }), 'openai').reasoning_effort, 'high');
	assert.equal(openaiChatExtras(settings('gpt-5.4-mini', { reasoning: 'minimal' }), 'openai').reasoning_effort, 'minimal');
	assert.equal(openaiChatExtras(settings('gpt-6-luna'), 'openai').reasoning_effort, undefined, '未设置不发');
});

test('Kimi K3.1 Pro 与 K3 同一契约: 温度不发、effort low、max_completion_tokens', () => {
	for (const model of ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']) {
		const body = openaiChatExtras(settings(model, { maxOutputTokens: 4096 }), 'moonshot');
		assert.equal(body.temperature, undefined, model);
		assert.equal(body.reasoning_effort, 'low', model);
		assert.equal(body.max_completion_tokens, 4096, model);
		assert.equal(body.max_tokens, undefined, model);
	}
});

test('已停用/自动路由的官方型号立即迁移;已公告但未到期的不提前改', () => {
	assert.equal(currentOfficialModel('gemini', 'gemini-3.7-flash'), 'gemini-3.8-flash');
	assert.equal(currentOfficialModel('gemini', 'gemini-3.5-flash'), 'gemini-3.6-flash');
	assert.equal(currentOfficialModel('openai', 'gpt-4.1-nano'), 'gpt-6-luna');
	assert.equal(currentOfficialModel('moonshot', 'kimi-latest'), 'kimi-k3');
	assert.equal(currentOfficialModel('anthropic', 'claude-sonnet-4-20250514'), 'claude-sonnet-5-5');
	const before = new Date('2026-11-19T12:00:00Z');
	const after = new Date('2026-12-11T00:00:00Z');
	assert.equal(currentOfficialModel('openai', 'gpt-5-mini', '', '', before), 'gpt-5-mini');
	assert.equal(currentOfficialModel('openai', 'gpt-5-mini', '', '', after), 'gpt-6.1-terra');
	assert.equal(currentOfficialModel('anthropic', 'claude-sonnet-4-5', '', '', before), 'claude-sonnet-4-5');
	assert.equal(currentOfficialModel('anthropic', 'claude-sonnet-4-5', '', '', new Date('2026-11-30T00:00:00Z')), 'claude-sonnet-5-5');
	// 代理/网关永不改写
	assert.equal(currentOfficialModel('openai', 'gpt-5-mini', 'https://proxy.example/v1', '', after), 'gpt-5-mini');
	assert.equal(currentOfficialModel('openrouter', 'openai/gpt-5-mini', '', '', after), 'openai/gpt-5-mini');
});

test('5.0 默认型号与目录一致,且目录不再推荐已公告停用的型号', () => {
	assert.equal(getProvider('openai').defaultModel, 'gpt-6-luna');
	assert.equal(getProvider('anthropic').defaultModel, 'claude-sonnet-5-5');
	assert.equal(getProvider('gemini').defaultModel, 'gemini-3.8-flash');
	const retiring = ['gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'claude-sonnet-4-5', 'gemini-3.7-flash', 'gemini-3.5-flash'];
	for (const entry of Object.values(MODEL_CATALOG)) {
		for (const m of entry.models) {
			assert.ok(!retiring.includes(m.id), `catalog still lists retiring ${m.id}`);
		}
		assert.equal(entry.checked, '2026-11-19');
	}
	assert.ok(MODEL_CATALOG.siliconflow!.models.every(m => !m.id.startsWith('THUDM/GLM-4.5')), 'SiliconFlow 用 zai-org/GLM-4.5-Air');
});
