/**
 * 文档术语记忆 (0.9.27 批次4) — extraction + memory semantics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentMemory, extractTermPairs } from '../../src/translation/docMemory';

test('extracts 「中文术语(ABBR)」 pairs cross-checked against the source', () => {
	const source = 'Contrast-enhanced ultrasound (CEUS) improves detection of hepatic lesions.';
	const translated = '对比增强超声(CEUS)提高了肝脏病灶的检出率。';
	assert.deepEqual(extractTermPairs(source, translated), [{ source: 'CEUS', target: '对比增强超声' }]);
});

test('an abbreviation absent from the source is NOT learned (防幻觉)', () => {
	assert.deepEqual(extractTermPairs('Plain text without the term.', '对比增强超声(CEUS)如何如何。'), []);
});

test('stat abbreviations and single-capital forms are ignored', () => {
	const source = 'The odds ratio (OR) and the P value are reported with 95% CI.';
	assert.deepEqual(extractTermPairs(source, '比值比(OR)与 P 值以95%置信区间(CI)报告。'), []);
});

test('first occurrence wins and rules come back as suggested', () => {
	const memory = new DocumentMemory();
	memory.learn([{ source: 'CEUS', target: '对比增强超声' }]);
	memory.learn([{ source: 'CEUS', target: '超声造影' }]); // later page, different rendering
	const rules = memory.rules();
	assert.equal(rules.length, 1);
	assert.equal(rules[0]!.target, '对比增强超声');
	assert.equal(rules[0]!.mode, 'suggested');
});

test('memory is bounded and clearable', () => {
	const memory = new DocumentMemory();
	for (let i = 0; i < 300; i++) {
		memory.learn([{ source: 'AB' + i, target: '术语' + i }]);
	}
	assert.ok(memory.size() <= 200);
	memory.clear();
	assert.equal(memory.size(), 0);
});
