/**
 * Column-aware flow layout for the rebuilt translated page.
 *
 * The previous renderer pinned every translation inside the exact rectangle its
 * source occupied and shrank the type until it fitted. That guarantees nothing
 * ever overlaps, but it also guarantees the page reads like a ransom note:
 * every paragraph at a slightly different size, none of them breaking where a
 * Chinese sentence wants to break.
 *
 * A real translated page instead RE-FLOWS: each block is set at one consistent
 * size, takes whatever height it needs, and the blocks below it move down. The
 * rules that keep that from turning into the overlapping mess earlier attempts
 * produced are deliberately few and strict:
 *
 *   1. A block never moves UP. Its source top is a floor. Chinese is usually
 *      shorter than the English it replaces, so blocks mostly stay put and the
 *      page keeps its shape; only genuinely longer text pushes downward.
 *   2. A block never leaves its column. Columns are derived from the source
 *      rects, so a two-column paper flows as two independent columns.
 *   3. A block never crosses an obstacle. Obstacles are regions of the ORIGINAL
 *      page that carry ink we are not replacing — figures, plots, photographs,
 *      stamps. The flow jumps over them rather than printing on top.
 *
 * Pure geometry: no DOM, no canvas. The caller measures natural heights and
 * supplies the obstacle list.
 */

export interface FlowItem {
	id: string;
	/** Column this block belongs to. */
	column: number;
	/** Left edge and width, in page pixels — flow never changes these. */
	left: number;
	width: number;
	/** Where the block started on the original page (its floor). */
	sourceTop: number;
	/** Height the translated text needs at its chosen size. */
	naturalHeight: number;
	/**
	 * Anchor semantics (opt-in):
	 *   true  — structural block (heading, title, caption): its source top is
	 *           a hard floor, exactly the old rule.
	 *   false — ordinary body text: PACKS from the column cursor, reclaiming
	 *           the whitespace shorter Chinese leaves behind. It may rise
	 *           above its source position but never above the block before it
	 *           or into an obstacle.
	 *   undefined — legacy behaviour (same as true); callers that don't know
	 *           about anchors keep exactly the old layout.
	 */
	anchor?: boolean;
}

export interface FlowObstacle {
	column: number;
	top: number;
	bottom: number;
	/**
	 * Actual horizontal ink extent in page pixels, when known. A small inline
	 * figure must not block its whole column in the final overlap sweep —
	 * without these, obstaclesToBoxes falls back to the column band.
	 */
	leftPx?: number;
	rightPx?: number;
}

export interface FlowPlacement {
	id: string;
	top: number;
	/** True when the block had to be pushed below its source position. */
	displaced: boolean;
	/** True when it ran past the bottom of the page. */
	overflow: boolean;
}

export interface FlowOptions {
	pageHeight: number;
	/** Vertical breathing room between consecutive blocks, in pixels. */
	gap: number;
	/** Ignore the page bottom until this margin. */
	bottomMargin?: number;
}

/**
 * Assign every item a top. Items are processed per column, in source order.
 */
export function planFlow(
	items: FlowItem[],
	obstacles: FlowObstacle[],
	options: FlowOptions
): FlowPlacement[] {
	const bottomLimit = options.pageHeight - (options.bottomMargin ?? 0);
	const byColumn = new Map<number, FlowItem[]>();
	for (const item of items) {
		const list = byColumn.get(item.column) ?? [];
		list.push(item);
		byColumn.set(item.column, list);
	}

	const placements: FlowPlacement[] = [];
	for (const [column, list] of byColumn) {
		const columnObstacles = obstacles
			.filter(o => o.column === column && o.bottom > o.top)
			.sort((a, b) => a.top - b.top);
		const ordered = [...list].sort((a, b) => a.sourceTop - b.sourceTop);
		let cursor = -Infinity;
		for (const item of ordered) {
			// Rule 1 (anchored / legacy): never above the source position, never
			// above the block before. Body text with anchor === false instead
			// PACKS from the cursor — the whitespace a shorter translation
			// leaves is reclaimed rather than preserved as a hole. The first
			// block of a column always keeps its source top, so columns stay
			// aligned with the page's own grid.
			let top: number;
			if (item.anchor === false && cursor !== -Infinity) {
				top = cursor;
			}
			else {
				top = Math.max(item.sourceTop, cursor);
			}
			// Rule 3: hop over anything we are not allowed to print on — but
			// only obstacles the block actually intersects HORIZONTALLY. An
			// obstacle carrying a tight ink extent must not stall blocks that
			// pass beside it in the same column.
			const relevant = columnObstacles.filter(o =>
				o.leftPx === undefined || o.rightPx === undefined
				|| (o.rightPx > item.left && o.leftPx < item.left + item.width));
			top = clearObstacles(top, item.naturalHeight, relevant);
			placements.push({
				id: item.id,
				top,
				displaced: top > item.sourceTop + 0.5,
				overflow: top + item.naturalHeight > bottomLimit
			});
			cursor = top + item.naturalHeight + options.gap;
		}
	}
	return placements;
}

/**
 * Slide `top` down until [top, top+height] clears every obstacle.
 *
 * Obstacles are sorted, and each hop can only move downward, so this settles in
 * at most one pass per obstacle.
 */
export function clearObstacles(top: number, height: number, obstacles: FlowObstacle[]): number {
	let result = top;
	for (const obstacle of obstacles) {
		if (obstacle.bottom <= result) {
			continue; // entirely above us
		}
		if (obstacle.top >= result + height) {
			break; // entirely below us, and the rest are lower still
		}
		result = obstacle.bottom;
	}
	return result;
}

/**
 * Group rects into columns by horizontal overlap.
 *
 * Returns a column index per input rect. Two rects share a column when their
 * overlap covers at least 55% of the WIDER one — they have to be substantially
 * the same span. Measuring against the narrower one instead looks reasonable
 * and is quietly wrong: a full-width title contains a column completely, scores
 * 100%, joins it, and then widens the band until both columns are one.
 */
export function assignColumns(rects: { left: number; width: number }[]): number[] {
	interface Band { left: number; right: number }
	const bands: Band[] = [];
	const assignment: number[] = [];
	for (const rect of rects) {
		const left = rect.left;
		const right = rect.left + rect.width;
		let found = -1;
		for (let i = 0; i < bands.length; i++) {
			const band = bands[i]!;
			const overlap = Math.min(right, band.right) - Math.max(left, band.left);
			const wider = Math.max(right - left, band.right - band.left);
			if (wider > 0 && overlap / wider >= 0.55) {
				found = i;
				break;
			}
		}
		if (found < 0) {
			bands.push({ left, right });
			assignment.push(bands.length - 1);
		}
		else {
			// Widen the band to the union so later rects match it too.
			bands[found] = {
				left: Math.min(bands[found]!.left, left),
				right: Math.max(bands[found]!.right, right)
			};
			assignment.push(found);
		}
	}
	return assignment;
}

/**
 * Turn an ink grid into per-column obstacle spans.
 *
 * `ink` is a coarse grid of the original page: true where the page has content
 * we are NOT replacing. Consecutive inked rows within a column's x-range
 * collapse into one span, which is what the flow hops over. Runs shorter than
 * `minRows` are ignored — a single inked row is a rule or an underline, not a
 * figure, and stopping the flow for those would shred the page.
 */
export function inkToObstacles(
	ink: boolean[][],
	cellHeight: number,
	columnCells: { column: number; fromCol: number; toCol: number }[],
	minRows = 2,
	cellWidth = 0
): FlowObstacle[] {
	const obstacles: FlowObstacle[] = [];
	for (const range of columnCells) {
		let runStart = -1;
		let runMinCol = Infinity;
		let runMaxCol = -Infinity;
		const flush = (row: number): void => {
			if (runStart >= 0 && row - runStart >= minRows) {
				const obstacle: FlowObstacle = {
					column: range.column,
					top: runStart * cellHeight,
					bottom: row * cellHeight
				};
				// Tight horizontal extent: the actually-inked cells, so a small
				// local figure does not block its whole column downstream.
				if (cellWidth > 0 && runMinCol <= runMaxCol) {
					obstacle.leftPx = runMinCol * cellWidth;
					obstacle.rightPx = (runMaxCol + 1) * cellWidth;
				}
				obstacles.push(obstacle);
			}
			runStart = -1;
			runMinCol = Infinity;
			runMaxCol = -Infinity;
		};
		for (let row = 0; row <= ink.length; row++) {
			const cells = ink[row];
			let inked = false;
			if (cells) {
				for (let col = range.fromCol; col <= range.toCol && col < cells.length; col++) {
					if (cells[col]) {
						inked = true;
						runMinCol = Math.min(runMinCol, col);
						runMaxCol = Math.max(runMaxCol, col);
					}
				}
			}
			if (inked && runStart < 0) {
				runStart = row;
			}
			else if (!inked && runStart >= 0) {
				flush(row);
			}
		}
	}
	return obstacles;
}

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Obstacles (figures, tables — per-column vertical spans) as immovable boxes,
 * so the FINAL overlap sweep can refuse to park a block on top of them.
 *
 * planFlow hops obstacles, but resolveOverlaps used to know nothing about
 * them: a block pushed down to clear ANOTHER block could land squarely on a
 * figure, and nothing re-checked. Handing the obstacles to the sweep as fixed
 * boxes closes that gap. Each obstacle takes its column's full x-band.
 */
export function obstaclesToBoxes(
	obstacles: FlowObstacle[],
	columnBands: Map<number, { left: number; right: number }>
): Box[] {
	const boxes: Box[] = [];
	for (const obstacle of obstacles) {
		if (obstacle.bottom <= obstacle.top) {
			continue;
		}
		// Prefer the obstacle's OWN ink extent: a small inline figure must not
		// wall off its entire column. The column band is only the fallback for
		// obstacles that don't carry one.
		if (obstacle.leftPx !== undefined && obstacle.rightPx !== undefined
			&& obstacle.rightPx - obstacle.leftPx > 0) {
			boxes.push({
				left: obstacle.leftPx,
				top: obstacle.top,
				width: obstacle.rightPx - obstacle.leftPx,
				height: obstacle.bottom - obstacle.top
			});
			continue;
		}
		const band = columnBands.get(obstacle.column);
		if (!band || band.right - band.left <= 0) {
			continue;
		}
		boxes.push({
			left: band.left,
			top: obstacle.top,
			width: band.right - band.left,
			height: obstacle.bottom - obstacle.top
		});
	}
	return boxes;
}

/**
 * Final guarantee: nothing overlaps anything, whatever the column analysis
 * decided.
 *
 * planFlow only orders blocks WITHIN a column, and that is not enough. An
 * abbreviation list, a two-column key/definition table, a heading that spans a
 * sub-column — these produce blocks whose x-ranges intersect while belonging to
 * different columns, and the per-column flow happily places them on top of each
 * other. This pass takes the planned tops, walks them top-down, and pushes any
 * box that still collides with something already settled — or with a FIXED box,
 * meaning a piece of the original page we are not replacing (author lists,
 * affiliation blocks, captions), which cannot move at all.
 *
 * Deliberately last and deliberately dumb: whatever cleverness upstream gets
 * wrong, "no two boxes may occupy the same pixels" is checked here.
 */
export interface LayoutProblem {
	id: string;
	kind: 'block-overlap' | 'fixed-overlap';
	otherId?: string;
}

/**
 * Final visual safety check, pure geometry: after everything has settled, do
 * any two translated blocks still intersect, or does a block sit on a piece
 * of the page it must never cover (figure, table, header/footer band)?
 *
 * `slack` forgives sub-visual penetration (rounding, the 12% column-abut
 * exemption). The caller decides what to do with a failing page — the checker
 * only reports.
 */
export function findLayoutProblems(
	movable: (Box & { id: string })[],
	fixed: Box[],
	slack = 4
): LayoutProblem[] {
	const problems: LayoutProblem[] = [];
	const penetrates = (a: Box, b: Box): boolean => {
		const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
		const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
		if (w <= slack || h <= slack) {
			return false;
		}
		// Mirror the sweep's column-abut exemption: a thin shared edge is not
		// an overlap worth failing a page for.
		return w > Math.min(a.width, b.width) * 0.12 + slack;
	};
	for (let i = 0; i < movable.length; i++) {
		for (let j = i + 1; j < movable.length; j++) {
			if (penetrates(movable[i]!, movable[j]!)) {
				problems.push({ id: movable[i]!.id, kind: 'block-overlap', otherId: movable[j]!.id });
			}
		}
		for (const box of fixed) {
			if (penetrates(movable[i]!, box)) {
				problems.push({ id: movable[i]!.id, kind: 'fixed-overlap' });
				break;
			}
		}
	}
	return problems;
}

export function resolveOverlaps(
	movable: (Box & { id: string })[],
	fixed: Box[],
	gap: number,
	_pageHeight: number
): Map<string, number> {
	const horizontallyClear = (a: Box, b: Box): boolean => {
		const overlap = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
		// A sliver of shared edge is not a collision — columns often abut.
		return overlap <= Math.min(a.width, b.width) * 0.12;
	};

	const settled: Box[] = [...fixed];
	const result = new Map<string, number>();
	const ordered = [...movable].sort((a, b) => a.top - b.top);

	for (const item of ordered) {
		let top = item.top;
		// Each pass can only move downward, so this terminates; the cap is a
		// backstop against pathological input.
		for (let pass = 0; pass < 40; pass++) {
			let moved = false;
			for (const other of settled) {
				if (horizontallyClear({ ...item, top }, other)) {
					continue;
				}
				const verticallyClear = top + item.height <= other.top || top >= other.top + other.height;
				if (verticallyClear) {
					continue;
				}
				top = other.top + other.height + gap;
				moved = true;
			}
			if (!moved) {
				break;
			}
		}
		// NO bottom clamp. Clamping blocks back inside the page height made
		// every overflowing block pile onto the same strip at the bottom — the
		// garbled overlap band. A block that runs long keeps going; the caller
		// GROWS the page below the original artwork instead.
		result.set(item.id, top);
		settled.push({ ...item, top });
	}
	return result;
}
