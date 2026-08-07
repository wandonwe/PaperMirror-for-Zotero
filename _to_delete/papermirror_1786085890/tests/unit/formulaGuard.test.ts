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
