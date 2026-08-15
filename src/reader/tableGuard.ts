/**
 * Table protection for the rebuilt page.
 *
 * Extraction shreds a data table into dozens of tiny "paragraphs" — numbers,
 * units, row labels. Translating those cell fragments and re-flowing them
 * produced translated text stamped across the table (the worst-looking failure
 * the reader sees). Until real Table→Row→Cell re-layout exists, the safe
 * behaviour is: detect the table's rectangle, keep the ENTIRE original table
 * untouched, and forbid the flow from parking anything on it.
 *
 * Detection is geometric + textual, not just the "Table N" prefix:
 *  - cell-like blocks: short, numeric/symbol-dense fragments;
 *  - clusters of them (vertically adjacent, horizontally overlapping) form a
 *    candidate region;
 *  - a cluster counts as a table when it is dense enough on its own, or when
 *    a `Table N`-typed caption sits directly above/below it;
 *  - every block substantially inside the final rectangle is excluded from
 *    translation — including prose-looking row labels the text test misses.
 *
 * Pure geometry over plain boxes — fully unit-testable.
 */

export interface GuardItem {
	id: string;
	text: string;
	type: string;
	box: { left: number; top: number; width: number; height: number };
	fontSize?: number;
}

export interface TableRegion {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Cell-like: short and dominated by digits/symbols rather than prose. */
export function looksTabular(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 160) {
		return false;
	}
	const letters = (t.match(/[A-Za-z一-鿿]/g) ?? []).length;
	const digitsAndSymbols = (t.match(/[0-9±%±.,;:()/<>=+\-·—–]/g) ?? []).length;
	const words = t.split(/\s+/).filter(Boolean);
	// Pure numbers / value±sd / ranges — the classic cell.
	if (letters === 0 && digitsAndSymbols > 0) {
		return true;
	}
	// Symbol-dense short fragments: "3.4 ± 1.2 (n=52)" etc. Must contain a DIGIT
	// (1.2.0 fix): an author-initial list ("A.H., H.P., C.J.W., J.K., S.L.") is
	// just as period/comma-dense but is prose, not a cell — without the digit
	// gate it seeded false table clusters in journal author-contribution boxes.
	if (t.length <= 80 && /[0-9]/.test(t) && digitsAndSymbols >= Math.max(3, t.length * 0.3)) {
		return true;
	}
	// Very short label-ish fragments count when they carry a digit OR a
	// measurement symbol ("LVEF, %", "n (%)", "HR ±") — but never plain
	// words, or headings and keywords would be swallowed.
	return words.length <= 3 && /[\d%±<>=/]/.test(t) && t.length <= 40;
}

function vGap(a: TableRegion, b: GuardItem['box']): number {
	if (b.top >= a.top + a.height) {
		return b.top - (a.top + a.height);
	}
	if (b.top + b.height <= a.top) {
		return a.top - (b.top + b.height);
	}
	return 0; // vertically intersecting
}

function hOverlaps(a: TableRegion, b: GuardItem['box'], slack: number): boolean {
	return Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left) > -slack;
}

function grow(region: TableRegion, box: GuardItem['box']): TableRegion {
	const left = Math.min(region.left, box.left);
	const top = Math.min(region.top, box.top);
	return {
		left,
		top,
		width: Math.max(region.left + region.width, box.left + box.width) - left,
		height: Math.max(region.top + region.height, box.top + box.height) - top
	};
}

/** Row centres (y) of a set of cells, ascending. */
function rowCentres(members: GuardItem[]): number[] {
	return members.map(m => m.box.top + m.box.height / 2).sort((a, b) => a - b);
}

/** Distinct row bands of a set of cells: y-centres deduped within tol. */
function distinctRows(members: GuardItem[], tol: number): number[] {
	const out: number[] = [];
	for (const y of rowCentres(members)) {
		if (!out.length || y > out[out.length - 1]! + tol) {
			out.push(y);
		}
	}
	return out;
}

/** How many DISTINCT rows of A line up (within tol) with a row of B (1.2.2:
 *  dedup 修复 — 旧实现按成员多重计数,同一行的 4 个单元格数成 4,一个单行
 *  碎片就能凑满 ≥3,靠事故桥接两块区域). Two side-by-side COLUMNS of one
 *  table share the same rows even across a wide gutter. */
function sharedRowCount(a: GuardItem[], b: GuardItem[], tol: number): number {
	const cb = distinctRows(b, tol);
	let n = 0;
	for (const y of distinctRows(a, tol)) {
		if (cb.some(z => Math.abs(z - y) <= tol)) {
			n++;
		}
	}
	return n;
}

/** Distinct column bands of a set of cells (x-centres deduped within tol). */
function distinctCols(members: GuardItem[], tol: number): number {
	const centres = members.map(m => m.box.left + m.box.width / 2).sort((x, y) => x - y);
	let n = 0;
	let last = -Infinity;
	for (const x of centres) {
		if (x > last + tol) {
			n++;
			last = x;
		}
	}
	return n;
}

/** Horizontal gap between two regions (negative when they overlap). */
function hGapBetween(a: TableRegion, b: TableRegion): number {
	return Math.max(a.left - (b.left + b.width), b.left - (a.left + a.width));
}

/** Is there an obstacle (figure/image box, top-down coords) standing in the
 *  gutter BETWEEN two horizontally separated regions, within their shared
 *  vertical span? A figure between two aligned numeric clusters means they are
 *  the columns of two different things, never one table. */
function obstacleBetweenRegions(a: TableRegion, b: TableRegion, obstacles: GuardItem['box'][]): boolean {
	if (!obstacles.length || hGapBetween(a, b) <= 0) {
		return false;
	}
	const gutterLeft = Math.min(a.left + a.width, b.left + b.width);
	const gutterRight = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const bottom = Math.min(a.top + a.height, b.top + b.height);
	if (bottom <= top) {
		return false;
	}
	return obstacles.some(o =>
		o.left < gutterRight && (o.left + o.width) > gutterLeft
		&& o.top < bottom && (o.top + o.height) > top);
}

/** Vertical gap between two regions (0 when they intersect vertically). */
function verticalGap(a: TableRegion, b: TableRegion): number {
	if (b.top >= a.top + a.height) {
		return b.top - (a.top + a.height);
	}
	if (a.top >= b.top + b.height) {
		return a.top - (b.top + b.height);
	}
	return 0;
}

/** Horizontal overlap as a fraction of the NARROWER region's width. */
function mutualHOverlapRatio(a: TableRegion, b: TableRegion): number {
	const overlap = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
	const narrower = Math.min(a.width, b.width);
	return narrower > 0 ? overlap / narrower : 0;
}

/** Is the gutter between two horizontally separated regions occupied by OTHER
 *  tabular cells within their (slightly expanded) shared vertical span? A
 *  populated gutter means the pair are non-adjacent columns of one table; an
 *  empty gutter is what two independent side-by-side tables look like. */
function gutterPopulated(a: TableRegion, b: TableRegion, cells: GuardItem[], em: number): boolean {
	if (hGapBetween(a, b) <= 0) {
		return false;
	}
	const gutterLeft = Math.min(a.left + a.width, b.left + b.width);
	const gutterRight = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top) - em;
	const bottom = Math.min(a.top + a.height, b.top + b.height) + em;
	if (bottom <= top) {
		return false;
	}
	return cells.some((c) => {
		const cx = c.box.left + c.box.width / 2;
		const cy = c.box.top + c.box.height / 2;
		return cx > gutterLeft && cx < gutterRight && cy > top && cy < bottom;
	});
}

function containedRatio(box: GuardItem['box'], region: TableRegion): number {
	const w = Math.min(box.left + box.width, region.left + region.width) - Math.max(box.left, region.left);
	const h = Math.min(box.top + box.height, region.top + region.height) - Math.max(box.top, region.top);
	if (w <= 0 || h <= 0 || box.width <= 0 || box.height <= 0) {
		return 0;
	}
	return (w * h) / (box.width * box.height);
}

/**
 * Detect table regions and the blocks to exclude from translation.
 *
 * `emPx` is the body size in page pixels — it scales the clustering gaps.
 */
export function detectTableRegions(
	items: GuardItem[],
	emPx: number,
	obstacles: GuardItem['box'][] = []
): { excluded: Set<string>; regions: TableRegion[] } {
	const em = Math.max(6, emPx);
	const cells = items.filter(i => looksTabular(i.text));
	const captions = items.filter(i => i.type === 'table');

	// Greedy clustering of cell-like boxes, in reading order.
	let clusters: { region: TableRegion; members: GuardItem[] }[] = [];
	for (const cell of [...cells].sort((a, b) => a.box.top - b.box.top)) {
		let joined = false;
		for (const cluster of clusters) {
			if (vGap(cluster.region, cell.box) <= em * 2.2 && hOverlaps(cluster.region, cell.box, em * 2.5)) {
				cluster.region = grow(cluster.region, cell.box);
				cluster.members.push(cell);
				joined = true;
				break;
			}
		}
		if (!joined) {
			clusters.push({ region: { ...cell.box }, members: [cell] });
		}
	}

	// Merge adjacent clusters transitively until a joint fixed point. Two rules,
	// both needed for a wide grid:
	//   • vertical-overlap: clusters that horizontally overlap and sit within a
	//     row gap are the same column split by a big gap, or stacked row groups.
	//   • column merge (1.2.0): clusters sharing ≥3 aligned row centres are the
	//     side-by-side COLUMNS of one table however wide the gutter — the wide
	//     NEJM "Clinical and Imaging Outcomes" table (a prose label column plus
	//     several far-apart numeric columns) shattered into one-column fragments
	//     under the first rule alone, and its labels collapsed. The ≥3 threshold
	//     keeps two unrelated numeric blobs from fusing.
	// Running both in one loop lets a column merge make strips full-width, after
	// which the vertical rule joins the full-width top and bottom row groups.
	for (let pass = 0; pass < 8; pass++) {
		let mergedAny = false;
		for (let i = 0; i < clusters.length; i++) {
			for (let j = clusters.length - 1; j > i; j--) {
				const a = clusters[i]!;
				const b = clusters[j]!;
				const vAdjacent = a.region.top <= b.region.top + b.region.height + em * 2.2
					&& b.region.top <= a.region.top + a.region.height + em * 2.2;
				// Column merge is bounded (1.2.2, 审核项): shared DISTINCT rows alone
				// let two UNRELATED aligned clusters fuse across arbitrary width. The
				// gutter between them must be table-scale (≤ em*8) — UNLESS the
				// gutter itself is populated by other tabular cells, which is what a
				// non-adjacent column pair of ONE table looks like (merge order is
				// arbitrary: NEJM's count column legitimately merges the P-value
				// column at 203px because two more columns sit in between). An image
				// obstacle in the gutter always separates.
				const columnMerge = sharedRowCount(a.members, b.members, em) >= 3
					&& !obstacleBetweenRegions(a.region, b.region, obstacles)
					&& (hGapBetween(a.region, b.region) <= em * 8
						|| gutterPopulated(a.region, b.region, cells, em));
				// Row-group merge (1.2.2): a table's HEADER rows share no data rows
				// with the body, and their vertical gap (a rule line + padding) can
				// exceed the plain-adjacency tolerance. Two stacked clusters that
				// strongly overlap horizontally, each with ≥2 distinct columns, at a
				// moderate gap (≤ em*4) are row groups of one table. Single-column
				// stacks (figure axis ticks, lists) never qualify.
				const rowGroupMerge = !vAdjacent
					&& verticalGap(a.region, b.region) <= em * 4
					&& mutualHOverlapRatio(a.region, b.region) >= 0.7
					&& distinctCols(a.members, em * 2) >= 2
					&& distinctCols(b.members, em * 2) >= 2
					&& !obstacleBetweenRegions(a.region, b.region, obstacles);
				const merge = (vAdjacent && hOverlaps(a.region, b.region as unknown as GuardItem['box'], em * 3))
					|| columnMerge || rowGroupMerge;
				if (merge) {
					a.region = grow(a.region, b.region as unknown as GuardItem['box']);
					a.members.push(...b.members);
					clusters.splice(j, 1);
					mergedAny = true;
				}
			}
		}
		if (!mergedAny) {
			break;
		}
	}

	const excluded = new Set<string>();
	const regions: TableRegion[] = [];
	for (const cluster of clusters) {
		const nearCaption = captions.some(c =>
			vGap(cluster.region, c.box) <= em * 3 && hOverlaps(cluster.region, c.box, em * 2.5));
		// Dense enough on its own, or anchored by a Table caption.
		if (cluster.members.length < 4 && !(cluster.members.length >= 2 && nearCaption)) {
			continue;
		}
		let region = cluster.region;
		// The numeric cells' row centres — the anchors a label column lines up
		// with. Fixed from the seed cells, so growing the region leftward can't
		// drift the anchor set.
		const numericRowCentres = rowCentres(cluster.members);
		// Sweep in the rest of the table the cell test misses: (a) anything
		// substantially INSIDE the region; (b) short row labels/header cells
		// BESIDE it — vertically aligned with the region's rows, horizontally
		// within a couple of ems; (c) a left-gutter LABEL that lines up with an
		// actual numeric row, however wide the gutter (a wide table's label
		// column sits far left of its first numeric column — the ≤2em rule (b)
		// never reached it, which is why those labels collapsed). Long prose
		// stays out even when adjacent, so a body paragraph in the neighbouring
		// column is never swallowed. Growing the region can pull in more blocks;
		// iterate (bounded).
		for (let pass = 0; pass < 4; pass++) {
			let grew = false;
			for (const item of items) {
				if (excluded.has(item.id) || item.type === 'table') {
					continue;
				}
				const inside = containedRatio(item.box, region) >= 0.6;
				let rowAligned = false;
				if (!inside && item.text.trim().length <= 60) {
					const vOverlap = Math.min(item.box.top + item.box.height, region.top + region.height)
						- Math.max(item.box.top, region.top);
					if (vOverlap >= item.box.height * 0.6) {
						const gapLeft = region.left - (item.box.left + item.box.width);
						const gapRight = item.box.left - (region.left + region.width);
						const nearSide = Math.max(gapLeft, gapRight) <= em * 2 || (gapLeft < 0 && gapRight < 0);
						// (c): sits in the LEFT gutter (right edge not crossing into
						// the numeric columns) AND its centre matches a real numeric
						// row. Far-left labels of a wide table qualify; a neighbouring
						// body line does not — it won't line up with a numeric row.
						const centre = item.box.top + item.box.height / 2;
						const inLeftGutter = (item.box.left + item.box.width) <= region.left + em && gapLeft >= -em;
						const alignsNumericRow = numericRowCentres.some(y => Math.abs(y - centre) <= em * 0.6);
						rowAligned = nearSide || (inLeftGutter && alignsNumericRow);
					}
				}
				if (inside || rowAligned) {
					excluded.add(item.id);
					const next = grow(region, item.box);
					if (next.width !== region.width || next.height !== region.height) {
						region = next;
						grew = true;
					}
				}
			}
			if (!grew) {
				break;
			}
		}
		for (const member of cluster.members) {
			excluded.add(member.id);
		}
		regions.push(region);
	}
	return { excluded, regions };
}
