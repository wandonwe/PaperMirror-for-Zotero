/**
 * 整页对照 — rebuild the current page with the body text translated, keeping
 * the original's page size, column grid, figures, rules, header and footer, so
 * the two pages can be read side by side as a spread.
 *
 * How it is built:
 *   1. The page PDF.js already rendered is copied into a fresh canvas. That
 *      brings figures, tables, equations, hairlines and the journal's running
 *      head/foot across pixel-exact, with no re-rasterising.
 *   2. Every paragraph we translated is painted out in the colour of ITS OWN
 *      local background (sampled per block from the bitmap — a coloured
 *      keywords box masks in that colour, a white figure panel in white).
 *   3. The translations are typeset STRICTLY inside their source rects: the
 *      font binary-searches down until the text fits (floor 8.5px). No
 *      reflow, no pushing — after several rounds of flow heuristics each
 *      finding new ways to overlap on complex pages, the guarantee the reader
 *      actually wants is 译文永远在原文的位置上. A block that cannot fit even
 *      at the floor is flagged and expands over the page on hover.
 *
 * Anything we did not translate — figures, tables, reference lists, the
 * running head, tiny figure labels — simply shows through from the bitmap.
 */

import type { SourceBlock } from '../types/models';
import * as adapter from '../reader/zoteroReaderAdapter';
import type { ReaderLike } from '../reader/zoteroReaderAdapter';
import { isMetadataBlock } from '../reader/metaFilter';
import { type Rect } from '../reader/paragraphHeuristics';
import * as logger from '../utils/logger';
import { translatedFontSize } from './pageLayout';
import {
	assignColumns,
	inkToObstacles,
	obstaclesToBoxes,
	planFlow,
	resolveOverlaps,
	type FlowItem,
	type FlowObstacle
} from './pageFlow';

const MODULE = 'translatedPageView';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Supersampling for the page bitmap so text-free artwork stays crisp.
 *
 * Two canvases are allocated per draw (artwork + mask), each pageWidth ×
 * pageHeight × BITMAP_SCALE² × 4 bytes. At 2× a large page costs ~35 MB per
 * draw, so the factor is stepped down on big pages: crispness is worth a lot
 * less than not exhausting memory.
 */
const BITMAP_SCALE_MAX = 2;
// Lowered from 6M when the pane became a full-document list: several pages
// are alive at once, and each page carries TWO canvases at this budget.
const BITMAP_PIXEL_BUDGET = 3_200_000; // per canvas, ≈13 MB at 4 bytes/px

function bitmapScaleFor(widthPx: number, heightPx: number): number {
	const area = Math.max(1, widthPx * heightPx);
	const scale = Math.sqrt(BITMAP_PIXEL_BUDGET / area);
	return Math.max(1, Math.min(BITMAP_SCALE_MAX, scale));
}
/** Paper-colour bleed around a blanked paragraph, in page pixels. */
const MASK_PADDING = 2;
/** Below this the text is noise, not reading material. */
const MIN_FONT_PX = 8.5;

export interface TranslatedPageInput {
	blocks: SourceBlock[];
	translations: Map<string, string>;
	pageIndex: number;
	/** Width available in the pane, in CSS px. */
	availableWidth: number;
	/**
	 * A page render supplied by the caller (from adapter.renderPageBitmap).
	 * When present it is used directly, which frees this builder from the left
	 * viewer's virtualisation — any page can be rebuilt, not just the ones
	 * PDF.js keeps on screen. Absent, the live viewer render is copied as
	 * before.
	 */
	render?: adapter.PageRender;
}

export interface TranslatedPageResult {
	/** The page element, already sized. */
	element: HTMLElement;
	/** True when the original bitmap could be copied (figures preserved). */
	hasArtwork: boolean;
	blocksPlaced: number;
}

function isTranslatable(block: SourceBlock): boolean {
	return !block.isReference
		&& block.type !== 'table'
		&& !!block.lineRectsPdf?.length;
}

/**
 * Sample the page's paper colour from the composed bitmap's margins.
 */
function samplePaper(ctx: CanvasRenderingContext2D, width: number, height: number): string {
	try {
		const inset = Math.max(2, Math.floor(Math.min(width, height) * 0.02));
		const points: [number, number][] = [
			[inset, inset], [width - inset, inset],
			[inset, height - inset], [width - inset, height - inset],
			[Math.floor(width / 2), inset], [Math.floor(width / 2), height - inset]
		];
		const counts = new Map<string, number>();
		for (const [x, y] of points) {
			const data = ctx.getImageData(
				Math.min(width - 1, Math.max(0, x)),
				Math.min(height - 1, Math.max(0, y)),
				1, 1
			).data;
			if (data[3] === 0) {
				continue;
			}
			const key = `${data[0]},${data[1]},${data[2]}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		let best = '255,255,255';
		let bestCount = 0;
		for (const [key, count] of counts) {
			if (count > bestCount) {
				best = key;
				bestCount = count;
			}
		}
		return `rgb(${best})`;
	}
	catch {
		return 'rgb(255,255,255)';
	}
}

/**
 * Background colour UNDER one block, sampled from the artwork bitmap.
 *
 * The page-wide paper colour is wrong the moment a block sits on anything
 * else — a coloured KEYWORDS box, a figure panel, an orange banner. Masking
 * those with the page colour painted dark/white patches all over the artwork.
 * Sampling the block's own corners and edge midpoints (text rarely touches
 * them) yields the colour that makes the mask invisible.
 */
function localPaper(ctx: CanvasRenderingContext2D, box: { left: number; top: number; width: number; height: number }, scaleFactor: number, fallback: string): string {
	try {
		// Twelve probes: the four inside corners, plus points 3px OUTSIDE each
		// edge (margins and line gaps are text-free far more reliably than
		// anything inside a dense paragraph). Colours are quantised to 32-level
		// buckets before voting, so the antialiased halo around glyphs doesn't
		// split the background vote. On a text-dense page a thin 6-point probe
		// kept hitting glowing glyphs, called the block "light", and then both
		// the mask and the ink were painted inverted — the interleaved
		// bright/faint text mess.
		const w = ctx.canvas.width;
		const h = ctx.canvas.height;
		const pts: [number, number][] = [];
		const push = (x: number, y: number): void => {
			const px = Math.round(x * scaleFactor);
			const py = Math.round(y * scaleFactor);
			if (px >= 0 && py >= 0 && px < w && py < h) {
				pts.push([px, py]);
			}
		};
		const { left, top, width, height } = box;
		push(left + 2, top + 2);
		push(left + width - 2, top + 2);
		push(left + 2, top + height - 2);
		push(left + width - 2, top + height - 2);
		push(left - 3, top + height / 2);
		push(left + width + 3, top + height / 2);
		push(left + width / 2, top - 3);
		push(left + width / 2, top + height + 3);
		push(left - 3, top + 2);
		push(left + width + 3, top + 2);
		push(left - 3, top + height - 2);
		push(left + width + 3, top + height - 2);

		const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
		for (const [x, y] of pts) {
			const d = ctx.getImageData(x, y, 1, 1).data;
			if (d[3] === 0) {
				continue;
			}
			const key = `${d[0]! >> 3},${d[1]! >> 3},${d[2]! >> 3}`;
			const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
			entry.count++;
			entry.r += d[0]!;
			entry.g += d[1]!;
			entry.b += d[2]!;
			buckets.set(key, entry);
		}
		let best: { count: number; r: number; g: number; b: number } | null = null;
		for (const entry of buckets.values()) {
			if (!best || entry.count > best.count) {
				best = entry;
			}
		}
		// A clear majority or nothing: a split vote means the probes are
		// landing on mixed content, and the page-wide paper colour is the
		// safer answer than a coin-flip.
		if (!best || best.count < 5) {
			return fallback;
		}
		const n = best.count;
		return `rgb(${Math.round(best.r / n)}, ${Math.round(best.g / n)}, ${Math.round(best.b / n)})`;
	}
	catch {
		return fallback;
	}
}

function inkFor(paper: string): string {
	const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(paper);
	if (!match) {
		return '#14171a';
	}
	const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
	return luminance < 0.5 ? '#eef1f5' : '#14171a';
}

/**
 * Build the rebuilt page for one PDF page. Returns null when the page is not
 * currently rendered by PDF.js (nothing to copy from).
 */
export function buildTranslatedPage(
	doc: Document,
	reader: ReaderLike,
	input: TranslatedPageInput
): TranslatedPageResult | null {
	const render = input.render ?? adapter.getPageRender(reader, input.pageIndex);
	if (!render) {
		return null;
	}
	const { viewportWidth, viewportHeight, scale } = render;
	if (viewportWidth <= 0 || viewportHeight <= 0) {
		return null;
	}

	// MIRROR THE READER, 1:1. The rebuilt page is rendered at exactly the size
	// PDF.js just rendered the original at — same pixels, same scale.
	//
	// Every previous formula scaled the page to the pane's width instead, and
	// each one failed the same way: the page element carries pixel geometry
	// (block lefts, widths, font sizes), so the moment an ancestor clamps its
	// width the bitmap scales down with the container while the text keeps its
	// pixel coordinates — giant type spilling past the edge, masks no longer
	// covering the words they were cut for. Deriving the size from the reader's
	// own render also makes zoom work for free: zooming re-renders the left
	// side, which fires pagerendered, which rebuilds the right side at the new
	// size. Both halves change together, always.
	const pxPerViewport = 1;
	const pageWidthPx = viewportWidth * pxPerViewport;
	const pageHeightPx = viewportHeight * pxPerViewport;
	const pxPerPoint = scale * pxPerViewport;

	const BITMAP_SCALE = bitmapScaleFor(pageWidthPx, pageHeightPx);

	const page = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	page.className = 'pm-repage';
	page.setAttribute('data-pm-page', String(input.pageIndex));
	page.style.width = `${pageWidthPx}px`;
	page.style.height = `${pageHeightPx}px`;

	// ---- 1. copy the rendered page -----------------------------------------
	const canvas = doc.createElementNS(HTML_NS, 'canvas') as HTMLCanvasElement;
	canvas.width = Math.max(1, Math.round(pageWidthPx * BITMAP_SCALE));
	canvas.height = Math.max(1, Math.round(pageHeightPx * BITMAP_SCALE));
	canvas.className = 'pm-repage-canvas';
	const ctx = canvas.getContext('2d');
	let hasArtwork = false;
	let paper = 'rgb(255,255,255)';
	if (ctx) {
		ctx.fillStyle = paper;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		try {
			ctx.drawImage(render.canvas, 0, 0, render.canvas.width, render.canvas.height,
				0, 0, canvas.width, canvas.height);
			hasArtwork = true;
			paper = samplePaper(ctx, canvas.width, canvas.height);
		}
		catch (e) {
			// Cross-document canvas copy refused: fall back to a blank page.
			// The translation is still fully readable, just without artwork.
			logger.debug(MODULE, 'page bitmap copy failed; rendering on blank paper', e);
			ctx.fillStyle = paper;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		}
	}
	page.appendChild(canvas);

	// ---- 2. what gets replaced ----------------------------------------------
	const translatable = input.blocks.filter(isTranslatable);
	const bodyPt = medianOf(translatable.map(b => b.fontSize ?? 0).filter(s => s > 0));

	// Blocks too small to re-typeset are left alone entirely — no mask, no
	// text. These are figure-internal labels ("A", axis numbers, legend
	// words): replacing them wrecks the artwork.
	const replaceable = new Set<string>();
	for (const block of translatable) {
		if (input.translations.get(block.id) === undefined) {
			continue; // not translated yet — leave the original visible
		}
		// Titles and headings ARE translated here. The rebuilt page is meant to
		// read as the paper in Chinese — a Chinese abstract under an English
		// heading reads like a bug. (The on-PDF overlay keeps the title in the
		// original, deliberately: there the English page is what you are
		// looking at, and the title is how you recognise it.)
		//
		// Belt and braces: a translation cached from before the metadata
		// filter learned a pattern must not resurface here.
		if (isMetadataBlock(block.sourceText)) {
			continue;
		}
		const box = pixelBox(block, render, pxPerViewport);
		if (box.width < 50 || box.height < 9 || block.sourceText.trim().length < 6) {
			continue;
		}
		replaceable.add(block.id);
	}

	// ---- 3. blank the paragraphs we are replacing ---------------------------
	// The mask lives on its OWN canvas so 显示原文对照 can lift it and reveal
	// the untouched original underneath. Each block masks in ITS local colour.
	const mask = doc.createElementNS(HTML_NS, 'canvas') as HTMLCanvasElement;
	mask.width = canvas.width;
	mask.height = canvas.height;
	mask.className = 'pm-repage-mask';
	const maskCtx = mask.getContext('2d');
	const blockPaper = new Map<string, string>();
	if (maskCtx && ctx) {
		for (const block of translatable) {
			if (!replaceable.has(block.id)) {
				continue;
			}
			const whole = pixelBox(block, render, pxPerViewport);
			const colour = localPaper(ctx, whole, BITMAP_SCALE, paper);
			blockPaper.set(block.id, colour);
			maskCtx.fillStyle = colour;
			for (const rect of block.lineRectsPdf!) {
				const box = rectToPixels(rect, render, pxPerViewport);
				maskCtx.fillRect(
					(box.left - MASK_PADDING) * BITMAP_SCALE,
					(box.top - MASK_PADDING) * BITMAP_SCALE,
					(box.width + MASK_PADDING * 2) * BITMAP_SCALE,
					(box.height + MASK_PADDING * 2) * BITMAP_SCALE
				);
			}
		}
	}
	page.appendChild(mask);

	const ink = inkFor(paper);
	page.style.setProperty('--pm-repage-ink', ink);
	page.style.background = paper;

	// ---- 4. place the translations, re-flowed ------------------------------
	const textLayer = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	textLayer.className = 'pm-repage-text';
	page.appendChild(textLayer);

	interface PlacedItem {
		node: HTMLElement;
		box: PixelBox;
		startSize: number;
	}
	const placed: PlacedItem[] = [];
	for (const block of translatable) {
		const translated = input.translations.get(block.id);
		if (translated === undefined || !translated.trim() || !replaceable.has(block.id)) {
			continue;
		}
		const box = pixelBox(block, render, pxPerViewport);
		const node = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
		node.className = 'pm-repage-block';
		node.setAttribute('data-pm-block', block.id);
		node.setAttribute('data-pm-type', block.type);
		node.setAttribute('data-pm-page', String(block.pageIndex));
		node.style.left = `${box.left}px`;
		node.style.top = `${box.top}px`;
		node.style.width = `${box.width}px`;
		// Height is NOT set: the block takes what the Chinese needs, and the
		// flow pass moves whatever is below it. That is the whole difference
		// between a re-flowed page and text crammed back into English boxes.
		const startSize = translatedFontSize(block.fontSize ?? 0, pxPerPoint, bodyPt);
		node.style.fontSize = `${startSize}px`;
		const bg = blockPaper.get(block.id);
		if (bg) {
			node.style.color = inkFor(bg);
			node.style.setProperty('--pm-block-paper', bg);
		}
		if (block.type === 'heading' || block.type === 'title') {
			node.setAttribute('data-pm-strong', 'true');
		}
		node.textContent = translated; // SAFE: text node only, never innerHTML
		node.title = block.sourceText;
		textLayer.appendChild(node);
		placed.push({ node, box, startSize });
	}

	if (!placed.length) {
		return { element: page, hasArtwork, blocksPlaced: 0 };
	}

	// Blocks left in the original — author lists, affiliations, anything the
	// metadata filter excluded. They stay exactly where the paper put them, so
	// the flow must treat them as immovable.
	const fixedBoxes = translatable
		.filter(b => !replaceable.has(b.id))
		.map(b => pixelBox(b, render, pxPerViewport))
		.filter(b => b.width > 8 && b.height > 4);

	// Obstacles: ink on the original page that is NOT one of our blocks —
	// figures, plots, logos, stamps. Sampled from the artwork bitmap while it
	// is still to hand.
	const obstacles = ctx
		? buildObstacles(ctx, BITMAP_SCALE, pageWidthPx, pageHeightPx, placed.map(p => p.box))
		: [];

	// The element must be in the document to be measurable; the caller inserts
	// it and then calls settle().
	(page as HTMLElement & { pmSettle?: () => void }).pmSettle = () => {
		// Idempotent: reset every block to its starting state first, so the
		// settle can be re-run (e.g. as font-readiness insurance) without the
		// previous run's shrunken sizes compounding. The PAGE HEIGHT resets
		// too — a previous run may have grown the page, and if this run needs
		// less the stale growth would leave a band of blank paper below.
		page.style.height = `${pageHeightPx}px`;
		for (const item of placed) {
			item.node.style.fontSize = `${item.startSize}px`;
			item.node.style.removeProperty('line-height');
			item.node.style.top = `${item.box.top}px`;
			item.node.removeAttribute('data-pm-displaced');
			item.node.removeAttribute('data-pm-overflow');
		}

		// ---- containment first: fit each region into ITS OWN box -----------
		// The translation belongs inside the region it replaces. Before the
		// flow is allowed to move anything, each block walks a typographic
		// ladder — leading 1.5 → 1.34 → 1.24 → 1.18 (matching the overlay's
		// ladder), then the type down to 88% of the source size (never below
		// 8.5px) — and only what STILL does not fit spills into the
		// flow/growth machinery. 中文通常更短, so most regions settle at 1:1
		// and the page keeps its exact shape.
		//
		// Tolerance is ±0.5px: scrollHeight rounds up, and the old ±2px let
		// borderline blocks seep a couple of pixels past their box bottom.
		const FIT_SLACK = 0.5;
		for (const item of placed) {
			const node = item.node;
			const boxHeight = item.box.height;
			if (node.scrollHeight <= boxHeight + FIT_SLACK) {
				continue;
			}
			for (const leading of ['1.34', '1.24', '1.18']) {
				node.style.lineHeight = leading;
				if (node.scrollHeight <= boxHeight + FIT_SLACK) {
					break;
				}
			}
			let size = item.startSize;
			const floor = Math.max(8.5, item.startSize * 0.88);
			while (node.scrollHeight > boxHeight + FIT_SLACK && size > floor) {
				size = Math.max(floor, size * 0.96);
				node.style.fontSize = `${size.toFixed(1)}px`;
			}
		}

		const columns = assignColumns(placed.map(p => ({ left: p.box.left, width: p.box.width })));
		// Natural height at the source size — one measurement per block.
		const items: FlowItem[] = placed.map((item, i) => ({
			id: String(i),
			column: columns[i] ?? 0,
			left: item.box.left,
			width: item.box.width,
			sourceTop: item.box.top,
			naturalHeight: item.node.scrollHeight
		}));
		let plan = planFlow(items, obstacles, {
			pageHeight: pageHeightPx,
			gap: Math.max(4, bodyPt * pxPerPoint * 0.55),
			bottomMargin: pageHeightPx * 0.04
		});

		// If the column ran off the page, tighten that column and re-flow it —
		// once. Shrinking everything because one paragraph is long is what made
		// earlier versions look like a ransom note.
		const overflowingColumns = new Set(
			plan.filter(p => p.overflow).map(p => items[Number(p.id)]!.column)
		);
		if (overflowingColumns.size) {
			for (let i = 0; i < placed.length; i++) {
				if (!overflowingColumns.has(items[i]!.column)) {
					continue;
				}
				const item = placed[i]!;
				const tightened = Math.max(MIN_FONT_PX, item.startSize * 0.9);
				item.node.style.fontSize = `${tightened.toFixed(1)}px`;
				// NEVER loosen: a block whose containment ladder already went to
				// 1.24/1.18 must keep that leading — blanket-resetting to 1.34
				// made those blocks TALLER and re-broke their own boxes.
				const current = parseFloat(item.node.style.lineHeight || '1.5');
				item.node.style.lineHeight = String(Math.min(current, 1.34));
				items[i]!.naturalHeight = item.node.scrollHeight;
			}
			plan = planFlow(items, obstacles, {
				pageHeight: pageHeightPx,
				gap: Math.max(3, bodyPt * pxPerPoint * 0.45),
				bottomMargin: pageHeightPx * 0.02
			});
		}

		// Last line of defence: whatever the column analysis decided, no two
		// boxes may end up on the same pixels — nothing may be printed over a
		// piece of the original we chose to keep, and nothing may be parked on
		// a FIGURE either (the obstacles join the sweep as immovable boxes;
		// planFlow hopped them, but a push in this sweep could land on one).
		const columnBands = new Map<number, { left: number; right: number }>();
		placed.forEach((item, i) => {
			const column = columns[i] ?? 0;
			const band = columnBands.get(column);
			columnBands.set(column, band
				? { left: Math.min(band.left, item.box.left), right: Math.max(band.right, item.box.left + item.box.width) }
				: { left: item.box.left, right: item.box.left + item.box.width });
		});
		const gap = Math.max(4, bodyPt * pxPerPoint * 0.4);
		const resolved = resolveOverlaps(
			plan.map((placement) => {
				const item = placed[Number(placement.id)]!;
				return {
					id: placement.id,
					left: item.box.left,
					top: placement.top,
					width: item.box.width,
					height: items[Number(placement.id)]!.naturalHeight
				};
			}),
			[...fixedBoxes, ...obstaclesToBoxes(obstacles, columnBands)],
			gap,
			pageHeightPx
		);

		let maxBottom = pageHeightPx;
		for (const placement of plan) {
			const item = placed[Number(placement.id)];
			if (!item) {
				continue;
			}
			const top = resolved.get(placement.id) ?? placement.top;
			item.node.style.top = `${top}px`;
			if (top > item.box.top + 0.5) {
				item.node.setAttribute('data-pm-displaced', 'true');
			}
			const bottom = top + items[Number(placement.id)]!.naturalHeight;
			if (bottom > pageHeightPx) {
				item.node.setAttribute('data-pm-overflow', 'true');
			}
			maxBottom = Math.max(maxBottom, bottom);
		}
		// Long translations extend the page below the artwork rather than
		// piling up on the bottom edge. The extension is plain paper.
		if (maxBottom > pageHeightPx + 1) {
			page.style.height = `${Math.ceil(maxBottom + 14)}px`;
		}
	};

	logger.debug(MODULE, `page ${input.pageIndex + 1}: ${placed.length} block(s), artwork=${hasArtwork}`);
	return { element: page, hasArtwork, blocksPlaced: placed.length };
}

/**
 * Run the deferred measurement pass once the page is in the document.
 *
 * Insurance: if the document's font set is still loading when the first
 * measurement runs, the settle re-runs once when it finishes (pmSettle is
 * idempotent — it resets every block first). With the system CJK stack this
 * is normally a no-op, but it closes the measure-once fragility for any
 * environment where a face does arrive late. `onSettled` fires after every
 * settle so the caller can re-sync the slot height to the (re)grown page.
 */
export function settleTranslatedPage(element: HTMLElement, onSettled?: () => void): void {
	const settle = (element as HTMLElement & { pmSettle?: () => void }).pmSettle;
	if (!settle) {
		return;
	}
	settle();
	onSettled?.();
	try {
		const fonts = (element.ownerDocument as Document & { fonts?: { status?: string; ready?: Promise<unknown> } }).fonts;
		if (!fonts?.ready) {
			return;
		}
		const resettle = (): void => {
			if (element.isConnected) {
				settle();
				onSettled?.();
			}
		};
		// Hook `ready` UNCONDITIONALLY: our own text insertion may be what
		// kicks off a font load, and the status check alone missed loads that
		// start between the first measurement and the check. pmSettle is
		// idempotent, so an already-loaded set just costs one cheap re-pass.
		// A second wave is caught once (a face can start loading during the
		// first re-settle); after that we stop — never an unbounded chain.
		void fonts.ready.then(() => {
			resettle();
			if (fonts.status === 'loading' && fonts.ready) {
				void fonts.ready.then(resettle);
			}
		});
	}
	catch {
		// insurance only — never let it break the page
	}
}

/**
 * Where on the page may the flow NOT print?
 *
 * Everything the reader can see that we are not replacing: figures, plots,
 * photographs, journal logos, coloured bands, tables. There is no layout model
 * to ask, so this reads the artwork bitmap directly — downsample the page to a
 * coarse grid, mark every cell whose contrast against the paper says "there is
 * something here", erase the cells covered by the blocks we are about to
 * replace, and hand the rest to the flow as obstacles.
 *
 * Coarse on purpose. The grid only has to answer "is there a figure roughly
 * here", and a fine grid would turn every stray speck into a wall.
 */
function buildObstacles(
	ctx: CanvasRenderingContext2D,
	bitmapScale: number,
	pageWidthPx: number,
	pageHeightPx: number,
	blockBoxes: PixelBox[]
): FlowObstacle[] {
	try {
		const COLS = 40;
		const ROWS = 80;
		const cellW = pageWidthPx / COLS;
		const cellH = pageHeightPx / ROWS;
		const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
		const data = image.data;
		const stride = image.width * 4;

		// Paper reference: the median-ish corner sample already used elsewhere.
		const paperAt = (x: number, y: number): number => {
			const idx = Math.min(data.length - 4, (Math.round(y) * image.width + Math.round(x)) * 4);
			return 0.2126 * data[idx]! + 0.7152 * data[idx + 1]! + 0.0722 * data[idx + 2]!;
		};
		const reference = paperAt(image.width * 0.02, image.height * 0.02);

		const ink: boolean[][] = [];
		for (let row = 0; row < ROWS; row++) {
			const cells: boolean[] = [];
			for (let col = 0; col < COLS; col++) {
				// Sample a few points per cell rather than every pixel: this runs
				// on every redraw and the answer is a yes/no.
				let hits = 0;
				for (let sy = 1; sy <= 3; sy++) {
					for (let sx = 1; sx <= 3; sx++) {
						const px = (col + sx / 4) * cellW * bitmapScale;
						const py = (row + sy / 4) * cellH * bitmapScale;
						if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
							continue;
						}
						const idx = Math.round(py) * stride + Math.round(px) * 4;
						if (idx < 0 || idx + 2 >= data.length) {
							continue;
						}
						const luminance = 0.2126 * data[idx]! + 0.7152 * data[idx + 1]! + 0.0722 * data[idx + 2]!;
						if (Math.abs(luminance - reference) > 26) {
							hits++;
						}
					}
				}
				cells.push(hits >= 4);
			}
			ink.push(cells);
		}

		// Erase the text we are replacing — its ink is about to be masked out.
		for (const box of blockBoxes) {
			const fromRow = Math.max(0, Math.floor((box.top - cellH) / cellH));
			const toRow = Math.min(ROWS - 1, Math.ceil((box.top + box.height + cellH) / cellH));
			const fromCol = Math.max(0, Math.floor((box.left - cellW) / cellW));
			const toCol = Math.min(COLS - 1, Math.ceil((box.left + box.width + cellW) / cellW));
			for (let row = fromRow; row <= toRow; row++) {
				for (let col = fromCol; col <= toCol; col++) {
					ink[row]![col] = false;
				}
			}
		}

		// One column range per distinct block column.
		const columns = assignColumns(blockBoxes.map(b => ({ left: b.left, width: b.width })));
		const ranges = new Map<number, { column: number; fromCol: number; toCol: number }>();
		blockBoxes.forEach((box, i) => {
			const column = columns[i] ?? 0;
			const fromCol = Math.max(0, Math.floor(box.left / cellW));
			const toCol = Math.min(COLS - 1, Math.ceil((box.left + box.width) / cellW));
			const existing = ranges.get(column);
			ranges.set(column, existing
				? { column, fromCol: Math.min(existing.fromCol, fromCol), toCol: Math.max(existing.toCol, toCol) }
				: { column, fromCol, toCol });
		});

		return inkToObstacles(ink, cellH, [...ranges.values()], 2, cellW);
	}
	catch (e) {
		// No obstacle map is survivable — the flow simply keeps blocks in
		// their source order and positions.
		logger.debug(MODULE, 'obstacle map failed; flowing without it', e);
		return [];
	}
}

/**
 * The untranslated counterpart: the page exactly as rendered, wrapped in the
 * same .pm-repage shell so the full-document list is visually uniform while a
 * page's translation is still on its way. The moment the translation lands,
 * the caller swaps this element for buildTranslatedPage's.
 */
export function buildOriginalPage(
	doc: Document,
	render: adapter.PageRender
): HTMLElement {
	const page = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	page.className = 'pm-repage';
	page.setAttribute('data-pm-original', 'true');
	page.style.width = `${render.viewportWidth}px`;
	page.style.height = `${render.viewportHeight}px`;
	const canvas = doc.createElementNS(HTML_NS, 'canvas') as HTMLCanvasElement;
	canvas.className = 'pm-repage-canvas';
	canvas.width = render.canvas.width;
	canvas.height = render.canvas.height;
	const ctx = canvas.getContext('2d');
	try {
		ctx?.drawImage(render.canvas, 0, 0);
	}
	catch (e) {
		logger.debug(MODULE, 'original page bitmap copy failed', e);
	}
	page.appendChild(canvas);
	return page;
}

// ---- geometry helpers -------------------------------------------------------

interface PixelBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

function rectToPixels(rect: Rect, render: adapter.PageRender, pxPerViewport: number): PixelBox {
	const [ax, ay] = render.toViewport(rect[0], rect[3]); // top-left
	const [bx, by] = render.toViewport(rect[2], rect[1]); // bottom-right
	const left = Math.min(ax, bx) * pxPerViewport;
	const top = Math.min(ay, by) * pxPerViewport;
	return {
		left,
		top,
		width: Math.abs(bx - ax) * pxPerViewport,
		height: Math.abs(by - ay) * pxPerViewport
	};
}

/** Union of a block's line rects, in page pixels. */
function pixelBox(block: SourceBlock, render: adapter.PageRender, pxPerViewport: number): PixelBox {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const rect of block.lineRectsPdf ?? []) {
		const box = rectToPixels(rect, render, pxPerViewport);
		left = Math.min(left, box.left);
		top = Math.min(top, box.top);
		right = Math.max(right, box.left + box.width);
		bottom = Math.max(bottom, box.top + box.height);
	}
	if (!Number.isFinite(left)) {
		return { left: 0, top: 0, width: 0, height: 0 };
	}
	return { left, top, width: right - left, height: bottom - top };
}

function medianOf(values: number[]): number {
	if (!values.length) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}
