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
import { buildTableModel, type CellMember } from '../reader/tableStructure';
import {
	inkFor,
	localPaper,
	pixelBox,
	rectToPixels,
	samplePaper,
	type PixelBox
} from './translatedPageView';
import { bodyAnchorPt, parseFactor } from './pageLayout';
import { getPref } from '../utils/prefs';

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

/** Never tighten a line below the source's own leading, nor below this floor. */
const LINE_HEIGHT_FLOOR = 1.0;

/**
 * The fit ladder for ONE block: the shared ladder, but never looser at the
 * bottom than the block's OWN original line spacing. A one-line heading whose
 * source rectangle is barely taller than its glyphs has a natural leading near
 * 1.0, so it gets a 1.0 step it can actually pass; a body paragraph set at 1.3
 * never has its lines crushed below 1.3. This is "match the original leading",
 * not "force everything to a fixed 1.14".
 */
export function ladderFor(minLineHeight: number): { lineHeight: number; letterSpacingEm: number }[] {
	const floor = Math.max(LINE_HEIGHT_FLOOR, Math.min(1.42, minLineHeight));
	const steps = STRICT_LADDER
		.map(s => ({ lineHeight: Math.max(floor, s.lineHeight), letterSpacingEm: s.letterSpacingEm }))
		.filter((s, i, a) => i === 0 || s.lineHeight !== a[i - 1]!.lineHeight);
	if (steps[steps.length - 1]!.lineHeight > floor) {
		steps.push({ lineHeight: floor, letterSpacingEm: -0.02 });
	}
	return steps;
}

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

/** Honest placement accounting for one strict page (#6). */
export interface StrictPageStats {
	/** Blocks eligible for in-place replacement (had a translation + geometry). */
	replaceable: number;
	/** Revealed translated so far. */
	committed: number;
	/** Given up on — original kept because no fit was possible. */
	abandoned: number;
	/** Still being resolved (measuring / compress in flight). */
	pending: number;
	/** Table cells kept original BY DESIGN — data/numeric cells, cross-column
	 * fragments. Not a failure; not counted as kept-that-should-have-translated.
	 * (Committed text cells are counted in `committed`, like any other block, so
	 * they are never double-counted here.) */
	tableIntentional: number;
	/** Table cells that FAILED to translate/place — missing translation, no
	 * line rects (extraction error), or a cell that could not be placed. These
	 * ARE real failures and must count as kept. */
	tableFailed: number;
	/** Kept original because the box overlapped a real image. */
	imageExcluded: number;
	/** The service returned no translation for these blocks. */
	untranslated: number;
	/** Below the min-size gate (tiny fragments). */
	tooSmall: number;
}

export interface StrictPageResult {
	element: HTMLElement;
	blocksPlaced: number;
	stats: StrictPageStats;
}

/** The honest per-page tally derived from raw stats, for the status capsule. */
export interface PlacementTally {
	/** Segments actually shown translated. */
	placed: number;
	/** Segments left in the source language because placement failed. */
	kept: number;
	/** placed + kept. */
	segTotal: number;
	/** 'partial' when anything was kept, else 'done'. */
	phase: 'done' | 'partial';
}

/**
 * Collapse raw strict stats into the capsule's honest tally with ONE 口径, no
 * double counting:
 *  - `committed` ALREADY includes table text cells that were placed (they are
 *    ordinary items), so `placed` is exactly `committed` — table cells are
 *    never added again on top.
 *  - Kept = real failures only: blocks that would not fit (abandoned), blocks
 *    the service never translated (untranslated), and table cells that failed
 *    to translate/place (tableFailed). Intentionally-kept content
 *    (`tableIntentional`, images, tiny fragments) is neither placed nor a
 *    failure, so "已完成" is shown only when nothing translatable was left in
 *    the source language.
 */
export function placementTally(s: StrictPageStats): PlacementTally {
	const placed = s.committed;
	const kept = s.abandoned + s.untranslated + s.tableFailed;
	const segTotal = placed + kept;
	return { placed, kept, segTotal, phase: kept > 0 ? 'partial' : 'done' };
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

/** Fraction of `box`'s area that lies inside `region`. */
function containedFraction(box: PixelBox, region: { left: number; top: number; width: number; height: number }): number {
	const area = box.width * box.height;
	return area > 0 ? intersectArea(box, region as PixelBox) / area : 0;
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
	const geometric = input.blocks.filter(b =>
		!b.isReference && b.type !== 'table' && !!b.lineRectsPdf?.length);
	const translatable = geometric.filter(b => b.translationMode !== 'preserve');
	const bodySizes = translatable.map(b => b.fontSize ?? 0).filter(s => s > 0).sort((a, b) => a - b);
	const bodyPt = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)]! : 10;
	// 页面基准字号 (role_min, 0.9.28 — 审核修正: the feature had landed on the
	// unused renderTranslatedPage path; THIS builder is what the split view
	// actually renders). Body blocks unify to the page's robust-minimum body
	// size so adjacent paragraphs never render at visibly different sizes;
	// headings/captions keep their own. 用户倍率 scales on top — the strict
	// measure gate still governs commit, so an over-scaled block simply fails
	// placement and stays original rather than overflowing.
	const anchorPt = bodyAnchorPt(translatable
		.filter(b => b.type === 'paragraph' || b.type === 'list')
		.map(b => b.fontSize ?? 0));
	const fontFactor = parseFactor(getPref('fontSizeFactor', '1'));
	const lineFactor = parseFactor(getPref('lineHeightFactor', '1'), 0.9, 1.4);

	const imageBoxes: PixelBox[] = (input.imageRectsPdf ?? [])
		.map(r => rectToPixels(r, render, 1))
		.filter(b => b.width > 8 && b.height > 8);

	const pxOf = new Map<string, PixelBox>();
	// GEOMETRIC, not translatable (1.0.3 卡死修复): preserve table cells are in
	// `geometric` and feed the table guard below — building pxOf from
	// `translatable` left their boxes undefined, and the first table page threw
	// inside detectTableRegions/containedFraction. The exception aborted
	// buildStrictPage, so 翻译 18/18 段 stood forever at 排版 0/18.
	for (const b of geometric) {
		pxOf.set(b.id, pixelBox(b, render, 1));
	}
	const blockById = new Map(geometric.map(b => [b.id, b]));

	const guard = detectTableRegions(
		geometric.map(b => ({
			id: b.id, text: b.sourceText, type: b.type,
			box: pxOf.get(b.id)!, fontSize: b.fontSize
		})),
		Math.max(6, bodyPt * pxPerPoint)
	);

	// ---- 2a. table cell model ----------------------------------------------
	// For each detected region, infer the Row/Cell grid. Prose cells become
	// synthetic per-cell "blocks" that go through the SAME strict pipeline
	// (masked, measured, committed inside their own rectangle); data cells and
	// cross-column fragments stay original. `translationOf` resolves both real
	// block ids and synthetic cell ids.
	const cellTranslations = new Map<string, string>();
	const cellBlocks: SourceBlock[] = [];
	const consumedMemberIds = new Set<string>();
	let tableIntentional = 0;
	let tableFailed = 0;
	guard.regions.forEach((region, tableIndex) => {
		const members: CellMember[] = geometric
			.filter(b => containedFraction(pxOf.get(b.id)!, region) >= 0.5 && b.lineRectsPdf?.length)
			.map(b => ({ id: b.id, box: pxOf.get(b.id)!, text: b.sourceText, fontSize: b.fontSize }));
		if (!members.length) {
			return;
		}
		const model = buildTableModel(input.pageIndex, tableIndex, region, members);
		for (const cell of model.cells) {
			for (const mid of cell.memberIds) {
				consumedMemberIds.add(mid); // handled here, not as a normal block
			}
			// A data / spanning cell stays original BY DESIGN (not a failure).
			if (cell.kind !== 'text') {
				tableIntentional += cell.memberIds.length;
				continue;
			}
			// Assemble the cell's translation from its members; if any member is
			// missing a translation the cell can't be shown whole → keep original.
			const parts = cell.memberIds.map(mid => input.translations.get(mid));
			if (parts.some(p => p === undefined || !p.trim())) {
				tableFailed += cell.memberIds.length; // a cell whose text was not translated
				continue;
			}
			const lineRects: [number, number, number, number][] = [];
			const sizes: number[] = [];
			for (const mid of cell.memberIds) {
				const mb = blockById.get(mid);
				if (mb?.lineRectsPdf) {
					lineRects.push(...mb.lineRectsPdf);
				}
				if (mb?.fontSize) {
					sizes.push(mb.fontSize);
				}
			}
			if (!lineRects.length) {
				tableFailed += cell.memberIds.length; // extraction gave no line rects
				continue;
			}
			cellTranslations.set(cell.id, parts.join(''));
			cellBlocks.push({
				id: cell.id,
				pageIndex: input.pageIndex,
				order: 0,
				type: 'paragraph',
				sourceText: cell.text,
				lineRectsPdf: lineRects,
				fontSize: sizes.length ? sizes[Math.floor(sizes.length / 2)] : bodyPt
			});
			// NOT counted here: a committed text cell is counted in `committed`
			// at settle time, exactly like a paragraph — no double counting.
		}
	});

	const translationOf = (id: string): string | undefined =>
		cellTranslations.get(id) ?? input.translations.get(id);

	const replaceable: SourceBlock[] = [];
	// Placement accounting (#6): every translatable block is classified so the
	// page can be honest about what was NOT shown translated — never a silent
	// English block.
	let imageExcluded = 0;
	let untranslated = 0;
	let tooSmall = 0;
	for (const block of translatable) {
		if (consumedMemberIds.has(block.id)) {
			continue; // owned by the table cell model (translated cell or kept original)
		}
		const text = input.translations.get(block.id);
		if (isMetadataBlock(block.sourceText)) {
			continue; // running heads/DOIs — deliberately not translated
		}
		if (text === undefined || !text.trim()) {
			untranslated++; // service never returned this block
			continue;
		}
		if (guard.excluded.has(block.id)) {
			tableIntentional++;
			continue; // protected table content the cell model didn't claim
		}
		const box = pxOf.get(block.id)!;
		const minWidth = block.type === 'caption' ? 28 : 50;
		if (box.width < minWidth || box.height < 9 || block.sourceText.trim().length < 6) {
			tooSmall++;
			continue;
		}
		// A body box overlapping a real image is an extraction error — the
		// "paragraph" is figure innards. Never mask, never replace.
		const area = box.width * box.height;
		if (area > 0 && imageBoxes.some(img => intersectArea(box, img) > area * 0.15)) {
			imageExcluded++;
			continue;
		}
		// A block overlapping a detected table REGION that the cell model did
		// NOT turn into a cell (e.g. a paragraph the extractor stitched across
		// cells) stays original — never stamped in Chinese across the table.
		if (area > 0 && guard.regions.some(r => intersectArea(box, r as unknown as PixelBox) > area * 0.15)) {
			tableIntentional++;
			continue;
		}
		replaceable.push(block);
	}
	// Synthetic text-cell blocks join the replaceable set (they live inside
	// table regions, so they must bypass the region-overlap guard above).
	for (const cb of cellBlocks) {
		const box = pixelBox(cb, render, 1);
		if (box.width < 20 || box.height < 9) {
			tableFailed += 1; // a translatable cell too small to place
			continue;
		}
		const area = box.width * box.height;
		if (area > 0 && imageBoxes.some(img => intersectArea(box, img) > area * 0.15)) {
			tableFailed += 1; // a translatable cell overlapping an image
			continue;
		}
		replaceable.push(cb);
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
	page.style.setProperty('--pm-line-scale', String(lineFactor));
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
		/** The block's own original line spacing, as a line-height ratio. */
		minLineHeight: number;
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
		const rolePt = (block.type === 'paragraph' || block.type === 'list') && anchorPt > 0
			? anchorPt
			: (block.fontSize ?? bodyPt);
		const fontPx = Math.max(6, rolePt * pxPerPoint * fontFactor);
		node.style.fontSize = `${fontPx.toFixed(2)}px`;
		const bg = blockPaper.get(block.id);
		if (bg) {
			node.style.color = inkFor(bg);
			node.style.setProperty('--pm-block-paper', bg);
		}
		if (block.type === 'heading' || block.type === 'title') {
			node.setAttribute('data-pm-strong', 'true');
		}
		node.textContent = translationOf(block.id)!; // SAFE: text node
		node.title = block.sourceText;
		textLayer.appendChild(node);
		// The block's own original leading: the median gap between successive
		// source line tops, relative to the font. One-line blocks (headings)
		// fall back to how tall their rectangle is — so a tight heading gets a
		// tight, achievable line-height instead of the body default.
		const tops = ((block.lineRectsPdf ?? []) as Rect[])
			.map(r => rectToPixels(r, render, 1).top).sort((a, b) => a - b);
		let naturalRatio = box.height / fontPx;
		if (tops.length >= 2) {
			const gaps: number[] = [];
			for (let k = 1; k < tops.length; k++) {
				gaps.push(tops[k]! - tops[k - 1]!);
			}
			gaps.sort((a, b) => a - b);
			naturalRatio = gaps[Math.floor(gaps.length / 2)]! / fontPx;
		}
		const minLineHeight = Math.max(LINE_HEIGHT_FLOOR, Math.min(1.42, naturalRatio || 1.2));
		const item: StrictItem = { id: block.id, node, box, fontPx, minLineHeight, committed: false, abandoned: false };
		items.push(item);
		byId.set(block.id, item);
	}

	/** Ladder-fit a hidden node; true when it fits its fixed rectangle. */
	const ladderFits = (item: StrictItem): boolean => {
		for (const step of ladderFor(item.minLineHeight)) {
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

	// ---- 边界扩展 (移植自 BabelDOC Typesetting「算法3」, funstory-ai/BabelDOC,
	// AGPL-3.0, docs/ImplementationDetails/Typesetting): 在缩字号之前,先测量
	// 块右侧/下方的实际空白并把盒子扩进去 —— "图 1 → Figure 1" 式越译越长的
	// 短标签与标题正是靠这一层救回,而不是被缩小或放弃。
	// 空白测量:对每个未适配块,取所有几何块盒 + 图形盒中与其在垂直向(右扩)
	// 或水平向(下扩)重叠者的最近边,留 3px 边距;右扩以版心 90% 为界
	// (BabelDOC 同),下扩以页高 95% 为界;各设温和上限防贪婪。
	const expansionAllowance = (item: StrictItem): { right: number; down: number } =>
		computeExpansionAllowance(item.box, [
			...imageBoxes,
			...geometric.filter(b => b.id !== item.id).map(b => pxOf.get(b.id)!).filter(Boolean)
		], canvas.width / BITMAP_SCALE, canvas.height / BITMAP_SCALE, item.fontPx);
	const applyBox = (item: StrictItem, width: number, height: number): void => {
		item.box = { ...item.box, width, height };
		item.node.style.width = `${width}px`;
		item.node.style.height = `${height}px`;
	};

	// ---- last-resort fit: 先扩边界(算法3),再缩字号(SHRINK_STEPS),最后
	// 底线组合(最小字号 + 最大扩展)——全失败才交还给放弃流程。
	(page as HTMLElement & { pmShrinkFit?: (ids: string[]) => string[] }).pmShrinkFit = (ids: string[]): string[] => {
		const still: string[] = [];
		for (const id of ids) {
			const item = byId.get(id);
			if (!item || item.committed || item.abandoned) {
				continue;
			}
			const original = { width: item.box.width, height: item.box.height };
			const grow = expansionAllowance(item);
			let fits = false;
			// 1. 算法3: 原字号下的扩展阶梯 — 右扩(标签/标题) → 下扩(段落) → 双向。
			const expansions: [number, number][] = [];
			if (grow.right > 4) {
				expansions.push([original.width + grow.right, original.height]);
			}
			if (grow.down > 4) {
				expansions.push([original.width, original.height + grow.down]);
			}
			if (grow.right > 4 && grow.down > 4) {
				expansions.push([original.width + grow.right, original.height + grow.down]);
			}
			for (const [w, h] of expansions) {
				applyBox(item, w, h);
				fits = ladderFits(item);
				if (fits) {
					break;
				}
			}
			if (!fits) {
				applyBox(item, original.width, original.height);
				// 2. 既有缩字梯子(原盒)。
				for (const factor of SHRINK_STEPS) {
					const px = Math.max(SHRINK_FLOOR_PX, item.fontPx * factor);
					item.node.style.fontSize = `${px.toFixed(2)}px`;
					fits = ladderFits(item);
					if (fits || px <= SHRINK_FLOOR_PX) {
						break;
					}
				}
				// 3. 底线: 最小字号 + 最大扩展的组合再试一次。
				if (!fits && expansions.length) {
					const last = expansions[expansions.length - 1]!;
					applyBox(item, last[0], last[1]);
					fits = ladderFits(item);
				}
			}
			if (fits) {
				commit(item);
			}
			else {
				item.node.style.fontSize = `${item.fontPx.toFixed(2)}px`; // restore
				applyBox(item, original.width, original.height);
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

	// ---- live placement stats (#6): never a silent English block -----------
	(page as HTMLElement & { pmStats?: () => StrictPageStats }).pmStats = (): StrictPageStats => {
		let committed = 0;
		let abandoned = 0;
		let pending = 0;
		for (const item of items) {
			if (item.committed) {
				committed++;
			}
			else if (item.abandoned) {
				abandoned++;
			}
			else {
				pending++;
			}
		}
		return {
			replaceable: items.length,
			committed, abandoned, pending,
			tableIntentional, tableFailed, imageExcluded, untranslated, tooSmall
		};
	};

	logger.debug(MODULE, `page ${input.pageIndex + 1}: ${items.length} strict block(s), ${guard.regions.length} protected table(s)`);
	return {
		element: page,
		blocksPlaced: items.length,
		stats: {
			replaceable: items.length,
			committed: 0, abandoned: 0, pending: items.length,
			tableIntentional, tableFailed, imageExcluded, untranslated, tooSmall
		}
	};
}

/** Read a strict page's live placement stats, or null if not a strict page. */
export function strictPageStats(element: HTMLElement): StrictPageStats | null {
	const fn = (element as HTMLElement & { pmStats?: () => StrictPageStats }).pmStats;
	return fn ? fn() : null;
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
/**
 * 边界扩展空白测量 (移植自 BabelDOC Typesetting「算法3」, funstory-ai/BabelDOC,
 * AGPL-3.0): 右扩以版心 90% 为界、下扩以页高 95% 为界,被任何几何块/图形盒的
 * 最近边截断(3px 边距);上限右 ≤0.6×原宽、下 ≤max(两行, 0.5×原高)。
 * Pure — unit-tested.
 */
export function computeExpansionAllowance(
	box: PixelBox,
	blockers: PixelBox[],
	pageW: number,
	pageH: number,
	fontPx: number
): { right: number; down: number } {
	let right = Math.max(0, pageW * 0.9 - (box.left + box.width));
	let down = Math.max(0, pageH * 0.95 - (box.top + box.height));
	for (const other of blockers) {
		const vOverlap = Math.min(box.top + box.height, other.top + other.height) - Math.max(box.top, other.top);
		if (vOverlap > 2 && other.left >= box.left + box.width - 1) {
			right = Math.min(right, other.left - (box.left + box.width) - 3);
		}
		const hOverlap = Math.min(box.left + box.width, other.left + other.width) - Math.max(box.left, other.left);
		if (hOverlap > 2 && other.top >= box.top + box.height - 1) {
			down = Math.min(down, other.top - (box.top + box.height) - 3);
		}
	}
	right = Math.max(0, Math.min(right, box.width * 0.6));
	down = Math.max(0, Math.min(down, Math.max(fontPx * 2.8, box.height * 0.5)));
	return { right, down };
}

export function shrinkStrictBlocks(element: HTMLElement, ids: string[]): string[] {
	const shrink = (element as HTMLElement & { pmShrinkFit?: (ids: string[]) => string[] }).pmShrinkFit;
	return shrink ? shrink(ids) : ids;
}
