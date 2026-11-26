import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentStyle, buildSampledDocumentStyle, documentStyleSample, furnitureKey, referencesContinueOnto, type StylePage } from '../../src/reader/documentStyle';

// 5.1: documents over 400 pages get a sampled whole-document style. Synthetic pages.

const page = (lines: string[], size = 10): StylePage => ({
	pageWidth: 612,
	pageHeight: 792,
	items: lines.map((text, i) => ({ text, rect: [72, 700 - i * 14, 72 + Math.min(468, text.length * 5), 700 - i * 14 + size] as [number, number, number, number], fontSize: size }))
});
const body = (n: number): StylePage => page(Array.from({ length: 30 }, (_, i) => `Body sentence ${n}.${i} of the chapter text, set at the normal size across the whole column width.`));
const refs = (n: number, heading = false): StylePage => page([
	...(heading ? ['References'] : []),
	...Array.from({ length: 24 }, (_, i) => `${n * 24 + i + 1}. Author${String.fromCharCode(65 + (i % 26))} B, Writer C. A study title number ${i}. J Example. ${1990 + (i % 30)};${10 + i}:${100 + i}-${110 + i}.`)
], 8);

test('5.1: the sample reads every page up to 400, and front, middle stride and a contiguous tail beyond', () => {
	assert.deepEqual(documentStyleSample(12), Array.from({ length: 12 }, (_, i) => i));
	assert.equal(documentStyleSample(400).length, 400);
	const s = documentStyleSample(774);
	assert.ok(s.length <= 400 && s.length >= 390, `size ${s.length}`);
	assert.deepEqual(s.slice(0, 30), Array.from({ length: 30 }, (_, i) => i), 'front matter in full');
	const tail = Math.ceil(774 * 0.15);
	assert.deepEqual(s.slice(-tail), Array.from({ length: tail }, (_, i) => 774 - tail + i), 'last 15 % contiguous');
	assert.ok(s.every((v, i) => i === 0 || v > s[i - 1]!), 'ascending, no duplicates');
});

test('5.1: a 600-page book gets its bibliography range in real page numbers (3200: none before)', () => {
	const pages: StylePage[] = Array.from({ length: 600 }, (_, i) => i >= 560 && i < 585 ? refs(i - 560, i === 560) : body(i));
	const idx = documentStyleSample(pages.length);
	const sampled = buildSampledDocumentStyle(idx, idx.map(i => pages[i]!), pages.length);
	const full = buildDocumentStyle(pages);
	assert.deepEqual(sampled.referenceRanges, full.referenceRanges, 'same range as reading every page');
	assert.deepEqual(sampled.referenceRanges, [[560, 584]]);
	assert.equal(sampled.pageCount, 600);
	assert.equal(sampled.pages.length, 600);
	assert.equal(sampled.bodyFontSize, 10);
	assert.ok(referencesContinueOnto(sampled, 570) && !referencesContinueOnto(sampled, 590));
});

test('5.1: a roman front-matter page number is the same furniture as an arabic one', () => {
	assert.equal(furnitureKey('xvi'), '#');
	assert.equal(furnitureKey('217'), '#');
	assert.equal(furnitureKey('Civil'), 'civil', 'a word made of roman letters with other letters is not a numeral');
	assert.notEqual(furnitureKey('vivid'), '#');
});
