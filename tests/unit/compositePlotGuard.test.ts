import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceBlock } from '../../src/types/models';
import { preserveCollapsedPlotPanels } from '../../src/reader/compositePlotGuard';
import { structureTableCells } from '../../src/reader/tableStructure';

function fixture(): SourceBlock[] {
 return [
  { id: 'head', pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'Author (Year) Weight (95% CI)',
   tableId: 'plot', tableRow: 0, tableCol: 0, tableRectPdf: [50, 700, 500, 720], lineRectsPdf: [[50, 704, 300, 715]] },
  { id: 'body', pageIndex: 0, order: 1, type: 'paragraph', sourceText: 'Smith (2021) Lee (2018) Jones (2020) Random effects model Heterogeneity: I2 = 64%',
   fontSize: 10, tableId: 'plot', tableRow: 1, tableCol: 0, tableRectPdf: [50, 580, 500, 700],
   lineRectsPdf: [680, 660, 640, 620, 600].map(y => [50, y, 280, y + 10]) },
  { id: 'caption', pageIndex: 0, order: 2, type: 'caption', sourceText: 'Meta-analysis for correlation and bias.', lineRectsPdf: [[50, 530, 500, 540]] }
 ];
}

test('collapsed forest panels are preserved as a unit without mutating source blocks', () => {
 const blocks = fixture();
 const before = JSON.stringify(blocks);
 const guarded = preserveCollapsedPlotPanels(blocks);
 assert.ok(guarded.slice(0, 2).every(b => b.translationMode === 'preserve'));
 assert.equal(guarded[2], blocks[2]);
 assert.equal(JSON.stringify(blocks), before);
 assert.deepEqual(preserveCollapsedPlotPanels(guarded), guarded);
});

test('text and properly separated study tables remain translatable', () => {
 const prose = fixture();
 prose[1]!.sourceText = 'Recommendations from studies published in 2018, 2020 and 2021.';
 assert.equal(preserveCollapsedPlotPanels(prose), prose);
 const separated = fixture();
 separated[1]!.lineRectsPdf = [[50, 680, 280, 690]];
 assert.equal(preserveCollapsedPlotPanels(separated), separated);
 const bodyOnly = fixture().map(b => ({ ...b, tableId: undefined }));
 assert.equal(preserveCollapsedPlotPanels(bodyOnly), bodyOnly);
});

test('unowned overlay labels inside a forest panel are also protected, not outside captions', () => {
 const blocks = fixture();
 blocks.push({ id: 'overlay', pageIndex: 0, order: 3, type: 'paragraph', sourceText: 'Extra diagram label', lineRectsPdf: [[350, 620, 450, 630]] });
 const guarded = preserveCollapsedPlotPanels(blocks);
 assert.equal(guarded[3]!.translationMode, 'preserve');
 assert.equal(guarded[2]!.translationMode, undefined);
});

test('table extraction marks a collapsed panel before it can be sent for translation', () => {
 const guarded = structureTableCells(fixture(), 0, 10);
 assert.ok(guarded.filter(b => b.tableId === 'plot').every(b => b.translationMode === 'preserve'));
 assert.equal(guarded.find(b => b.id === 'caption')!.translationMode, undefined);
});


test('preserves the adjacent central illustration banner and its coloured background', () => {
 const blocks = fixture();
 blocks.push({ id: 'banner', pageIndex: 0, order: 3, type: 'paragraph', sourceText: 'C E NTR AL IL L USTR AT IO N Meta-analysis',
  lineRectsPdf: [[50, 730, 500, 740]], fontSize: 10 });
 const guarded = preserveCollapsedPlotPanels(blocks);
 assert.equal(guarded[3]!.translationMode, 'preserve');
 assert.equal(guarded[2]!.translationMode, undefined);
});
