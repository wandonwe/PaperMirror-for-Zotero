import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExplainPrompt, canExplain, explainText, MAX_EXPLAIN_CHARS } from '../../src/translation/explainer';
import { getProvider, listProviders } from '../../src/translation/providers/registry';
import type { ProviderSettings } from '../../src/types/models';
import { PaperMirrorError } from '../../src/types/models';

const settings: ProviderSettings = {
	providerId: 'deepseek',
	apiBaseURL: '',
	apiKey: 'k',
	model: '',
	timeoutMs: 1000
};

test('buildExplainPrompt includes passage, sections, and context rules', () => {
	const prompt = buildExplainPrompt({
		text: 'The hazard ratio was 1.42.',
		targetLanguage: 'zh-CN',
		documentTitle: 'A Study',
		context: 'Surrounding paragraph text.'
	});
	assert.match(prompt, /整体翻译/);
	assert.match(prompt, /关键术语/);
	assert.match(prompt, /句法结构/);
	assert.match(prompt, /缩写与符号/);
	assert.match(prompt, /The hazard ratio was 1\.42\./);
	assert.match(prompt, /for understanding only/);
	assert.match(prompt, /简体中文/);
});

test('explanation language follows target language', () => {
	assert.match(buildExplainPrompt({ text: 'x', targetLanguage: 'en' }), /in English/);
	assert.match(buildExplainPrompt({ text: 'x', targetLanguage: 'zh-TW' }), /繁體中文/);
});

test('MT engines cannot explain; LLM providers can', () => {
	assert.equal(canExplain(getProvider('bing-free')), false);
	assert.equal(canExplain(getProvider('google-free')), false);
	assert.equal(canExplain(getProvider('deepl')), false);
	assert.equal(canExplain(getProvider('anthropic')), true);
	assert.equal(canExplain(getProvider('deepseek')), true);
	assert.equal(canExplain(getProvider('ollama')), true);
});

test('explainText rejects MT providers and empty input', async () => {
	await assert.rejects(
		explainText(getProvider('bing-free'), settings, { text: 'hello', targetLanguage: 'zh-CN' }),
		(e: unknown) => e instanceof PaperMirrorError && e.message === 'EXPLAIN_UNSUPPORTED'
	);
	await assert.rejects(
		explainText(getProvider('anthropic'), settings, { text: '   ', targetLanguage: 'zh-CN' }),
		PaperMirrorError
	);
});

test('explainText requires an API key for key-based providers', async () => {
	await assert.rejects(
		explainText(getProvider('deepseek'), { ...settings, apiKey: '' }, { text: 'hello', targetLanguage: 'zh-CN' }),
		(e: unknown) => e instanceof PaperMirrorError && e.code === 'NO_API_KEY'
	);
});

test('explainText truncates oversized passages in the prompt', async () => {
	let seenPrompt = '';
	const fake = {
		...getProvider('deepseek'),
		complete: async (prompt: string) => {
			seenPrompt = prompt;
			return 'ok';
		}
	};
	await explainText(fake, settings, { text: 'y'.repeat(MAX_EXPLAIN_CHARS + 500), targetLanguage: 'zh-CN' });
	const passage = seenPrompt.slice(seenPrompt.indexOf('Passage to explain:'));
	assert.ok(passage.length < MAX_EXPLAIN_CHARS + 100);
});

// ---- provider preset roster -------------------------------------------------

test('preset providers are registered with unique ids and sane defaults', () => {
	const providers = listProviders();
	const ids = providers.map(p => p.id);
	assert.equal(new Set(ids).size, ids.length, 'ids unique');
	for (const id of ['deepseek', 'moonshot', 'qwen', 'zhipu', 'gemini', 'openrouter', 'siliconflow', 'groq', 'ollama']) {
		const p = providers.find(x => x.id === id);
		assert.ok(p, `${id} registered`);
		assert.ok(p!.defaultBaseURL.length > 0, `${id} has base URL`);
		assert.ok(p!.defaultModel.length > 0, `${id} has default model`);
	}
	assert.equal(providers.find(p => p.id === 'ollama')!.requiresApiKey, false);
	assert.equal(providers.find(p => p.id === 'deepseek')!.requiresApiKey, true);
});

// ---- chat URL building for presets -----------------------------------------

test('chatURL respects noV1Suffix and version-suffixed bases', async () => {
	const { chatURL } = await import('../../src/translation/providers/openaiCompatible');
	const s = (base: string): ProviderSettings => ({ ...settings, apiBaseURL: base });
	assert.equal(chatURL(s(''), 'https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
	assert.equal(chatURL(s(''), 'https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
	assert.equal(
		chatURL(s(''), 'https://generativelanguage.googleapis.com/v1beta/openai', true),
		'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
	);
	assert.equal(chatURL(s(''), 'https://openrouter.ai/api/v1', true), 'https://openrouter.ai/api/v1/chat/completions');
});

// ---- explanation section parsing -------------------------------------------

test('parseExplanationSections splits labeled output', async () => {
	const { parseExplanationSections } = await import('../../src/translation/explainer');
	const raw = [
		'1. 整体翻译 — 我们发现投影 h 次更有益。',
		'2. 关键术语 — linearly project 指线性变换。',
		'补充一行。',
		'3. 句法结构 — Instead of A, we found it beneficial to B。',
		'4. 缩写与符号 — 无。'
	].join('\n');
	const sections = parseExplanationSections(raw);
	assert.equal(sections.length, 4);
	assert.equal(sections[0]!.label, '整体翻译');
	assert.match(sections[1]!.text, /线性变换[\s\S]*补充一行/);
});

test('parseExplanationSections tolerates markdown-bold labels and colons', async () => {
	const { parseExplanationSections } = await import('../../src/translation/explainer');
	const sections = parseExplanationSections('**整体翻译**: 译文内容\n**关键术语**: 术语内容');
	assert.equal(sections.length, 2);
	assert.equal(sections[0]!.text, '译文内容');
});

test('parseExplanationSections falls back to a single section', async () => {
	const { parseExplanationSections } = await import('../../src/translation/explainer');
	const sections = parseExplanationSections('这是一段没有任何标签的自由讲解文本。');
	assert.equal(sections.length, 1);
	assert.equal(sections[0]!.label, '');
});

// ---- provider display base URL (settings placeholder) -----------------------

test('displayBaseURL exposes the effective endpoint users recognise', () => {
	const providers = listProviders();
	const openai = providers.find(p => p.id === 'openai')!;
	assert.equal(openai.displayBaseURL, 'https://api.openai.com/v1');
	assert.equal(providers.find(p => p.id === 'deepseek')!.displayBaseURL, 'https://api.deepseek.com/v1');
	// Providers whose base already carries a version segment stay unchanged
	assert.equal(providers.find(p => p.id === 'openrouter')!.displayBaseURL, 'https://openrouter.ai/api/v1');
	// Gemini runs on the NATIVE API (Bob-plugin style): the base is the host.
	assert.equal(
		providers.find(p => p.id === 'gemini')!.displayBaseURL,
		'https://generativelanguage.googleapis.com'
	);
	// Non-OpenAI-compatible providers keep their own base
	assert.equal(providers.find(p => p.id === 'bing-free')!.displayBaseURL, undefined);
});
