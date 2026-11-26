import test from 'node:test';
import assert from 'node:assert/strict';
import { sidewaysBodyChars, ROTATED_TABLE_MIN_CHARS, buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';
import { capsuleStateFor, idleProgressFor, ROTATED_TABLE_NOTE } from '../../src/ui/statusCapsule';
import { readSource } from '../fixtures/sourceFamily';

/** A run printed sideways: its box is tall and narrow. */
const sideways = (text: string, x: number, y: number): SpanItem => ({ text, rect: [x, y, x + 7.5, y + text.length * 3.8], fontSize: 7.5 });

// 推荐模型校验 2897 末页 / 3386 p9–10: a table set rotated 90° on an upright page.
test('5.0: sideways body text is counted as a rotated table; the margin watermark strip is not', () => {
	const watermark = [0, 1, 2, 3].map(i => sideways('Author Manuscript', 22.8, 176 + i * 170));
	assert.equal(sidewaysBodyChars(watermark, 612), 0, 'edge strip only');
	const cells: SpanItem[] = [];
	for (let col = 0; col < 8; col++) for (let row = 0; row < 6; row++) cells.push(sideways(`-701.4±0.${row}`, 104 + row * 40, 380 + col * 45));
	const chars = sidewaysBodyChars([...watermark, ...cells], 612);
	assert.ok(chars >= ROTATED_TABLE_MIN_CHARS, String(chars));
	// A single rotated axis label is not a table.
	assert.ok(sidewaysBodyChars([sideways('Attenuation (HU)', 300, 300)], 612) < ROTATED_TABLE_MIN_CHARS);
	// Extraction still leaves the sideways runs out (policy for 5.0: keep original).
	const { blocks } = buildBlocksFromSpans(cells, { pageIndex: 15, pageWidth: 612, pageHeight: 792, includeReferences: true, imageRectsPdf: [] });
	assert.equal(blocks.length, 0);
});

test('5.0: the capsule says the rotated table stays in the source language', () => {
	const done = capsuleStateFor({ phase: 'done', currentPage: 16, totalPages: 16, segTotal: 3, segTranslated: 3, segPlaced: 3, kept: 0, note: ROTATED_TABLE_NOTE });
	assert.equal(done.sub, ROTATED_TABLE_NOTE);
	const idle = capsuleStateFor(idleProgressFor(16, 16, true, undefined, ROTATED_TABLE_NOTE));
	assert.equal(idle.sub, ROTATED_TABLE_NOTE);
	const partial = capsuleStateFor(idleProgressFor(10, 14, true, { placed: 20, kept: 2, segTotal: 22 }, ROTATED_TABLE_NOTE));
	assert.match(partial.sub ?? '', /旋转排版的表格保留原文/);
	// Pages without the note are unchanged.
	assert.equal(capsuleStateFor(idleProgressFor(3, 14, true)).sub, undefined);
});

test('5.0: the session attaches the rotated-table note to the final placement and the resting ring (结构性回归闸)', () => {
	const src = readSource('src/reader/readerSession.ts');
	assert.match(src, /kept,\s*\.\.\.this\.pageNote\(pageIndex\)/);
	assert.match(src, /placementTally\(stats\) : undefined, this\.pageNote\(pageIndex\)\.note\)/);
	assert.match(src, /this\.extractor\.hasRotatedTable\(pageIndex\)/);
});

test('真机 4.99.16 3386 p10: short runs of a rotated table do not leak as fragments; body text beside it is kept', () => {
	const items: SpanItem[] = [];
	// Rotated table in the left half: long sideways runs plus short ones ("Value", "–", "99)").
	for (let col = 0; col < 6; col++) for (let row = 0; row < 5; row++) items.push(sideways(`85.36 (77.18, 96.${row})`, 60 + col * 30, 120 + row * 110));
	items.push({ text: 'Value', rect: [200, 600, 208, 619], fontSize: 7.5 });
	items.push({ text: '–', rect: [90, 300, 98, 304], fontSize: 7.5 });
	items.push({ text: '99)', rect: [150, 410, 158, 421], fontSize: 7.5 });
	// Upright body column on the right.
	const body = ['revision rates between antioxidant stabilized and nonstabilized implants were compared', 'in this study, and a lower revision rate due to late wear related loosening was expected'];
	body.forEach((t, i) => items.push({ text: t, rect: [310, 700 - i * 12, 560, 709 - i * 12], fontSize: 9 }));
	const { blocks } = buildBlocksFromSpans(items, { pageIndex: 9, pageWidth: 595, pageHeight: 842, includeReferences: true, imageRectsPdf: [] });
	const texts = blocks.map(b => b.sourceText);
	assert.ok(!texts.some(t => /^(?:Value|–|99\))$/.test(t.trim())), texts.join(' / '));
	assert.ok(texts.some(t => t.includes('revision rates between') && t.includes('late wear')), texts.join(' / '));
});
