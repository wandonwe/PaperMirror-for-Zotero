import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayoutModules } from '../../src/reader/layoutModules';
import type { BlockType, SourceBlock } from '../../src/types/models';

let seq = 0;
function block(type: BlockType, text: string, column = 0): SourceBlock {
	const order = seq++;
	return { id: `b${order}`, pageIndex: 0, order, type, sourceText: text, column };
}

test('a heading groups the paragraphs that follow it in the same column', () => {
	seq = 0;
	const h = block('heading', 'Deleterious effects of inotropic therapy');
	const p1 = block('paragraph', 'para one');
	const p2 = block('paragraph', 'para two');
	const mods = buildLayoutModules([h, p1, p2]);
	assert.equal(mods.length, 1);
	assert.equal(mods[0]!.anchorType, 'heading');
	assert.equal(mods[0]!.anchorId, h.id);
	assert.deepEqual(mods[0]!.memberIds, [h.id, p1.id, p2.id]);
	// moduleId is stamped back onto every member block.
	assert.equal(p2.moduleId, mods[0]!.id);
});

test('each heading starts its own module', () => {
	seq = 0;
	const blocks = [block('heading', 'A'), block('paragraph', 'a1'), block('heading', 'B'), block('paragraph', 'b1')];
	const mods = buildLayoutModules(blocks);
	assert.equal(mods.length, 2);
	assert.deepEqual(mods[0]!.memberIds, [blocks[0]!.id, blocks[1]!.id]);
	assert.deepEqual(mods[1]!.memberIds, [blocks[2]!.id, blocks[3]!.id]);
});

test('a figure caption is a hard anchor that breaks the running body', () => {
	seq = 0;
	const h = block('heading', 'Results');
	const p1 = block('paragraph', 'body');
	const cap = block('caption', 'Figure 1. A plot.');
	const p2 = block('paragraph', 'after the figure');
	const mods = buildLayoutModules([h, p1, cap, p2]);
	assert.deepEqual(mods.map(m => m.anchorType), ['heading', 'figure', 'column-continuation']);
	assert.deepEqual(mods[0]!.memberIds, [h.id, p1.id]);
	assert.deepEqual(mods[1]!.memberIds, [cap.id]);
	assert.deepEqual(mods[2]!.memberIds, [p2.id]);
});

test('a table is its own hard anchor and consecutive table rows stay together', () => {
	seq = 0;
	const t1 = block('table', 'Table 1 header');
	const t2 = block('table', 'row values');
	const mods = buildLayoutModules([t1, t2]);
	assert.equal(mods.length, 1);
	assert.equal(mods[0]!.anchorType, 'table');
	assert.deepEqual(mods[0]!.memberIds, [t1.id, t2.id]);
});

test('synthetic table cells (type paragraph + tableRow/tableCol) anchor as a table module', () => {
	seq = 0;
	// Structuring emits cells as type:'paragraph' (rendering needs it) but stamps
	// tableRow/tableCol. They must route as a 'table' anchor, not body prose.
	const h = block('heading', 'Results');
	const p = block('paragraph', 'body before the table');
	const c1: SourceBlock = { ...block('paragraph', 'Group'), tableRow: 0, tableCol: 0 };
	const c2: SourceBlock = { ...block('paragraph', 'Outcome'), tableRow: 0, tableCol: 1 };
	const after = block('paragraph', 'body after the table');
	const mods = buildLayoutModules([h, p, c1, c2, after]);
	assert.deepEqual(mods.map(m => m.anchorType),
		['heading', 'table', 'column-continuation']);
	// consecutive cells collapse into one table module
	assert.deepEqual(mods[1]!.memberIds, [c1.id, c2.id]);
	assert.deepEqual(mods[2]!.memberIds, [after.id]);
});

test('modules never cross columns (right column starts a fresh module)', () => {
	seq = 0;
	const h = block('heading', 'Section', 0);
	const p1 = block('paragraph', 'left body', 0);
	const p2 = block('paragraph', 'right column top', 1);
	const mods = buildLayoutModules([h, p1, p2]);
	assert.equal(mods.length, 2);
	assert.deepEqual(mods[0]!.memberIds, [h.id, p1.id]);
	assert.equal(mods[0]!.column, 0);
	assert.equal(mods[1]!.anchorType, 'column-continuation');
	assert.equal(mods[1]!.column, 1);
	assert.deepEqual(mods[1]!.memberIds, [p2.id]);
});

test('body with no heading above gets a virtual column-continuation anchor', () => {
	seq = 0;
	const p0 = block('paragraph', 'continues previous column');
	const h = block('heading', 'New section');
	const p1 = block('paragraph', 'under heading');
	const mods = buildLayoutModules([p0, h, p1]);
	assert.equal(mods[0]!.anchorType, 'column-continuation');
	assert.deepEqual(mods[0]!.memberIds, [p0.id]);
	assert.equal(mods[1]!.anchorType, 'heading');
	assert.deepEqual(mods[1]!.memberIds, [h.id, p1.id]);
});

test('the references heading opens a references module that absorbs entries by reading order', () => {
	seq = 0;
	const h = block('heading', 'Discussion');
	const p1 = block('paragraph', 'body');
	const refH = block('heading', 'References');
	const r1 = block('paragraph', '[1] Smith 2020', 0);
	const r2 = block('paragraph', '[2] Doe 2021', 1); // different column still joins
	const mods = buildLayoutModules([h, p1, refH, r1, r2]);
	assert.deepEqual(mods.map(m => m.anchorType), ['heading', 'references']);
	assert.deepEqual(mods[1]!.memberIds, [refH.id, r1.id, r2.id]);
});

test('empty input yields no modules', () => {
	assert.deepEqual(buildLayoutModules([]), []);
});
