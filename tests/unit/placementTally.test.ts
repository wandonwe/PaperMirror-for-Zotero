import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placementTally, type StrictPageStats } from '../../src/ui/strictPageReplacement';

const base: StrictPageStats = {
	replaceable: 0,
	committed: 0,
	abandoned: 0,
	pending: 0,
	tableIntentional: 0,
	tableFailed: 0,
	imageExcluded: 0,
	untranslated: 0,
	tooSmall: 0,
	annexed: 0
};

test('placed is exactly committed — table text cells are NOT added on top (issue 3)', () => {
	// 10 committed items, 4 of which are table text cells. Those 4 are already
	// inside `committed`; a naive `committed + tableTranslated` would report 14.
	const s: StrictPageStats = { ...base, replaceable: 10, committed: 10 };
	const t = placementTally(s);
	assert.equal(t.placed, 10, 'no double count of table text cells');
	assert.equal(t.kept, 0);
	assert.equal(t.segTotal, 10);
	assert.equal(t.phase, 'done');
});

test('intentionally-kept table cells do NOT make a page "partial" (issue 4)', () => {
	// A page that placed every translatable block but kept numeric/data cells
	// by design must still read as 已完成 — not a false partial.
	const s: StrictPageStats = { ...base, replaceable: 6, committed: 6, tableIntentional: 9 };
	const t = placementTally(s);
	assert.equal(t.kept, 0, 'tableIntentional is not a failure');
	assert.equal(t.phase, 'done');
});

test('failed table cells DO count as kept and force a partial (issue 4)', () => {
	// Cells whose text was never translated / had no line rects / could not be
	// placed are real failures — they must count as kept, so 已完成 is not shown.
	const s: StrictPageStats = { ...base, replaceable: 6, committed: 6, tableFailed: 3 };
	const t = placementTally(s);
	assert.equal(t.kept, 3);
	assert.equal(t.segTotal, 9);
	assert.equal(t.phase, 'partial');
});

test('kept sums abandoned + untranslated + tableFailed only', () => {
	const s: StrictPageStats = {
		...base,
		replaceable: 12,
		committed: 5,
		abandoned: 2,
		untranslated: 1,
		tableFailed: 4,
		// none of these count as kept:
		tableIntentional: 7,
		imageExcluded: 3,
		tooSmall: 8,
		pending: 0
	};
	const t = placementTally(s);
	assert.equal(t.placed, 5);
	assert.equal(t.kept, 7, '2 + 1 + 4');
	assert.equal(t.segTotal, 12);
	assert.equal(t.phase, 'partial');
});
