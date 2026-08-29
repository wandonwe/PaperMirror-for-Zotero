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

import { detectTableRegions, looksTabular } from './tableGuard';
import type { SourceBlock } from '../types/models';

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
	// 表级 email 探测 (2.5.13): 纯人名格保留规则的前提 —— 见下方 nameOnly。
	const tableHasEmail = [...slots.values()].some(sl =>
		sl.members.some(m => /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/.test(m.text)));
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
		// 微小符号格 (2.3.7, 基线 doc1 实证): ≤4 字符且不含 2+ 连续字母/汉字的格
		// ("R²"、"n=5"、"±SD")翻译无意义 —— 送去只会被验收拒掉再计入 tableFailed,
		// 白费请求。直接归 data/preserve。
		const tinySymbol = text.length <= 4 && !/[A-Za-z一-鿿]{2,}/.test(text);
		// 联系人格保留 (2.5.13, wu2026-p1 实证): 含 email 的格是通讯信息
		// ("Weifeng Han hanweifeng1981@163.com"),翻译只会把人名猜成汉字、
		// 邮箱被改写 —— 按数据格 preserve,原样保留。同一张表里的纯人名格
		// ("Weifeng Han" 单独一格、email 在下一格) 一并保留: 判据是【表内
		// 存在 email 格】+ 该格全部 token 是 TitleCase 名形态 —— 数据表没有
		// email,不受影响。
		const hasEmail = /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/.test(text);
		const nameOnly = tableHasEmail && text.length <= 40
			&& text.split(/\s+/).filter(Boolean).length >= 2
			&& text.split(/\s+/).filter(Boolean).every(w => /^[A-Z][a-zA-Z'’.-]*$/.test(w));
		const kind: TableCell['kind'] =
			slot.straddles || !text || hasEmail || nameOnly ? 'data'
				: row === 0 && hasWord && !isPureNumeric ? 'text'
					: looksTabular(text) || text.length < 3 || tinySymbol ? 'data' : 'text';
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

function contained(box: Box, region: Box): number {
	const w = Math.min(box.left + box.width, region.left + region.width) - Math.max(box.left, region.left);
	const h = Math.min(box.top + box.height, region.top + region.height) - Math.max(box.top, region.top);
	return w > 0 && h > 0 && box.width > 0 && box.height > 0 ? (w * h) / (box.width * box.height) : 0;
}

/**
 * Extraction-stage table normalization. This runs before prose coalescing so a
 * row or column can never be welded into a body paragraph. Text cells receive
 * stable ids and become provider request units; numeric/data cells remain in
 * the page model but are explicitly marked preserve.
 */
export function structureTableCells(blocks: SourceBlock[], pageIndex: number, em: number): SourceBlock[] {
	const originalById = new Map(blocks.map(block => [block.id, block]));
	const geometric = blocks.filter((b): b is SourceBlock & { boundingBox: NonNullable<SourceBlock['boundingBox']> } => !!b.boundingBox);
	if (geometric.length < 2) {
		return blocks;
	}
	const guard = detectTableRegions(geometric.map(b => ({
		id: b.id,
		text: b.sourceText,
		type: b.type,
		box: { left: b.boundingBox.x, top: b.boundingBox.y, width: b.boundingBox.width, height: b.boundingBox.height },
		fontSize: b.fontSize
	})), Math.max(6, em));
	if (!guard.regions.length) {
		return blocks;
	}

	const consumed = new Set<string>();
	const cells: SourceBlock[] = [];
	guard.regions.forEach((region, tableIndex) => {
		const members = geometric.filter(b => contained({
			left: b.boundingBox.x, top: b.boundingBox.y,
			width: b.boundingBox.width, height: b.boundingBox.height
		}, region) >= 0.5).map(b => ({
			id: b.id,
			box: { left: b.boundingBox.x, top: b.boundingBox.y, width: b.boundingBox.width, height: b.boundingBox.height },
			text: b.sourceText,
			fontSize: b.fontSize
		}));
		const model = buildTableModel(pageIndex, tableIndex, region, members);
		for (const cell of model.cells) {
			const originals = cell.memberIds.map(id => originalById.get(id)).filter((b): b is SourceBlock => !!b);
			if (!originals.length) continue;
			for (const original of originals) consumed.add(original.id);
			const sizes = originals.map(b => b.fontSize ?? 0).filter(Boolean).sort((a, b) => a - b);
			// PAGE column, not table column (审核 P1): `column` drives the page
			// reading order — a 3-column table must not turn a 1-column page into
			// a fake 3-column layout. The cell inherits the page column of its
			// member fragments (unanimous → that column, mixed → -1 full-width);
			// the table-internal column index lives in `tableCol`.
			const memberColumns = originals
				.map(b => b.column)
				.filter((c): c is number => typeof c === 'number');
			const pageColumn = memberColumns.length
				? (memberColumns.every(c => c === memberColumns[0]) ? memberColumns[0]! : -1)
				: undefined;
			cells.push({
				id: cell.id,
				pageIndex,
				order: Math.min(...originals.map(b => b.order)),
				type: 'paragraph',
				sourceText: cell.text,
				boundingBox: { x: cell.box.left, y: cell.box.top, width: cell.box.width, height: cell.box.height },
				lineRectsPdf: originals.flatMap(b => b.lineRectsPdf ?? []),
				fontSize: sizes.length ? sizes[Math.floor(sizes.length / 2)] : undefined,
				column: pageColumn,
				tableCol: cell.col,
				tableRow: cell.row,
				...((): { formulaRuns?: string[] } => {
					const runs = [...new Set(originals.flatMap(b => b.formulaRuns ?? []))];
					return runs.length ? { formulaRuns: runs } : {};
				})(),
				memberIds: cell.memberIds,
				isReference: originals.some(b => b.isReference),
				translationMode: cell.kind === 'data' ? 'preserve' : 'translate'
			});
		}
	});
	const out = [...blocks.filter(b => !consumed.has(b.id)), ...cells]
		.sort((a, b) => a.order - b.order || (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0));
	return out.map((b, order) => ({ ...b, order }));
}
