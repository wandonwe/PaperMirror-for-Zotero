import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairLegacyStatSymbols } from '../../src/pdfgen/legacyPdfSymbols';

test('repairs signed integers, decimals and scientific notation only when attested in source', () => {
 const source = 'Values: \u000311, \u0003.25, \u0003 1.2e-3.';
 assert.equal(repairLegacyStatSymbols('数值：\u000311、\u0003.25、\u0003 1.2e-3。', source, true),
  '数值：−11、−.25、−1.2e-3。');
 assert.equal(repairLegacyStatSymbols('数值：\u000311.2', source, true), '数值：\u000311.2');
});

test('does not repair arbitrary controls, unmatched values, or already correct characters', () => {
 const text = '系数：\u00030.523；−0.540；\u0002；P ¼ 0.02；¼ 样本';
 assert.equal(repairLegacyStatSymbols(text, 'Unrelated 0.523; P ¼ 0.01.', true), text);
 assert.equal(repairLegacyStatSymbols(text, '\u00030.523; P ¼ 0.02.', false), text);
});

test('repairs source-attested equality at sentence end without changing literal fractions', () => {
 const source = 'P for difference ¼ 0.015. Use ¼ sample.';
 assert.equal(repairLegacyStatSymbols('差异 P ¼ 0.015。使用 ¼ 样本。', source, true),
  '差异 P = 0.015。使用 ¼ 样本。');
 assert.equal(repairLegacyStatSymbols('P ¼ 0.0159', source, true), 'P ¼ 0.0159');
});
