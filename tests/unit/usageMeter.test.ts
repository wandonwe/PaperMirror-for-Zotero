import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, addUsage, emptyUsage } from '../../src/translation/usageMeter';

test('parseUsage: OpenAI 兼容形状 (含缓存明细)', () => {
	const u = parseUsage({ usage: { prompt_tokens: 1200, completion_tokens: 800, prompt_tokens_details: { cached_tokens: 1024 } } });
	assert.deepEqual(u, { inputTokens: 1200, outputTokens: 800, cachedInputTokens: 1024 });
	// 无明细时缓存计 0。
	assert.deepEqual(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
		{ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
});

test('parseUsage: Anthropic 形状 —— 输入总数含缓存读写', () => {
	const u = parseUsage({ usage: { input_tokens: 300, output_tokens: 900, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } });
	assert.deepEqual(u, { inputTokens: 1350, outputTokens: 900, cachedInputTokens: 1000 });
});

test('parseUsage: Gemini 形状', () => {
	const u = parseUsage({ usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 400, cachedContentTokenCount: 100 } });
	assert.deepEqual(u, { inputTokens: 700, outputTokens: 400, cachedInputTokens: 100 });
});

test('parseUsage: 不认识的形状/坏值 → undefined,不抛', () => {
	assert.equal(parseUsage(null), undefined);
	assert.equal(parseUsage('x'), undefined);
	assert.equal(parseUsage({ choices: [] }), undefined);
	assert.equal(parseUsage({ usage: { prompt_tokens: 'many' } }), undefined);
	assert.equal(parseUsage({ usage: { input_tokens: -1 } }), undefined);
});

test('addUsage 累加,undefined 无副作用', () => {
	const t = emptyUsage();
	addUsage(t, { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 });
	addUsage(t, undefined);
	addUsage(t, { inputTokens: 10, outputTokens: 20, cachedInputTokens: 30 });
	assert.deepEqual(t, { inputTokens: 11, outputTokens: 22, cachedInputTokens: 33 });
});
