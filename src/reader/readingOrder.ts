/**
 * Canonical reading order for column pages.
 *
 * The char/text-layer stream often emits a two-column page ROW-WISE — left
 * line, right line, left line… coalesceRegions only merges CONSECUTIVE blocks,
 * so in stream order the same-column neighbours are never adjacent and the
 * one-line shreds never rejoin: every line translates alone, and stat-heavy
 * lines get rejected — the EN/ZH zebra page.
 *
 * This pass rebuilds the canonical order from geometry: full-width blocks
 * (column −1) act as horizontal SECTION SEPARATORS splitting the page into
 * bands; within each band the columns are emitted left-to-right, each top to
 * bottom. This also fixes the audit finding that a mid-page full-width block
 * (spanning caption/table) used to be emitted after the whole right column.
 *
 * Pure module — geometry only, no DOM.
 */

import type { SourceBlock } from '../types/models';

/** Top edge in top-origin page coordinates (smaller = higher on the page). */
function topOf(b: SourceBlock): number {
	return b.boundingBox ? b.boundingBox.y : 0;
}

function bottomOf(b: SourceBlock): number {
	return b.boundingBox ? b.boundingBox.y + b.boundingBox.height : 0;
}

/** Stamp the explicit reading-order index; used by every return path so the
 * field is always present (stream order IS the reading order when the page has
 * no usable column geometry). */
function stampReadingIndex(blocks: SourceBlock[]): SourceBlock[] {
	return blocks.map((b, i) => (b.readingIndex === i ? b : { ...b, readingIndex: i }));
}

export function orderBlocksForReading(blocks: SourceBlock[]): SourceBlock[] {
	if (blocks.length < 4) {
		return stampReadingIndex(blocks);
	}
	// Geometry and column stamps must be present on every block, and there must
	// actually be ≥2 columns — otherwise stream order is the best we have.
	if (blocks.some(b => !b.boundingBox || typeof b.column !== 'number')) {
		return stampReadingIndex(blocks);
	}
	const columnIds = new Set(blocks.filter(b => (b.column ?? 0) >= 0).map(b => b.column));
	if (columnIds.size < 2) {
		return stampReadingIndex(blocks);
	}

	const wides = blocks.filter(b => b.column === -1).sort((a, b) => topOf(a) - topOf(b));
	const columns = blocks.filter(b => b.column !== -1);

	// Band index of a column block = number of full-width separators fully
	// above it (small tolerance for touching edges).
	const bandOf = (b: SourceBlock): number => {
		let n = 0;
		for (const w of wides) {
			if (bottomOf(w) <= topOf(b) + 2) {
				n++;
			}
		}
		return n;
	};

	const byBand = new Map<number, SourceBlock[]>();
	for (const b of columns) {
		const k = bandOf(b);
		const list = byBand.get(k) ?? [];
		list.push(b);
		byBand.set(k, list);
	}

	const out: SourceBlock[] = [];
	const emitBand = (k: number): void => {
		const list = byBand.get(k);
		if (!list) {
			return;
		}
		list.sort((a, b) => (a.column! - b.column!) || (topOf(a) - topOf(b)));
		out.push(...list);
	};
	emitBand(0);
	for (let i = 0; i < wides.length; i++) {
		out.push(wides[i]!);
		emitBand(i + 1);
	}

	// Renumber `order` to the canonical sequence (ids stay stable).
	return out.map((b, i) => ({ ...b, order: i, readingIndex: i }));
}
