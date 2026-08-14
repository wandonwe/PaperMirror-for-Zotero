/**
 * 残留/质量规则移植测试 (0.9.31) — 对照 retain-pdf english_residue.py/quality.py
 * 的语义:copy-dominance、数据密集豁免、作者名单豁免、截断、混合残留跨度。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	copyDominant,
	hasMixedCopiedResidue,
	isDataDenseSegment,
	isTruncatedTranslation,
	longEnglishResidueSpans,
	looksLikeAuthorNameList,
	surfaceSimilarity,
	normalizedSurface
} from '../../src/translation/residueRules';
import { formulaRiskScore, isFormulaDenseRisk, protectFormulas } from '../../src/reader/formulaGuard';

test('copyDominant: echo is dominant, a real translation is not', () => {
	const source = 'Multidetector CT allows more efficient and flexible use of contrast medium than single-detector CT.';
	assert.equal(copyDominant(source, source), true);
	// Punctuation/casing changes do not hide a copy.
	assert.equal(copyDominant(source, source.toUpperCase().replace(/\./g, '!')), true);
	assert.equal(copyDominant(source, '多排探测器CT比单排探测器CT能更高效灵活地使用对比剂。'), false);
});

test('data-dense segments are exempt (NMR/数值串豁免)', () => {
	assert.equal(isDataDenseSegment('1H NMR (400 MHz, CDCl3) 7.42 (d, J = 8.2 Hz, 2H), 7.21 (t, 1H), 3.85 (s, 3H)'), true);
	assert.equal(isDataDenseSegment('the resulting model outperformed all baselines significantly'), false);
});

test('longEnglishResidueSpans catches Title-Case spans, exempts data-dense ones', () => {
	const mixed = '该方法优于基线。 The Proposed Method Consistently Outperforms Existing Baselines On Every Benchmark Considered Here. 其余部分正常。';
	assert.equal(longEnglishResidueSpans(mixed, 10).length, 1);
	const nmr = '产物表征如下 1H NMR (400 MHz, CDCl3) 7.42 (d, J = 8.2 Hz, 2H), 7.21 (t, 1H), 3.85 (s, 3H) 与文献一致。';
	assert.equal(longEnglishResidueSpans(nmr, 10).length, 0);
});

test('author name lists are recognised (署名行豁免)', () => {
	assert.equal(looksLikeAuthorNameList('John A. Smith, Maria García, Wei Zhang, and Pierre Dubois'), true);
	assert.equal(looksLikeAuthorNameList('The proposed method outperforms all existing baselines'), false);
});

test('truncation: a long source answered with a stub is rejected', () => {
	const source = 'x'.repeat(300);
	assert.equal(isTruncatedTranslation(source, '短译文'), true);
	assert.equal(isTruncatedTranslation(source, '这'.repeat(120)), false);
	assert.equal(isTruncatedTranslation('short source', '短'), false);
});

test('hasMixedCopiedResidue: Chinese-dominant output with a copied English tail', () => {
	const source = 'The contrast enhancement increases proportionally with iodine concentration. For a given voltage the proportionality of contrast enhancement to iodine concentration is near constant across scanners and patients alike.';
	const half = '对比增强随碘浓度成比例增加。 For a given voltage the proportionality of contrast enhancement to iodine concentration is near constant across scanners and patients alike.';
	const full = '对比增强随碘浓度成比例增加。在给定电压下,对比增强与碘浓度的比例关系在不同扫描仪和患者之间近乎恒定。';
	assert.equal(hasMixedCopiedResidue(source, half), true);
	assert.equal(hasMixedCopiedResidue(source, full), false);
});

test('surfaceSimilarity sanity: identical=1, unrelated≈0', () => {
	const a = normalizedSurface('The quick brown fox jumps over the lazy dog');
	assert.equal(surfaceSimilarity(a, a), 1);
	assert.ok(surfaceSimilarity(a, normalizedSurface('completely different words entirely')) < 0.4);
});

test('formulaRiskScore: definition sentence with embedded formulas routes slow', () => {
	const source = 'The attenuation coefficient, denoted as $\\mu(E)$, is defined as $I = I_0 e^{-\\mu d}$ where $I_0$ is the incident intensity and $d$ stands for the material thickness measured along the beam path in this model.';
	const { text, placeholders } = protectFormulas(source);
	assert.ok(placeholders.length >= 4, `expected ≥4 placeholders, got ${placeholders.length}`);
	assert.ok(formulaRiskScore(text, placeholders.length) >= 6);
	assert.equal(isFormulaDenseRisk(text, placeholders.length), true);
	// A short caption with one formula is NOT slow-lane material.
	const simple = protectFormulas('Results for $n=30$ patients.');
	assert.equal(isFormulaDenseRisk(simple.text, simple.placeholders.length), false);
});
