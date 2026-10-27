import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectFormulas, restoreFormulas } from '../../src/reader/formulaGuard';

// From the user's acquisition-protocol table: prose grouping exposed decimal
// values after punctuation to the heuristic equation matcher.
const tableParagraph = 'Three-phase IV injection using iomeprol-400 or iopromide-370: • Phase 1: 0.7 mL/kg undiluted contrast at 5–6 mL/s. • Phase 2: 0.5 mL/kg contrast + 0.5 mL/kg saline at 3–4.5 mL/s. • Phase 3: 50 mL saline. Total for a 70-kg patient: 84 mL (49 mL undiluted + 35 mL mixed phase). ≈33.6 g (0.48 gI/kg) with iomeprol-400; ≈31.08 g (0.44 gI/kg) with iopromide-370. Tube potential: 120 kVp for CCTA; 140 kVp for medium-resolution thoraco-cervical acquisitions and the 5-min delayed phase.';

test('protocol decimal doses stay whole and punctuation stays outside placeholders', () => {
 const { text, placeholders } = protectFormulas(tableParagraph);
 assert.ok(text.includes('≈33.6 g'));
 assert.ok(text.includes('≈31.08 g'));
 assert.ok(!placeholders.some(p => /^[.,;!?。；]/.test(p.original.trim())));
 assert.equal(restoreFormulas(text, placeholders), tableParagraph);
});

test('dose safety is independent of the values and sentence separators', () => {
 for (const value of ['33.6', '31.08', '-12.125', '0.04', '.75', '-.125']) {
  for (const separator of ['. ', '; ', '。', '；']) {
   const source = `A complete measurement${separator}≈${value} g with contrast.`;
   const { text, placeholders } = protectFormulas(source);
   assert.ok(text.includes(`≈${value}`), text);
   assert.equal(restoreFormulas(text, placeholders), source);
  }
 }
});

test('genuine equations retain complete decimal and fractional operands', () => {
 for (const formula of ['x ≈ 33.6', 'y = βx + ε', 'x ≤ -0.25', 'x ≥ .125', 'x ≠ -1/2', 'y = 0.5 × x']) {
  const source = `${formula}.`;
  const { text, placeholders } = protectFormulas(source);
  assert.equal(placeholders.length, 1, formula);
  assert.equal(placeholders[0]!.original, formula);
  assert.equal(text, `${placeholders[0]!.token}.`);
  assert.equal(restoreFormulas(text, placeholders), source);
 }
});

test('grouped and locale decimal values are never split by heuristic tokens', () => {
 for (const formula of ['x≈1,234.5', 'x≈33,6', '1,234.5≈2', '0,75≤1']) {
  const {text, placeholders} = protectFormulas(formula);
  assert.equal(placeholders.length, 0, formula);
  assert.equal(text, formula);
 }
});


test('leading-dot left operands are protected whole without exposing their decimal point', () => {
 for (const formula of ['.75≤1', '.5 ≈ .75', '.125≥.025', '.75 ≤ 1.2']) {
  for (const prefix of ['', 'Measurement. ', 'Measurement; ']) {
   const source = `${prefix}${formula}.`;
   const {text, placeholders} = protectFormulas(source);
   assert.equal(placeholders.length, 1, source);
   assert.equal(placeholders[0]!.original, formula, source);
   assert.equal(text, `${prefix}${placeholders[0]!.token}.`, source);
   assert.equal(restoreFormulas(text, placeholders), source);
  }
 }
});
