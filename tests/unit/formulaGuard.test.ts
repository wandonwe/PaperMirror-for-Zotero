import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectFormulas, restoreFormulas, placeholdersIntact, isFormulaRun } from '../../src/reader/formulaGuard';

test('isFormulaRun detects symbol-dense math', () => {
	assert.equal(isFormulaRun('y = βx + ε'), true);
	assert.equal(isFormulaRun('∑_{i=1}^{n} x_i'), true);
	assert.equal(isFormulaRun('This is an ordinary English sentence.'), false);
});

test('protect + restore round-trips a LaTeX span', () => {
	const input = 'We model $E = mc^2$ in the paper.';
	const { text, placeholders } = protectFormulas(input);
	assert.equal(placeholders.length, 1);
	assert.ok(!text.includes('mc^2'));
	const translated = text.replace('We model', '我们建模').replace('in the paper', '于论文中');
	const restored = restoreFormulas(translated, placeholders);
	assert.ok(restored.includes('$E = mc^2$'));
});

test('placeholdersIntact detects a dropped token', () => {
	const { placeholders } = protectFormulas('value $x = 1$ here');
	assert.equal(placeholdersIntact('translated without token', placeholders), false);
	assert.equal(placeholdersIntact(`translated ${placeholders[0]!.token}`, placeholders), true);
});

test('ordinary prose is untouched', () => {
	const input = 'The overall survival was 24 months (95% CI: 18-30).';
	const { text, placeholders } = protectFormulas(input);
	// CI notation may or may not be captured; text must still restore identically
	assert.equal(restoreFormulas(text, placeholders), input);
});

// ---------------------------------------------------------------------------
// 0.9.24 批次1: 引用标记/统计量保护 + 清单校验 + 散文视图 (参照 retain-pdf)
// ---------------------------------------------------------------------------

import { stripProtectable, verifyPlaceholders } from '../../src/reader/formulaGuard';

test('citations and statistics are masked and round-trip byte-identical', () => {
	const input = 'The odds ratio was 0.82 (95% CI: 0.71–0.94, p = 0.003) with n = 342 across sites [12,15-18], mean 34.2 ± 5.1.';
	const { text, placeholders } = protectFormulas(input);
	assert.ok(placeholders.length >= 4, `expected ≥4 placeholders, got ${placeholders.length}`);
	assert.ok(!text.includes('p = 0.003'));
	assert.ok(!text.includes('[12,15-18]'));
	assert.ok(!text.includes('±'));
	assert.equal(restoreFormulas(text, placeholders), input);
});

test('stripProtectable leaves prose only — stats do not count as Latin words', () => {
	const stripped = stripProtectable('比值比为 0.82(95% CI: 0.71–0.94,p = 0.003),n = 342 [12]。');
	assert.ok(!/CI/.test(stripped));
	assert.ok(!/342/.test(stripped));
});

test('verifyPlaceholders flags lost and invented tokens, accepts bare form', () => {
	const { text, placeholders } = protectFormulas('We test $x=1$ and $y=2$ here.');
	assert.equal(placeholders.length, 2);
	const t0 = placeholders[0]!.token;
	// all present → ok
	assert.equal(verifyPlaceholders(`译文 ${t0} 与 ${placeholders[1]!.token}`, placeholders).ok, true);
	// one lost → missing
	const lost = verifyPlaceholders(`译文只有 ${t0}`, placeholders);
	assert.equal(lost.ok, false);
	assert.equal(lost.missing.length, 1);
	// bare "PMn" form counts as present
	const bare = placeholders[1]!.token.replace('⟦', '').replace('⟧', '');
	assert.equal(verifyPlaceholders(`译文 ${t0} 与 ${bare}`, placeholders).ok, true);
	// invented token → unexpected
	const invented = verifyPlaceholders(`译文 ${t0} ${placeholders[1]!.token} ⟦PM7⟧`, placeholders);
	assert.equal(invented.ok, false);
	assert.deepEqual(invented.unexpected, ['⟦PM7⟧']);
	void text;
});

test('user do-not-translate literals are masked via extraLiterals', () => {
	const { text, placeholders } = protectFormulas(
		'The RetainNet model outperforms baselines.', ['RetainNet']
	);
	assert.ok(!text.includes('RetainNet'));
	const restored = restoreFormulas(text.replace('The', '该').replace('model outperforms baselines.', '模型优于基线。'), placeholders);
	assert.ok(restored.includes('RetainNet'));
});
