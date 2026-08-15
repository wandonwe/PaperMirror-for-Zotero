/**
 * 字形级公式判定 (1.0.4 批次1) — 对照 pdf2zh vflag / BabelDOC formular_helper
 * 的语义。来源与协议见模块头与 THIRD-PARTY-NOTICES.md。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGlyphFormulaRuns, isFormulaCodepoint, isMathFontName } from '../../src/reader/glyphFormula';
import type { PdfChar } from '../../src/types/models';

function ch(c: string, opts: Partial<PdfChar> = {}): PdfChar {
	return { c, rect: [0, 0, 5, 10], fontSize: 10, fontName: 'ABCDEF+Times-Roman', ...opts };
}

function chars(text: string, opts: Partial<PdfChar> = {}): PdfChar[] {
	return [...text].map(c => ch(c, opts));
}

test('isMathFontName: pdf2zh LaTeX/math font families, subset prefix stripped', () => {
	assert.equal(isMathFontName('ABCDEF+CMMI10'), true);   // CM non-Roman
	assert.equal(isMathFontName('CMR10'), false);          // CM Roman is body text
	assert.equal(isMathFontName('XYATIP10'), true);
	assert.equal(isMathFontName('STIXMath-Regular'), true); // .*Math family
	assert.equal(isMathFontName('TeX-cmex10'), true);
	assert.equal(isMathFontName('DejaVuSansMono'), true);  // .*Mono
	assert.equal(isMathFontName('Times-Italic'), true);    // .*Ital
	assert.equal(isMathFontName('Times-Roman'), false);
	assert.equal(isMathFontName(undefined), false);
});

test('isFormulaCodepoint: Greek, math operators, sub/superscripts, cid', () => {
	assert.equal(isFormulaCodepoint('α'), true);
	assert.equal(isFormulaCodepoint('∑'), true);
	assert.equal(isFormulaCodepoint('²'), true);
	assert.equal(isFormulaCodepoint('→'), true);
	assert.equal(isFormulaCodepoint('(cid:113)'), true);
	assert.equal(isFormulaCodepoint('a'), false);
	assert.equal(isFormulaCodepoint(' '), false);
});

test('a math-font run is detected whole, with single-space bridging', () => {
	const seq: PdfChar[] = [
		...chars('The model '),
		...chars('y', { fontName: 'CMMI10' }),
		ch('='),
		...chars('βx', { fontName: 'CMMI10' }),
		...chars(' predicts outcomes.')
	];
	const runs = detectGlyphFormulaRuns(seq, 10);
	assert.equal(runs.length, 1, JSON.stringify(runs));
	assert.ok(runs[0]!.includes('y') && runs[0]!.includes('βx'), runs[0]);
});

test('subscripts join the formula at <0.79× the base size (角标)', () => {
	const seq: PdfChar[] = [
		...chars('Value of '),
		...chars('H', { fontName: 'CMMI10' }),
		...chars('max', { fontSize: 6.5 }), // 0.65× → 角标
		...chars(' increased with dose today.')
	];
	const runs = detectGlyphFormulaRuns(seq, 10);
	assert.equal(runs.length, 1);
	assert.ok(runs[0]!.includes('Hmax') || runs[0]!.includes('H max'), runs[0]);
});

test('bracket balance keeps the closing paren inside the formula (vbkt)', () => {
	const seq: PdfChar[] = [
		...chars('where '),
		...chars('P(A|B', { fontName: 'CMMI10' }),
		ch(')'),
		...chars(' denotes probability today.')
	];
	const runs = detectGlyphFormulaRuns(seq, 10);
	assert.equal(runs.length, 1);
	assert.ok(runs[0]!.endsWith(')'), runs[0]);
});

test('digit-only pseudo-formulas are dropped (BabelDOC 后处理)', () => {
	const seq: PdfChar[] = [
		...chars('In total '),
		...chars('1,024', { fontSize: 6.5 }), // small digits (e.g. superscripted count)
		...chars(' samples were collected here.')
	];
	assert.deepEqual(detectGlyphFormulaRuns(seq, 10), []);
});

test('plain prose produces no runs', () => {
	assert.deepEqual(detectGlyphFormulaRuns(chars('An ordinary English sentence today.'), 10), []);
});
