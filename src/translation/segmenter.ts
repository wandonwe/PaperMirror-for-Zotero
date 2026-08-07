/**
 * Splits a page's blocks into request-sized chunks so a single request stays
 * well inside model context limits. Pure module (unit-tested).
 */

import type { SourceBlock } from '../types/models';

/** Conservative per-request budget in characters (≈ safe for all providers). */
export const DEFAULT_CHUNK_BUDGET = 6000;
export const MAX_BLOCKS_PER_REQUEST = 24;

export function chunkBlocks(blocks: SourceBlock[], budget: number = DEFAULT_CHUNK_BUDGET): SourceBlock[][] {
	const chunks: SourceBlock[][] = [];
	let current: SourceBlock[] = [];
	let size = 0;
	for (const block of blocks) {
		const blockSize = block.sourceText.length;
		const wouldOverflow = current.length > 0
			&& (size + blockSize > budget || current.length >= MAX_BLOCKS_PER_REQUEST);
		if (wouldOverflow) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(block);
		size += blockSize;
	}
	if (current.length) {
		chunks.push(current);
	}
	return chunks;
}

/** Trailing context (last N chars of the previous chunk/page) for coherence. */
export function trailingContext(blocks: SourceBlock[], maxChars = 600): string {
	if (!blocks.length) {
		return '';
	}
	const text = blocks[blocks.length - 1]!.sourceText;
	return text.length <= maxChars ? text : text.slice(-maxChars);
}
