import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlossaryLines, serializeGlossaryLines, matchRules, mergeGlossaries, parseGlossaryJSON } from '../../src/translation/glossary';

test('parses "source → target" lines and modes', () => {
	const rules = parseGlossaryLines('radiomics → 影像组学\nfeature -> 特征 ?\n# comment\n\nhazard ratio → 风险比');
	assert.equal(rules.length, 3);
	assert.equal(rules[0]!.source, 'radiomics');
	assert.equal(rules[0]!.target, '影像组学');
	assert.equal(rules[0]!.mode, 'required');
	assert.equal(rules[1]!.mode, 'suggested');
});

test('round-trips through serialize', () => {
	const rules = parseGlossaryLines('overall survival → 总生存期');
	const text = serializeGlossaryLines(rules);
	const again = parseGlossaryLines(text);
	assert.deepEqual(again, rules);
});

test('matchRules returns only rules present in text', () => {
	const rules = parseGlossaryLines('radiomics → 影像组学\nhazard ratio → 风险比');
	const matched = matchRules(rules, ['We extracted radiomics features.']);
	assert.equal(matched.length, 1);
	assert.equal(matched[0]!.source, 'radiomics');
});

test('matchRules is case-insensitive', () => {
	const rules = parseGlossaryLines('Radiomics → 影像组学');
	assert.equal(matchRules(rules, ['RADIOMICS pipeline']).length, 1);
});

test('mergeGlossaries: earlier layer wins', () => {
	const perItem = parseGlossaryLines('feature → 特征(项)');
	const global = parseGlossaryLines('feature → 特征\nmodel → 模型');
	const merged = mergeGlossaries(perItem, global);
	assert.equal(merged.length, 2);
	assert.equal(merged.find(r => r.source === 'feature')!.target, '特征(项)');
});

test('parseGlossaryJSON tolerates malformed input', () => {
	assert.deepEqual(parseGlossaryJSON('not json'), []);
	assert.deepEqual(parseGlossaryJSON('{}'), []);
	const rules = parseGlossaryJSON('[{"source":"a","target":"甲"}]');
	assert.equal(rules[0]!.mode, 'required');
});
