import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBlocks, trailingContext, MAX_BLOCKS_PER_REQUEST } from '../../src/translation/segmenter';
import type { SourceBlock } from '../../src/types/models';

function block(id: string, len: number): SourceBlock {
	return { id, pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'x'.repeat(len) };
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
