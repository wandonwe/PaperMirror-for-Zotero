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
import { type Rect } from '../reader/paragraphHeuristics';
import * as logger from '../utils/logger';
import { translatedFontSize } from './pageLayout';

const MODULE = 'translatedPageView';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** Supersampling for the page bitmap so text-free artwork stays crisp. */
const BITMAP_SCALE = 2;
/** Paper-colour bleed around a blanked paragraph, in page pixels. */
const MASK_PADDING = 1.5;
/** Below this the text is noise, not reading material. */
const MIN_FONT_PX = 8.5;

export interface TranslatedPageInput {
	blocks: SourceBlock[];
	translations: Map<string, string>;
	pageIndex: number;
	/** Width available in the pane, in CSS px. */
	availableWidth: number;
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
	const render = adapter.getPageRender(reader, input.pageIndex);
	if (!render) {
		return null;
	}
	const { viewportWidth, viewportHeight, scale } = render;
	if (viewportWidth <= 0 || viewportHeight <= 0) {
		return null;
	}

	// Fill the pane's width, always. The split is pixel-locked at 50/50, so
	// "as wide as the pane" IS "as wide as the original's half" — whatever
	// zoom the left side happens to be at. The old never-upscale cap left the
	// rebuilt page floating small with margins whenever the reader rendered
	// below pane width (fit-page zoom, or a rebuild racing the left side's
	// re-fit), shrinking every rect and font with it. A modest upscale bound
	// keeps a pathological tiny render from blowing up into mush.
	const pxPerViewport = Math.min(input.availableWidth / viewportWidth, 2.5);
	const pageWidthPx = viewportWidth * pxPerViewport;
	const pageHeightPx = viewportHeight * pxPerViewport;
	const pxPerPoint = scale * pxPerViewport;

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
		// Headings and titles keep the ORIGINAL text. They are the page's
		// skeleton: leaving them intact keeps the frame recognisable, reads
		// fine (short English labels), and removes a whole class of garbled
		// heading translations. Body paragraphs carry the actual reading load.
		if (block.type === 'heading' || block.type === 'title') {
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

	// ---- 4. place the translations, strictly in place -----------------------
	const textLayer = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	textLayer.className = 'pm-repage-text';
	page.appendChild(textLayer);

	interface PlacedItem { node: HTMLElement; height: number }
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
		node.style.height = `${box.height}px`;
		node.style.overflow = 'hidden';
		node.style.fontSize = `${translatedFontSize(block.fontSize ?? 0, pxPerPoint, bodyPt)}px`;
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
		placed.push({ node, height: box.height });
	}

	if (!placed.length) {
		return { element: page, hasArtwork, blocksPlaced: 0 };
	}

	// The element must be in the document to be measurable; the caller inserts
	// it and then calls settle(). Strict containment: binary-search the font
	// down until the translation fits its source rect. A block that cannot fit
	// even at the floor is flagged and expands over the page on hover.
	(page as HTMLElement & { pmSettle?: () => void }).pmSettle = () => {
		for (const item of placed) {
			const { node, height } = item;
			const fits = (size: number): boolean => {
				node.style.fontSize = `${size}px`;
				return node.scrollHeight <= height + 2;
			};
			const initial = parseFloat(node.style.fontSize) || 12;
			if (fits(initial)) {
				continue;
			}
			let lo = MIN_FONT_PX;
			let hi = initial;
			for (let i = 0; i < 8 && hi - lo > 0.25; i++) {
				const mid = (hi + lo) / 2;
				if (fits(mid)) {
					lo = mid;
				}
				else {
					hi = mid;
				}
			}
			node.style.fontSize = `${lo.toFixed(1)}px`;
			if (node.scrollHeight > height + 2) {
				node.style.lineHeight = '1.32';
			}
			if (node.scrollHeight > height + 2) {
				node.setAttribute('data-pm-overflow', 'true');
			}
		}
	};

	logger.debug(MODULE, `page ${input.pageIndex + 1}: ${placed.length} block(s), artwork=${hasArtwork}`);
	return { element: page, hasArtwork, blocksPlaced: placed.length };
}

/** Run the deferred measurement pass once the page is in the document. */
export function settleTranslatedPage(element: HTMLElement): void {
	(element as HTMLElement & { pmSettle?: () => void }).pmSettle?.();
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
