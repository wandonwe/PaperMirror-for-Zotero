/**
 * 边框硬屏障 (figure-border barriers).
 *
 * The operator-list image rectangles were only consulted at RENDER time, so
 * EXTRACTION happily merged text straight across figure borders: figure-internal
 * labels ("X-rays", "Low keV") joined the body flow, captions of side-by-side
 * figures fused, and one bad union rect then swallowed half the page. These
 * pure helpers make the borders first-class citizens of extraction:
 *
 *   1. insideObstacle  — a line mostly inside a figure is a DIAGRAM LABEL:
 *      it stays on the original page untouched and never enters translation.
 *   2. obstacleBetween — two blocks separated by a figure belong to different
 *      layout regions and must NEVER merge, whatever the geometry says.
 *
 * Pure math over plain arrays — no DOM, no Zotero APIs, unit-testable.
 */

/** [x1, y1, x2, y2] in PDF coordinates (origin bottom-left, y up). */
export type Rect = [number, number, number, number];

function xOverlap(a: Rect, b: Rect): number {
	return Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
}

/** Fraction of `rect`'s area covered by `obstacle` (0..1). */
function coverage(rect: Rect, obstacle: Rect): number {
	const w = Math.min(rect[2], obstacle[2]) - Math.max(rect[0], obstacle[0]);
	const h = Math.min(rect[3], obstacle[3]) - Math.max(rect[1], obstacle[1]);
	if (w <= 0 || h <= 0) {
		return 0;
	}
	const area = Math.max(1e-6, (rect[2] - rect[0]) * (rect[3] - rect[1]));
	return (w * h) / area;
}

/**
 * True when the rect sits (mostly) INSIDE a figure — an axis label, a legend
 * entry, text painted over a plot. Threshold 0.6: a caption that merely touches
 * the figure's bottom edge stays out.
 */
export function insideObstacle(rect: Rect, obstacles: readonly Rect[], threshold = 0.6): boolean {
	for (const o of obstacles) {
		if (coverage(rect, o) >= threshold) {
			return true;
		}
	}
	return false;
}

/**
 * True when a figure lies VERTICALLY between the two rects (sharing x-range
 * with both) — text above a figure and text below it are different layout
 * regions (e.g. body column vs. the caption under the NEXT figure) and must
 * never be merged into one block.
 */
export function obstacleBetween(a: Rect, b: Rect, obstacles: readonly Rect[]): boolean {
	if (!obstacles.length) {
		return false;
	}
	// PDF y-up: the upper rect has the larger bottom edge.
	const upper = a[1] >= b[1] ? a : b;
	const lower = upper === a ? b : a;
	const gapTop = upper[1];
	const gapBottom = lower[3];
	if (gapTop - gapBottom < 2) {
		return false; // touching/overlapping lines — no room for a figure
	}
	for (const o of obstacles) {
		if (xOverlap(o, a) < 6 || xOverlap(o, b) < 6) {
			continue;
		}
		const interTop = Math.min(gapTop, o[3]);
		const interBottom = Math.max(gapBottom, o[1]);
		const needed = Math.min(4, (gapTop - gapBottom) * 0.5);
		if (interTop - interBottom >= needed) {
			return true;
		}
	}
	return false;
}
