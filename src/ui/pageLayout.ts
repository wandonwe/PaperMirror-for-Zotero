/**
 * Layout maths for the rebuilt translated page (整页对照).
 *
 * The rebuilt page is NOT the on-page overlay. The overlay squeezes each
 * translation back into the exact rectangle its source occupied, which forces
 * the type down to whatever size happens to fit. Here the page is rebuilt
 * instead: every paragraph starts where its source started, keeps its column
 * width, and is typeset at (near) the source's own point size — then simply
 * flows to whatever height it needs. Chinese is usually shorter than English,
 * so paragraphs normally end early and the grid stays aligned; when one does
 * run long, the paragraphs below it are pushed down inside their column
 * rather than the text being shrunk.
 *
 * Pure module — no DOM. The caller measures rendered heights and feeds them
 * back in, which keeps the awkward part (text measurement) at the edge and
 * the arithmetic testable.
 */

export interface PlacedBlock {
	id: string;
	/** Column index; blocks only push blocks in their own column. */
	column: number;
	/** Position in page pixels, top-left origin. */
	left: number;
	top: number;
	width: number;
	/** Height the text actually needs once rendered. */
	height: number;
	/** Height of the source paragraph, for reference. */
	sourceHeight: number;
}

export interface ResolveOptions {
	/** Page height in the same pixel space. */
	pageHeight: number;
	/** Minimum whitespace kept between two paragraphs. */
	minGap: number;
}

/**
 * Push overlapping blocks downward within their column, in reading order.
 *
 * Only a block that would actually collide is moved, and a block is never
 * pulled upward — a translation that ends early simply leaves white space,
 * exactly as the original page would if the paragraph were shorter.
 */
export function resolveColumnFlow(blocks: PlacedBlock[], options: ResolveOptions): PlacedBlock[] {
	const byColumn = new Map<number, PlacedBlock[]>();
	for (const block of blocks) {
		const list = byColumn.get(block.column);
		if (list) {
			list.push(block);
		}
		else {
			byColumn.set(block.column, [block]);
		}
	}
	const moved = new Map<string, number>();
	for (const list of byColumn.values()) {
		const ordered = [...list].sort((a, b) => a.top - b.top);
		let floor = -Infinity;
		for (const block of ordered) {
			const top = Math.max(block.top, floor);
			moved.set(block.id, top);
			floor = top + block.height + options.minGap;
		}
	}
	return blocks.map(block => ({ ...block, top: moved.get(block.id) ?? block.top }));
}

/**
 * How much taller the rebuilt page must be so nothing is cut off. Returns the
 * original page height unless a pushed block ran past the bottom.
 */
export function requiredPageHeight(blocks: PlacedBlock[], pageHeight: number): number {
	let bottom = pageHeight;
	for (const block of blocks) {
		bottom = Math.max(bottom, block.top + block.height);
	}
	return bottom;
}

/**
 * Type size for a translated paragraph, in page pixels: EXACTLY the source
 * size (磅值 × 当前缩放), no fudge factor. 译文字体大小要和原文一致 — the
 * fine print stays fine print, the body stays body, the heading stays a
 * heading. The strict-containment fitter shrinks below this only when the
 * translation genuinely does not fit its rect. The floor exists solely to
 * keep degenerate extracted sizes (0.5pt artifacts) from rendering invisible.
 */
export function translatedFontSize(sourcePt: number, pxPerPoint: number, bodyPt = 0): number {
	const fallback = bodyPt > 0 ? bodyPt : 10;
	const pt = sourcePt > 0 ? sourcePt : fallback;
	return Math.max(5, Math.min(48, pt * pxPerPoint));
}

/**
 * 页面基准字号 (参照 retain-pdf role_min / font-scaling 参考文): the size EVERY
 * body block on the page is unified to, so adjacent paragraphs never render at
 * visibly different sizes ("发花"). Robust minimum: the smallest size inside a
 * band around the median — a stray 6pt superscript-styled fragment or a
 * misclassified 14pt lead-in cannot drag the whole page.
 */
export function bodyAnchorPt(sizes: number[]): number {
	const usable = sizes.filter(s => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
	if (!usable.length) {
		return 0;
	}
	const median = usable[Math.floor(usable.length / 2)]!;
	const band = usable.filter(s => s >= median * 0.8 && s <= median * 1.25);
	return band.length ? band[0]! : median;
}

/** Parse a user factor pref ('1', '1.1') with a safety clamp. */
export function parseFactor(raw: unknown, min = 0.7, max = 1.4): number {
	const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
	if (!Number.isFinite(n) || n <= 0) {
		return 1;
	}
	return Math.max(min, Math.min(max, n));
}

/**
 * Assign blocks to columns from their horizontal position, using the column
 * bands already detected during extraction. A block wider than most is
 * full-width and gets its own lane so it can push (and be pushed by)
 * everything.
 */
export function laneOf(left: number, right: number, bands: { left: number; right: number }[], pageWidth: number): number {
	if (bands.length <= 1) {
		return 0;
	}
	if (right - left >= pageWidth * 0.62) {
		return -1; // spans the page
	}
	let best = 0;
	let bestOverlap = -1;
	for (let i = 0; i < bands.length; i++) {
		const band = bands[i]!;
		const overlap = Math.min(right, band.right) - Math.max(left, band.left);
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			best = i;
		}
	}
	return best;
}

/**
 * A full-width block sits in every column, so it must participate in each
 * column's flow. Expanding lane -1 into "one entry per column" lets
 * resolveColumnFlow stay a simple per-column sweep.
 */
export function expandSpanningLanes(blocks: PlacedBlock[], columnCount: number): PlacedBlock[] {
	if (columnCount <= 1) {
		return blocks.map(b => ({ ...b, column: 0 }));
	}
	const out: PlacedBlock[] = [];
	for (const block of blocks) {
		if (block.column !== -1) {
			out.push(block);
			continue;
		}
		for (let c = 0; c < columnCount; c++) {
			out.push({ ...block, column: c });
		}
	}
	return out;
}

/** Collapse the duplicates expandSpanningLanes created, taking the lowest top. */
export function collapseSpanningLanes(blocks: PlacedBlock[]): PlacedBlock[] {
	const byId = new Map<string, PlacedBlock>();
	for (const block of blocks) {
		const existing = byId.get(block.id);
		if (!existing || block.top > existing.top) {
			byId.set(block.id, block);
		}
	}
	return [...byId.values()];
}
