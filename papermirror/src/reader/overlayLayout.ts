/**
 * Pure geometry/text logic for the on-page translation overlay.
 *
 * A paragraph's per-line rects are grouped into "runs" — maximal sequences of
 * consecutive lines that share a column and flow downward. A single-column
 * paragraph yields one run; a paragraph that wraps from the bottom of the left
 * column to the top of the right column yields two. Each run becomes one
 * overlay box, so the translation never gets painted across the gutter.
 *
 * No DOM, no Zotero APIs — fully unit-testable.
 */

/** Raw PDF rect: [x1, y1, x2, y2], origin bottom-left. */
export type PdfRect = [number, number, number, number];

export interface OverlayRun {
	/** Union rect of the lines in this run (PDF coords). */
	rect: PdfRect;
	/** Number of source lines the run covers — used to weight text splitting. */
	lineCount: number;
	/** Total glyph area, a better weight than line count for ragged text. */
	area: number;
}

function union(a: PdfRect, b: PdfRect): PdfRect {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function area(rect: PdfRect): number {
	return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
}

/**
 * Group consecutive line rects into column runs.
 *
 * A new run starts when the next line is not a plain "wrap to the next line in
 * the same column": either it moves right by more than half the current run's
 * width (column switch) or it jumps upward instead of downward.
 */
export function groupLineRects(lineRects: PdfRect[]): OverlayRun[] {
	const runs: OverlayRun[] = [];
	let current: PdfRect | null = null;
	let count = 0;
	let glyphArea = 0;
	let previous: PdfRect | null = null;

	const flush = (): void => {
		if (current) {
			runs.push({ rect: current, lineCount: count, area: glyphArea });
		}
		current = null;
		count = 0;
		glyphArea = 0;
	};

	for (const rect of lineRects) {
		if (!rect || !Number.isFinite(rect[0])) {
			continue;
		}
		if (current && previous) {
			const runWidth = Math.max(1, current[2] - current[0]);
			// Column switch: the line starts well to the right of the run's left edge
			const movedToNewColumn = rect[0] > current[0] + runWidth * 0.5;
			// Reading order goes downward; an upward jump means a new column/section
			const jumpedUp = rect[3] > previous[3] + (previous[3] - previous[1]) * 0.5;
			if (movedToNewColumn || jumpedUp) {
				flush();
			}
		}
		current = current ? union(current, rect) : [...rect] as PdfRect;
		count++;
		glyphArea += area(rect);
		previous = rect;
	}
	flush();
	return runs;
}

/**
 * Split a translation across several overlay boxes in proportion to the space
 * each box offers, so a paragraph that originally flowed across two columns
 * still reads left-column-then-right-column.
 *
 * Splits are nudged to the nearest sensible boundary: CJK punctuation, a
 * space, or a word edge — never mid-word for Latin text.
 */
export function distributeText(text: string, runs: OverlayRun[]): string[] {
	const trimmed = text.trim();
	if (runs.length <= 1 || !trimmed) {
		return runs.map((_, i) => (i === 0 ? trimmed : ''));
	}
	const totalArea = runs.reduce((sum, r) => sum + (r.area || 1), 0);
	if (totalArea <= 0) {
		return runs.map((_, i) => (i === 0 ? trimmed : ''));
	}
	const parts: string[] = [];
	let cursor = 0;
	for (let i = 0; i < runs.length - 1; i++) {
		const share = (runs[i]!.area || 1) / totalArea;
		const target = cursor + Math.round(trimmed.length * share);
		const cut = findCutPoint(trimmed, Math.min(target, trimmed.length), cursor);
		parts.push(trimmed.slice(cursor, cut).trim());
		cursor = cut;
	}
	parts.push(trimmed.slice(cursor).trim());
	return parts;
}

/** Nearest acceptable break at or near `target`, never before `minIndex`. */
export function findCutPoint(text: string, target: number, minIndex: number): number {
	if (target >= text.length) {
		return text.length;
	}
	const isBreak = (i: number): boolean => {
		const ch = text[i];
		const prev = text[i - 1];
		if (ch === undefined) {
			return false;
		}
		if (/\s/.test(ch)) {
			return true;
		}
		// After CJK punctuation is a natural break
		if (prev !== undefined && /[。，、；：!?」』）】]/.test(prev)) {
			return true;
		}
		// Between two CJK glyphs is acceptable
		if (prev !== undefined && /[一-鿿]/.test(prev) && /[一-鿿]/.test(ch)) {
			return true;
		}
		return false;
	};
	const maxSearch = 24;
	for (let delta = 0; delta <= maxSearch; delta++) {
		const forward = target + delta;
		if (forward < text.length && forward > minIndex && isBreak(forward)) {
			return forward;
		}
		const back = target - delta;
		if (back > minIndex && back < text.length && isBreak(back)) {
			return back;
		}
	}
	return Math.max(minIndex + 1, Math.min(target, text.length));
}

/**
 * Convert a PDF rect to CSS pixels inside a rendered page, using the two
 * corner points produced by PDF.js's viewport transform (which already
 * accounts for scale and rotation).
 */
export function rectToCssBox(
	topLeft: [number, number],
	bottomRight: [number, number],
	padding = 0
): { left: number; top: number; width: number; height: number } {
	const left = Math.min(topLeft[0], bottomRight[0]) - padding;
	const top = Math.min(topLeft[1], bottomRight[1]) - padding;
	const width = Math.abs(bottomRight[0] - topLeft[0]) + padding * 2;
	const height = Math.abs(bottomRight[1] - topLeft[1]) + padding * 2;
	return { left, top, width, height };
}

/**
 * Starting font size for an overlay box: proportional to the box height and
 * the number of source lines it replaces. The renderer then shrinks it until
 * the text fits.
 */
export function initialFontSize(boxHeightPx: number, lineCount: number): number {
	const perLine = boxHeightPx / Math.max(1, lineCount);
	// Glyph height is roughly 0.72 of the line box for CJK serif faces
	return Math.max(6, Math.min(28, perLine * 0.78));
}

/** Blocks worth covering — never paint over figures or tables. */
export function isOverlayableType(type: string): boolean {
	return type === 'paragraph' || type === 'heading' || type === 'title'
		|| type === 'list' || type === 'caption' || type === 'unknown';
}
