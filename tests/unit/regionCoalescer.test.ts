import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMerge, coalesceRegions, separatorBetween } from '../../src/reader/regionCoalescer';
import type { SourceBlock } from '../../src/types/models';

/** A body block occupying one or more stacked lines in a column. */
function block(
	id: string,
	text: string,
	options: {
		left?: number;
		width?: number;
		topY?: number;
		lines?: number;
		fontSize?: number;
		type?: SourceBlock['type'];
		isReference?: boolean;
	} = {}
): SourceBlock {
	const left = options.left ?? 54;
	const width = options.width ?? 240;
	const topY = options.topY ?? 700;
	const lines = options.lines ?? 1;
	const size = options.fontSize ?? 10;
	const lineRects: [number, number, number, number][] = [];
	for (let i = 0; i < lines; i++) {
		const y2 = topY - i * (size * 1.3);
		lineRects.push([left, y2 - size, left + width, y2]);
	}
	return {
		id,
		pageIndex: 0,
		order: 0,
		type: options.type ?? 'paragraph',
		sourceText: text,
		lineRectsPdf: lineRects,
		fontSize: size,
		isReference: options.isReference ?? false
	};
}

// ---- the shredded-abstract case ---------------------------------------------

test('one-line fragments of a paragraph coalesce into a single region', () => {
	// The Circ Cardiovasc Imaging abstract came through as one block per line;
	// each line translated in isolation reads as broken clauses.
	const fragments = [
		block('a', 'Background—Computed tomographic coronary angiography is a', { topY: 700 }),
		block('b', 'noninvasive imaging modality that permits identification', { topY: 687 }),
		block('c', 'and characterization of coronary plaques.', { topY: 674 })
	];
	const regions = coalesceRegions(fragments);
	assert.equal(regions.length, 1, 'three line fragments are ONE region');
	assert.equal(
		regions[0]!.sourceText,
		'Background—Computed tomographic coronary angiography is a noninvasive imaging modality that permits identification and characterization of coronary plaques.'
	);
	assert.equal(regions[0]!.lineRectsPdf!.length, 3, 'every source line rect is kept for masking');
});

test('paragraph roles survive as paragraph breaks', () => {
	// Background ends a sentence; Methods starts a new role with visible
	// spacing → the region keeps "\n\n" between them.
	const a = block('a', 'Background—This is the background sentence.', { topY: 700, lines: 2 });
	const b = block('b', 'Methods and Results—Databases were searched for studies.', { topY: 665 });
	const regions = coalesceRegions([a, b]);
	assert.equal(regions.length, 1);
	assert.ok(
		regions[0]!.sourceText.includes('.\n\nMethods and Results—'),
		`expected a paragraph break before the role, got: ${JSON.stringify(regions[0]!.sourceText)}`
	);
});

test('a hyphenated line break joins without a space', () => {
	const a = block('a', 'identifica-', { topY: 700 });
	const b = block('b', 'tion of plaques.', { topY: 687 });
	const regions = coalesceRegions([a, b]);
	assert.equal(regions[0]!.sourceText, 'identification of plaques.');
});

// ---- boundaries that must NOT merge ----------------------------------------

test('a heading between paragraphs splits the region', () => {
	const blocks = [
		block('a', 'End of the introduction paragraph.', { topY: 700 }),
		block('h', 'Methods', { topY: 685, type: 'heading' }),
		block('b', 'First sentence of the methods.', { topY: 668 })
	];
	const regions = coalesceRegions(blocks);
	assert.equal(regions.length, 3, 'headings never merge into a region');
});

test('different columns never merge', () => {
	const left = block('a', 'Left column text continues here', { left: 54, topY: 700 });
	const right = block('b', 'Right column text continues here', { left: 320, topY: 690 });
	assert.equal(canMerge(left, right), false);
});

test('a large vertical gap is a region boundary', () => {
	const a = block('a', 'A paragraph that ends here.', { topY: 700 });
	const b = block('b', 'Something much further down the page.', { topY: 620 });
	assert.equal(canMerge(a, b), false);
});

test('a type-size jump is a region boundary', () => {
	const body = block('a', 'Body text at ten points continues', { topY: 700, fontSize: 10 });
	const caption = block('b', 'Tiny caption text under a figure', { topY: 687, fontSize: 7.5 });
	assert.equal(canMerge(body, caption), false);
});

test('references never merge', () => {
	const a = block('a', '1. Smith J. Some cited work. 2020.', { topY: 700, isReference: true });
	const b = block('b', '2. Jones K. Другая работа. 2021.', { topY: 687, isReference: true });
	assert.equal(canMerge(a, b), false);
});

test('regions respect the provider character cap', () => {
	const a = block('a', 'x'.repeat(2000), { topY: 700 });
	const b = block('b', 'y'.repeat(1000), { topY: 687 });
	assert.equal(canMerge(a, b), false, 'merging would exceed the request cap');
});

// ---- separators -------------------------------------------------------------

test('mid-sentence fragments join with a space; finished tight lines too', () => {
	const a = block('a', 'this fragment ends mid', { topY: 700 });
	const b = block('b', 'sentence and continues', { topY: 687 });
	assert.equal(separatorBetween(a, b), ' ');
	// Finished sentence but line-spacing only → still the same paragraph.
	const c = block('c', 'A complete sentence.', { topY: 700 });
	const d = block('d', 'The next line, tightly below.', { topY: 688 });
	assert.equal(separatorBetween(c, d), ' ');
});

// ---- shard absorption -------------------------------------------------------

test('a bare citation marker is absorbed into the previous region', () => {
	const a = block('a', 'Coronary inflammation predicts adverse outcomes in this cohort', { topY: 700 });
	const shard = block('b', '(5,6).', { topY: 687, width: 30, fontSize: 7 }); // superscript-ish size
	const regions = coalesceRegions([a, shard]);
	assert.equal(regions.length, 1, 'citation shard merged');
	assert.ok(regions[0]!.sourceText.endsWith('(5,6).'));
});

test('a torn-off lowercase continuation is absorbed despite a font mismatch', () => {
	const a = block('a', 'The attenuation of the polarized beam is measured after the', { topY: 700 });
	const shard = block('b', 'ated light is isolated in the detector.', { topY: 660, fontSize: 8 });
	const regions = coalesceRegions([a, shard]);
	assert.equal(regions.length, 1, 'continuation shard merged into its paragraph');
});

test('a shard with no adjacent body neighbour survives unmerged', () => {
	const h = block('h', 'Methods', { topY: 700, type: 'heading' });
	const shard = block('s', '(12).', { topY: 300, width: 26 });
	const regions = coalesceRegions([h, shard]);
	assert.equal(regions.length, 2, 'nothing eligible to absorb it — kept');
});

// ---- 语义段落组: long continuations, provenance, colon separators ------------

test('a LONG lowercase continuation fragment is absorbed — length is not a rejection criterion', () => {
	// The Radiology page-6 case: "least as robust, if not better, than…" is 70+
	// chars, starts lowercase, and is unmistakably the middle of a sentence.
	// The old ≤60-char cap left it as an independent English block inside a
	// Chinese paragraph.
	const regions = coalesceRegions([
		block('a', 'One should expect that PCCT-based models will be at', { topY: 700, fontSize: 10 }),
		block('b', 'least as robust, if not better, than CT-based algorithms given the many improvements that PCCT has to offer.', { topY: 685, fontSize: 8 })
	]);
	assert.equal(regions.length, 1, 'the long continuation joined its paragraph');
	assert.ok(regions[0]!.sourceText.includes('will be at least as robust'), 'sentence reads whole');
});

test('a merged region keeps memberIds provenance for every absorbed fragment', () => {
	const regions = coalesceRegions([
		block('a', 'Background—Computed tomographic coronary angiography is a', { topY: 700 }),
		block('b', 'noninvasive imaging modality that permits identification', { topY: 687 }),
		block('c', 'and characterization of coronary plaques.', { topY: 674 })
	]);
	assert.equal(regions.length, 1);
	assert.deepEqual(regions[0]!.memberIds, ['a', 'b', 'c'], 'source relationship preserved through the merge');
});

test('a colon at a fragment boundary does not become a paragraph break', () => {
	const a = block('a', 'the modifications include the following:', { topY: 700 });
	const b = block('b', 'sharper kernels and thinner sections.', { topY: 660 });
	assert.equal(separatorBetween(a, b), ' ', 'colon means the clause continues — a space, never \\n\\n');
});
