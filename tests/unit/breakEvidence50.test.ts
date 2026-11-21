import test from 'node:test';
import assert from 'node:assert/strict';
import { decideBreak, shouldBreak, type BreakContext } from '../../src/reader/paragraphHeuristics';
import { groupIntoLines, groupIntoParagraphs, lineText, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { startsUnnumberedEntry } from '../../src/reader/referenceDetect';
import { buildDocumentStyle, type StylePage } from '../../src/reader/documentStyle';

// ---- 1. The scoring is exactly the old cascade --------------------------------

/** The pre-5.0 shouldBreak, verbatim. */
function legacyShouldBreak(ctx: BreakContext): boolean {
	const size = ctx.fontSize > 0 ? ctx.fontSize : 10;
	if (ctx.newColumn || ctx.listStart) return true;
	if (ctx.leaderDots) return true;
	if (ctx.shortLine && !ctx.wrapped) return true;
	if (ctx.gap > size * 1.7) return true;
	if (ctx.indented || ctx.fontJump) return true;
	if (ctx.wrapped) return false;
	return ctx.gap > size * 0.75;
}

test('5.0 断段证据: weighted evidence decides exactly like the old cascade, for every combination', () => {
	const flags = ['wrapped', 'newColumn', 'indented', 'fontJump', 'listStart', 'shortLine', 'leaderDots'] as const;
	let checked = 0;
	for (let mask = 0; mask < 1 << flags.length; mask++) {
		for (const gap of [-2, 0, 5, 8, 12, 20]) {
			const ctx: BreakContext = { fontSize: 10, gap, wrapped: false, newColumn: false, indented: false, fontJump: false, listStart: false };
			flags.forEach((f, i) => { (ctx as unknown as Record<string, boolean>)[f] = !!(mask & (1 << i)); });
			assert.equal(shouldBreak(ctx), legacyShouldBreak(ctx), JSON.stringify(ctx));
			checked++;
		}
	}
	assert.equal(checked, 128 * 6);
});

test('5.0 断段证据: every decision carries its reasons', () => {
	const d = decideBreak({ fontSize: 10, gap: 9, wrapped: true, newColumn: false, indented: true, fontJump: false, listStart: false });
	assert.equal(d.brk, true);
	assert.deepEqual(d.evidence.map(e => e.reason).sort(), ['gap', 'indent', 'wrapped']);
	assert.equal(d.score, 3 - 2 + 1);
	const c = decideBreak({ fontSize: 10, gap: 3, wrapped: true, newColumn: false, indented: false, fontJump: false, listStart: false });
	assert.equal(c.brk, false);
	assert.deepEqual(c.evidence.map(e => e.reason), ['wrapped']);
});

// ---- 2. Reference context: entry boundaries, no short-line / field rule --------

const SIZE = 9;
/** One full-width line per string (so every line "wrapped"), top to bottom. */
function linesOf(texts: string[], widths: number[] = []): SpanItem[] {
	return texts.map((text, i) => ({ text, rect: [72, 700 - i * 11, 72 + (widths[i] ?? 450), 700 - i * 11 + SIZE] as [number, number, number, number], fontSize: SIZE }));
}

test('5.0 (2877 p18): unnumbered entries are split at the entry boundary on a reference page, not on a body page', () => {
	const items = linesOf([
		'Rasband W. ImageJ, U.S. National Institutes of Health, Bethesda, Maryland, USA. In, 2011',
		'Benomar A, Zarour E, Letourneau-Guillon L, Raymond J. Measuring Interrater Reliability. Radiology 2023;',
		'309:e230492'
	], [450, 450, 60]);
	const lines = groupIntoLines(items, 612, 792);
	const asRefs = groupIntoParagraphs(lines, 612, 792, [], null, { referencePage: true }).map(p => p.map(lineText).join(' '));
	assert.equal(asRefs.length, 2, asRefs.join(' | '));
	assert.ok(asRefs[1]!.startsWith('Benomar A') && asRefs[1]!.endsWith('309:e230492'));
	const asBody = groupIntoParagraphs(lines, 612, 792).map(p => p.map(lineText).join(' '));
	assert.equal(asBody.length, 1, 'outside a reference list the same lines are one paragraph');
});

test('5.0 (3064): inside a reference list "doi:10…" and a short author line continue the entry', () => {
	const items = linesOf([
		'16. Robijn S, Hoppe B, Vervaet BA, D’Haese PC, Verhulst A.',
		'Hyperoxaluria: a gut-kidney axis? Kidney Int. 2011;80:1146-1158.',
		'doi:10.1038/ki.2011.287',
		'17. Hatch M, Freel RW. Intestinal transport of an obdurate anion: oxalate. Urol Res. 2005;33:1-16.'
	], [250, 450, 120, 450]);
	const lines = groupIntoLines(items, 612, 792);
	const refs = groupIntoParagraphs(lines, 612, 792, [], null, { referencePage: true }).map(p => p.map(lineText).join(' '));
	assert.deepEqual(refs.map(r => r.slice(0, 3)), ['16.', '17.'], refs.join(' | '));
	assert.ok(refs[0]!.includes('doi:10.1038'));
});

test('5.0: on a heading page only the lines below the heading in its own column are the list', () => {
	const heading: SpanItem = { text: 'References', rect: [72, 600, 140, 610], fontSize: 11 };
	const full = 'The authors declare no conflicts of interest and thank the staff of the imaging unit for their help with';
	const body = linesOf([full, full, full, 'the data. Competing interests: none.', 'Consent for publication', 'Not applicable.'], [450, 450, 450, 200, 120, 80]);
	const lines = groupIntoLines([...body, heading], 612, 792);
	const ctx = { referenceHeadingRect: heading.rect };
	const paras = groupIntoParagraphs(lines, 612, 792, [], null, ctx).map(p => p.map(lineText).join(' '));
	assert.ok(paras.includes('Not applicable.'), 'body above the heading keeps the short-line rule: ' + paras.join(' | '));
	// The same lines treated as a reference list lose the short-line break.
	const asList = groupIntoParagraphs(lines, 612, 792, [], null, { referencePage: true }).map(p => p.map(lineText).join(' '));
	assert.ok(!asList.includes('Not applicable.'), asList.join(' | '));
});

test('5.0 (3386): APA / Harvard author starts count as entry starts', () => {
	for (const s of ['Behrend, H., Giesinger, K., Giesinger, J.M. & Kuster, M.S. (2012) The forgotten joint',
		'Bistolfi, A. & Bellare, A. (2011) The relative effects of radiation crosslinking',
		'Currier, J.H., Currier, B.H., Abdel, M.P. (2021) What factors drive polyethylene wear',
		'Kurtz, S.M. (2012) Chemical and radiation stability of PEEK']) assert.equal(startsUnnumberedEntry(s), true, s);
	for (const s of ['However, R. and colleagues reported a lower rate', 'In summary, the method described here']) assert.equal(startsUnnumberedEntry(s), false, s);
});

// ---- 3. Document-wide gutters --------------------------------------------------

test('5.0 (3064 p9): a gutter the body pages agree on splits welded reference columns', () => {
	const twoColumn = (rows: number, leftText: (i: number) => string, rightText: (i: number) => string, rightX = 306): SpanItem[] =>
		Array.from({ length: rows }, (_, i) => [
			{ text: leftText(i), rect: [54, 700 - i * 11, 291, 709 - i * 11] as [number, number, number, number], fontSize: 7.5 },
			{ text: rightText(i), rect: [rightX, 700 - i * 11, 545, 709 - i * 11] as [number, number, number, number], fontSize: 7.5 }
		]).flat();
	const body: StylePage = { pageWidth: 595, pageHeight: 842, items: twoColumn(40, i => `Left column body sentence ${i} continues here`, i => `Right column body sentence ${i} continues`) };
	const style = buildDocumentStyle([body, body, body]);
	assert.equal(style.columnGutters.length, 1);
	const gutter = style.columnGutters[0]!;
	assert.ok(gutter > 291 && gutter < 306, String(gutter));
	// Reference page: right-column numbers start at 303, inside the channel; the gap is only 12pt (1.6em).
	const refs = twoColumn(30, i => `${i + 5}. Hoppe B, Leumann E. Diagnostic approaches ${i}.`, i => `${i + 22}. Devresse A, Cochat P. Transplantation ${i}.`, 303);
	const welded = groupIntoLines(refs, 595, 842, true).filter(l => /Hoppe/.test(lineText(l)) && /Devresse/.test(lineText(l)));
	const split = groupIntoLines(refs, 595, 842, true, style.columnGutters).filter(l => /Hoppe/.test(lineText(l)) && /Devresse/.test(lineText(l)));
	assert.equal(split.length, 0, 'with the known gutter no line spans both columns');
	assert.ok(welded.length >= split.length);
});

// ---- 4. Measured first-line indent ---------------------------------------------

test('5.0 (3285 p3): a 0.75em first-line indent, measured from the document, starts a paragraph', () => {
	const W = 450, SZ = 10;
	const full = 'The study was approved by the ethical review authority and all patients gave written consent before';
	const at = (text: string, x: number, y: number, w = W): SpanItem => ({ text, rect: [x, y, x + w, y + SZ], fontSize: SZ });
	// Body pages: paragraphs whose first line is indented 7.5pt (0.75em).
	const bodyPage: StylePage = { pageWidth: 612, pageHeight: 792, items: Array.from({ length: 40 }, (_, i) =>
		at(full, i % 5 === 0 ? 79.5 : 72, 740 - i * 12, i % 5 === 0 ? W - 7.5 : W)) };
	const style = buildDocumentStyle([bodyPage, bodyPage]);
	assert.equal(style.paragraphIndent, 7.5);
	// Previous paragraph ends with a FULL line, next paragraph is indented 7.5pt.
	const page = [at(full, 72, 700), at(full, 72, 688), at('Five carotid plaques were randomly chosen from donations of patients undergoing', 79.5, 676, W - 7.5), at(full, 72, 664)];
	const lines = groupIntoLines(page, 612, 792);
	const fixed = groupIntoParagraphs(lines, 612, 792);
	const measured = groupIntoParagraphs(lines, 612, 792, [], null, { paragraphIndent: style.paragraphIndent, bodyFontSize: style.bodyFontSize });
	assert.equal(fixed.length, 1, 'the fixed 0.8em rule misses a 0.75em indent');
	assert.equal(measured.length, 2);
	assert.ok(lineText(measured[1]![0]!).startsWith('Five carotid'));
});

test('5.0: no measurable indent (manuscripts without one) keeps the fixed rule', () => {
	const flat: StylePage = { pageWidth: 612, pageHeight: 792, items: Array.from({ length: 40 }, (_, i) =>
		({ text: 'A manuscript line of body text that runs the full width of the column here', rect: [72, 740 - i * 12, 520, 750 - i * 12] as [number, number, number, number], fontSize: 10 })) };
	assert.equal(buildDocumentStyle([flat]).paragraphIndent, 0);
});
