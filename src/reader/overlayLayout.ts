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
	/**
	 * The individual source line rects making up this run.
	 *
	 * The mask is painted from THESE, one small rectangle per line — never from
	 * the union. A union rect covers the ragged tail of the last line, the
	 * indent of the first, and any inline artwork the paragraph flows around;
	 * painting it is what makes an overlay look like a sticker slapped over the
	 * page instead of a translation of it.
	 */
	lines: PdfRect[];
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
/**
 * Put a block's line rects into reading order before they are grouped.
 *
 * The rects arrive from whichever extraction path ran, and one of them can
 * hand back a column bottom-to-top. Grouping trusts the sequence — every line
 * then looks like an upward jump, every line becomes its own run, and the
 * translation gets sliced into one fragment per source line. That is the
 * shredded-paragraph look. Detect the reversal by counting which way
 * consecutive lines actually travel, and flip the whole list if the answer is
 * "upward"; a genuine two-column flow still travels downward within each
 * column and is untouched.
 */
export function normalizeReadingOrder(lineRects: PdfRect[]): PdfRect[] {
	if (lineRects.length < 3) {
		return lineRects;
	}
	let down = 0;
	let up = 0;
	for (let i = 1; i < lineRects.length; i++) {
		const prev = lineRects[i - 1]!;
		const cur = lineRects[i]!;
		const lineHeight = Math.max(1, prev[3] - prev[1]);
		const delta = cur[3] - prev[3];
		if (Math.abs(delta) < lineHeight * 0.3) {
			continue; // same line, split into pieces
		}
		if (delta < 0) {
			down++;
		}
		else {
			up++;
		}
	}
	return up > down ? [...lineRects].reverse() : lineRects;
}

export function groupLineRects(inputRects: PdfRect[]): OverlayRun[] {
	const lineRects = normalizeReadingOrder(inputRects);
	const runs: OverlayRun[] = [];
	let current: PdfRect | null = null;
	let count = 0;
	let glyphArea = 0;
	let previous: PdfRect | null = null;
	let members: PdfRect[] = [];

	const flush = (): void => {
		if (current) {
			runs.push({ rect: current, lines: members, lineCount: count, area: glyphArea });
		}
		current = null;
		count = 0;
		glyphArea = 0;
		members = [];
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
		members.push([...rect] as PdfRect);
		count++;
		glyphArea += area(rect);
		previous = rect;
	}
	flush();
	return runs;
}

/**
 * Split text into sentences, keeping terminal punctuation attached.
 * Used so a paragraph spanning two columns breaks at a full stop rather than
 * in the middle of a clause.
 */
export function splitSentences(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (!/[。！？；.!?;]/.test(ch)) {
			continue;
		}
		// Consume trailing quotes/brackets that belong to this sentence.
		let end = i + 1;
		while (end < trimmed.length && /["'”’」』)\]】]/.test(trimmed[end]!)) {
			end++;
		}
		// CJK terminators are unambiguous. Latin ones are not: "et al.",
		// "Fig. 2", "J. Smith" and "0.75" all contain a period that ends
		// nothing, so require whitespace after it AND a sentence-like start
		// after that, and reject known abbreviations.
		if (/[.!?;]/.test(ch)) {
			if (end >= trimmed.length) {
				// Trailing terminator — fine, the sentence ends with the text.
			}
			else {
				if (!/\s/.test(trimmed[end]!)) {
					continue;
				}
				let after = end;
				while (after < trimmed.length && /\s/.test(trimmed[after]!)) {
					after++;
				}
				const next = trimmed[after];
				if (next !== undefined && !/[A-Z0-9“"'(\[一-鿿]/.test(next)) {
					continue;
				}
				if (ABBREVIATION_BEFORE_PERIOD.test(trimmed.slice(Math.max(0, i - 12), i + 1))) {
					continue;
				}
			}
		}
		while (end < trimmed.length && /\s/.test(trimmed[end]!)) {
			end++;
		}
		out.push(trimmed.slice(start, end).trim());
		start = end;
		i = end - 1;
	}
	if (start < trimmed.length) {
		out.push(trimmed.slice(start).trim());
	}
	return out.filter(s => s.length > 0);
}

/**
 * Trailing context that means the period is an abbreviation mark, not a full
 * stop: a single initial ("J."), or one of the abbreviations that pervade
 * academic prose.
 */
const ABBREVIATION_BEFORE_PERIOD
	= /(^|[\s(])(?:[A-Za-z]|al|Fig|fig|Eq|eq|No|no|vs|cf|resp|approx|Ref|ref|Sec|sec|Tab|tab|Dr|Mr|Ms|Mrs|Prof|St|Inc|Ltd|e\.g|i\.e|etc)\.$/;

/**
 * Split a translation across several overlay boxes in proportion to the space
 * each box offers, so a paragraph that originally flowed across two columns
 * still reads left-column-then-right-column.
 *
 * Sentences are kept whole wherever possible — cutting a clause across the
 * gutter is the single most jarring artefact of the overlay. Only when one
 * sentence is itself larger than a box's share does it fall back to a
 * character split at a safe boundary (CJK punctuation, a space, a word edge —
 * never mid-word for Latin text).
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

	// Preferred character budget per box.
	const budgets = runs.map(r => (trimmed.length * (r.area || 1)) / totalArea);

	const sentences = splitSentences(trimmed);
	if (sentences.length >= runs.length) {
		const parts: string[] = runs.map(() => '');
		let index = 0;
		for (let i = 0; i < runs.length; i++) {
			const isLast = i === runs.length - 1;
			// Always leave at least one sentence for each remaining box.
			const reserve = runs.length - 1 - i;
			while (index < sentences.length - reserve) {
				const candidate = sentences[index]!;
				const wouldBe = parts[i] ? `${parts[i]} ${candidate}` : candidate;
				const overshoot = wouldBe.length - budgets[i]!;
				// Take the sentence unless it overshoots badly and we already
				// have something; the last box takes whatever is left.
				if (!isLast && parts[i] && overshoot > budgets[i]! * 0.35) {
					break;
				}
				parts[i] = wouldBe;
				index++;
				if (!isLast && parts[i]!.length >= budgets[i]!) {
					break;
				}
			}
		}
		if (parts.every(p => p.length > 0)) {
			return parts;
		}
	}

	// Fallback: proportional character split at safe boundaries.
	const parts: string[] = [];
	let cursor = 0;
	for (let i = 0; i < runs.length - 1; i++) {
		const target = cursor + Math.round(budgets[i]!);
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

/**
 * Blocks worth covering. Deliberately narrow: ONLY running body text and
 * headings. Captions sit against artwork, lists are often figure legends, and
 * 'unknown' is exactly that — painting over any of them risks wrecking a
 * figure. They remain readable in the translation pane instead.
 */
export function isOverlayableType(type: string): boolean {
	// The paper's TITLE stays in the original, deliberately: it is how the
	// reader recognises the page at a glance, it is what they will cite and
	// search for, and a title is the single worst place for a translation
	// wobble. Section headings are still translated — 方法 / 结果 in place is
	// what makes the translated page navigable.
	return type === 'paragraph' || type === 'heading';
}
