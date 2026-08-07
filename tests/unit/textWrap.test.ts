import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutBlock, tokenize, wrapAt, type Measure } from '../../src/pdfgen/textWrap';

/** Fake metrics: CJK glyph = 1em, Latin/digit = 0.5em, space = 0.3em. */
const measure: Measure = (text, size) => {
	let width = 0;
	for (const ch of text) {
		if (/[一-鿿，。；：（）]/u.test(ch)) {
			width += size;
		}
		else if (ch === ' ') {
			width += size * 0.3;
		}
		else {
			width += size * 0.5;
		}
	}
	return width;
};

test('tokenize keeps Latin words atomic and CJK per-character', () => {
	const tokens = tokenize('CCTA 是一线检查 first-line');
	assert.ok(tokens.includes('CCTA'));
	assert.ok(tokens.includes('是') && tokens.includes('一'));
	assert.ok(tokens.some(t => t.startsWith('first')));
});

test('wrapAt never splits a Latin word across lines', () => {
	const lines = wrapAt('the CCTA examination shows atherosclerosis', 10, 80, measure)!;
	for (const line of lines) {
		// every Latin token in every line is intact (appears in the source)
		for (const word of line.split(/\s+/)) {
			assert.ok('the CCTA examination shows atherosclerosis'.includes(word), word);
		}
	}
});

test('wrapAt hard-splits a single over-wide token instead of failing', () => {
	const lines = wrapAt('https://doi.org/10.1016/j.ejrad.2023.111008', 10, 60, measure)!;
	assert.ok(lines.length > 1);
	assert.equal(lines.join(''), 'https://doi.org/10.1016/j.ejrad.2023.111008');
});

test('layoutBlock keeps the source size when the translation fits', () => {
	// Box: 200 wide, 40 tall; 10pt CJK line of 12 chars = 120 wide → fits.
	const result = layoutBlock('这是一个很短的译文段落。', 200, 40, 10, measure);
	assert.equal(result.fontSize, 10, '与原文字号一致');
	assert.equal(result.overflow, false);
});

test('layoutBlock shrinks only when the translation runs longer', () => {
	const long = '这是一个非常长的译文段落，'.repeat(8);
	const result = layoutBlock(long, 200, 40, 10, measure);
	assert.ok(result.fontSize < 10);
	assert.equal(result.overflow, false);
	assert.ok(result.lines.length * result.lineHeight <= 40 + result.fontSize * 0.35);
});

test('layoutBlock clips with an ellipsis at the minimum size', () => {
	const enormous = '内容。'.repeat(400);
	const result = layoutBlock(enormous, 100, 20, 10, measure, { minSize: 6 });
	assert.equal(result.overflow, true);
	assert.equal(result.fontSize, 6);
	assert.ok(result.lines[result.lines.length - 1]!.endsWith('…'));
});

test('layoutBlock tolerates empty text and degenerate boxes', () => {
	assert.deepEqual(layoutBlock('', 100, 50, 10, measure).lines, []);
	assert.deepEqual(layoutBlock('文字', 0, 0, 10, measure).lines, []);
});
