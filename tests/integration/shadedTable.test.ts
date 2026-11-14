import {test} from 'node:test';
import assert from 'node:assert/strict';
import f from '../fixtures/regression/siemens-dcect-p4.spans.json';
import edges from '../fixtures/regression/siemens-dcect-p4.edges.json';
import {buildBlocksFromSpans, type SpanItem} from '../../src/reader/spanBlockBuilder';
import {orderBlocksForReading} from '../../src/reader/readingOrder';
import {structureTableCells} from '../../src/reader/tableStructure';
import {borderGrids, type Segment} from '../../src/reader/tableBorders';
import {finalizePageRegions} from '../../src/reader/pageRegions';

// 4.9: a table drawn only with alternate-row shading has no outer frame. Its
// first (Tumor type) and last (Year) columns used to fall outside the grid and
// were merged vertically as body text, so translations lost their rows.
const grids = borderGrids(edges.segments as Segment[], {pageHeight: f.pageHeight});
const initial = buildBlocksFromSpans(f.items as SpanItem[], {pageIndex: 3, pageWidth: f.pageWidth,
 pageHeight: f.pageHeight, includeReferences: true, grids}).blocks;
const final = finalizePageRegions(structureTableCells(orderBlocksForReading(initial), 3, 8, [], grids, true, f.pageHeight), f.pageHeight);

test('alternate-row shaded table keeps its outer columns in the border grid', () => {
 assert.equal(grids.length, 1);
 assert.deepEqual(grids[0]!.columns.map(Math.round), [77, 176, 279, 382, 484, 519]);
 assert.equal(grids[0]!.rows.length, 13, 'header plus eleven body rows');
});

test('every tumour-type row is its own cell next to its own marker, author and year', () => {
 const cells = final.filter(b => b.tableId !== undefined);
 const renal = cells.filter(b => b.sourceText === 'Renal cancer');
 assert.equal(renal.length, 3, 'three separate Renal cancer rows');
 assert.equal(new Set(renal.map(b => b.tableRow)).size, 3);
 assert.ok(renal.every(b => b.tableCol === 0));
 const bladder = cells.find(b => b.sourceText === 'Transitional cell carcinoma of the bladder');
 assert.ok(bladder && bladder.tableCol === 0);
 assert.ok(!renal.some(b => b.tableRow === bladder!.tableRow));
 const rowOf = (text: string) => cells.find(b => b.sourceText === text)!;
 const xie = rowOf('Xie et al. [18]'), year = cells.find(b => b.sourceText === '2005')!;
 assert.equal(xie.tableRow, bladder!.tableRow, 'author stays on the bladder row');
 assert.equal(year.tableRow, bladder!.tableRow, 'year column is inside the grid too');
 assert.ok(!final.some(b => b.tableId === undefined && /Renal cancer/.test(b.sourceText)), 'no body-text block swallows table rows');
});
