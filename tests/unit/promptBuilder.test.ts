import { test } from 'node:test';
import assert from 'node:assert/strict';

test('charBudget blocks add layout-budget rules; absent budgets add none', async () => {
	const { buildSystemPrompt, PROMPT_VERSION } = await import('../../src/translation/promptBuilder');
	assert.equal(PROMPT_VERSION, 2, 'prompt version bumped to invalidate long-form caches');
	const base = {
		sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 'T',
		previousContext: '', blocks: [{ id: 'a', type: 'paragraph', text: 'x' }]
	};
	assert.ok(!buildSystemPrompt(base as never).includes('Layout budgets'));
	const budgeted = { ...base, blocks: [{ id: 'a', type: 'paragraph', text: 'x', charBudget: 120 }] };
	const prompt = buildSystemPrompt(budgeted as never);
	assert.ok(prompt.includes('Layout budgets'));
	assert.ok(prompt.includes('never by dropping facts'));
});

test('plain mode prompt asks for bare text and payload is the block text', async () => {
	const { buildSystemPrompt, buildUserPayload } = await import('../../src/translation/promptBuilder');
	const request = {
		sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 'T',
		previousContext: '', plain: true,
		blocks: [{ id: 'x', type: 'paragraph', text: 'Hello world' }]
	} as unknown as import('../../src/types/models').TranslationRequest;
	const sys = buildSystemPrompt(request);
	assert.ok(/ONLY the translation/i.test(sys));
	assert.ok(!/JSON object of this exact shape/.test(sys));
	assert.equal(buildUserPayload(request), 'Hello world');
});
