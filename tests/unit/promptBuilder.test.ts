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
