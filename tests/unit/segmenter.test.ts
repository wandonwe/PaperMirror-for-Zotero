import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBlocks, chunkByModules, planChunks, trailingContext, MAX_BLOCKS_PER_REQUEST } from '../../src/translation/segmenter';
import { buildLayoutModules } from '../../src/reader/layoutModules';
import type { BlockType, SourceBlock } from '../../src/types/models';

function block(id: string, len: number): SourceBlock {
	return { id, pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'x'.repeat(len) };
}

function typed(id: string, type: BlockType, len: number, column = 0): SourceBlock {
	return { id, pageIndex: 0, order: 0, type, sourceText: 'x'.repeat(len), column };
}

test('chunks by character budget', () => {
	const blocks = [block('a', 3000), block('b', 3000), block('c', 3000)];
	const chunks = chunkBlocks(blocks, 6000);
	assert.equal(chunks.length, 2);
});

test('chunks by max block count', () => {
	const blocks = Array.from({ length: MAX_BLOCKS_PER_REQUEST + 5 }, (_, i) => block('b' + i, 10));
	const chunks = chunkBlocks(blocks, 1_000_000);
	assert.equal(chunks.length, 2);
	assert.equal(chunks[0]!.length, MAX_BLOCKS_PER_REQUEST);
});

test('a single oversized block still forms its own chunk', () => {
	const chunks = chunkBlocks([block('big', 20000)], 6000);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0]!.length, 1);
});

test('trailingContext truncates to the tail', () => {
	const ctx = trailingContext([block('a', 2000)], 600);
	assert.equal(ctx.length, 600);
});

test('trailingContext of empty list is empty', () => {
	assert.equal(trailingContext([]), '');
});

// ---- module-aware chunking -------------------------------------------------

test('chunkByModules keeps a heading and its paragraphs in one request', () => {
	const blocks = [
		typed('h', 'heading', 40),
		typed('p1', 'paragraph', 1000),
		typed('p2', 'paragraph', 1000)
	];
	const chunks = chunkByModules(blocks, buildLayoutModules(blocks), 6000);
	assert.equal(chunks.length, 1);
	assert.deepEqual(chunks[0]!.map(b => b.id), ['h', 'p1', 'p2']);
});

test('chunkByModules lets several small modules share one request', () => {
	const blocks = [
		typed('h1', 'heading', 20), typed('a', 'paragraph', 500),
		typed('h2', 'heading', 20), typed('b', 'paragraph', 500)
	];
	const chunks = chunkByModules(blocks, buildLayoutModules(blocks), 6000);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0]!.length, 4);
});

test('chunkByModules starts a fresh request when the next module would overflow', () => {
	const blocks = [
		typed('h1', 'heading', 20), typed('a', 'paragraph', 3500),
		typed('h2', 'heading', 20), typed('b', 'paragraph', 3500)
	];
	const chunks = chunkByModules(blocks, buildLayoutModules(blocks), 6000);
	assert.equal(chunks.length, 2);
	assert.deepEqual(chunks[0]!.map(b => b.id), ['h1', 'a']);
	assert.deepEqual(chunks[1]!.map(b => b.id), ['h2', 'b']);
});

test('chunkByModules splits an oversized module but keeps block order', () => {
	const blocks = [
		typed('h', 'heading', 20),
		typed('p1', 'paragraph', 5000),
		typed('p2', 'paragraph', 5000)
	];
	const chunks = chunkByModules(blocks, buildLayoutModules(blocks), 6000);
	assert.ok(chunks.length >= 2);
	assert.deepEqual(chunks.flat().map(b => b.id), ['h', 'p1', 'p2']);
});

test('chunkByModules falls back to chunkBlocks when there are no modules', () => {
	const blocks = [block('a', 3000), block('b', 3000), block('c', 3000)];
	assert.equal(chunkByModules(blocks, [], 6000).length, 2);
});

test('chunkByModules covers every block exactly once', () => {
	const blocks = [
		typed('h', 'heading', 20, 0), typed('p1', 'paragraph', 100, 0),
		typed('p2', 'paragraph', 100, 1), typed('cap', 'caption', 50, 1)
	];
	const chunks = chunkByModules(blocks, buildLayoutModules(blocks), 6000);
	const ids = chunks.flat().map(b => b.id).sort();
	assert.deepEqual(ids, ['cap', 'h', 'p1', 'p2']);
});

// ---- soft-boundary planner (planChunks) ------------------------------------

test('planChunks packs many short subheading modules into one high-fill request', () => {
	const blocks: SourceBlock[] = [];
	for (let i = 0; i < 4; i++) {
		blocks.push(typed(`h${i}`, 'heading', 20));
		blocks.push(typed(`p${i}`, 'paragraph', 1000));
	}
	const chunks = planChunks(blocks, buildLayoutModules(blocks));
	assert.equal(chunks.length, 1, 'four short modules → one request, not four');
	assert.equal(chunks[0]!.blocks.length, 8);
	assert.equal(chunks[0]!.moduleContext, '');
});

test('planChunks splits an oversized module and carries the heading as moduleContext', () => {
	const h = typed('h', 'heading', 30);
	h.sourceText = 'Effects of fluid administration';
	const blocks = [h, typed('p1', 'paragraph', 6000), typed('p2', 'paragraph', 6000)];
	const chunks = planChunks(blocks, buildLayoutModules(blocks), { charBudget: 8000 });
	assert.ok(chunks.length >= 2);
	assert.equal(chunks[0]!.moduleContext, '', 'the chunk holding the heading needs no context');
	const cont = chunks.slice(1).find(c => c.blocks.every(b => b.id !== 'h'));
	assert.ok(cont, 'a continuation chunk exists');
	assert.equal(cont!.moduleContext, 'Effects of fluid administration');
	// heading is only ever sent once (it stays in its own chunk).
	assert.equal(chunks.flatMap(c => c.blocks).filter(b => b.id === 'h').length, 1);
});

test('planChunks never splits a single block and preserves reading order', () => {
	const blocks = [typed('h', 'heading', 20), typed('big', 'paragraph', 20000)];
	const chunks = planChunks(blocks, buildLayoutModules(blocks), { charBudget: 8000 });
	assert.deepEqual(chunks.flatMap(c => c.blocks.map(b => b.id)), ['h', 'big']);
});

test('planChunks respects the character budget', () => {
	const blocks = [typed('a', 'paragraph', 5000), typed('b', 'paragraph', 5000)];
	assert.equal(planChunks(blocks, buildLayoutModules(blocks), { charBudget: 8000 }).length, 2);
});

test('planChunks of empty input is empty', () => {
	assert.deepEqual(planChunks([], []), []);
});

// ---------------------------------------------------------------------------
// 0.9.25 批次2: 三分道 —— 高风险块隔离为单块慢道,快批保持既有打包
// ---------------------------------------------------------------------------

function para(id: string, text: string): SourceBlock {
	return { id, pageIndex: 0, order: 0, type: 'paragraph', sourceText: text };
}

test('risky blocks are isolated into single-block slow chunks at the tail', () => {
	const blocks = [
		para('b0', 'Normal paragraph one about methods and results.'),
		para('b1', 'x'.repeat(3000)), // very long → slow
		para('b2', 'Normal paragraph two continues the discussion.'),
		para('b3', 'Normal paragraph three closes the section.')
	];
	const chunks = planChunks(blocks, [], { riskOf: b => b.sourceText.length > 2400 });
	const fast = chunks.filter(c => c.lane === 'fast');
	const slow = chunks.filter(c => c.lane === 'slow');
	assert.equal(slow.length, 1);
	assert.equal(slow[0]!.blocks.length, 1);
	assert.equal(slow[0]!.blocks[0]!.id, 'b1');
	// fast chunks contain the remaining blocks, in order, and come FIRST
	assert.deepEqual(fast.flatMap(c => c.blocks.map(b => b.id)), ['b0', 'b2', 'b3']);
	assert.equal(chunks[chunks.length - 1]!.lane, 'slow');
});

test('without riskOf every chunk is a fast chunk (behaviour unchanged)', () => {
	const blocks = [para('a', 'one'), para('b', 'two')];
	const chunks = planChunks(blocks, []);
	assert.ok(chunks.every(c => c.lane === 'fast'));
});

// ---------------------------------------------------------------------------
// 2.2.0 item 3: 表格单元格硬边界 —— 单元格绝不与正文段落同请求
// ---------------------------------------------------------------------------

function cell(id: string, len: number, row: number, col: number): SourceBlock {
	return { id, pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'x'.repeat(len), tableRow: row, tableCol: col };
}

test('planChunks never packs table cells into the same request as body prose', () => {
	const blocks = [
		typed('h', 'heading', 20),
		para('p1', 'short body before the table'),
		cell('c1', 30, 0, 0), cell('c2', 30, 0, 1),
		cell('c3', 30, 1, 0), cell('c4', 30, 1, 1),
		para('p2', 'short body after the table')
	];
	const chunks = planChunks(blocks, buildLayoutModules(blocks));
	// No chunk mixes a cell (has tableRow/tableCol) with a non-cell block.
	for (const c of chunks) {
		const cells = c.blocks.filter(b => typeof b.tableRow === 'number').length;
		assert.ok(cells === 0 || cells === c.blocks.length,
			`chunk ${c.blocks.map(b => b.id)} mixes cells and body`);
	}
	// The four cells share a single request (batched, not one-per-cell).
	const cellChunk = chunks.find(c => c.blocks.some(b => b.id === 'c1'));
	assert.deepEqual(cellChunk!.blocks.map(b => b.id), ['c1', 'c2', 'c3', 'c4']);
});

// ---- 2.5.13: 表格标题作为单元格语境 (wu2026-p3 实证) -------------------------

test('table cells get the table caption as moduleContext (2.5.13)', async () => {
	const { planChunks } = await import('../../src/translation/segmenter');
	const { buildLayoutModules } = await import('../../src/reader/layoutModules');
	const mk = (id: string, type: string, text: string, extra: object = {}): SourceBlock => ({
		id, pageIndex: 2, order: 0, type: type as SourceBlock['type'], sourceText: text,
		boundingBox: { x: 0, y: 0, width: 100, height: 10 }, column: 0, ...extra
	});
	const caption = mk('cap', 'table', 'Table 1 The CT image acquisition and reconstruction protocols');
	const cells = [
		mk('c1', 'paragraph', 'Detector collimation (mm)', { tableRow: 0, tableCol: 0 }),
		mk('c2', 'paragraph', 'Pitch', { tableRow: 1, tableCol: 0 }),
		mk('c3', 'paragraph', 'Tube voltage (kV)', { tableRow: 2, tableCol: 0 })
	];
	const blocks = [caption, ...cells];
	const modules = buildLayoutModules(blocks);
	// riskOf 把 caption (type 'table') 抽进 slow 道 —— 单元格批次没有它。
	const chunks = planChunks(blocks, modules, { riskOf: b => b.type === 'table' });
	const cellChunk = chunks.find(c => c.blocks.some(b => b.id === 'c2'));
	assert.ok(cellChunk, 'cells are chunked');
	assert.ok(cellChunk!.moduleContext.includes('CT image acquisition'),
		`cells must carry the table caption as context, got: "${cellChunk!.moduleContext}"`);
	// caption 自己的 slow chunk 不用自己的文本当语境。
	const capChunk = chunks.find(c => c.blocks.some(b => b.id === 'cap'));
	assert.equal(capChunk!.moduleContext, '');
});

// ---- 2.7.1 (审核 EF-1): 正文流 / 单元格流两趟独立打包 ------------------------

test('planChunks: 阅读序里格与正文交替,同类批次合并 —— 恰 2 批 (2.7.1)', () => {
	// chen2023-p5 形态: 正文、格、正文、格、正文 —— 此前每次交替断一批 (5 批),
	// 现在正文流 1 批 + 单元格流 1 批。
	const blocks = [
		para('p1', 'body paragraph one before the first table'),
		cell('c1', 20, 0, 0), cell('c2', 20, 0, 1),
		para('p2', 'body paragraph two between the tables'),
		cell('c3', 20, 1, 0), cell('c4', 20, 1, 1),
		para('p3', 'body paragraph three after the tables')
	];
	const chunks = planChunks(blocks, buildLayoutModules(blocks));
	assert.equal(chunks.length, 2, `expected prose + cells, got ${chunks.map(c => c.blocks.map(b => b.id).join('+')).join(' | ')}`);
	assert.equal(chunks[0]!.kind, 'prose');
	assert.deepEqual(chunks[0]!.blocks.map(b => b.id), ['p1', 'p2', 'p3'], '正文流保持阅读序');
	assert.equal(chunks[1]!.kind, 'cells');
	assert.deepEqual(chunks[1]!.blocks.map(b => b.id), ['c1', 'c2', 'c3', 'c4'], '单元格流保持阅读序');
	// 硬边界不变: 绝不混装。
	for (const c of chunks) {
		const cells = c.blocks.filter(b => typeof b.tableRow === 'number').length;
		assert.ok(cells === 0 || cells === c.blocks.length);
	}
});

test('planChunks: 单元格批块数上限放宽到 MAX_CELLS_PER_REQUEST,正文仍是 24 (2.7.1)', async () => {
	const { MAX_CELLS_PER_REQUEST } = await import('../../src/translation/segmenter');
	assert.ok(MAX_CELLS_PER_REQUEST > MAX_BLOCKS_PER_REQUEST);
	const cells = Array.from({ length: MAX_CELLS_PER_REQUEST }, (_, i) => cell('c' + i, 8, Math.floor(i / 4), i % 4));
	const cellChunks = planChunks(cells, buildLayoutModules(cells));
	assert.equal(cellChunks.length, 1, `${MAX_CELLS_PER_REQUEST} short cells fit one request`);
	const paras = Array.from({ length: MAX_BLOCKS_PER_REQUEST + 1 }, (_, i) => para('p' + i, 'short body line ' + i));
	const proseChunks = planChunks(paras, buildLayoutModules(paras));
	assert.equal(proseChunks.length, 2, 'prose keeps the 24-block ceiling');
	// 显式 maxBlocks 对两流都生效。
	assert.equal(planChunks(cells, buildLayoutModules(cells), { maxBlocks: 10 }).length, Math.ceil(MAX_CELLS_PER_REQUEST / 10));
});

test('planChunks: 风险分道后,fast 批同样先正文后单元格,slow 批仍在尾部 (2.7.1)', () => {
	const blocks = [
		para('p1', 'body one'), cell('c1', 20, 0, 0), para('big', 'y'.repeat(3000)), cell('c2', 20, 0, 1), para('p2', 'body two')
	];
	const chunks = planChunks(blocks, buildLayoutModules(blocks), { riskOf: b => b.id === 'big' });
	assert.deepEqual(chunks.map(c => `${c.lane}:${c.kind}:${c.blocks.map(b => b.id).join('+')}`),
		['fast:prose:p1+p2', 'fast:cells:c1+c2', 'slow:prose:big']);
});
