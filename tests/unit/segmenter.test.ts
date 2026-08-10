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
