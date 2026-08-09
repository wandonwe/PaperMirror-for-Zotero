/**
 * Table Row/Cell model for in-place cell translation.
 *
 * tableGuard finds a table's RECTANGLE and, until now, kept the whole thing in
 * the original language. That is safe but leaves text tables (a column of
 * "Section title" labels beside a column of prose recommendations) entirely in
 * English. This module infers the grid INSIDE a detected region so each cell
 * can be handled on its own:
 *
 *   - text cells (prose: labels, recommendations) → translated + replaced in
 *     place, confined to the cell's own rectangle;
 *   - data cells (numbers, value±sd, ranges, symbols) → kept original, so a
 *     numeric table's alignment and figures are never disturbed;
 *   - a fragment the extractor stitched ACROSS columns → kept original, so it
 *     can never be stamped in translation over the table.
 *
 * Pure geometry over plain boxes — fully unit-testable, no DOM, no PDF.
 */

import { looksTabular } from './tableGuard';

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface CellMember {
	id: string;
	box: Box;
	text: string;
	fontSize?: number;
}

export interface TableCell {
	/** Synthetic stable id: page-<p>-table-<t>-r<row>-c<col>. */
	id: string;
	/** Source block ids composing this cell, in reading order. */
	memberIds: string[];
	box: Box;
	text: string;
	row: number;
	col: number;
	/** text → translate & replace; data → keep original. */
	kind: 'text' | 'data';
}

export interface TableModel {
	region: Box;
	rowCount: number;
	colCount: number;
	cells: TableCell[];
}

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
	return Math.min(a1, b1) - Math.max(a0, b0);
}

function unionBox(boxes: Box[]): Box {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const b of boxes) {
		left = Math.min(left, b.left);
		top = Math.min(top, b.top);
		right = Math.max(right, b.left + b.width);
		bottom = Math.max(bottom, b.top + b.height);
	}
	return { left, top, width: right - left, height: bottom - top };
}

interface Band { start: number; end: number }

/**
 * Cluster 1-D intervals into bands (columns from x, rows from y). Seeds bands
 * from the NARROW members first so a wide cell that straddles two real columns
 * doesn't fuse them; then every member joins the band it overlaps most.
 */
function inferBands(
	intervals: { start: number; end: number }[],
	joinRatio: number
): Band[] {
	const seeds = [...intervals]
		.map((v, i) => ({ v, i }))
		.sort((a, b) => (a.v.end - a.v.start) - (b.v.end - b.v.start));
	const bands: Band[] = [];
	for (const { v } of seeds) {
		let joined = false;
		for (const band of bands) {
			const ov = overlap1D(band.start, band.end, v.start, v.end);
			const minW = Math.min(band.end - band.start, v.end - v.start);
			if (minW > 0 && ov > joinRatio * minW) {
				band.start = Math.min(band.start, v.start);
				band.end = Math.max(band.end, v.end);
				joined = true;
				break;
			}
		}
		if (!joined) {
			bands.push({ start: v.start, end: v.end });
		}
	}
	return bands.sort((a, b) => a.start - b.start);
}

/**
 * The band a member's interval overlaps most, and whether it truly straddles
 * ≥2 columns. "Straddles" means the cell COVERS most of two or more bands —
 * only a full-width fragment stitched across columns does that. A merely wide
 * legitimate column (e.g. "Key results") fills its own band and just clips a
 * neighbour, which must NOT count, or whole text tables get flagged as data
 * and left in English.
 */
function assignBand(start: number, end: number, bands: Band[]): { index: number; straddles: boolean } {
	let best = -1;
	let bestOv = 0;
	let covered = 0;
	for (let i = 0; i < bands.length; i++) {
		const ov = overlap1D(bands[i]!.start, bands[i]!.end, start, end);
		if (ov > bestOv) {
			bestOv = ov;
			best = i;
		}
		const bandW = bands[i]!.end - bands[i]!.start;
		if (bandW > 0 && ov > 0.5 * bandW) {
			covered++;
		}
	}
	return { index: best < 0 ? 0 : best, straddles: covered >= 2 };
}

/**
 * Build the Row/Cell model for one detected table region.
 *
 * `members` are the source blocks the guard assigned to this region (in pixel
 * space). `emPx` scales nothing here directly but is accepted for symmetry with
 * the guard; callers pass the body size.
 */
export function buildTableModel(
	pageIndex: number,
	tableIndex: number,
	region: Box,
	members: CellMember[]
): TableModel {
	if (!members.length) {
		return { region, rowCount: 0, colCount: 0, cells: [] };
	}

	// Columns from every member's x-extent. inferBands seeds from the NARROWEST
	// first, so real (narrow) column cells establish the bands before a wide
	// cross-column fragment can fuse them; a straddling cell is caught at
	// assignment instead.
	const colBands = inferBands(members.map(m => ({ start: m.box.left, end: m.box.left + m.box.width })), 0.4);
	// Rows from every member's vertical extent.
	const rowBands = inferBands(members.map(m => ({ start: m.box.top, end: m.box.top + m.box.height })), 0.4);

	interface Slot { members: CellMember[]; straddles: boolean }
	const slots = new Map<string, Slot>();
	for (const m of members) {
		const col = assignBand(m.box.left, m.box.left + m.box.width, colBands);
		const row = assignBand(m.box.top, m.box.top + m.box.height, rowBands);
		const key = `${row.index}:${col.index}`;
		const slot = slots.get(key) ?? { members: [], straddles: false };
		slot.members.push(m);
		slot.straddles = slot.straddles || col.straddles;
		slots.set(key, slot);
	}

	const cells: TableCell[] = [];
	for (const [key, slot] of slots) {
		const [row, col] = key.split(':').map(Number) as [number, number];
		const ordered = [...slot.members].sort((a, b) =>
			a.box.top - b.box.top || a.box.left - b.box.left);
		const text = ordered.map(m => m.text.trim()).filter(Boolean).join(' ');
		const box = unionBox(ordered.map(m => m.box));
		// A header-row cell that carries any actual word is a label to translate
		// (e.g. "2025 Recommendation"), not a data cell — looksTabular would
		// otherwise flag it just for containing a year.
		const hasWord = /[A-Za-z一-鿿]/.test(text);
		const isPureNumeric = /^[\d\s.,%±()/<>=+\-·—–]+$/.test(text);
		const kind: TableCell['kind'] =
			slot.straddles || !text ? 'data'
				: row === 0 && hasWord && !isPureNumeric ? 'text'
					: looksTabular(text) || text.length < 3 ? 'data' : 'text';
		cells.push({
			id: `page-${pageIndex}-table-${tableIndex}-r${row}-c${col}`,
			memberIds: ordered.map(m => m.id),
			box, text, row, col, kind
		});
	}

	coerceNumericColumns(cells, colBands.length);

	cells.sort((a, b) => a.row - b.row || a.col - b.col);
	return { region, rowCount: rowBands.length, colCount: colBands.length, cells };
}

/**
 * If a column is overwhelmingly data (a numbers column with one stray word),
 * keep the whole column original so its alignment is never broken. The header
 * row (row 0) is left as classified — a numeric column can still have a prose
 * heading that should translate.
 */
function coerceNumericColumns(cells: TableCell[], colCount: number): void {
	for (let c = 0; c < colCount; c++) {
		const body = cells.filter(cell => cell.col === c && cell.row > 0);
		if (body.length < 3) {
			continue;
		}
		const data = body.filter(cell => cell.kind === 'data').length;
		if (data / body.length >= 0.7) {
			for (const cell of body) {
				cell.kind = 'data';
			}
		}
	}
}
