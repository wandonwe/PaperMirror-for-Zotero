import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSymbolCandidate, operatorFromGlyphPath, repairSymbolText, type GlyphPathCommand } from '../../src/reader/symbolFontSemantics';
import { isRunningHeadOrFoot, isSectionHeadingName } from '../../src/reader/metaFilter';
import { groupIntoLines, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { structureSpanPage } from '../../src/reader/pagePipeline';
import geometry from '../fixtures/regression/r24-banded-wordgap-geometry.json';

// All fixtures are synthetic.

type Point = [number, number];
const polygon = (points: Point[]): GlyphPathCommand[] => [
	{ command: 'moveTo', args: [...points[0]!] },
	...points.slice(1).map(p => ({ command: 'lineTo', args: [...p] })),
	{ command: 'closePath', args: [] }
];
const plus: Point[] = [[.4, .1], [.5, .1], [.5, .4], [.8, .4], [.8, .5], [.5, .5], [.5, .8], [.4, .8], [.4, .5], [.1, .5], [.1, .4], [.4, .4]];
const rotate = (ps: Point[]): Point[] => ps.map(([x, y]) => [(x - .45) * Math.SQRT1_2 - (y - .45) * Math.SQRT1_2 + .45, (x - .45) * Math.SQRT1_2 + (y - .45) * Math.SQRT1_2 + .45]);
const less: Point[] = [[.1, .42], [.8, .64], [.8, .58], [.21, .39], [.8, .2], [.8, .14], [.1, .36]];
const greater: Point[] = [[.8, .42], [.1, .64], [.1, .58], [.69, .39], [.1, .2], [.1, .14], [.8, .36]];

test('5.0 r24 (3023): a math font\'s operator glyphs are read from their outlines', () => {
	assert.equal(operatorFromGlyphPath(polygon(less)), '<');
	assert.equal(operatorFromGlyphPath(polygon(greater)), '>');
	assert.equal(operatorFromGlyphPath(polygon([[.1, .4], [.8, .4], [.8, .44], [.1, .44]])), '−');
	assert.equal(operatorFromGlyphPath(polygon(plus)), '+');
	assert.equal(operatorFromGlyphPath(polygon(rotate(plus))), '×');
	// A comma is curved; a digit has curves or several contours; a square is not a cross.
	assert.equal(operatorFromGlyphPath([{ command: 'moveTo', args: [.2, .1] }, { command: 'bezierCurveTo', args: [.3, .0, .3, -.1, .2, -.2] }, { command: 'lineTo', args: [.25, -.2] }, { command: 'bezierCurveTo', args: [.35, -.1, .35, .05, .25, .15] }, { command: 'closePath', args: [] }]), undefined);
	assert.equal(operatorFromGlyphPath(polygon([[.1, .1], [.8, .1], [.8, .8], [.1, .8]])), undefined);
	assert.equal(operatorFromGlyphPath([...polygon(plus), ...polygon([[.1, .9], [.8, .9], [.8, .94], [.1, .94]])]), undefined, 'two contours');
});

test('5.0 r24 (3023): an operator slot run triggers the outline check, and only verified slots change', () => {
	assert.ok(hasSymbolCandidate(','));
	assert.ok(hasSymbolCandidate(' 3 '));
	assert.ok(!hasSymbolCandidate('Results, 2021'));
	const math = new Map([[',', '<'], ['3', '×'], ['1', '+'], ['2', '−']]);
	assert.equal(repairSymbolText(',', math), '<');
	assert.equal(repairSymbolText('3', math), '×');
	assert.equal(repairSymbolText('P , .001', new Map()), 'P , .001', 'no verified map, no change');
});

test('5.0 r24 (3023 p2): a caption at the page foot is not a running foot', () => {
	assert.ok(!isRunningHeadOrFoot([50, 40, 290, 58], 792, 2, 'Figure 1: Study inclusion and exclusion flowchart. EID = energy-integrating detector.'));
	assert.ok(!isRunningHeadOrFoot([50, 40, 290, 50], 792, 1, 'Table 2. Image Review Phases'));
	assert.ok(isRunningHeadOrFoot([50, 40, 290, 50], 792, 1, 'Radiology: Volume 305: Number 2—November 2022'));
});

test('5.0 r24 (2775 / 3132 / 2638): a section heading at the column head is not a running head', () => {
	for (const t of ['Introduction', 'INTRODUCTION', '1. Introduction', 'Materials and Methods', 'Discussion']) assert.ok(isSectionHeadingName(t), t);
	for (const t of ['INTRODUCTION AND PREVIEW', 'S. AHN ET AL.', 'Introduction to the methods']) assert.ok(!isSectionHeadingName(t), t);
	const items: SpanItem[] = [
		{ text: '1142 September-October 2005', rect: [50, 760, 160, 768], fontSize: 8 },
		{ text: 'Introduction', rect: [50, 735, 130, 747], fontSize: 12 }
	];
	for (let k = 0; k < 20; k++) items.push({ text: `Body line ${k} of the introduction about arterial occlusive disease and measures.`, rect: [50, 715 - k * 12, 290, 724 - k * 12], fontSize: 10 });
	const blocks = structureSpanPage({ items, pageWidth: 612, pageHeight: 792 }, { pageIndex: 1, includeReferences: true, referencesAlreadyStarted: false, bodyFontSize: 10 }).blocks;
	const heading = blocks.find(b => b.sourceText === 'Introduction');
	assert.ok(heading && heading.translationMode !== 'preserve');
});

test('5.0 r24 (2795 p2, masked geometry): a justified body line in the left column is not cut at a phantom channel', () => {
	const lines = groupIntoLines(geometry.items as SpanItem[], geometry.pageWidth, geometry.pageHeight, false, [296, 336]);
	// The body line at y 553 runs 58 → 285 with a 7pt word gap at x 200.
	const row = lines.filter(l => Math.abs(l.rect[1] - 553) < 2 && l.rect[0] < 290);
	assert.equal(row.length, 1);
	assert.ok(row[0]!.rect[0] < 60 && row[0]!.rect[2] > 280);
});

test('5.0 r24 (2795 p4, masked geometry): a two-column body under a full-width table is read column by column', async () => {
	const { default: page } = await import('../fixtures/regression/r24-table-over-columns-geometry.json');
	const blocks = structureSpanPage({ items: page.items as SpanItem[], pageWidth: page.pageWidth, pageHeight: page.pageHeight },
		{ pageIndex: 3, includeReferences: true, referencesAlreadyStarted: false, bodyFontSize: 9, knownGutters: [296, 336] }).blocks;
	// Below the table (top < 300pt from the bottom) the body forms paragraphs, not one block per line.
	const body = blocks.filter(b => b.boundingBox && page.pageHeight - b.boundingBox.y < 300 && b.translationMode !== 'preserve');
	assert.ok(body.length <= 6, `body blocks: ${body.length}`);
	assert.ok(body.some(b => b.sourceText.length > 600));
});
