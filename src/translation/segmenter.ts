/**
 * Splits a page's blocks into request-sized chunks so a single request stays
 * well inside model context limits. Pure module (unit-tested).
 */

import type { SourceBlock } from '../types/models';
import type { LayoutModule } from '../reader/layoutModules';

/** Per-request budget in characters. Higher fill = fewer round-trips. */
export const DEFAULT_CHUNK_BUDGET = 8000;
export const MAX_BLOCKS_PER_REQUEST = 24;
/** Below this fill fraction we keep packing across a module boundary. */
export const DEFAULT_TARGET_FILL = 0.85;

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

/**
 * Soft-boundary translation planner (spec: modules become CONTEXT tags, the
 * character budget is the real request boundary).
 *
 * Difference from chunkByModules: a semantic module is a *preferred* break, not
 * a hard one. We pack blocks greedily to a high fill; a module boundary only
 * ends a chunk when the chunk is already at/above the target fill, so a page
 * with many short subheadings no longer explodes into 4–8 half-empty requests.
 * When a heading-anchored module DOES get split across chunks, the continuation
 * chunk carries the heading as `moduleContext` — the model gets the section
 * heading for understanding, and the heading is translated only once (it stays
 * a normal block in its own chunk; it is never re-sent for translation).
 *
 * A single SourceBlock is never split. Output preserves reading order.
 */
export interface PlannedChunk {
	blocks: SourceBlock[];
	/** Section heading for understanding only; '' when none applies. */
	moduleContext: string;
	/**
	 * 三分道 (参照 retain-pdf batched_fast / single_slow): 'fast' chunks are
	 * densely packed low-risk batches and run first; 'slow' chunks isolate one
	 * high-risk block each (tables, very long paragraphs, formula-dense text)
	 * so a hard block can neither sink a 24-block batch through id drift or
	 * truncation, nor delay the fast batches that paint most of the page.
	 */
	lane: 'fast' | 'slow';
}

export function planChunks(
	blocks: SourceBlock[],
	modules: LayoutModule[],
	opts?: {
		charBudget?: number;
		maxBlocks?: number;
		targetFill?: number;
		/** Marks a block as high-risk → isolated into its own 'slow' chunk. */
		riskOf?: (block: SourceBlock) => boolean;
	}
): PlannedChunk[] {
	const charBudget = opts?.charBudget ?? DEFAULT_CHUNK_BUDGET;
	const maxBlocks = opts?.maxBlocks ?? MAX_BLOCKS_PER_REQUEST;
	const targetFill = opts?.targetFill ?? DEFAULT_TARGET_FILL;
	if (!blocks.length) {
		return [];
	}
	// Risk split first: risky blocks leave the packing stream entirely and come
	// back at the END as single-block slow chunks, in reading order.
	const riskOf = opts?.riskOf;
	const slowBlocks = riskOf ? blocks.filter(b => riskOf(b)) : [];
	if (slowBlocks.length) {
		const slowIds = new Set(slowBlocks.map(b => b.id));
		const fast = planChunks(blocks.filter(b => !slowIds.has(b.id)), modules,
			{ charBudget, maxBlocks, targetFill });
		const byId = new Map(blocks.map(b => [b.id, b]));
		const headingOf = new Map<string, string>();
		for (const mod of modules) {
			if (mod.anchorType === 'heading') {
				const heading = byId.get(mod.anchorId)?.sourceText ?? '';
				for (const id of mod.memberIds) {
					headingOf.set(id, heading);
				}
			}
		}
		return [
			...fast,
			...slowBlocks.map(b => ({
				blocks: [b],
				moduleContext: headingOf.get(b.id) ?? '',
				lane: 'slow' as const
			}))
		];
	}

	const byId = new Map(blocks.map(b => [b.id, b]));
	const moduleOf = new Map<string, string>();
	const anchorOf = new Map<string, string>();
	const headingOf = new Map<string, string>();
	for (const mod of modules) {
		anchorOf.set(mod.id, mod.anchorId);
		if (mod.anchorType === 'heading') {
			headingOf.set(mod.id, byId.get(mod.anchorId)?.sourceText ?? '');
		}
		for (const id of mod.memberIds) {
			moduleOf.set(id, mod.id);
		}
	}
	// 表格块硬分隔 (2.2.0, 计划 item 3): 表格模块(单元格)与正文之间是**硬**边界
	// —— 单元格绝不与正文段落打进同一个请求(否则表头/数据行译文互相污染、id 漂移)。
	// 单元格之间仍按预算批量,不逐格请求。
	const tableBlockIds = new Set<string>();
	for (const mod of modules) {
		if (mod.anchorType === 'table') {
			for (const id of mod.memberIds) {
				tableBlockIds.add(id);
			}
		}
	}

	const contextFor = (chunkBlocks: SourceBlock[]): string => {
		const first = chunkBlocks[0];
		if (!first) {
			return '';
		}
		const mid = moduleOf.get(first.id);
		if (!mid || !headingOf.has(mid)) {
			return '';
		}
		// Only a CONTINUATION (the heading block landed in an earlier chunk) needs
		// the heading echoed as context.
		const anchorId = anchorOf.get(mid);
		const hasAnchor = chunkBlocks.some(b => b.id === anchorId);
		return hasAnchor ? '' : (headingOf.get(mid) ?? '');
	};

	const chunks: PlannedChunk[] = [];
	let cur: SourceBlock[] = [];
	let size = 0;
	const flush = (): void => {
		if (cur.length) {
			chunks.push({ blocks: cur, moduleContext: contextFor(cur), lane: 'fast' });
			cur = [];
			size = 0;
		}
	};
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!;
		const bs = b.sourceText.length;
		const startsNewModule = i > 0 && moduleOf.get(b.id) !== moduleOf.get(blocks[i - 1]!.id);
		// 表格硬边界 (2.2.0, item 3): 单元格与正文之间无条件断开,无论填充率。
		// 一个请求要么全是表格单元格、要么全是正文 —— 绝不混装,避免译文互相污染
		// 与 id 漂移。单元格之间仍受下面的预算/块数上限约束批量打包。
		if (cur.length && tableBlockIds.has(b.id) !== tableBlockIds.has(cur[cur.length - 1]!.id)) {
			flush();
		}
		// Prefer to keep modules whole: end the chunk at a module boundary once it
		// is already full enough.
		if (cur.length && startsNewModule && size >= charBudget * targetFill) {
			flush();
		}
		// Hard boundary: never exceed the budget or the block ceiling.
		if (cur.length && (size + bs > charBudget || cur.length >= maxBlocks)) {
			flush();
		}
		cur.push(b);
		size += bs;
	}
	flush();
	return chunks;
}

/** Trailing context (last N chars of the previous chunk/page) for coherence.
 *  上下文收窄 (2.3.5, 第四批 item7 · API-7): 600→300 —— 术语/语气衔接靠最后
 *  一两句就够,600 字的边际收益递减,每 chunk 白付 ~150 输入 token。 */
export function trailingContext(blocks: SourceBlock[], maxChars = 300): string {
	if (!blocks.length) {
		return '';
	}
	const text = blocks[blocks.length - 1]!.sourceText;
	return text.length <= maxChars ? text : text.slice(-maxChars);
}
