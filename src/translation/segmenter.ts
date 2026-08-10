/**
 * Splits a page's blocks into request-sized chunks so a single request stays
 * well inside model context limits. Pure module (unit-tested).
 */

import type { SourceBlock } from '../types/models';
import type { LayoutModule } from '../reader/layoutModules';

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

/**
 * Module-aware chunking (spec: "模块可以整体理解和翻译").
 *
 * Packs whole semantic modules into requests so a heading and its paragraphs
 * reach the model TOGETHER (the model sees the section context), while still
 * returning one translation per block id — nothing is merged. Rules:
 *   - a module that fits the budget is never split; several small modules may
 *     share one request (extra context is only ever helpful);
 *   - a single module larger than the budget is split across requests but its
 *     blocks stay in reading order and contiguous;
 *   - the per-request block ceiling still applies.
 * Output shape is identical to chunkBlocks(): SourceBlock[][] in reading order.
 */
export function chunkByModules(blocks: SourceBlock[], modules: LayoutModule[], budget: number = DEFAULT_CHUNK_BUDGET): SourceBlock[][] {
	if (!modules.length) {
		return chunkBlocks(blocks, budget);
	}
	const byId = new Map(blocks.map(b => [b.id, b]));
	const chunks: SourceBlock[][] = [];
	let current: SourceBlock[] = [];
	let size = 0;
	const flush = (): void => {
		if (current.length) {
			chunks.push(current);
			current = [];
			size = 0;
		}
	};
	for (const mod of modules) {
		const members = mod.memberIds
			.map(id => byId.get(id))
			.filter((b): b is SourceBlock => !!b);
		if (!members.length) {
			continue;
		}
		const modSize = members.reduce((n, b) => n + b.sourceText.length, 0);
		if (modSize <= budget && members.length <= MAX_BLOCKS_PER_REQUEST) {
			// Keep the module whole; start a fresh request if it would overflow.
			if (current.length && (size + modSize > budget || current.length + members.length > MAX_BLOCKS_PER_REQUEST)) {
				flush();
			}
			current.push(...members);
			size += modSize;
		}
		else {
			// Oversized module: must be split. Flush first so it starts clean,
			// then pack its blocks in order.
			flush();
			for (const b of members) {
				const bs = b.sourceText.length;
				if (current.length && (size + bs > budget || current.length >= MAX_BLOCKS_PER_REQUEST)) {
					flush();
				}
				current.push(b);
				size += bs;
			}
		}
	}
	flush();

	// Any block not covered by a module (shouldn't happen — every block is
	// assigned) is swept up so nothing is silently dropped.
	const covered = new Set(chunks.flat().map(b => b.id));
	const leftovers = blocks.filter(b => !covered.has(b.id));
	if (leftovers.length) {
		chunks.push(...chunkBlocks(leftovers, budget));
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
