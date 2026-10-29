import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceBlock } from '../../src/types/models';
import { buildContinuityContexts, contextualSourceText, pageContinuityNeeds } from '../../src/translation/sourceContinuity';

function body(id: string, sourceText: string, overrides: Partial<SourceBlock> = {}): SourceBlock {
	const pageIndex = overrides.pageIndex ?? 0, column = overrides.column ?? 0;
	const x = column === 1 ? 330 : 50;
	const box = overrides.boundingBox ?? { x, y: 100, width: 250, height: 20 };
	return {
		id, sourceText, pageIndex, column, order: 0, type: 'paragraph', fontSize: 10,
		boundingBox: box,
		lineRectsPdf: [[box.x, 800 - box.y - box.height, box.x + box.width, 810 - box.y - box.height]],
		sourceRegion: { id: `${id}-body`, kind: 'body-column', evidence: 'column-geometry',
			boundsPdf: [box.x, 800 - box.y - box.height, box.x + box.width, 800 - box.y] },
		...overrides
	};
}

function below(id: string, sourceText: string, y: number, overrides: Partial<SourceBlock> = {}): SourceBlock {
	return body(id, sourceText, { boundingBox: { x: 50, y, width: 250, height: 20 }, ...overrides });
}

test('same-column sentence fragments supply both directions without mutating source ownership', () => {
	const blocks = [body('a', 'The protocol caused no'), below('b', 'failed acquisitions or intolerance.', 122)];
	const original = JSON.stringify(blocks);
	const contexts = buildContinuityContexts(blocks);
	assert.deepEqual(contexts.get('a'), { before: '', after: 'failed acquisitions or intolerance.' });
	assert.deepEqual(contexts.get('b'), { before: 'The protocol caused no', after: '' });
	assert.equal(JSON.stringify(blocks), original);
});

test('Gori-like cross-column negation reaches a long isolated right-column paragraph', () => {
	const left = body('left', 'Between January and June, all examinations were completed. All completed without complications (i.e. no failed', {
		boundingBox: { x: 50, y: 710, width: 250, height: 30 }
	});
	const right = body('right', 'acquisitions or intolerance). Subjects had a median age of 62 years. ' + 'Subsequent independent findings were recorded. '.repeat(80), { column: 1 });
	const context = buildContinuityContexts([left, right]);
	assert.deepEqual(context.get('right'), { before: 'All completed without complications (i.e. no failed', after: '' });
	assert.equal(context.get('left')?.after, 'acquisitions or intolerance).');
	assert.ok(!context.get('left')?.after.includes('median age'));
});

test('Gori-like cross-page before/and-or clause is available in both page visit orders', () => {
	const tail = body('tail', 'Earlier instructions are complete. Baseline pressure and heart rate are measured before rate-control agents', { pageIndex: 3 });
	const head = body('head', 'and/or vasodilators are administered,¹¹ and patients are coached on breath-holding. The exam begins with a baseline scan.', { pageIndex: 4 });
	assert.deepEqual(buildContinuityContexts([tail], { next: [head] }).get('tail'), {
		before: '', after: 'and/or vasodilators are administered,¹¹ and patients are coached on breath-holding.'
	});
	assert.deepEqual(buildContinuityContexts([head], { previous: [tail] }).get('head'), {
		before: 'Baseline pressure and heart rate are measured before rate-control agents', after: ''
	});
});

test('real Gori boundary excerpts and exported source rectangles preserve before/no scope', () => {
	// Necessary excerpts/edge rectangles from the pre4 Gori corpus. Self-contained:
	// no local user's PDF path, model service or Zotero application is required.
	const p4 = body('p4-tail', 'Baseline blood pressure and heart rate are measured before rate-control agents', {
		pageIndex: 3, column: 1, fontSize: 8.5,
		boundingBox: { x: 303.817, y: 578.668078, width: 248.97312087, height: 160.4951118 },
		lineRectsPdf: [[303.817, 206.533022, 552.7391214700001, 215.03292199999999], [303.817, 54.53781019999999, 552.75612127, 63.03771019999999]],
		sourceRegion: { id: 'p4-body', kind: 'body-column', evidence: 'column-geometry',
			boundsPdf: [303.81515920000004, 30.53781019999999, 552.79012087, 281.59092200000003] }
	});
	const p5 = body('p5-head', 'and/or nitroglycerin are administered,¹¹ and patients are coached on breath-holding to optimize diagnostic quality.¹¹', {
		pageIndex: 4, column: 0, fontSize: 8.5,
		boundingBox: { x: 42.5188062, y: 529.514676, width: 248.98311460999994, height: 209.58587860000003 },
		lineRectsPdf: [[42.5196, 254.099022, 291.43667772, 264.186324], [42.5203, 54.60044539999999, 291.46792116999995, 63.100345399999995]],
		sourceRegion: { id: 'p5-body', kind: 'body-column', evidence: 'column-geometry',
			boundsPdf: [42.5188062, 30.60044539999999, 291.50192080999994, 264.186324] }
	});
	const left = body('p6-left', 'Between January and June 2025, GPs invited 223 eligible individuals, and 172 were referred for PCCT. All 172 completed the examination without complications (i.e. no failed', {
		pageIndex: 5, column: 0, fontSize: 9,
		boundingBox: { x: 36.8503, y: 709.2952, width: 248.97240000000005, height: 29.976299999999995 },
		lineRectsPdf: [[36.8503, 75.4058, 285.77320000000003, 84.4058], [36.85030000000003, 54.429500000000004, 285.7831000000001, 63.429500000000004]],
		sourceRegion: { id: 'p6-left-body', kind: 'body-column', evidence: 'column-geometry',
			boundsPdf: [36.85029999999997, 30.429500000000004, 285.83872069000006, 735.4169220000001] }
	});
	const right = body('p6-right', 'acquisitions or intolerance). Subjects undergoing PCCT had a median age of 62 years (interquartile range 54–68), and 56% were males.', {
		pageIndex: 5, column: 1, fontSize: 9,
		boundingBox: { x: 303.81639999999976, y: 58.23429999999996, width: 248.97240000000016, height: 681.0372000000001 },
		lineRectsPdf: [[303.8164000000001, 726.4667000000001, 552.7492000000002, 735.4667000000001], [303.8164, 54.429500000000004, 552.7681000000002, 63.429500000000004]],
		sourceRegion: { id: 'p6-right-body', kind: 'body-column', evidence: 'column-geometry',
			boundsPdf: [303.81639999999976, 30.429500000000004, 552.7887999999999, 735.4667000000001] }
	});
	assert.equal(buildContinuityContexts([p4], { next: [p5] }).get(p4.id)?.after, p5.sourceText);
	assert.equal(buildContinuityContexts([p5], { previous: [p4] }).get(p5.id)?.before, p4.sourceText);
	const across = buildContinuityContexts([left, right]);
	assert.equal(across.get(left.id)?.after, 'acquisitions or intolerance).');
	assert.equal(across.get(right.id)?.before, 'All 172 completed the examination without complications (i.e. no failed');
});

test('page body boundaries ignore following table cells and preceding figure material', () => {
	const tail = body('tail', 'The measurements were recorded before the agents', { pageIndex: 3 });
	const cell = body('cell', 'A completely unrelated table-cell sentence.', { pageIndex: 3,
		sourceRegion: { id: 'cell-region', kind: 'table-cell', evidence: 'table-model', boundsPdf: [50, 400, 500, 420] } });
	const figure = body('figure', 'Figure 2 Acquisition protocol', { pageIndex: 4, type: 'heading',
		sourceRegion: { id: 'figure-caption', kind: 'caption', evidence: 'label-aligned-lines', boundsPdf: [50, 650, 580, 700] } });
	const head = body('head', 'and/or vasodilators were administered.', { pageIndex: 4 });
	const tailPage = [tail, cell], headPage = [figure, head];
	assert.deepEqual(pageContinuityNeeds(tailPage), { previous: false, next: true });
	assert.deepEqual(pageContinuityNeeds(headPage), { previous: true, next: false });
	assert.equal(buildContinuityContexts(headPage, { previous: tailPage }).get('head')?.before, tail.sourceText);
	assert.equal(buildContinuityContexts(tailPage, { next: headPage }).get('tail')?.after, head.sourceText);
	assert.equal(buildContinuityContexts(headPage, { previous: tailPage }).has('figure'), false);
});

test('Kitagawa-like metric list and statistics retain a complete multi-fragment source sentence', () => {
	const parts = [
		'The sensitivity, specificity,',
		'positive and negative predictive values, and accuracy at a fixed cutoff (≥50% stenosis) were 93%, 36%, 58%, 85%, and 64%',
		'(95% CI: 56%-71%). When a second measure was added, the values were 72%',
		'(95% CI: 61%-82%), 75%, 73%, 74%, and 74%, respectively. Continuous net reclassification improvement and',
		'integrated',
		'discrimination',
		'improvement were 0.289 (P = 0.039) and 0.029 (P = 0.192), respectively.'
	];
	const blocks = parts.map((text, index) => below(`b${index}`, text, 100 + index * 22));
	const contexts = buildContinuityContexts(blocks);
	assert.equal(contexts.get('b1')?.before, parts[0]);
	assert.equal(contexts.get('b1')?.after, '(95% CI: 56%-71%).');
	assert.equal(contexts.get('b4')?.before, 'Continuous net reclassification improvement and');
	assert.equal(contexts.get('b5')?.after, parts[6]);
	assert.match(contexts.get('b6')?.before ?? '', /Continuous net reclassification improvement and integrated discrimination$/);
	assert.ok(contexts.get('b4')!.after.length < 250);
});

test('only unfinished sentences link; punctuation and independent capitalized paragraphs stop links', () => {
	for (const terminal of ['.', '!', '?', '。', '！', '？', '.”', '.)', '.¹¹']) {
		const a = body('a', `The result was complete${terminal}`);
		const b = below('b', 'another independent result was recorded.', 122);
		assert.equal(buildContinuityContexts([a, b]).size, 0, terminal);
	}
	assert.equal(buildContinuityContexts([body('a', 'The method remained'), below('b', 'A separate paragraph starts here.', 122)]).size, 0);
});

test('decimals and dotted parentheticals do not cut away the negation or a statistic', () => {
	const a = body('a', 'The earlier result was complete. The coefficient was 0.039 (i.e. no');
	const b = below('b', 'measurable decrease in quality).', 122);
	assert.equal(buildContinuityContexts([a, b]).get('b')?.before, 'The coefficient was 0.039 (i.e. no');
});

test('academic abbreviations and personal initials cannot strip a negation from the needed sentence tail', () => {
	const sources = [
		'The outcome was not replicated by Smith et al. in',
		'The outcome was not replicated by Dr. Green in',
		'The outcome was not replicated by Prof. Chen in',
		'The outcome was not replicated by A. J. Smith in',
		'The outcome was not replicated by J. van Smith in',
		'The outcome was not included in Fig. S2 of',
		'The outcome was not included in Eq. (2) of',
		'The outcome did not follow the U.S. protocol in',
		'The outcome was not replicated, e.g. Smith reported no change in',
		'The outcome was not replicated, i.e. there was no change in'
	];
	for (const text of sources) {
		const a = body('a', `An earlier independent sentence is complete. ${text}`);
		const b = below('b', 'the independent cohort.', 122);
		assert.equal(buildContinuityContexts([a, b]).get('b')?.before, text, text);
	}
});

test('abbreviations still allow a visible independent sentence boundary or a final stop', () => {
	for (const completed of [
		'The outcome was replicated by Smith et al.',
		'The trial took place in the U.S.',
		'The source cited Fig. 2.',
		'The comparison concerned Eq. (2).',
		'The intervention followed Dr. Green.'
	]) {
		assert.equal(buildContinuityContexts([body('a', completed), below('b', 'another cohort was independent.', 122)]).size, 0, completed);
	}
	const a = body('a', 'The primary result agreed with Smith et al. The secondary result was not replicated in');
	const b = below('b', 'the independent cohort.', 122);
	assert.equal(buildContinuityContexts([a, b]).get('b')?.before, 'The secondary result was not replicated in');
	const titled = body('a', 'The earlier role was Prof. However, the secondary result was not replicated in');
	assert.equal(buildContinuityContexts([titled, b]).get('b')?.before, 'However, the secondary result was not replicated in');
});

test('after context recognises abbreviations until a real sentence end, without swallowing the following sentence', () => {
	const a = body('a', 'No independent effect was reported by');
	const b = below('b', 'Dr. Green et al. in the first cohort. The next finding was different.', 122);
	// The first letter is capitalised because it is a title. That alone is not
	// a continuation proof, so the conservative graph does not link this case.
	assert.equal(buildContinuityContexts([a, b]).size, 0);
	const c = below('c', 'the team led by Dr. Green et al. in the first cohort. The next finding was different.', 122);
	assert.equal(buildContinuityContexts([a, c]).get('a')?.after, 'the team led by Dr. Green et al. in the first cohort.');
});

test('an unavailable earlier page cannot supply a negative sentence start through a lower-case graph boundary', () => {
	const unavailable = body('p0', 'No participants', { pageIndex: 0 });
	const previous = body('p1', 'experienced failed acquisitions in', { pageIndex: 1 });
	const current = body('p2', 'the independent cohort.', { pageIndex: 2 });
	assert.equal(buildContinuityContexts([current], { previous: [previous] }).get('p2'), undefined);
	assert.equal(buildContinuityContexts([current], { previous: [unavailable, previous] }).get('p2'), undefined,
		'a caller cannot bypass the adjacent-page limit with a mixed-page neighbour array');
	const numeric = body('p1-number', '20 participants experienced failures in', { pageIndex: 1 });
	assert.equal(buildContinuityContexts([current], { previous: [numeric] }).get('p2'), undefined);
});

test('after context is omitted when the bounded next-page graph still has no sentence end', () => {
	const current = body('p0', 'No participants experienced failures in', { pageIndex: 0 });
	const next = body('p1', 'the independent cohort and', { pageIndex: 1 });
	const unavailable = body('p2', 'the external cohort.', { pageIndex: 2 });
	assert.equal(buildContinuityContexts([current], { next: [next] }).get('p0'), undefined);
	assert.equal(buildContinuityContexts([current], { next: [next, unavailable] }).get('p0'), undefined);
});

test('a visible sentence boundary, document start or section start can establish a lower-case prefix safely', () => {
	const current = body('current', 'the independent cohort.', { pageIndex: 2 });
	const bounded = body('previous', 'The earlier sentence ended. no failures were observed in', { pageIndex: 1 });
	assert.equal(buildContinuityContexts([current], { previous: [bounded] }).get('current')?.before, 'no failures were observed in');
	const section = body('section', 'Results', { pageIndex: 1, type: 'heading' });
	const afterSection = body('previous', 'no failures were observed in', { pageIndex: 1 });
	assert.equal(buildContinuityContexts([current], { previous: [section, afterSection] }).get('current')?.before, afterSection.sourceText);
	const first = body('first', 'no failures were observed in', { pageIndex: 0 });
	const following = body('following', 'the independent cohort.', { pageIndex: 1 });
	assert.equal(buildContinuityContexts([following], { previous: [first] }).get('following')?.before, first.sourceText);
});

test('section headings block same-page and cross-page attachments', () => {
	const a = body('a', 'The measurement was performed before', { pageIndex: 2 });
	const heading = body('section', 'Results', { pageIndex: 2, type: 'heading' });
	const b = below('b', 'another component was acquired.', 122, { pageIndex: 2 });
	assert.equal(buildContinuityContexts([a, heading, b]).size, 0);
	const next = body('next', 'another component was acquired.', { pageIndex: 3 });
	assert.equal(buildContinuityContexts([a, heading], { next: [next] }).size, 0);
	const nextHeading = body('section', 'Results', { pageIndex: 3, type: 'heading' });
	assert.equal(buildContinuityContexts([nextHeading, next], { previous: [a] }).size, 0);
	assert.equal(pageContinuityNeeds([nextHeading, next]).previous, false);
});

test('page furniture headings are excluded from section-boundary evidence', () => {
	const a = body('a', 'The measurement was performed before', { pageIndex: 2 });
	const footer = body('footer', 'Journal title', { pageIndex: 2, type: 'title',
		sourceRegion: { id: 'furniture', kind: 'page-furniture', evidence: 'page-margin', boundsPdf: [50, 10, 300, 20] } });
	const next = body('next', 'another component was acquired.', { pageIndex: 3 });
	assert.equal(buildContinuityContexts([a, footer], { next: [next] }).get('a')?.after, next.sourceText);
});

test('references, table cells, image labels, preserved data and captions never acquire body context', () => {
	const a = body('a', 'The measurement remained incomplete because');
	const excluded: Partial<SourceBlock>[] = [
		{ isReference: true }, { translationMode: 'preserve' }, { type: 'table' }, { type: 'caption' },
		{ tableId: 'table-1' }, { tableRow: 0 }, { tableCol: 0 }, { imageTextRegionPdf: [0, 0, 100, 20] },
		{ sourceRegion: { id: 'caption', kind: 'caption', evidence: 'label-aligned-lines', boundsPdf: [0, 0, 100, 20] } }
	];
	for (const flags of excluded) {
		const b = below('excluded', 'the remaining component was missing.', 122, flags);
		assert.equal(buildContinuityContexts([a, b]).size, 0, JSON.stringify(flags));
	}
});

test('explicit body ownership takes precedence over unowned paragraph-like labels', () => {
	const a = body('a', 'The measurement remained incomplete because');
	const noise = below('noise', 'unrelated label', 121, { sourceRegion: undefined });
	const b = below('b', 'the remaining component was missing.', 122);
	const contexts = buildContinuityContexts([a, noise, b]);
	assert.equal(contexts.get('b')?.before, a.sourceText);
	assert.equal(contexts.has('noise'), false);
});

test('same-column gaps, overlap, differing fonts and widths conservatively reject continuation', () => {
	const a = body('a', 'The measurement remained incomplete because');
	const bad = [
		below('b', 'the remaining component was missing.', 190),
		below('b', 'the remaining component was missing.', 80),
		below('b', 'the remaining component was missing.', 122, { fontSize: 6 }),
		below('b', 'the remaining component was missing.', 122, {
			boundingBox: { x: 50, y: 122, width: 100, height: 20 }, sourceRegion: undefined })
	];
	for (const b of bad) assert.equal(buildContinuityContexts([a, b]).size, 0);
});

test('cross-column/page links require a filled last line and matching column width', () => {
	const a = body('a', 'The measurement was performed before', {
		lineRectsPdf: [[50, 680, 180, 690]] });
	const right = body('right', 'another component was acquired.', { column: 1 });
	const next = body('next', 'another component was acquired.', { pageIndex: 1 });
	assert.equal(buildContinuityContexts([a, right]).size, 0);
	assert.equal(buildContinuityContexts([a], { next: [next] }).size, 0);
	assert.equal(pageContinuityNeeds([a]).next, false);
	const narrow = body('narrow', next.sourceText, { pageIndex: 1,
		boundingBox: { x: 50, y: 100, width: 130, height: 20 }, sourceRegion: undefined });
	assert.equal(buildContinuityContexts([body('full', a.sourceText)], { next: [narrow] }).size, 0);
});

test('column wraps cannot run backward or skip a column', () => {
	const a = body('a', 'The measurement was performed before', { column: 1 });
	for (const column of [0, 3]) {
		const b = body('b', 'another component was acquired.', { column });
		assert.equal(buildContinuityContexts([a, b]).size, 0);
	}
});

test('absent, malformed and nonfinite geometry cannot establish continuation', () => {
	const a = body('a', 'The measurement was performed before');
	for (const flags of [{ boundingBox: undefined }, { lineRectsPdf: undefined },
		{ lineRectsPdf: [[50, 680, NaN, 690]] }, { lineRectsPdf: [[50, 680, 50, 690]] }]) {
		const b = below('b', 'another component was acquired.', 122, flags as Partial<SourceBlock>);
		assert.equal(buildContinuityContexts([a, b]).size, 0);
		assert.deepEqual(pageContinuityNeeds([b]), { previous: false, next: false });
	}
});

test('only immediately adjacent pages are accepted, independently of caller labels', () => {
	const a = body('a', 'The measurement was performed before', { pageIndex: 5 });
	const b = body('b', 'another component was acquired.', { pageIndex: 7 });
	assert.equal(buildContinuityContexts([a], { next: [b] }).size, 0);
	assert.equal(buildContinuityContexts([b], { previous: [a] }).size, 0);
	assert.equal(buildContinuityContexts([a], { previous: [b] }).size, 0);
});

test('missing neighbours never manufacture words or mutate an incomplete source fragment', () => {
	const a = body('a', 'and/or another agent was administered', { pageIndex: 5 });
	assert.deepEqual(pageContinuityNeeds([a]), { previous: true, next: true });
	assert.equal(buildContinuityContexts([a]).size, 0);
	assert.equal(contextualSourceText(a), a.sourceText);
});

test('a complete source sentence is retained or omitted whole rather than truncated past its negation', () => {
	const a = body('a', 'No ' + 'assessment of the independent component '.repeat(55));
	const b = below('b', 'failed in the acquisition.', 122);
	assert.ok(a.sourceText.length > 1800);
	assert.equal(buildContinuityContexts([a, b]).get('b'), undefined);
	assert.equal(buildContinuityContexts([a, b]).get('a')?.after, b.sourceText);
});

test('large complete previous sentences are skipped while the needed tail sentence stays intact', () => {
	const a = body('a', 'A long unrelated sentence ' + 'was successfully completed '.repeat(100) + '. No independent component');
	const b = below('b', 'failed in the acquisition.', 122);
	assert.equal(buildContinuityContexts([a, b]).get('b')?.before, 'No independent component');
});

test('each side is bounded across a long multi-fragment chain', () => {
	const blocks = Array.from({ length: 120 }, (_, i) => below(`b${i}`, 'another portion of the same unclosed source sentence', 100 + i * 22));
	for (const context of buildContinuityContexts(blocks).values()) {
		assert.ok(context.before.length <= 1800);
		assert.ok(context.after.length <= 1800);
		assert.ok(context.before.length + context.after.length <= 3600);
	}
});

test('cache identity is unchanged for independent blocks, but includes both contextual sides and explicit failures', () => {
	const block = body('a', 'another agent was administered.');
	assert.equal(contextualSourceText(block), block.sourceText);
	const empty = contextualSourceText({ ...block, continuationContext: { before: '', after: '' } });
	const before = contextualSourceText({ ...block, continuationContext: { before: 'Before the scan,', after: '' } });
	const after = contextualSourceText({ ...block, continuationContext: { before: '', after: 'A later part' } });
	assert.equal(new Set([block.sourceText, empty, before, after]).size, 4);
	assert.deepEqual(JSON.parse(empty), ['PaperMirror.source-continuity.v3', block.sourceText, '', '']);
	assert.equal(contextualSourceText({ ...block, id: 'other-id', pageIndex: 9, continuationContext: { before: 'Before the scan,', after: '' } }), before);
});

test('empty input, mixed-page current input and duplicate current IDs are conservative', () => {
	assert.equal(buildContinuityContexts([]).size, 0);
	assert.deepEqual(pageContinuityNeeds([]), { previous: false, next: false });
	const a = body('a', 'The measurement was performed before');
	const b = below('a', 'another component was acquired.', 122);
	assert.equal(buildContinuityContexts([a, b]).size, 0);
	assert.equal(buildContinuityContexts([a, { ...b, id: 'b', pageIndex: 1 }]).size, 0);
});
