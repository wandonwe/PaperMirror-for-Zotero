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
import { getPref } from '../utils/prefs';
import { bodyAnchorPt, parseFactor, translatedFontSize } from './pageLayout';
import {
	assignColumns,
	findLayoutProblems,
	inkToObstacles,
	obstaclesToBoxes,
	planFlow,
	resolveOverlaps,
	type Box,
	type FlowItem,
	type FlowObstacle
} from './pageFlow';
import { detectTableRegions } from '../reader/tableGuard';

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

// (1.1.2 P2 清理) buildTranslatedPage/settleTranslatedPage/buildFallbackPage 及其
// 输入/结果接口已删除 —— 自 strict 分屏成为唯一渲染通道后它们再无调用方
// (最终审核 P2: ~700 行死代码)。存活导出: samplePaper/localPaper/inkFor/
// buildOriginalPage/PixelBox/rectToPixels/pixelBox。

export function samplePaper(ctx: CanvasRenderingContext2D, width: number, height: number): string {
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
export function localPaper(ctx: CanvasRenderingContext2D, box: { left: number; top: number; width: number; height: number }, scaleFactor: number, fallback: string): string {
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

export function inkFor(paper: string): string {
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

export interface PixelBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

export function rectToPixels(rect: Rect, render: adapter.PageRender, pxPerViewport: number): PixelBox {
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
export function pixelBox(block: SourceBlock, render: adapter.PageRender, pxPerViewport: number): PixelBox {
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
