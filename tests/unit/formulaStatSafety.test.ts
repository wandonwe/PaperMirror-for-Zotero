import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protectFormulas, restoreFormulas} from '../../src/reader/formulaGuard';

function assertWhole(statistic: string, prefix = 'Result: ', suffix = '. Next sentence.') {
 const source = prefix + statistic + suffix;
 const {text, placeholders} = protectFormulas(source);
 assert.equal(placeholders.length, 1, source);
 assert.equal(placeholders[0]!.original, statistic, source);
 assert.equal(text, prefix + placeholders[0]!.token + suffix, source);
 assert.equal(restoreFormulas(text, placeholders), source);
}

test('mean/deviation statistics keep signed and leading-decimal values in the same token', () => {
 for (const statistic of ['−3.2 ± 1.4', '-3.2 ± 1.4', '+3.2 ± 1.4', '- 3.2 ± 1.4', '.75 ± 1.25',
  '−.125±.025', '2.73 ± .04', '3.2 ± −1.4', '1,234.5 ± 67.8']) assertWhole(statistic);
});

test('p-values keep the complete scientific notation and sentence punctuation', () => {
 for (const statistic of ['p = 1.2e-5', 'P < 2.73E−8', 'p = 1.2×10−5', 'p = 1.2 × 10^-5',
  'P ≤ .75', 'p = 2.73e+2', 'P=.005', 'p = 1.2 × 10⁻⁵', 'p = 1.2 · 10⁻⁵', 'p = 1.2*10^-5']) assertWhole(statistic);
});

test('confidence intervals own complete signed/exponent endpoints and leave punctuation outside', () => {
 for (const statistic of ['95% CI: 0.71–0.94', '95% CI: −0.71–−0.14', '99.5% CI -.12 to .35',
  '95% CI: 1.2e-5–2.3e-5', '95% CI: 1.2×10−5–2.3×10−5']) {
  for (const suffix of ['.', ', next result.', '。下一句。', ')']) assertWhole(statistic, 'Result: ', suffix);
 }
});

test('sample sizes leave following prose commas and periods outside the token', () => {
 for (const statistic of ['n = 342', 'N=1,234', 'n=42']) assertWhole(statistic, 'Participants (', '), next group.');
 assertWhole('n=342', 'Participants: ', ', followed over time.');
});

test('ambiguous locale or unsupported exponent notation stays inline rather than partly protected', () => {
 for (const source of ['p = 0,05', '1,2 ± 0,5', 'n=34.5', '95% CI: 0,71–0,94']) {
  const {text, placeholders} = protectFormulas(source);
  assert.equal(text, source, source);
  assert.equal(placeholders.length, 0, source);
 }
});

test('citation ownership and ordinary prose remain unchanged', () => {
 const source = 'Results [1,3–5] and (2–4) agreed; 5 [4, 5] vs. 3 [3, 4] are data.';
 const {text, placeholders} = protectFormulas(source);
 assert.deepEqual(placeholders.map(p => p.original), ['[1,3–5]', '(2–4)']);
 assert.ok(text.includes('5 [4, 5] vs. 3 [3, 4]'));
 assert.equal(restoreFormulas(text, placeholders), source);
 assert.equal(protectFormulas('This is ordinary prose.').text, 'This is ordinary prose.');
});


test('fallback heuristic math can protect unsupported exponent syntax only as a complete expression', () => {
 const source = 'p = 1.2 ×10^{-5}';
 const {text, placeholders} = protectFormulas(source);
 assert.equal(placeholders.length, 1);
 assert.equal(placeholders[0]!.original, source);
 assert.equal(text, placeholders[0]!.token);
 assert.equal(restoreFormulas(text, placeholders), source);
});
