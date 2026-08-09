/**
 * 严格原位替换 — the 整页对照 renderer.
 *
 * The reflow experiments are over for this mode: the page the reader sees is
 * the ORIGINAL page — same size, same figures, same table lines, same
 * background, same positions — with translated text written into exactly the
 * rectangles the source text occupied. Nothing moves, nothing grows, nothing
 * continues onto another sheet.
 *
 *   original page bitmap: kept 1:1
 *        ↓
 *   per-line masks over ONLY the text strokes being replaced
 *   (hard-clipped against real image rectangles — a mask may never touch a
 *   figure, whatever the extraction thought)
 *        ↓
 *   translation typeset INSIDE the source rectangle, fixed font size
 *   (the block's body-cluster minimum), leading/tracking compress ladder
 *        ↓
 *   still too long → the caller re-requests a COMPRESSED translation with a
 *   character budget; still too long after that → the block REVERTS to the
 *   original text (mask cleared) — never clipped, never overlapped
 *
 * pageFlow (planFlow/resolveOverlaps/packing/continuation) is NOT used here.
 * It remains in service of the 文章流 mode, where reflow is the point.
 */

import type { SourceBlock } from '../types/models';
import * as adapter from '../reader/zoteroReaderAdapter';
import { isMetadataBlock } from '../reader/metaFilter';
import { type Rect } from '../reader/paragraphHeuristics';
import * as logger from '../utils/logger';
import { detectTableRegions } from '../reader/tableGuard';
import {
	inkFor,
	localPaper,
	pixelBox,
	rectToPixels,
	samplePaper,
	type PixelBox
} from './translatedPageView';

const MODULE = 'strictPageReplacement';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

const BITMAP_SCALE_MAX = 2;
const BITMAP_PIXEL_BUDGET = 3_200_000;

function bitmapScaleFor(widthPx: number, heightPx: number): number {
	const area = Math.max(1, widthPx * heightPx);
	return Math.max(1, Math.min(BITMAP_SCALE_MAX, Math.sqrt(BITMAP_PIXEL_BUDGET / area)));
}

/** The leading/tracking compress ladder. The FONT SIZE never changes here. */
const STRICT_LADDER: { lineHeight: number; letterSpacingEm: number }[] = [
	{ lineHeight: 1.42, letterSpacingEm: 0 },
	{ lineHeight: 1.32, letterSpacingEm: 0 },
	{ lineHeight: 1.24, letterSpacingEm: -0.01 },
	{ lineHeight: 1.18, letterSpacingEm: -0.02 },
	{ lineHeight: 1.14, letterSpacingEm: -0.02 }
];

/**
 * LAST-RESORT font shrink, tried only after the compress-and-retry rounds are
 * exhausted (or unavailable — the free engines ignore character budgets).
 * This is a deliberate, bounded deviation from the fixed-font-size rule:
 * a translation at 94%/88% of the body size is far better reading than one
 * that silently reverts to English. Floor 8.5px; below that we still revert.
 */
const SHRINK_STEPS = [0.94, 0.88];
const SHRINK_FLOOR_PX = 8.5;

export interface StrictPageInput {
	blocks: SourceBlock[];
	translations: Map<string, string>;
	pageIndex: number;
	render: adapter.PageRender;
	/** Real image rectangles (PDF user space) — hard no-mask/no-text zones. */
	imageRectsPdf?: [number, number, number, number][];
}

export interface UnfitBlock {
	id: string;
	/** Rough CJK character capacity of the block's rectangle. */
	maxChars: number;
}

export interface StrictPageResult {
	element: HTMLElement;
	blocksPlaced: number;
}

/**
 * Rough capacity of a fixed rectangle in CJK characters at a fixed size —
 * the budget handed back to the translator for a compress-and-retry.
 */
export function estimateCjkCapacity(widthPx: number, heightPx: number, fontPx: number): number {
	if (widthPx <= 0 || heightPx <= 0 || fontPx <= 0) {
		return 8;
	}
	const cols = Math.floor(widthPx / fontPx);
	const rows = Math.floor(heightPx / (fontPx * 1.18));
	return Math.max(8, Math.floor(cols * rows * 0.95));
}

function intersectArea(a: PixelBox, b: PixelBox): number {
	const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
	const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Build the strict page. The returned element exposes:
 *   pmSettleStrict(): UnfitBlock[]  — idempotent measure pass
 *   pmRevert(ids): void             — clear masks + hide translations, so the
 *                                     original text shows for those blocks
 */
export function buildStrictPage(doc: Document, input: StrictPageInput): StrictPageResult | null {
	const render = input.render;
	const { viewportWidth, viewportHeight, scale } = render;
	if (viewportWidth <= 0 || viewportHeight <= 0) {
		return null;
	}
	const pageWidthPx = viewportWidth;
	const pageHeightPx = viewportHeight;
	const pxPerPoint = scale;
	const BITMAP_SCALE = bitmapScaleFor(pageWidthPx, pageHeightPx);

	const page = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	page.className = 'pm-repage';
	page.setAttribute('data-pm-strict', 'true');
	page.setAttribute('data-pm-page', String(input.pageIndex));
	page.style.width = `${pageWidthPx}px`;
	page.style.height = `${pageHeightPx}px`; // NEVER changes

	// ---- 1. the original page, 1:1 -----------------------------------------
	const canvas = doc.createElementNS(HTML_NS, 'canvas') as HTMLCanvasElement;
	canvas.width = Math.max(1, Math.round(pageWidthPx * BITMAP_SCALE));
	canvas.height = Math.max(1, Math.round(pageHeightPx * BITMAP_SCALE));
	canvas.className = 'pm-repage-canvas';
	const ctx = canvas.getContext('2d');
	let paper = 'rgb(255,255,255)';
	if (ctx) {
		ctx.fillStyle = paper;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		try {
			ctx.drawImage(render.canvas, 0, 0, render.canvas.width, render.canvas.height,
				0, 0, canvas.width, canvas.height);
			paper = samplePaper(ctx, canvas.width, canvas.height);
		}
		catch (e) {
			logger.debug(MODULE, 'page bitmap copy failed; blank paper', e);
		}
	}
	page.appendChild(canvas);

	// ---- 2. what may be replaced -------------------------------------------
	const translatable = input.blocks.filter(b =>
		!b.isReference && b.type !== 'table' && !!b.lineRectsPdf?.length);
	const bodySizes = translatable.map(b => b.fontSize ?? 0).filter(s => s > 0).sort((a, b) => a - b);
	const bodyPt = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)]! : 10;

	const imageBoxes: PixelBox[] = (input.imageRectsPdf ?? [])
		.map(r => rectToPixels(r, render, 1))
		.filter(b => b.width > 8 && b.height > 8);

	// Table regions stay entirely original until the cell model exists.
	const guard = detectTableRegions(
		translatable.map(b => ({
			id: b.id, text: b.sourceText, type: b.type,
			box: pixelBox(b, render, 1), fontSize: b.fontSize
		})),
		Math.max(6, bodyPt * pxPerPoint)
	);

	const replaceable: SourceBlock[] = [];
	for (const block of translatable) {
		const text = input.translations.get(block.id);
		if (text === undefined || !text.trim() || isMetadataBlock(block.sourceText)) {
			continue;
		}
		if (guard.excluded.has(block.id)) {
			continue; // protected table content
		}
		const box = pixelBox(block, render, 1);
		const minWidth = block.type === 'caption' ? 28 : 50;
		if (box.width < minWidth || box.height < 9 || block.sourceText.trim().length < 6) {
			continue;
		}
		// A body box overlapping a real image is an extraction error — the
		// "paragraph" is figure innards. Never mask, never replace.
		const area = box.width * box.height;
		if (area > 0 && imageBoxes.some(img => intersectArea(box, img) > area * 0.15)) {
			continue;
		}
		replaceable.push(block);
	}

	// ---- 3. per-line mask geometry (painted lazily, ONLY on commit) ---------
	// The mask starts EMPTY. A block's paper rectangle is painted over the
	// original strokes only at the moment the block is accepted (its
	// translation measured to fit). Until then the original English text shows
	// through untouched — so a block is never shown translated and then taken
	// away. This is the core of the "measure before commit" contract.
	const mask = doc.createElementNS(HTML_NS, 'canvas') as HTMLCanvasElement;
	mask.width = canvas.width;
	mask.height = canvas.height;
	mask.className = 'pm-repage-mask';
	const maskCtx = mask.getContext('2d');
	const blockPaper = new Map<string, string>();
	const lineBoxesFor = new Map<string, PixelBox[]>();
	if (ctx) {
		for (const block of replaceable) {
			const whole = pixelBox(block, render, 1);
			const colour = localPaper(ctx, whole, BITMAP_SCALE, paper);
			blockPaper.set(block.id, colour);
			// Font-relative padding, not a fixed 2px: masks hug the strokes.
			const fontPx = Math.max(6, (block.fontSize ?? bodyPt) * pxPerPoint);
			const pad = Math.min(3, Math.max(1, fontPx * 0.08));
			const lines: PixelBox[] = [];
			for (const rect of block.lineRectsPdf as Rect[]) {
				const box = rectToPixels(rect, render, 1);
				lines.push({
					left: box.left - pad, top: box.top - pad,
					width: box.width + pad * 2, height: box.height + pad * 2
				});
			}
			lineBoxesFor.set(block.id, lines);
		}
	}
	page.appendChild(mask);

	/**
	 * Paint one block's paper rectangle over its original strokes, then re-wipe
	 * every real image rectangle so the HARD RULE always holds:
	 * intersectionArea(mask, image) === 0. Idempotent.
	 */
	const paintMask = (id: string): void => {
		if (!maskCtx) {
			return;
		}
		const colour = blockPaper.get(id) ?? paper;
		maskCtx.fillStyle = colour;
		for (const line of lineBoxesFor.get(id) ?? []) {
			maskCtx.fillRect(
				line.left * BITMAP_SCALE, line.top * BITMAP_SCALE,
				line.width * BITMAP_SCALE, line.height * BITMAP_SCALE
			);
		}
		for (const img of imageBoxes) {
			maskCtx.clearRect(
				img.left * BITMAP_SCALE, img.top * BITMAP_SCALE,
				img.width * BITMAP_SCALE, img.height * BITMAP_SCALE
			);
		}
	};
	const clearMask = (id: string): void => {
		for (const line of lineBoxesFor.get(id) ?? []) {
			maskCtx?.clearRect(
				line.left * BITMAP_SCALE, line.top * BITMAP_SCALE,
				line.width * BITMAP_SCALE, line.height * BITMAP_SCALE
			);
		}
	};

	const ink = inkFor(paper);
	page.style.setProperty('--pm-repage-ink', ink);
	page.style.background = paper;

	// ---- 4. translations at FIXED geometry ----------------------------------
	const textLayer = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	textLayer.className = 'pm-repage-text';
	page.appendChild(textLayer);

	interface StrictItem {
		id: string;
		node: HTMLElement;
		box: PixelBox;
		fontPx: number;
		/** Shown (mask painted + node visible) after passing measurement. */
		committed: boolean;
		/** Gave up — stays original, never to be shown translated. */
		abandoned: boolean;
	}
	const items: StrictItem[] = [];
	const byId = new Map<string, StrictItem>();
	for (const block of replaceable) {
		const box = pixelBox(block, render, 1);
		const node = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
		node.className = 'pm-repage-block';
		node.setAttribute('data-pm-block', block.id);
		node.setAttribute('data-pm-type', block.type);
		node.setAttribute('data-pm-page', String(block.pageIndex));
		node.style.left = `${box.left}px`;
		node.style.top = `${box.top}px`;
		node.style.width = `${box.width}px`;
		// FIXED height + hidden overflow: pure safety net — a block that
		// cannot pass the measure gate is never revealed at all.
		node.style.height = `${box.height}px`;
		node.style.overflow = 'hidden';
		// Hidden until accepted: laid out (so it is measurable) but invisible,
		// and — critically — its mask is NOT yet painted, so the original text
		// shows through. Acceptance flips visibility AND paints the mask together.
		node.style.visibility = 'hidden';
		const fontPx = Math.max(6, (block.fontSize ?? bodyPt) * pxPerPoint);
		node.style.fontSize = `${fontPx.toFixed(2)}px`;
		const bg = blockPaper.get(block.id);
		if (bg) {
			node.style.color = inkFor(bg);
			node.style.setProperty('--pm-block-paper', bg);
		}
		if (block.type === 'heading' || block.type === 'title') {
			node.setAttribute('data-pm-strong', 'true');
		}
		node.textContent = input.translations.get(block.id)!; // SAFE: text node
		node.title = block.sourceText;
		textLayer.appendChild(node);
		const item: StrictItem = { id: block.id, node, box, fontPx, committed: false, abandoned: false };
		items.push(item);
		byId.set(block.id, item);
	}

	/** Ladder-fit a hidden node; true when it fits its fixed rectangle. */
	const ladderFits = (item: StrictItem): boolean => {
		for (const step of STRICT_LADDER) {
			item.node.style.lineHeight = String(step.lineHeight);
			item.node.style.letterSpacing = step.letterSpacingEm ? `${step.letterSpacingEm}em` : '';
			if (item.node.scrollHeight <= item.box.height + 1.5
				&& item.node.scrollWidth <= item.box.width + 1.5) {
				return true;
			}
		}
		return false;
	};

	/** Reveal a measured-to-fit block: paint its mask, then show the node. */
	const commit = (item: StrictItem): void => {
		if (item.committed) {
			return;
		}
		paintMask(item.id);
		item.node.style.visibility = '';
		item.node.removeAttribute('data-pm-unfit');
		item.committed = true;
	};

	const budgetFor = (item: StrictItem): number => {
		const estimate = estimateCjkCapacity(item.box.width, item.box.height, item.fontPx);
		const textLen = (item.node.textContent ?? '').length;
		const sh = item.node.scrollHeight;
		const measured = sh > item.box.height && textLen > 0
			? Math.floor(textLen * (item.box.height / sh) * 0.92)
			: estimate;
		return Math.max(8, Math.min(estimate, measured));
	};

	// ---- measurement pass ---------------------------------------------------
	// `commitFitting` is the whole point: when true (the FINAL, fonts-settled
	// pass) a block that measures to fit is revealed on the spot; a block that
	// does not is left hidden (original showing) and returned as unfit. When
	// false (a provisional pass on fallback-font metrics) NOTHING is revealed —
	// we never show a block we might have to take back.
	(page as HTMLElement & { pmSettleStrict?: (commitFitting: boolean) => UnfitBlock[] }).pmSettleStrict = (commitFitting: boolean): UnfitBlock[] => {
		const unfit: UnfitBlock[] = [];
		for (const item of items) {
			if (item.committed || item.abandoned) {
				continue;
			}
			const fits = ladderFits(item);
			if (fits && commitFitting) {
				commit(item);
			}
			else if (!fits) {
				unfit.push({ id: item.id, maxChars: budgetFor(item) });
			}
		}
		return unfit;
	};

	// ---- apply a compressed retry: patch text in place, measure, commit -----
	// The compressed translations replace the block text WITHOUT rebuilding the
	// page, so already-committed blocks never flicker. Blocks that now fit are
	// revealed; the rest come back as still-unfit.
	(page as HTMLElement & { pmApplyCompressed?: (m: Map<string, string>) => UnfitBlock[] }).pmApplyCompressed = (updates: Map<string, string>): UnfitBlock[] => {
		const still: UnfitBlock[] = [];
		for (const [id, text] of updates) {
			const item = byId.get(id);
			if (!item || item.committed || item.abandoned || !text.trim()) {
				continue;
			}
			item.node.textContent = text; // SAFE: text node
			if (ladderFits(item)) {
				commit(item);
			}
			else {
				still.push({ id, maxChars: budgetFor(item) });
			}
		}
		return still;
	};

	// ---- last-resort shrink (see SHRINK_STEPS): fit-and-commit, or hand back -
	(page as HTMLElement & { pmShrinkFit?: (ids: string[]) => string[] }).pmShrinkFit = (ids: string[]): string[] => {
		const still: string[] = [];
		for (const id of ids) {
			const item = byId.get(id);
			if (!item || item.committed || item.abandoned) {
				continue;
			}
			let fits = false;
			for (const factor of SHRINK_STEPS) {
				const px = Math.max(SHRINK_FLOOR_PX, item.fontPx * factor);
				item.node.style.fontSize = `${px.toFixed(2)}px`;
				fits = ladderFits(item);
				if (fits || px <= SHRINK_FLOOR_PX) {
					break;
				}
			}
			if (fits) {
				commit(item);
			}
			else {
				item.node.style.fontSize = `${item.fontPx.toFixed(2)}px`; // restore
				still.push(id);
			}
		}
		return still;
	};

	// ---- give up on a block: stays original forever (it was never shown) -----
	(page as HTMLElement & { pmRevert?: (ids: string[]) => void }).pmRevert = (ids: string[]): void => {
		for (const id of ids) {
			const item = byId.get(id);
			if (!item) {
				continue;
			}
			item.abandoned = true;
			if (item.committed) {
				// Only reachable in pathological re-measures; undo the reveal.
				clearMask(id);
				item.committed = false;
			}
			item.node.style.visibility = 'hidden';
			item.node.setAttribute('data-pm-unfit', 'true');
		}
	};

	logger.debug(MODULE, `page ${input.pageIndex + 1}: ${items.length} strict block(s), ${guard.regions.length} protected table(s)`);
	return { element: page, blocksPlaced: items.length };
}

/**
 * Measure with font-readiness insurance. `onMeasured` fires with the unfit
 * list and a `final` flag: exactly ONE call per render carries final=true —
 * the measure taken after web fonts settled, and the ONLY pass that reveals
 * fitting blocks or lets the caller spend a compress round. Provisional passes
 * (final=false) reveal nothing and must not drive any consequential action;
 * acting on their fallback-font metrics is what made long-text translations
 * flash in and then vanish.
 */
export function settleStrictPage(element: HTMLElement, onMeasured: (unfit: UnfitBlock[], final: boolean) => void): void {
	const settle = (element as HTMLElement & { pmSettleStrict?: (commitFitting: boolean) => UnfitBlock[] }).pmSettleStrict;
	if (!settle) {
		return;
	}
	let fonts: { status?: string; ready?: Promise<unknown> } | undefined;
	try {
		fonts = (element.ownerDocument as Document & { fonts?: { status?: string; ready?: Promise<unknown> } }).fonts;
	}
	catch {
		fonts = undefined;
	}
	const ready = fonts?.ready;
	if (!fonts || !ready) {
		onMeasured(settle(true), true); // no font API — this is the final pass
		return;
	}
	const f = fonts;
	onMeasured(settle(false), false); // provisional: measure only, reveal nothing
	try {
		void ready.then(() => {
			if (!element.isConnected) {
				return;
			}
			const secondWave = f.status === 'loading' ? f.ready : undefined;
			if (secondWave) {
				// A second load wave started — one more provisional pass now,
				// the final one when it completes.
				onMeasured(settle(false), false);
				void secondWave.then(() => {
					if (element.isConnected) {
						onMeasured(settle(true), true);
					}
				});
				return;
			}
			onMeasured(settle(true), true);
		});
	}
	catch {
		onMeasured(settle(true), true); // insurance: never leave the caller waiting
	}
}

/**
 * Apply a compressed retry's shorter translations to the live page: patches
 * the block text in place (no page rebuild → committed blocks never flicker),
 * measures, reveals those that now fit, and returns the ones still too long.
 */
export function applyCompressedStrict(element: HTMLElement, updates: Map<string, string>): UnfitBlock[] {
	const apply = (element as HTMLElement & { pmApplyCompressed?: (m: Map<string, string>) => UnfitBlock[] }).pmApplyCompressed;
	return apply ? apply(updates) : [];
}

/**
 * The retry plan for a set of unfit blocks: which get a budgeted compress
 * round (only budget-capable engines, only blocks with rounds left) and which
 * fall through to the shrink/revert stage. Pure — unit-tested directly.
 */
export interface RetryPlan {
	compress: string[];
	shrink: string[];
}
export function planStrictRetry(
	unfit: UnfitBlock[],
	opts: { roundsFor: (id: string) => number; maxRounds: number; budgetCapable: boolean }
): RetryPlan {
	const compress: string[] = [];
	const shrink: string[] = [];
	for (const u of unfit) {
		if (opts.budgetCapable && opts.roundsFor(u.id) < opts.maxRounds) {
			compress.push(u.id);
		}
		else {
			shrink.push(u.id);
		}
	}
	return { compress, shrink };
}

export function revertStrictBlocks(element: HTMLElement, ids: string[]): void {
	(element as HTMLElement & { pmRevert?: (ids: string[]) => void }).pmRevert?.(ids);
}

/**
 * Last-resort font shrink for the listed blocks (94% → 88%, floor 8.5px).
 * Returns the ids that STILL do not fit — those are the only candidates left
 * for revertStrictBlocks.
 */
export function shrinkStrictBlocks(element: HTMLElement, ids: string[]): string[] {
	const shrink = (element as HTMLElement & { pmShrinkFit?: (ids: string[]) => string[] }).pmShrinkFit;
	return shrink ? shrink(ids) : ids;
}
