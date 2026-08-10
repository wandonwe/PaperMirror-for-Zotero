/**
 * Shared paragraph-segmentation heuristics — pure, no DOM, no Zotero APIs.
 *
 * Both extraction paths (the PDF.js fork char stream and the rendered text
 * layer) had the same two failure modes, so the fixes live here once:
 *
 *  1. 句子被切碎 — a paragraph break was declared in the middle of a sentence.
 *     Two causes: (a) font size measured as the MEAN over a line, so one
 *     superscript citation or inline math glyph moved it >20% and tripped the
 *     "font jump = structural boundary" rule; (b) no check that the previous
 *     line actually ENDED the paragraph. A line that runs all the way to the
 *     column's right margin is a wrapped line — the sentence continues, and a
 *     break after it is almost always wrong.
 *
 *  2. 分段乱 — in a two-column paper, lines from the left and right column
 *     sharing a baseline were merged. Columns must be detected first (by
 *     projecting line rects onto x and finding the gutter) and lines grouped
 *     within a column, never across it.
 *
 * Anything the geometry still gets wrong is repaired by mergeContinuations(),
 * which rejoins a fragment that ends mid-sentence with the one that follows.
 */

/** [x1, y1, x2, y2] in PDF coordinates (origin bottom-left, y grows upward). */
export type Rect = [number, number, number, number];

export interface ColumnBand {
	left: number;
	right: number;
}

/** Lines wider than this fraction of the page span the gutter (titles, abstracts). */
const FULL_WIDTH_RATIO = 0.62;

/**
 * Detect text columns by projecting line rects onto the x axis and splitting
 * on gaps wider than the gutter threshold. Full-width lines are excluded from
 * the projection — otherwise a single spanning title bridges the gutter and
 * the whole page looks like one column.
 */
export function detectColumns(rects: Rect[], pageWidth: number): ColumnBand[] {
	const width = pageWidth > 0 ? pageWidth : 612;
	const gutter = Math.max(11, width * 0.018);
	const valid = rects.filter(r => Number.isFinite(r[0]) && Number.isFinite(r[2]) && r[2] > r[0]);
	// Spanning lines (titles, abstracts) bridge the gutter, so they are left
	// out of the projection. If EVERY line spans, the page is single-column
	// and the spanning lines are all we have to measure.
	const candidates = valid.filter(r => r[2] - r[0] < width * FULL_WIDTH_RATIO);
	const narrow = (candidates.length ? candidates : valid).sort((a, b) => a[0] - b[0]);
	if (!narrow.length) {
		return [];
	}
	const bands: ColumnBand[] = [];
	for (const r of narrow) {
		const last = bands[bands.length - 1];
		if (last && r[0] <= last.right + gutter) {
			last.right = Math.max(last.right, r[2]);
		}
		else {
			bands.push({ left: r[0], right: r[2] });
		}
	}
	// Ignore slivers (equation numbers, margin notes) — they are not columns.
	const significant = bands.filter(b => b.right - b.left >= width * 0.12);
	return significant.length ? significant : bands;
}

/**
 * Find the vertical whitespace channels (gutters) that separate text columns.
 *
 * A single wide line cannot tell you where the gutter is — a full-width title
 * covers it. So this works per row: for every x it counts how many wide rows
 * have NO glyph there, and reports the runs where most of them agree. Titles
 * and spanning figures are outvoted by the body rows.
 *
 * Returns the x centre of each gutter, left to right.
 */
export function detectGutters(rows: Rect[][], pageWidth: number): number[] {
	const width = pageWidth > 0 ? pageWidth : 612;
	const STEP = 2;
	const cells = Math.ceil(width / STEP);
	if (cells <= 0) {
		return [];
	}
	const uncovered = new Array<number>(cells).fill(0);
	let counted = 0;
	for (const row of rows) {
		if (!row.length) {
			continue;
		}
		let rowLeft = Infinity;
		let rowRight = -Infinity;
		for (const r of row) {
			rowLeft = Math.min(rowLeft, r[0]);
			rowRight = Math.max(rowRight, r[2]);
		}
		// Only rows spanning most of the text block can reveal a gutter.
		if (!Number.isFinite(rowLeft) || rowRight - rowLeft < width * 0.5) {
			continue;
		}
		counted++;
		const covered = new Array<boolean>(cells).fill(false);
		for (const r of row) {
			const from = Math.max(0, Math.floor(r[0] / STEP));
			const to = Math.min(cells - 1, Math.ceil(r[2] / STEP));
			for (let k = from; k <= to; k++) {
				covered[k] = true;
			}
		}
		const from = Math.max(0, Math.ceil(rowLeft / STEP));
		const to = Math.min(cells - 1, Math.floor(rowRight / STEP));
		for (let k = from; k <= to; k++) {
			if (!covered[k]) {
				uncovered[k]!++;
			}
		}
	}
	// Too few wide rows to vote — the caller falls back to a gap threshold.
	if (counted < 6) {
		return [];
	}
	const quorum = counted * 0.6;
	const gutters: number[] = [];
	let runStart = -1;
	for (let k = 0; k <= cells; k++) {
		const isGap = k < cells && uncovered[k]! >= quorum;
		if (isGap && runStart < 0) {
			runStart = k;
		}
		else if (!isGap && runStart >= 0) {
			const startX = runStart * STEP;
			const endX = k * STEP;
			// A real gutter is a sustained channel, not a word space.
			if (endX - startX >= 8 && startX > width * 0.12 && endX < width * 0.88) {
				gutters.push((startX + endX) / 2);
			}
			runStart = -1;
		}
	}
	return gutters;
}

/**
 * Which column a rect belongs to. Returns -1 for a full-width rect (it spans
 * every column and must not be grouped with either one's neighbours).
 */
export function columnOf(rect: Rect, bands: ColumnBand[], pageWidth: number): number {
	if (!bands.length) {
		return 0;
	}
	const width = pageWidth > 0 ? pageWidth : 612;
	if (bands.length > 1 && rect[2] - rect[0] >= width * FULL_WIDTH_RATIO) {
		return -1;
	}
	let best = -1;
	let bestOverlap = 0;
	for (let i = 0; i < bands.length; i++) {
		const band = bands[i]!;
		const overlap = Math.min(rect[2], band.right) - Math.max(rect[0], band.left);
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			best = i;
		}
	}
	return best >= 0 ? best : 0;
}

/**
 * The representative font size of a line.
 *
 * NOT the mean: a body line containing a 6pt superscript citation has a mean
 * well below the 10pt body size, and comparing that against the next (clean)
 * line trips a bogus "font jump" break in the middle of a sentence. Instead
 * bucket the sizes to 0.5pt and take the one covering the most characters,
 * which is the size the reader actually perceives.
 */
/**
 * The size a REPLACEMENT should be typeset at: the smallest size in the
 * paragraph's own body cluster.
 *
 * The band [0.75×median, 1.25×median] excludes drop caps and heading-styled
 * lead-ins above, and superscript citations / footnote marks below — a "(5)"
 * at 6pt must not drag a 10pt paragraph down, and an ornamental "T" at 22pt
 * must not blow it up. Within the surviving body cluster the MINIMUM wins
 * (用户要求: 译文字号与段落有效正文最小字号一致).
 */
export function replacementFontSize(sizes: number[]): number {
	const usable = sizes.filter(s => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
	if (!usable.length) {
		return 0;
	}
	const median = usable[Math.floor(usable.length / 2)]!;
	const body = usable.filter(s => s >= median * 0.75 && s <= median * 1.25);
	return body.length ? body[0]! : median;
}

export function dominantFontSize(sizes: number[]): number {
	const usable = sizes.filter(s => Number.isFinite(s) && s > 0);
	if (!usable.length) {
		return 0;
	}
	const counts = new Map<number, number>();
	for (const size of usable) {
		const bucket = Math.round(size * 2) / 2;
		counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
	}
	let best = 0;
	let bestCount = -1;
	for (const [bucket, count] of counts) {
		// Ties go to the larger size: body text beats a run of subscripts.
		if (count > bestCount || (count === bestCount && bucket > best)) {
			best = bucket;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Does this line run to its column's right margin? If so it is a WRAPPED line
 * and the sentence continues on the next one — geometric break signals
 * (spacing, indentation, font wobble) must not end the paragraph here.
 */
export function reachesRightMargin(rect: Rect, columnRight: number, fontSize: number): boolean {
	const slack = Math.max(fontSize * 1.6, 6);
	return rect[2] >= columnRight - slack;
}

/**
 * Ends with SENTENCE-terminal punctuation, so a following break is plausible.
 * A colon or semicolon is NOT sentence-final — "the following:" and a clause
 * ending in ";" continue onto the next line. They were wrongly listed here,
 * which both forced a break and made the `danglingEnd` rule (which treats ":"
 * and ";" as mid-sentence) dead code — a direct contradiction that left
 * colon/semicolon lines stranded as their own untranslated one-line blocks.
 */
export function endsSentence(text: string): boolean {
	return /[.!?。！？]["'”’」』)\]]*\s*$/.test(text.trim());
}

/** Starts the way a continuation does, not the way a new paragraph does. */
export function startsContinuation(text: string): boolean {
	const t = text.trim();
	if (!t) {
		return false;
	}
	// Lowercase Latin, or a dangling closing/joining mark.
	if (/^[a-z]/.test(t)) {
		return true;
	}
	// A dangling closing or joining mark can only be a continuation.
	// NOTE: no capitalised-word rule here. "The next paragraph begins" would
	// match a conjunction list case-insensitively, and swallowing a real
	// paragraph start is far worse than leaving one over-split.
	return /^[,;:)\]}、，；：）】」』]/.test(t);
}

/**
 * A numbered/bulleted item — or a bracketed reference entry — legitimately
 * starts a new block even when the text before it looks unfinished.
 */
export function looksLikeListStart(text: string): boolean {
	return /^(\[\d{1,3}\]|[•▪◦‣·*–—-]\s|\(?\d{1,2}[.)]\s|[（(]\d{1,2}[）)]|[ivxIVX]{1,4}[.)]\s)/.test(text.trim());
}

/**
 * A single-level ordered-list marker — "1." "2)" "10." "(3)" — but NOT a
 * multi-level section number like "1.1" or "4.6.1". This keeps a short numbered
 * list at the foot of a page from being classified as a big heading.
 */
export function isOrderedListStart(text: string): boolean {
	const t = text.trim();
	if (/^\d+(\.\d+)+/.test(t)) {
		return false; // 1.1 / 4.6.1 → section number, not a list item
	}
	return /^[（(]?\d{1,3}[.)）]\s+\S/.test(t);
}

/**
 * A multi-level section number that introduces a heading: "1.1 Methods",
 * "4.6.1 Results". Single "1." is a list item, handled above.
 */
export function isSectionNumberHeading(text: string): boolean {
	return /^\d+(\.\d+)+\s+\S/.test(text.trim());
}

export interface MergeableParagraph {
	text: string;
	/** Column index; only same-column neighbours may merge. -1 = full width. */
	column?: number;
	/** Structural type; only body paragraphs merge. */
	type?: string;
	/** Vertical whitespace to the paragraph that follows, in PDF units. */
	gapAfter?: number;
	/** Body font size of this paragraph, used to scale the gap test. */
	fontSize?: number;
	/** Bounding rect; when both sides carry one, they must overlap in x. */
	rect?: Rect;
}

/**
 * Repair over-splitting: join a fragment that ends mid-sentence with the
 * fragment that follows it, when the follower reads like a continuation.
 * Deliberately conservative — it needs BOTH signals, so headings, list items
 * and genuine paragraph starts are never swallowed.
 *
 * `join(a, b)` builds the merged text (callers differ on CJK vs. Latin joins);
 * `merge(indexA, indexB)` is called so the caller can also merge geometry.
 */
export function planMerges<T extends MergeableParagraph>(paragraphs: T[]): number[][] {
	const groups: number[][] = [];
	let current: number[] = [];
	for (let i = 0; i < paragraphs.length; i++) {
		const p = paragraphs[i]!;
		if (!current.length) {
			current = [i];
			continue;
		}
		const prev = paragraphs[current[current.length - 1]!]!;
		const bodyOnly = (prev.type ?? 'paragraph') === 'paragraph' && (p.type ?? 'paragraph') === 'paragraph';
		// A genuine over-split leaves the two fragments on CONSECUTIVE lines.
		// Anything separated by real whitespace was a deliberate break.
		const size = prev.fontSize && prev.fontSize > 0 ? prev.fontSize : 10;
		const adjacent = prev.gapAfter === undefined || prev.gapAfter <= size * 1.2;
		// Same-column test, GEOMETRY-first: when both fragments have rects (the
		// real pipeline) two fragments belong together iff their x-ranges
		// overlap — the band index is unstable row-to-row on narrow two-column
		// pages and, trusted here, left mid-paragraph lines un-rejoined (stuck
		// in English). Fragments in different columns never share an x-range, so
		// this can't interleave the columns. Only when rects are absent (unit
		// tests) do we fall back to the column index.
		const sameColumn = (prev.rect && p.rect)
			? linesShareColumn(prev.rect, p.rect)
			: (prev.column ?? 0) === (p.column ?? 0);
		// A fragment ending in a comma/colon is mid-sentence no matter how the
		// next fragment begins — "…阻塞的患者中，" + "CCTA可以…" must rejoin
		// even though the continuation starts with an uppercase acronym.
		const danglingEnd = /[,，、;；:：]$/.test(prev.text.trim());
		const mergeable = sameColumn
			&& bodyOnly
			&& adjacent
			&& !endsSentence(prev.text)
			&& !looksLikeListStart(p.text)
			&& (startsContinuation(p.text) || danglingEnd);
		if (mergeable) {
			current.push(i);
		}
		else {
			groups.push(current);
			current = [i];
		}
	}
	if (current.length) {
		groups.push(current);
	}
	return groups;
}

/** Join two text fragments the way the script requires (no space inside CJK). */
/**
 * Line-ending hyphens that mark an interrupted word: ASCII hyphen-minus
 * (U+002D), soft hyphen (U+00AD), hyphen (U+2010), non-breaking hyphen
 * (U+2011). A word broken across a line with any of these should rejoin.
 */
export const LINE_HYPHENS = '-­‐‑';
const ENDS_LATIN_HYPHEN = new RegExp(`[A-Za-z][${LINE_HYPHENS}]$`);

/** True when `a` ends in a Latin letter + line hyphen and `b` starts Latin. */
export function isHyphenBreak(a: string, b: string): boolean {
	return ENDS_LATIN_HYPHEN.test(a.replace(/\s+$/, '')) && /^[A-Za-z]/.test(b.replace(/^\s+/, ''));
}

export function joinFragments(a: string, b: string): string {
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	const left = a.replace(/\s+$/, '');
	const right = b.replace(/^\s+/, '');
	// De-hyphenate an interrupted Latin word: "exam-" + "ple" -> "example".
	// Only when a letter sits on BOTH sides of the hyphen, so ranges ("3-5"),
	// compounds kept intact and trailing dashes are left alone.
	if (isHyphenBreak(left, right)) {
		return left.slice(0, -1) + right;
	}
	const cjkJoin = /[　-〿㐀-䶿一-鿿＀-￯]$/.test(left)
		&& /^[　-〿㐀-䶿一-鿿＀-￯]/.test(right);
	return cjkJoin ? left + right : `${left} ${right}`;
}

/** Join a paragraph's lines in reading order, de-hyphenating word breaks. */
export function joinLines(lines: string[]): string {
	return lines.reduce((acc, line) => joinFragments(acc, line), '').replace(/\s+/g, ' ').trim();
}

/**
 * Should a paragraph break be declared between two consecutive lines?
 * Centralises the rule both builders use.
 */
/**
 * Do two line rects overlap horizontally enough to belong to one paragraph?
 * The last line of a paragraph is short, so the requirement is one-sided:
 * most of the NARROWER line must sit inside the wider one's x-range.
 */
export function linesShareColumn(a: Rect, b: Rect): boolean {
	const left = Math.max(a[0], b[0]);
	const right = Math.min(a[2], b[2]);
	const overlap = right - left;
	if (overlap <= 0) {
		return false;
	}
	const narrower = Math.min(a[2] - a[0], b[2] - b[0]);
	return narrower <= 0 || overlap / narrower >= 0.5;
}

export interface BreakContext {
	/** Representative font size of the current line. */
	fontSize: number;
	/** Vertical whitespace between the two lines (PDF units, may be < 0). */
	gap: number;
	/** The current line reaches its column's right margin (i.e. it wrapped). */
	wrapped: boolean;
	/** The next line starts a new column, or jumps back up the page. */
	newColumn: boolean;
	/** The next line is indented relative to the column's left margin. */
	indented: boolean;
	/** Relative font-size change to the next line. */
	fontJump: boolean;
	/** The next line looks like a list item. */
	listStart: boolean;
}

export function shouldBreak(ctx: BreakContext): boolean {
	const size = ctx.fontSize > 0 ? ctx.fontSize : 10;
	if (ctx.newColumn || ctx.listStart) {
		return true;
	}
	// A gap this big is a section break no matter what the line looked like.
	if (ctx.gap > size * 1.7) {
		return true;
	}
	// Indentation is measured against the COLUMN's left margin, and a font-size
	// change is measured from dominant (not mean) sizes — both are strong
	// enough to end a paragraph on their own.
	if (ctx.indented || ctx.fontJump) {
		return true;
	}
	// The decisive guard for the remaining signal: a line that filled its
	// column wrapped, so the sentence continues. Line-spacing wobble — a tall
	// glyph, an inline formula, a superscript — must not cut it in half.
	if (ctx.wrapped) {
		return false;
	}
	return ctx.gap > size * 0.75;
}
