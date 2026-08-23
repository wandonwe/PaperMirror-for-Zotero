import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlossaryLines, serializeGlossaryLines, matchRules, mergeGlossaries, parseGlossaryJSON, dedupeLearnedTerms } from '../../src/translation/glossary';

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

// ---- 2.3.1 (第四批 item3 · WF-8): 学得术语「预览并保存到词汇表」的去重 --------

test('dedupeLearnedTerms drops terms already in the glossary (case-insensitive)', () => {
	const existing = parseGlossaryLines('Transformer → 变换器\nattention → 注意力');
	const fresh = dedupeLearnedTerms(existing, [
		{ source: 'transformer', target: '变换器' },   // 已有(大小写不同)→ 去掉
		{ source: 'Attention', target: '注意力机制' }, // 已有 → 去掉(即使译文不同)
		{ source: 'embedding', target: '嵌入' }        // 新 → 保留
	]);
	assert.deepEqual(fresh, [{ source: 'embedding', target: '嵌入' }]);
});

test('dedupeLearnedTerms self-dedupes and drops dirty entries', () => {
	const fresh = dedupeLearnedTerms([], [
		{ source: 'token', target: '词元' },
		{ source: 'Token', target: '标记' },  // 自身重复(大小写)→ 取首个
		{ source: '  ', target: '空' },       // 脏 source → 丢
		{ source: 'logit', target: '' }       // 脏 target → 丢
	]);
	assert.deepEqual(fresh, [{ source: 'token', target: '词元' }]);
});
