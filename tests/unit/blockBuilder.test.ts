import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLines, buildParagraphs, textForRange, buildBlocks, buildBlocksFromPlainText } from '../../src/reader/blockBuilder';
import type { PdfChar } from '../../src/types/models';

/** Helper: build a char stream from words with break flags. */
function chars(spec: { text: string; x: number; y: number; size?: number; font?: string; br?: 'line' | 'para' | 'space' }[]): PdfChar[] {
	const out: PdfChar[] = [];
	for (const token of spec) {
		const glyphs = [...token.text];
		glyphs.forEach((g, i) => {
			const last = i === glyphs.length - 1;
			out.push({
				c: g,
				rect: [token.x + i, token.y, token.x + i + 1, token.y + (token.size ?? 10)],
				fontSize: token.size ?? 10,
				fontName: token.font ?? 'Body',
				spaceAfter: last && token.br === 'space',
				lineBreakAfter: last && token.br === 'line',
				paragraphBreakAfter: last && token.br === 'para'
			});
		});
	}
	return out;
}

test('buildLines splits on line/paragraph breaks', () => {
	const cs = chars([
		{ text: 'Hello', x: 0, y: 100, br: 'line' },
		{ text: 'World', x: 0, y: 90, br: 'para' }
	]);
	const lines = buildLines(cs);
	assert.equal(lines.length, 2);
});

test('textForRange de-hyphenates wrapped English words', () => {
	const cs = chars([
		{ text: 'exam-', x: 0, y: 100, br: 'line' },
		{ text: 'ple', x: 0, y: 90, br: 'para' }
	]);
	const text = textForRange(cs, 0, cs.length - 1);
	assert.equal(text, 'example');
});

test('textForRange joins wrapped lines with a space', () => {
	const cs = chars([
		{ text: 'foo', x: 0, y: 100, br: 'line' },
		{ text: 'bar', x: 0, y: 90, br: 'para' }
	]);
	assert.equal(textForRange(cs, 0, cs.length - 1), 'foo bar');
});

test('buildParagraphs merges wrapped lines into one paragraph', () => {
	const cs = chars([
		{ text: 'The', x: 10, y: 100, br: 'line' },
		{ text: 'study', x: 10, y: 88, br: 'para' },
		{ text: 'Next', x: 10, y: 60, br: 'para' }
	]);
	const paras = buildParagraphs(cs, buildLines(cs));
	assert.equal(paras.length, 2);
	assert.match(paras[0]!.text, /The study/);
});

test('buildBlocks marks a References heading and stops emitting entries', () => {
	const cs = chars([
		{ text: 'Body paragraph text that is long enough to be a paragraph here.', x: 10, y: 200, size: 10, br: 'para' },
		{ text: 'References', x: 10, y: 150, size: 10, br: 'para' },
		{ text: '1. Smith J. Some cited work. Journal 2020.', x: 10, y: 120, size: 10, br: 'para' }
	]);
	const result = buildBlocks(cs, { pageIndex: 0, pageWidth: 600, pageHeight: 800, includeReferences: false });
	assert.equal(result.referencesStarted, true);
	// The reference entry must be excluded; the heading may remain
	assert.ok(!result.blocks.some(b => b.sourceText.includes('Smith J')));
});

test('buildBlocks includes references when enabled', () => {
	const cs = chars([
		{ text: 'References', x: 10, y: 150, size: 10, br: 'para' },
		{ text: '1. Smith J. Some cited work. Journal 2020.', x: 10, y: 120, size: 10, br: 'para' }
	]);
	const result = buildBlocks(cs, { pageIndex: 0, pageWidth: 600, pageHeight: 800, includeReferences: true });
	assert.ok(result.blocks.some(b => b.sourceText.includes('Smith J')));
});

test('header/footer bare page numbers are dropped', () => {
	const cs = chars([
		{ text: '42', x: 300, y: 5, size: 9, br: 'para' }, // footer band
		{ text: 'Real body content long enough to survive filtering here.', x: 10, y: 400, size: 10, br: 'para' }
	]);
	const result = buildBlocks(cs, { pageIndex: 3, pageWidth: 600, pageHeight: 800 });
	assert.ok(!result.blocks.some(b => b.sourceText === '42'));
	assert.ok(result.blocks.some(b => b.sourceText.includes('Real body content')));
});

test('two-column interleaved stream is reordered', () => {
	// left col (x≈10) and right col (x≈320) interleaved by the stream
	const cs = chars([
		{ text: 'Left one paragraph with sufficient length to be body text.', x: 10, y: 700, size: 10, br: 'para' },
		{ text: 'Right one paragraph with sufficient length to be body text.', x: 320, y: 700, size: 10, br: 'para' },
		{ text: 'Left two paragraph with sufficient length to be body text.', x: 10, y: 600, size: 10, br: 'para' },
		{ text: 'Right two paragraph with sufficient length to be body text.', x: 320, y: 600, size: 10, br: 'para' }
	]);
	const result = buildBlocks(cs, { pageIndex: 0, pageWidth: 600, pageHeight: 800 });
	const order = result.blocks.map(b => b.sourceText.slice(0, 8));
	const leftOneIdx = order.findIndex(t => t.startsWith('Left one'));
	const leftTwoIdx = order.findIndex(t => t.startsWith('Left two'));
	const rightOneIdx = order.findIndex(t => t.startsWith('Right on'));
	// Both left paragraphs should come before the first right paragraph
	assert.ok(leftOneIdx < rightOneIdx && leftTwoIdx < rightOneIdx);
});

test('plain-text fallback splits paragraphs and honors references', () => {
	const text = 'First paragraph.\n\nSecond paragraph.\n\nReferences\n\n1. A cited work.';
	const result = buildBlocksFromPlainText(text, 0, { includeReferences: false });
	assert.ok(result.blocks.some(b => b.sourceText === 'First paragraph.'));
	assert.ok(!result.blocks.some(b => b.sourceText.includes('cited work')));
});
