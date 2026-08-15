import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePageIR, type PageIR } from '../../src/ir/documentIR';
import { buildBlocks } from '../../src/reader/blockBuilder';
import { orderBlocksForReading } from '../../src/reader/readingOrder';
import { structureTableCells } from '../../src/reader/tableStructure';
import { coalesceRegions } from '../../src/reader/regionCoalescer';
import type { SourceBlock } from '../../src/types/models';
import * as fixtures from '../fixtures/pageFixtures';

function block(partial: Partial<SourceBlock> & { id: string }): SourceBlock {
	return {
		pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'text', readingIndex: 0,
		...partial
	} as SourceBlock;
}

test('validatePageIR: clean page passes', () => {
	const ir: PageIR = {
		pageIndex: 0,
		blocks: [
			block({ id: 'a', readingIndex: 0 }),
			block({ id: 'b', readingIndex: 1, boundingBox: { x: 1, y: 1, width: 10, height: 10 } })
		]
	};
	assert.deepEqual(validatePageIR(ir), []);
});

test('validatePageIR: each invariant fires on its violation', () => {
	const ir: PageIR = {
		pageIndex: 2,
		blocks: [
			block({ id: 'dup', pageIndex: 2, readingIndex: 0 }),
			block({ id: 'dup', pageIndex: 2, readingIndex: 1 }),                                  // unique-id
			block({ id: 'wrongpage', pageIndex: 3, readingIndex: 2 }),                            // page-index
			block({ id: 'unordered', pageIndex: 2, readingIndex: 7 }),                            // reading-index
			block({ id: 'halfcell', pageIndex: 2, readingIndex: 4, tableCol: 1 }),                // table-cell-pair
			block({ id: 'ph', pageIndex: 2, readingIndex: 5, translationMode: 'preserve', placeholders: [{ token: '⟦PM0⟧', original: 'x' }] }), // preserve-no-placeholders
			block({ id: 'empty', pageIndex: 2, readingIndex: 6, memberIds: [] }),                 // member-ids-nonempty
			block({ id: 'flat', pageIndex: 2, readingIndex: 7, boundingBox: { x: 0, y: 0, width: 5, height: 0 } }) // positive-box
		]
	};
	const got = new Set(validatePageIR(ir).map(v => v.invariant));
	for (const inv of ['unique-id', 'page-index', 'reading-index', 'table-cell-pair', 'preserve-no-placeholders', 'member-ids-nonempty', 'positive-box']) {
		assert.ok(got.has(inv), `expected violation ${inv}, got ${[...got].join(',')}`);
	}
});

test('IR contract: the real extraction pipeline output satisfies every invariant', () => {
	// Same composition as TextExtractor.extractPage path 1: buildBlocks →
	// order → structureTableCells → coalesce prose → final order.
	for (const [name, chars] of [
		['englishSingleColumn', fixtures.englishSingleColumn],
		['englishTwoColumn', fixtures.englishTwoColumn]
	] as const) {
		const result = buildBlocks(chars, { pageIndex: 0, pageWidth: 600, pageHeight: 792, includeReferences: false });
		const structured = structureTableCells(orderBlocksForReading(result.blocks), 0, 10);
		const tableCells = structured.filter(b => b.translationMode !== undefined);
		const prose = coalesceRegions(structured.filter(b => b.translationMode === undefined), []);
		const blocks = orderBlocksForReading([...prose, ...tableCells]);
		const violations = validatePageIR({ pageIndex: 0, blocks });
		assert.deepEqual(violations, [], `${name}: ${JSON.stringify(violations.slice(0, 3))}`);
	}
});
