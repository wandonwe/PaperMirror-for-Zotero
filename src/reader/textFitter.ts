/**
 * Overlay box sizing policy — pure geometry, no DOM.
 *
 * Two fitting strategies (per the overlay design):
 *   strict  — the translation may only use the original paragraph's rect;
 *             the font shrinks until it fits. Preserves the page exactly.
 *   expand  — the box may grow downward into the empty space before the next
 *             block *in the same column*, so long translations stay readable.
 *             Never grows sideways, never crosses the gutter, never overlaps
 *             a neighbouring block.
 */

export interface CssBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

export type FitMode = 'strict' | 'expand';

/** Fraction of horizontal overlap required to call two boxes "same column". */
const COLUMN_OVERLAP_RATIO = 0.45;

/** Do two boxes sit in the same text column? */
export function sameColumn(a: CssBox, b: CssBox, ratio = COLUMN_OVERLAP_RATIO): boolean {
	const left = Math.max(a.left, b.left);
	const right = Math.min(a.left + a.width, b.left + b.width);
	const overlap = right - left;
	if (overlap <= 0) {
		return false;
	}
	const narrower = Math.min(a.width, b.width);
	return narrower > 0 && overlap / narrower >= ratio;
}

/**
 * How tall this box may become. In `strict` mode that is its original height.
 * In `expand` mode it may reach down to just above the closest obstacle that
 * shares its column, capped by the page height.
 */
/**
 * How much taller than the original a box may grow in `expand` mode. The
 * obstacle list only contains other overlay boxes — figures, tables and
 * equations are NOT in it, so unlimited growth would eventually cover one.
 * Capping the growth keeps expansion inside the paragraph's own white space.
 */
export const MAX_GROWTH_RATIO = 2.2;

export function availableHeight(
	box: CssBox,
	obstacles: CssBox[],
	pageHeight: number,
	mode: FitMode,
	minGap = 3,
	maxGrowthRatio = MAX_GROWTH_RATIO
): number {
	if (mode === 'strict') {
		return box.height;
	}
	const boxBottom = box.top + box.height;
	let limit = pageHeight;
	for (const other of obstacles) {
		if (other === box) {
			continue;
		}
		// Only things strictly below us, in our column, can block growth
		if (other.top < boxBottom - 1 || !sameColumn(box, other)) {
			continue;
		}
		limit = Math.min(limit, other.top - minGap);
	}
	const reachable = Math.min(limit, pageHeight) - box.top;
	return Math.max(box.height, Math.min(reachable, box.height * maxGrowthRatio));
}

/**
 * Font-size search bounds for a box. `lineCount` is the number of source lines
 * the box replaces, which is a good proxy for the original type size.
 */
export function fontSizeBounds(boxHeight: number, lineCount: number, minSize = 4): { min: number; max: number } {
	const perLine = boxHeight / Math.max(1, lineCount);
	return {
		min: minSize,
		max: Math.max(minSize, Math.min(30, perLine * 0.82))
	};
}

/**
 * Smallest size the overlay is ever allowed to render at. Below this the text
 * is not reading material, it is grey noise — better to let the box overflow
 * (and expand on hover) than to shrink into illegibility. Four pixels, the old
 * floor, is what made 覆盖翻译 unreadable.
 */
export const MIN_READABLE_PX = 8.5;

/**
 * Quality signal for the UI: how much the text had to be shrunk relative to
 * the size the original occupied. < 0.62 means the overlay is noticeably
 * smaller than the source text and the reader may prefer the side pane.
 */
export function shrinkRatio(finalSize: number, boxHeight: number, lineCount: number): number {
	const { max } = fontSizeBounds(boxHeight, lineCount);
	return max > 0 ? finalSize / max : 1;
}

/** Boxes that would overlap after expansion — used to bail out safely. */
export function overlaps(a: CssBox, b: CssBox): boolean {
	return !(
		a.left + a.width <= b.left
		|| b.left + b.width <= a.left
		|| a.top + a.height <= b.top
		|| b.top + b.height <= a.top
	);
}
