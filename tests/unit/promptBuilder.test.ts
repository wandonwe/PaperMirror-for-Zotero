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

// ---- 2.3.5 (第四批 item7 · API-4): 按请求内容条件化规则行 -------------------

test('无占位符/样式/上下文的请求不携带对应规则行 (API-4 省 token)', async () => {
	const { buildSystemPrompt } = await import('../../src/translation/promptBuilder');
	const bare = {
		sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 'T',
		previousContext: '', blocks: [{ id: 'a', type: 'paragraph', text: 'plain body text' }]
	};
	const sys = buildSystemPrompt(bare as never);
	assert.ok(!sys.includes('⟦PM0⟧'), '无占位符 → 不带占位符规则');
	assert.ok(!sys.includes('⟦b⟧'), '无样式标记 → 不带样式规则');
	assert.ok(!sys.includes('previousContext'), '无上下文 → 不带上下文规则');
	assert.ok(sys.includes('exact shape'), 'JSON 输出契约恒在');
});

test('携带占位符/样式/上下文时对应规则一字不少 (行为不变,无需 bump 版本)', async () => {
	const { buildSystemPrompt } = await import('../../src/translation/promptBuilder');
	const loaded = {
		sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 'T',
		previousContext: 'previous tail…',
		blocks: [{ id: 'a', type: 'paragraph', text: 'x ⟦PM0⟧ and ⟦b⟧bold⟦/b⟧' }]
	};
	const sys = buildSystemPrompt(loaded as never);
	assert.ok(sys.includes('⟦PM0⟧ are protected placeholders'));
	assert.ok(sys.includes('mark bold/italic spans'));
	assert.ok(sys.includes('previousContext and moduleContext'));
	// plain 兜底同样条件化。
	const plainBare = { ...loaded, previousContext: '', plain: true, blocks: [{ id: 'a', type: 'paragraph', text: 'no tokens here' }] };
	const plainSys = buildSystemPrompt(plainBare as never);
	assert.ok(!plainSys.includes('⟦PM0⟧'));
});

test('人名保护规则进系统提示 (2.5.13)', async () => {
	const { buildSystemPrompt } = await import('../../src/translation/promptBuilder');
	const system = buildSystemPrompt({
		pageIndex: 0, sourceLanguage: 'en', targetLanguage: 'zh-CN',
		documentTitle: 't', previousContext: '',
		blocks: [{ id: 'b1', type: 'paragraph', text: 'The authors acknowledge Dr. Joo Myung Lee.' }],
		glossary: []
	} as never);
	assert.ok(/person names/i.test(system) && /transliterate/i.test(system),
		'system prompt must forbid transliterating person names');
});
