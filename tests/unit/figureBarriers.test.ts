import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideObstacle, obstacleBetween } from '../../src/reader/figureBarriers';
import { buildLines, buildParagraphs } from '../../src/reader/blockBuilder';
import { canMerge } from '../../src/reader/regionCoalescer';
import type { PdfChar, SourceBlock } from '../../src/types/models';

// Radiology-page geometry: a figure occupying [54, 500, 340, 700].
const FIG: [number, number, number, number] = [54, 500, 340, 700];

test('insideObstacle: axis labels inside the figure are detected; captions below are not', () => {
	assert.equal(insideObstacle([100, 600, 160, 612], [FIG]), true, 'label inside the plot');
	assert.equal(insideObstacle([54, 470, 340, 490], [FIG]), false, 'caption below the figure');
	assert.equal(insideObstacle([100, 600, 160, 612], []), false, 'no obstacles → nothing inside');
});

test('obstacleBetween: a figure separates text above from the caption of the next block below', () => {
	const above: [number, number, number, number] = [54, 710, 340, 722]; // line above the figure
	const below: [number, number, number, number] = [54, 470, 340, 482]; // caption below it
	assert.equal(obstacleBetween(above, below, [FIG]), true);
	// Side-by-side blocks (different columns) — no vertical figure between.
	assert.equal(obstacleBetween([54, 470, 292, 482], [360, 470, 558, 482], [FIG]), false);
	// Adjacent lines with no room for a figure.
	assert.equal(obstacleBetween([54, 470, 340, 482], [54, 456, 340, 468], [FIG]), false);
});

function chars(spec: { text: string; x: number; y: number; br: 'line' | 'para' }[]): PdfChar[] {
	const out: PdfChar[] = [];
	for (const token of spec) {
		const glyphs = [...token.text];
		glyphs.forEach((g, i) => {
			out.push({
				c: g,
				rect: [token.x + i * 5, token.y, token.x + i * 5 + 5, token.y + 10],
				fontSize: 10,
				fontName: 'Body',
				lineBreakAfter: i === glyphs.length - 1 && token.br === 'line',
				paragraphBreakAfter: i === glyphs.length - 1 && token.br === 'para'
			});
		});
	}
	return out;
}

test('buildParagraphs never merges two lines separated by a figure', () => {
	// Line above the figure ends mid-sentence; caption line sits right below the
	// figure. Without the barrier the small font/spacing signals could merge
	// them; with it the figure forces the break.
	const cs = chars([
		{ text: 'text above the figure that', x: 60, y: 710, br: 'line' },
		{ text: 'Figure 5: caption below it', x: 60, y: 470, br: 'para' }
	]);
	const paras = buildParagraphs(cs, buildLines(cs), 612, 792, [FIG]);
	assert.equal(paras.length, 2, 'the figure is a hard paragraph barrier');
});

test('canMerge refuses to merge regions separated by a figure', () => {
	const mk = (id: string, rects: [number, number, number, number][]): SourceBlock => ({
		id, pageIndex: 0, order: 0, type: 'paragraph',
		sourceText: 'some body text that continues and', lineRectsPdf: rects, fontSize: 10
	});
	const above = mk('a', [[60, 705, 300, 715]]);
	const below = mk('b', [[60, 470, 300, 480]]);
	// Wide vertical gap → the plain distance test already rejects; shrink the
	// figure case to a close pair with the figure inside the gap.
	const nearFig: [number, number, number, number] = [54, 692, 340, 703];
	const aClose = mk('a2', [[60, 705, 300, 715]]);
	const bClose = mk('b2', [[60, 680, 300, 690]]);
	assert.equal(canMerge(aClose, bClose, [nearFig]), false, 'figure between → no merge');
	assert.equal(canMerge(aClose, bClose, []), true, 'same pair merges when no figure');
	void above; void below;
});
