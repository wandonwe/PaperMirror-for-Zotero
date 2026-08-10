import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	providerNeedsModel,
	catalogModelsFor,
	recommendedModelFor,
	catalogHasModel,
	catalogProvenance,
	MODEL_CATALOG
} from '../../src/translation/providers/modelCatalog';
import { getProvider } from '../../src/translation/providers/registry';

test('providerNeedsModel: false for fixed MT engines, true for LLMs', () => {
	assert.equal(providerNeedsModel('bing-free'), false);
	assert.equal(providerNeedsModel('google-free'), false);
	assert.equal(providerNeedsModel('deepl'), false);
	assert.equal(providerNeedsModel('openai'), true);
	assert.equal(providerNeedsModel('gemini'), true);
	// providers without a catalog (custom / openai-compatible) still need a model
	assert.equal(providerNeedsModel('custom'), true);
	assert.equal(providerNeedsModel('openai-compatible'), true);
});

test('recommendedModelFor returns the recommended (or first) entry', () => {
	assert.equal(recommendedModelFor('openai'), 'gpt-5-mini');
	assert.equal(recommendedModelFor('deepseek'), 'deepseek-v4-flash');
	assert.equal(recommendedModelFor('gemini'), 'gemini-2.5-flash');
	assert.equal(recommendedModelFor('custom'), ''); // no catalog
});

test('catalogHasModel distinguishes catalog picks from custom ones', () => {
	assert.equal(catalogHasModel('openai', 'gpt-5-mini'), true);
	assert.equal(catalogHasModel('openai', 'my-finetune-123'), false);
	assert.equal(catalogHasModel('openai', ''), false);
});

test('every catalog entry records a checked date and an official source', () => {
	for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
		assert.match(entry.checked, /^\d{4}-\d{2}-\d{2}$/, `${id} checked date`);
		assert.match(entry.source, /^https:\/\//, `${id} source url`);
		assert.ok(entry.models.length > 0, `${id} has models`);
		assert.equal(entry.models.filter(m => m.recommended).length <= 1, true, `${id} has ≤1 recommended`);
	}
});

test('catalogProvenance returns null when there is no catalog', () => {
	assert.equal(catalogProvenance('bing-free'), null);
	assert.ok(catalogProvenance('openai'));
});

// Guard against drift: the recommended catalog model must equal the registry
// default, so an empty profile (uses the default) and the recommended pick
// behave identically.
test('recommended catalog model matches the registry default model', () => {
	for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'qwen', 'zhipu', 'groq']) {
		assert.equal(recommendedModelFor(id), getProvider(id).defaultModel, `${id} default vs recommended`);
	}
});

test('catalogModelsFor returns a copy (mutation-safe)', () => {
	const a = catalogModelsFor('openai');
	a.push({ id: 'x' });
	assert.notEqual(catalogModelsFor('openai').length, a.length);
});
