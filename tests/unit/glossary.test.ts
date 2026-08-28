import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capLearnedRules, parseGlossaryLines, serializeGlossaryLines, matchRules, mergeGlossaries, parseGlossaryJSON, dedupeLearnedTerms } from '../../src/translation/glossary';
import type { GlossaryRule } from '../../src/types/models';

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

// ---- 学得术语的注入上限 (2.5.9) --------------------------------------------

test('学得术语超过上限时按本页出现次数保留', () => {
	// docMemory 上限 200 条,而缩写天然反复出现 —— 长文末尾一次请求可能多出
	// 两百行提示词。matchRules 只滤掉"没出现的",没有上限。
	const learned: GlossaryRule[] = Array.from({ length: 10 }, (_, i) => ({
		source: `AB${i}`, target: `术语${i}`, mode: 'suggested' as const
	}));
	// AB0 出现 3 次、AB1 出现 2 次,其余各 1 次。
	const texts = ['AB0 AB0 AB0 AB1 AB1 AB2 AB3 AB4 AB5 AB6 AB7 AB8 AB9'];
	const capped = capLearnedRules(learned, new Set(), texts, 2);
	assert.deepEqual(capped.map(r => r.source), ['AB0', 'AB1'], '出现得多的先留');
});

test('用户词汇表一条都不裁', () => {
	const user: GlossaryRule[] = [
		{ source: 'CCTA', target: '冠状动脉CT血管成像', mode: 'required' },
		// 用户自己也可以把某条设成 suggested —— 判据必须是"来自用户那份",不是 mode
		{ source: 'MACE', target: '主要不良心血管事件', mode: 'suggested' }
	];
	const learned: GlossaryRule[] = Array.from({ length: 6 }, (_, i) => ({
		source: `XY${i}`, target: `学得${i}`, mode: 'suggested' as const
	}));
	const texts = ['CCTA MACE XY0 XY1 XY2 XY3 XY4 XY5'];
	const userSources = new Set(user.map(r => r.source.toLowerCase()));
	const capped = capLearnedRules([...user, ...learned], userSources, texts, 1);
	const sources = capped.map(r => r.source);
	assert.ok(sources.includes('CCTA') && sources.includes('MACE'), '用户的两条都在');
	assert.equal(sources.filter(s => s.startsWith('XY')).length, 1, '学得的裁到 1 条');
});

test('没超上限时原样返回(含顺序)', () => {
	const rules: GlossaryRule[] = [
		{ source: 'AAA', target: '甲', mode: 'suggested' },
		{ source: 'BBB', target: '乙', mode: 'suggested' }
	];
	const out = capLearnedRules(rules, new Set(), ['AAA BBB'], 40);
	assert.deepEqual(out, rules, '常态下这条闸不该改变任何东西');
});
