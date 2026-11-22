import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentStyle, referencesContinueOnto, type StylePage } from '../../src/reader/documentStyle';

/** A page whose lines are the given strings, one item per line, top to bottom. */
function page(lines: string[], size = 10): StylePage {
	return {
		pageWidth: 612,
		pageHeight: 792,
		items: lines.map((text, i) => ({ text, rect: [72, 740 - i * 13, 72 + text.length * size * 0.45, 740 - i * 13 + size] as [number, number, number, number], fontSize: size }))
	};
}
const prose = (n: number) => Array.from({ length: n }, (_, i) => `This is body sentence number ${i} of the study and it continues across the column.`);
const numbered = (from: number, n: number) => Array.from({ length: n }, (_, i) => [
	`${from + i}. Smith J, Brown K, Lee M. A study of imaging protocols in patients with disease`,
	`number ${from + i}. J Radiol. ${2010 + (i % 10)};${20 + i}:${100 + i}-${110 + i}.`
]).flat();

test('5.0 全篇样式: references are found once, independent of which page is opened first', () => {
	const pages = [page(prose(40)), page(prose(40)), page(['References', ...numbered(1, 12)], 8), page(numbered(13, 14), 8)];
	const style = buildDocumentStyle(pages);
	assert.deepEqual(style.referenceRanges, [[2, 3]]);
	assert.equal(referencesContinueOnto(style, 3), true, 'the continuation page knows without the heading page having been extracted');
	assert.equal(referencesContinueOnto(style, 2), false, 'the heading page finds its own heading');
	assert.equal(style.bodyFontSize, 10, 'reference pages (8pt, many characters) do not decide the body size');
});

test('5.0 全篇样式: pages after the references (tables, figure legends) are not references', () => {
	const legends = page(['Figure 1. Phantom images reconstructed at three dose levels.', 'Figure 2. Noise as a function of dose for both detectors.']);
	const style = buildDocumentStyle([page(prose(40)), page(['References', ...numbered(1, 12)]), page(numbered(13, 12)), legends, page(['Table 1. Patient characteristics', 'Age 63 ± 9 years', 'Male 21 (72%)'])]);
	assert.deepEqual(style.referenceRanges, [[1, 2]]);
	assert.equal(referencesContinueOnto(style, 3), false);
	assert.equal(referencesContinueOnto(style, 4), false);
});

test('5.0 全篇样式: a compound PDF (article + supplement) has two reference sections', () => {
	const style = buildDocumentStyle([
		page(prose(40)), page(['References', ...numbered(1, 12)]), page(['Supplementary material', ...prose(30)]),
		page(prose(40)), page(['References', ...numbered(1, 10)]), page(numbered(11, 3))
	]);
	assert.deepEqual(style.referenceRanges, [[1, 1], [4, 5]]);
	assert.equal(referencesContinueOnto(style, 2), false);
	assert.equal(referencesContinueOnto(style, 3), false);
	assert.equal(referencesContinueOnto(style, 5), true);
});

test('5.0 全篇样式: a lone "References" line with no entries (front-matter box) does not start references', () => {
	const style = buildDocumentStyle([page(['Citation format', 'References', ...prose(30)]), page(prose(40)), page(prose(40))]);
	assert.deepEqual(style.referenceRanges, []);
	assert.equal(referencesContinueOnto(style, 1), false);
});

test('5.0 全篇样式: unnumbered Vancouver entries under "References:" and a tail-only last page', () => {
	const unnumbered = (n: number) => Array.from({ length: n }, (_, i) => [
		`Feigin${'abcdefgh'[i % 8]} VL, Brainin M, Norrving B, et al. Global stroke fact sheet ${i}.`,
		`Int J Stroke ${2015 + (i % 8)}; ${17 + i}:18-29`
	]).flat();
	const tailPage = page(['14 of 14', '559–564. Available from: https://doi.org/10.1302/0301-620X.', '101B5.BJJ-2018-1355.R1',
		'34. Tibrewal S, Grant K, Goodfellow J. The radiolucent line beneath the tibial components (1984).',
		'How to cite this article: Bistolfi A, et al. (2024) Vitamin E-stabilized polyethylene.']);
	const style = buildDocumentStyle([page(prose(40)), page(['References:', ...unnumbered(10)]), page(unnumbered(12)), tailPage]);
	assert.deepEqual(style.referenceRanges, [[1, 3]]);
});
