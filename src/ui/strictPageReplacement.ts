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
import { auditPlacedBoxes, violationStillPresent, boxNewlyViolates, type AuditBox, type AuditObstacles } from './layoutSafety';
import { parseStyledSegments } from '../reader/styleRuns';
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

/**
 * 末位缩字是否允许作用于该块类型 (2.2.7, 计划 第三批 item7(b) · LO-3) — pure。
 *
 * 正文(paragraph/list)**不**参与单块末位缩字: 一段正文缩到 88% 而上下相邻段
 * 仍 100%,读起来就是「发花」(同栏正文忽大忽小)。正文只在**页内统一字号**下
 * 排版 —— 靠行距/字距梯子、无损扩边、压缩把它放进原字号盒,放不下就保留原文
 * (诚实计数,可「查看保留原文」),绝不单独缩它一块。独立元素(图题 caption、
 * 标题 heading/title)是孤立的,缩它自己不会与正文比出大小差,仍可末位缩字保住
 * 译文。表格单元格由独立表格模型渲染、根本不进这条 items 流水线,不受影响。
 */
export function allowsFontShrink(blockType: string, opts?: { isTableCell?: boolean; tinyLine?: boolean }): boolean {
	// 2.3.7 (基线 doc3 实证修正): 2.2.7 的「正文不缩字」把两类**孤立小盒**误伤了 ——
	// 探针显示 13px/9px 高的单行表格单元格与表单细行因禁缩只能整行放弃(一篇文档
	// abandoned 从个位数涨到 56)。它们不是正文流,各自缩字不会与相邻正文比出
	// 「发花」: ① 表格单元格(格间本就独立);② 微小单行块(标签/表行,单行盒
	// 行距梯子无从发力、扩边被下一行挡死,缩字是唯一救法)。两类放行缩字;
	// 真正文段(多行 paragraph/list)维持 2.2.7 的页内统一字号。
	if (opts?.isTableCell || opts?.tinyLine) {
		return true;
	}
	return blockType !== 'paragraph' && blockType !== 'list';
}

/**
 * LO-7 (2.4.0) 大标题「整体另置」的候选位置 — pure。
 *
 * 顺序即偏好: 正下方(标题与摘要/作者行之间通常有版式留白)优先,正上方次之。
 * 两端各留 2% 页高的安全边;放不进页面的候选直接不出。宽度沿用标题原盒宽
 * (展示型标题通常横贯版心),left 不动 —— 另置只在垂直向找空白。
 */
/**
 * LO-10 (2.4.6) 像素级墨迹判据 — pure,便于单测阈值。
 *
 * `data` 是 RGBA 扫描结果(canvas getImageData 的 data),`paper` 是纸色。
 * 按 stride 抽样(总点数约 ≤900),数出与纸色距离超过 `distance` 的点。
 * 两个门槛都要过:占比 > `minShare`,且绝对命中数 ≥ `minPoints`。
 *
 * 两档口径的由来:判「这块区域是不是空白」(另置)用 2%;抓「有没有一条细线」
 * (扩边)必须低得多 —— 一条 1px 分栏竖线在 100px 宽的条带里只占 1%,2% 必漏。
 * 低门槛带来的单点噪声由 `minPoints` 挡住。
 */
export function bitmapHasInk(
	data: ArrayLike<number>,
	width: number,
	height: number,
	paper: [number, number, number],
	opts: { minShare: number; minPoints: number; distance?: number }
): boolean {
	if (width <= 0 || height <= 0) {
		return false;
	}
	const distance = opts.distance ?? 48;
	const [pr, pg, pb] = paper;
	const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 900)));
	let inked = 0;
	let total = 0;
	for (let yy = 0; yy < height; yy += stride) {
		for (let xx = 0; xx < width; xx += stride) {
			const o = (yy * width + xx) * 4;
			total++;
			if (Math.abs((data[o] ?? 0) - pr) + Math.abs((data[o + 1] ?? 0) - pg)
				+ Math.abs((data[o + 2] ?? 0) - pb) > distance) {
				inked++;
			}
		}
	}
	return total > 0 && inked >= opts.minPoints && inked / total > opts.minShare;
}

/**
 * LO-10 (2.4.6) 扩展新占的条带 — pure。
 *
 * 一次扩展可能同时向右和向下长。新占的地方是「扩展后盒 − 原盒」这个 L 形区域,
 * 拆成两条不重叠的矩形:右条(原高,右侧新增宽)、下条(**扩展后的全宽**,
 * 下方新增高)—— 下条取全宽才能覆盖 L 形的拐角,两条合起来恰好是那个 L,
 * 且互不重叠(右条只占原高范围)。
 *
 * 只返回**新增**部分:原盒底下是本块自己的原文,它会被遮罩盖掉,采样它只会
 * 得到假阳性。宽/高没长的方向不产出条带。
 */
export function expansionStrips(
	original: { left: number; top: number; width: number; height: number },
	expanded: { left: number; top: number; width: number; height: number },
	minSize = 1
): { left: number; top: number; width: number; height: number }[] {
	const strips: { left: number; top: number; width: number; height: number }[] = [];
	const grewRight = expanded.width - original.width;
	const grewDown = expanded.height - original.height;
	if (grewRight >= minSize) {
		strips.push({
			left: original.left + original.width,
			top: original.top,
			width: grewRight,
			height: original.height
		});
	}
	if (grewDown >= minSize) {
		strips.push({
			left: original.left,
			top: original.top + original.height,
			width: Math.max(original.width, expanded.width),
			height: grewDown
		});
	}
	return strips;
}

export function annexCandidateBoxes(
	original: { left: number; top: number; width: number; height: number },
	naturalHeight: number,
	pageHeight: number,
	gap = 6
): { left: number; top: number; width: number; height: number }[] {
	const out: { left: number; top: number; width: number; height: number }[] = [];
	for (const top of [original.top + original.height + gap, original.top - gap - naturalHeight]) {
		if (top < pageHeight * 0.02 || top + naturalHeight > pageHeight * 0.98) {
			continue;
		}
		out.push({ left: original.left, top, width: original.width, height: naturalHeight });
	}
	return out;
}

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
	/** LO-7 (2.4.0): 大标题原位放不下、译文整体另置成功的块数(已含在
	 * `committed` 里,单列仅供诊断观察另置策略的启用频率)。 */
	annexed: number;
	/** LO-10 (2.4.6): 因新占区域压上未建模墨迹而被否决的扩展次数(按次计)。
	 * 不是失败 —— 块回退原盒后继续走压缩/缩字/保留原文的既有流程。 */
	inkBlocked: number;
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
/**
 * Split a coalesced region's translated text back onto its source paragraph
 * groups, so each paragraph is placed in its OWN box rather than the region's
 * tall union box (which collapses a structured abstract to the top). Returns
 * one synthetic placement block per paragraph, or null to fall back to the
 * whole-region placement — the STRICT rule being: only split when the region
 * has ≥2 paragraph groups AND the translation splits on blank lines into
 * exactly that many non-empty parts. Any mismatch (the engine dropped the
 * `\n\n` breaks, merged, or split paragraphs) falls back, so this can only
 * ever improve placement, never regress it.
 */
export interface RegionParagraphPlacement {
	id: string;
	lineRectsPdf: [number, number, number, number][];
	fontSize?: number;
	text: string;
}

export function splitRegionForPlacement(
	block: SourceBlock,
	translation: string | undefined
): RegionParagraphPlacement[] | null {
	const groups = block.regionParagraphs;
	if (!groups || groups.length < 2 || !translation) {
		return null;
	}
	// A group with no line rects can't be placed — bail rather than emit a
	// zero-area box that would silently swallow its paragraph.
	if (groups.some(g => !g.lineRectsPdf?.length)) {
		return null;
	}
	// Split on ANY run of newlines, not just blank lines: coalesceRegions joins
	// paragraph groups with "\n\n", but translation engines commonly normalise
	// that to a single "\n" — matching only "\n\n" silently fell back and left
	// the region collapsed. Within a group the text has no newlines (members are
	// joined with " "/""), so "\n+" partitions exactly at the group boundaries.
	const paras = translation.split(/\n+/).map(p => p.trim()).filter(Boolean);
	// 一坨(引擎把所有分段合成一段)无从拆分 → 回退整块放置(与旧行为一致)。
	if (paras.length < 2) {
		return null;
	}
	const G = groups.length;
	const P = paras.length;
	if (P === G) {
		// 段数相等: 一一对应,每段落进自己的组盒(最忠实)。
		return groups.map((g, i) => ({
			id: `${block.id}::p${i}`,
			lineRectsPdf: g.lineRectsPdf!,
			fontSize: g.fontSize,
			text: paras[i]!
		}));
	}
	// 尽力对齐 (2.2.6, 计划 第三批 item7 · LO-2): 段数不等不再整块塌顶,而是把**多
	// 的一侧**按顺序均匀并入**少的一侧**,得到 K=min(P,G) 个盒子 —— 每盒都有文本、
	// 每段文本都落地、顺序不变、盒子几何覆盖原区域全部行矩形(不留空、不塌顶)。
	// K≥2 恒成立(此处 P≥2 且 G≥2)。「顺次映射 + 贪心合并」正是计划所述做法。
	const K = Math.min(P, G);
	// 把 n 个有序项切成 K 个连续、尽量均匀的桶 → 每桶 [start,end)。
	const bins = (n: number): [number, number][] => {
		const out: [number, number][] = [];
		let start = 0;
		for (let i = 0; i < K; i++) {
			const size = Math.floor(n / K) + (i < n % K ? 1 : 0);
			out.push([start, start + size]);
			start += size;
		}
		return out;
	};
	if (P > G) {
		// 译文比组多(引擎多切了段): 盒子=G 个组(几何不变),P 段按序并入 G 桶,
		// 桶内多段用空格接回一段。
		const pb = bins(P); // K === G 个桶
		return groups.map((g, i) => ({
			id: `${block.id}::p${i}`,
			lineRectsPdf: g.lineRectsPdf!,
			fontSize: g.fontSize,
			text: paras.slice(pb[i]![0], pb[i]![1]).join(' ')
		}));
	}
	// 译文比组少(引擎并了段): 合并 G 个组盒到 P 个(并集行矩形),与 P 段一一对应。
	const gb = bins(G); // K === P 个桶
	return paras.map((text, i) => {
		const [s, e] = gb[i]!;
		const merged = groups.slice(s, e);
		return {
			id: `${block.id}::p${i}`,
			lineRectsPdf: merged.flatMap(g => g.lineRectsPdf!),
			fontSize: merged[0]!.fontSize,
			text
		};
	});
}

/** Parse an `rgb(r,g,b)` / `rgba(...)` string into [r,g,b]; white on failure. */
function parseRgb(colour: string): [number, number, number] {
	const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(colour);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255];
}

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
	// willReadFrequently (2.1.7, 计划 PF-1): 底图被 localPaper(每块~12 点)/
	// samplePaper/pmProbe 高频 getImageData —— 声明后走 CPU 后端,免去每次
	// GPU→CPU 回读与管线冲刷。
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

	// 墨迹遮挡物 (2.0.4, 审核 P2-14): isReference / type==='table' 的块被排除在
	// `geometric` 之外(它们永不参与替换),但它们的原文墨迹仍在位图上。
	// 边界扩展与几何审计此前对它们**失明**: 扩展可以把译文盒子长进参考文献或
	// 表格的原文里叠印,审计也看不见。它们以纯几何成员身份进入两处遮挡物列表
	// (expansionAllowance 的 blockers 与 pmGeometryAudit 的 preserved),
	// 绝不进入可替换集合。
	const inkObstacles: { id: string; box: PixelBox }[] =
		selectInkObstacleBlocks(input.blocks).map(b => ({ id: b.id, box: pixelBox(b, render, 1) }));

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
			// Assemble the cell's translation from its members. 逐 member 兜底
			// (2.3.4, 第四批 item6 · LO-8): 任一 member 缺译不再把**整格**回退 ——
			// 有译文的 member 各自作为独立块放置(用自己的行矩形),只有真正缺译
			// 的 member 保留原文并计入 tableFailed。整格齐全时仍走整格路径(拼合
			// 译文进单元格盒,排版最好)。
			const parts = cell.memberIds.map(mid => input.translations.get(mid));
			if (parts.some(p => p === undefined || !p.trim())) {
				for (let mi = 0; mi < cell.memberIds.length; mi++) {
					const mid = cell.memberIds[mi]!;
					const text = parts[mi];
					const mb = blockById.get(mid);
					if (text === undefined || !text.trim() || !mb?.lineRectsPdf?.length) {
						tableFailed += 1; // 这个 member 缺译/缺几何 → 保留原文
						continue;
					}
					cellBlocks.push({
						id: mid, // 真实块 id: translationOf 直接命中 input.translations
						pageIndex: input.pageIndex,
						order: 0,
						type: 'paragraph',
						sourceText: mb.sourceText,
						lineRectsPdf: mb.lineRectsPdf,
						fontSize: mb.fontSize ?? bodyPt
					});
				}
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

	// 段落拆分译文 (regionParagraphs): 每个合成段落块 id → 该段译文。
	const paraTranslations = new Map<string, string>();
	const translationOf = (id: string): string | undefined =>
		paraTranslations.get(id) ?? cellTranslations.get(id) ?? input.translations.get(id);

	const replaceable: SourceBlock[] = [];
	// Placement accounting (#6): every translatable block is classified so the
	// page can be honest about what was NOT shown translated — never a silent
	// English block.
	let imageExcluded = 0;
	let untranslated = 0;
	let tooSmall = 0;
	// LO-7 (2.4.0): 展示型大标题原位放不下、改为「整体另置」成功的块数。
	// 另置块同时计入 committed(它确实显示了),这里单列供诊断观察。
	let annexed = 0;
	// LO-10 (2.4.6): 因新占条带上有**未建模墨迹**(分节横线/分栏竖线等)而被
	// 否决的扩展次数 —— 这些块本来会叠印上去且审计看不见。按次计,非按块。
	let inkBlocked = 0;
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
		// 阈值 15%→2% (2.0.4, 审核 P2-15): 遮罩对图像是硬裁剪 (clearRect,
		// 交面积恒 0),但准入曾容忍 ≤15% 重叠 —— 容差带内的块照样 commit,
		// 遮罩盖不到图像部分的原文(英文透出),译文 div 却覆盖整个盒
		// (中文叠印图上)。准入与遮罩必须服从同一条规则。
		const area = box.width * box.height;
		if (overlapsImageInk(box, imageBoxes)) {
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
		// 结构化区域按段落拆回各自的盒子 (审核: 封面摘要塌顶 / 标题空洞根因):
		// 合并后的区域(如整段四节摘要)若原是多个段落组,就把译文按 `\n\n` 拆开、
		// 每段放回自己的组盒;拆不齐(引擎丢了段落分隔)则整体回退到联合盒(旧行为)。
		const split = splitRegionForPlacement(block, text);
		if (split) {
			for (const p of split) {
				paraTranslations.set(p.id, p.text);
				replaceable.push({
					id: p.id,
					pageIndex: block.pageIndex,
					order: block.order,
					type: block.type,
					sourceText: block.sourceText,
					lineRectsPdf: p.lineRectsPdf,
					fontSize: p.fontSize ?? block.fontSize,
					column: block.column
				});
			}
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
		// P2-15: 与上方同一条规则 —— 准入阈值对齐遮罩硬裁剪 (15%→2%)。
		if (overlapsImageInk(box, imageBoxes)) {
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
	const maskCtx = mask.getContext('2d', { willReadFrequently: true }); // 2.1.7 PF-1: pmProbe 采样
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

	/**
	 * 样式化填充 (BabelDOC RichTextPlaceholder 思想, styleRuns.ts): 成对
	 * ⟦b⟧/⟦i⟧ 标记 → <b>/<i> 子元素。安全路径:createTextNode/createElement +
	 * textContent,绝不 innerHTML;解析失败整段回退纯文本。node.textContent
	 * 读取值 = 去标记后的正文,budgetFor 等长度测量自然正确。
	 */
	const fillStyled = (node: HTMLElement, text: string): void => {
		const segments = parseStyledSegments(text);
		if (segments.length === 1 && segments[0]!.style === null) {
			node.textContent = segments[0]!.text; // SAFE: text node
			return;
		}
		node.textContent = '';
		for (const seg of segments) {
			if (seg.style === null) {
				node.appendChild(doc.createTextNode(seg.text));
			}
			else {
				const el = doc.createElementNS(HTML_NS, seg.style) as HTMLElement;
				el.textContent = seg.text; // SAFE: text node
				node.appendChild(el);
			}
		}
	};

	interface StrictItem {
		id: string;
		node: HTMLElement;
		box: PixelBox;
		/** 构建时的原始盒(几何安全复核的"新增侵入"基准;扩展只改 box)。 */
		originalBox: PixelBox;
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
		// 表格单元格标记 (2.3.7): 整格块与逐 member 兜底块的 id 都是
		// `…-table-T-rR-cC` 形;单元格可末位缩字(allowsFontShrink 豁免)。
		if (typeof block.tableRow === 'number' || /-table-\d+-r\d+-c\d+/.test(block.id)) {
			node.setAttribute('data-pm-cell', 'true');
		}
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
		fillStyled(node, translationOf(block.id)!); // SAFE: text nodes + b/i elements, never innerHTML
		// 单段操作提示 (2.3.3, 第四批 item5 · WF-6): 悬停既看原文,也自然发现
		// 双击解析 / 右键单段重译这两个隐藏交互。
		node.title = `${block.sourceText}\n\n双击:解析此段 · 右键:重译此段`;
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
		const item: StrictItem = { id: block.id, node, box, originalBox: { ...box }, fontPx, minLineHeight, committed: false, abandoned: false };
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
		// 计入可用空白 (2.2.2, 计划 第三批 item3 · LO-6/API): 压缩预算按「原盒 +
		// 可安全扩进的邻近空白」算容量,而非仅原盒。否则模型被告知偏小的框、一
		// 上来就过度缩写(信息流失),而这页本可先无损扩边救回。扩边无损,预算据
		// 此放宽 —— 模型只需缩到「盒+空白」放得下,不必更狠。
		const grow = expansionAllowance(item);
		const capW = item.box.width + grow.right;
		const capH = item.box.height + grow.down;
		const estimate = estimateCjkCapacity(capW, capH, item.fontPx);
		const textLen = (item.node.textContent ?? '').length;
		const sh = item.node.scrollHeight;
		// sh 在当前(较窄)盒宽下测得,对 capH 是保守高估 → 预算偏宽不偏窄,与
		// 「别过度缩写」同向;Math.min(estimate,…) 仍封顶。
		const measured = sh > capH && textLen > 0
			? Math.floor(textLen * (capH / sh) * 0.92)
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
			fillStyled(item.node, text); // SAFE: text nodes + b/i elements
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
			// P2-14: 参考文献/表格墨迹也是遮挡物 —— 扩展不得长进它们的原文。
			...inkObstacles.map(o => o.box),
			...geometric.filter(b => b.id !== item.id).map(b => pxOf.get(b.id)!).filter(Boolean)
		], canvas.width / BITMAP_SCALE, canvas.height / BITMAP_SCALE, item.fontPx);
	const applyBox = (item: StrictItem, width: number, height: number): void => {
		item.box = { ...item.box, width, height };
		item.node.style.width = `${width}px`;
		item.node.style.height = `${height}px`;
	};

	// ---- LO-10 (2.4.6): 未建模墨迹 —— 扩边前对底图采样 -------------------------
	// 扩边的避让清单只认**建模过**的东西:图形盒、preserve 墨迹、兄弟块盒。页面上
	// 还有一类墨迹从不进任何模型 —— 分节横线、分栏竖线、脚注分隔线、装饰边框。
	// 扩边对它们失明,译文盒长过去就是叠印;末端审计同样看不见,不会回退。
	// 2.4.0 的大标题另置已经证明「拿渲染底图当真相」这条路可行,这里把它推广到
	// 扩边路径:只采样**新增的那一条**(原盒底下是本块自己的原文,它会被遮罩,
	// 采样它只会得到假阳性),命中未建模墨迹即拒绝这次扩展,回退原盒。
	// 阈值比另置路径低得多:另置要判「这块区域是不是空白」,而这里要抓的是
	// **一条细线** —— 一条 1px 分栏竖线在 100px 宽的条带里只占 1%,用另置的 2%
	// 门槛必然漏掉。改为 0.5% 且至少 3 个采样点命中(挡住反锯齿单点噪声)。
	const INK_COLOUR_DISTANCE = 48;
	const paperRgb = parseRgb(paper);
	const regionHasInk = (b: PixelBox, minShare: number, minPoints: number): boolean => {
		if (!ctx) {
			return false; // 无底图可采样时不否决 —— 交给 boxNewlyViolates 兜底
		}
		try {
			const [pr, pg, pb] = paperRgb;
			const x = Math.max(0, Math.round(b.left * BITMAP_SCALE));
			const y = Math.max(0, Math.round(b.top * BITMAP_SCALE));
			const w = Math.min(ctx.canvas.width - x, Math.round(b.width * BITMAP_SCALE));
			const h = Math.min(ctx.canvas.height - y, Math.round(b.height * BITMAP_SCALE));
			if (w <= 0 || h <= 0) {
				return true; // 出界当作有墨,让候选被拒
			}
			const data = ctx.getImageData(x, y, w, h).data;
			return bitmapHasInk(data, w, h, [pr, pg, pb], { minShare, minPoints, distance: INK_COLOUR_DISTANCE });
		}
		catch {
			return false; // 采样失败不否决(与探针同姿态),几何预校验仍在
		}
	};
	/** 另置路径的口径 (2.4.0 原样): 判「这块区域是不是空白」。 */
	const areaHasInk = (b: PixelBox): boolean => regionHasInk(b, 0.02, 1);
	/** 扩边路径的口径 (2.4.6): 抓细线,门槛低、要求至少 3 点命中。 */
	const stripHasInk = (b: PixelBox): boolean => regionHasInk(b, 0.005, 3);
	/**
	 * 这次扩展新占的地方有未建模墨迹吗?只看**新增条带**,不看原盒。
	 * 任一条带命中即拒。
	 */
	const expansionHitsInk = (item: StrictItem): boolean =>
		expansionStrips(item.originalBox, item.box).some(stripHasInk);

	// ---- 提交前几何预校验 (2.2.3, 计划 第三批 item4 · 页面级原子提交) ----------
	// 与末端 pmGeometryAudit 同一套「新增侵入>容差」判据(boxNewlyViolates),但在
	// **揭示之前**核验:扩展后的块只有既适配、又不新压盖已提交块/图形/preserve/
	// 出界时才 commit。杜绝「显示了又被审计回退」的闪烁。非扩展块(盒==原盒)恒
	// 通过,首屏原字号揭示不受影响。preserve/图形遮挡物与审计、扩展避让共用一份。
	const geometryObstacles = (): AuditObstacles => ({
		images: imageBoxes,
		preserved: geometric
			.filter(b => !byId.has(b.id))
			.map(b => ({ id: b.id, box: pxOf.get(b.id)! }))
			.filter(p => !!p.box)
			.concat(inkObstacles)
	});
	const violatesGeometry = (item: StrictItem): boolean => boxNewlyViolates(
		{ id: item.id, box: item.box, originalBox: item.originalBox },
		items
			.filter(i => i.committed && !i.abandoned && i.id !== item.id)
			.map(i => ({ id: i.id, box: i.box, originalBox: i.originalBox })),
		geometryObstacles(),
		canvas.width / BITMAP_SCALE,
		canvas.height / BITMAP_SCALE
	);

	// ---- 无损扩边优先 (2.2.2, 计划 第三批 item3): 在**压缩/缩字之前**,只靠邻近
	// 安全空白(算法3,原字号、原文一字不动)把能救回的块救回 —— "图1→Figure 1"
	// 式越译越长的标签/标题正是这样无损放下,既不牺牲译文、也不费一次 API。
	// 适配即提交;不适配则**回退原盒**(让后续压缩/缩字从真实盒起算),返回仍未
	// 适配的 id。与 pmShrinkFit 的区别: 这里绝不缩字、绝不动到最小字号组合。
	(page as HTMLElement & { pmExpandFit?: (ids: string[]) => string[] }).pmExpandFit = (ids: string[]): string[] => {
		const still: string[] = [];
		for (const id of ids) {
			const item = byId.get(id);
			if (!item || item.committed || item.abandoned) {
				continue;
			}
			const original = { width: item.box.width, height: item.box.height };
			const grow = expansionAllowance(item);
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
			let fits = false;
			for (const [w, h] of expansions) {
				applyBox(item, w, h);
				// 既适配、又不新压盖邻居/图形/preserve/出界 —— 提交前预校验 (item4);
				// 新占的条带还不能压上未建模墨迹(分节横线/分栏竖线,LO-10 2.4.6)。
				const clean = ladderFits(item) && !violatesGeometry(item);
				if (clean && !expansionHitsInk(item)) {
					fits = true;
					break;
				}
				if (clean) {
					inkBlocked++; // 几何干净、只输在未建模墨迹上
				}
			}
			if (fits) {
				commit(item);
			}
			else {
				applyBox(item, original.width, original.height); // 回退,预算/后续从原盒起算
				still.push(id);
			}
		}
		return still;
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
				// 预校验 (item4) + 未建模墨迹闸 (LO-10 2.4.6)。
				const clean = ladderFits(item) && !violatesGeometry(item);
				fits = clean && !expansionHitsInk(item);
				if (clean && !fits) {
					inkBlocked++;
				}
				if (fits) {
					break;
				}
			}
			// 正文不单独缩字 (2.2.7, item7(b)): 多行 paragraph/list 只靠扩边放置,
			// 放不下保留原文。2.3.7 豁免(基线 doc3 实证): 表格单元格与微小单行块
			// 是孤立小盒,缩字不发花,禁缩只会让它们整行放弃 —— 放行。
			const tinyLine = item.originalBox.height <= item.fontPx * 1.7
				&& (item.node.textContent ?? '').length <= 120;
			const canShrink = allowsFontShrink(item.node.getAttribute('data-pm-type') ?? '', {
				isTableCell: item.node.hasAttribute('data-pm-cell'),
				tinyLine
			});
			if (!fits && canShrink) {
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
					// 组合扩展同样预校验 (item4) + 墨迹闸 (LO-10 2.4.6)。
					fits = ladderFits(item) && !violatesGeometry(item) && !expansionHitsInk(item);
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

	// ---- LO-7 (2.4.0, 计划 排版P2): 封面大标题「整体另置」---------------------
	// 展示型大标题 (type='title') 走完梯子/扩边/压缩/缩字仍放不下时,不再整块保留
	// 英文:原文**原样保留**(不画遮罩),译文以缩小字号另置到标题正下方(次选
	// 正上方)的空白处。安全面三层:①候选区先对**底图采样**——未建模墨迹(作者行、
	// 刊头、装饰线)一票否决,这是 LO-10 指出的扩边盲区,另置不允许有;②仍走
	// boxNewlyViolates 预校验(已提交块/图形/保护区/出界);③全部失败恢复原状,
	// 落回既有放弃流程。旋转刊名条在提取层就被排除,不进此路径。
	const ANNEX_FONT_STEPS = [0.72, 0.6, 0.5];
	const ANNEX_GAP = 6;
	const restoreOriginalBox = (item: StrictItem): void => {
		item.box = { ...item.originalBox };
		item.node.style.fontSize = `${item.fontPx.toFixed(2)}px`;
		item.node.style.left = `${item.originalBox.left}px`;
		item.node.style.top = `${item.originalBox.top}px`;
		item.node.style.width = `${item.originalBox.width}px`;
		item.node.style.height = `${item.originalBox.height}px`;
	};
	const tryAnnexTitle = (item: StrictItem): boolean => {
		const pageH = canvas.height / BITMAP_SCALE;
		const ob = item.originalBox;
		item.node.style.letterSpacing = '';
		item.node.style.lineHeight = '1.3';
		for (const factor of ANNEX_FONT_STEPS) {
			const px = Math.max(9, item.fontPx * factor);
			item.node.style.fontSize = `${px.toFixed(2)}px`;
			// 自然高度: 标题原宽下测量(展示型标题通常横贯版心,宽度沿用原盒)。
			item.node.style.width = `${ob.width}px`;
			item.node.style.height = 'auto';
			const natural = item.node.scrollHeight + 2;
			item.node.style.height = `${natural}px`;
			for (const candidate of annexCandidateBoxes(ob, natural, pageH, ANNEX_GAP)) {
				if (areaHasInk(candidate)) {
					continue;
				}
				item.box = candidate;
				item.node.style.left = `${candidate.left}px`;
				item.node.style.top = `${candidate.top}px`;
				if (item.node.scrollHeight <= natural + 1.5
					&& item.node.scrollWidth <= ob.width + 1.5
					&& !violatesGeometry(item)) {
					// 另置提交: 不画遮罩 —— 原文标题保持可见,译文是附加而非替换。
					item.node.setAttribute('data-pm-annex', 'true');
					item.node.style.visibility = '';
					item.node.removeAttribute('data-pm-unfit');
					item.committed = true;
					annexed++;
					return true;
				}
			}
		}
		restoreOriginalBox(item);
		return false;
	};

	// ---- give up on a block: stays original forever (it was never shown) -----
	(page as HTMLElement & { pmRevert?: (ids: string[]) => void }).pmRevert = (ids: string[]): void => {
		for (const id of ids) {
			const item = byId.get(id);
			if (!item) {
				continue;
			}
			// LO-7: 大标题在放弃前最后尝试整体另置(成功即显示,计 committed)。
			if (!item.committed && !item.abandoned
				&& item.node.getAttribute('data-pm-type') === 'title'
				&& tryAnnexTitle(item)) {
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

	// ---- 几何安全复核 (1.1.0 目标架构第 5 步): 排版后的整页审计 -------------
	// 保护性不变量(集成清单,1.0.2 教训):
	//  - 只动 committed 且未 abandoned 的块(未提交块不可见,无几何足迹);
	//  - mask 按原始行矩形绘制,盒回退不需要重绘;un-commit 与 pmRevert 同动作
	//    (clearMask + 隐藏 + data-pm-unfit),原文完整重现;
	//  - 页高/画布永不改;每轮只收缩不增长 → 幂等收敛;上限 4 轮防病态;
	//  - 只在 FINAL 状态由 reportPlacement 调用,provisional pass 永不触发。
	// 处置顺序与 pmShrinkFit 相反:回退扩展(违例几乎都来自扩展)→ 原盒缩字梯
	// → 仍不适配才放弃(保留原文,诚实计数)。
	(page as HTMLElement & { pmGeometryAudit?: () => { violations: number; adjusted: number; reverted: number; detail?: string[] } }).pmGeometryAudit = (): { violations: number; adjusted: number; reverted: number; detail?: string[] } => {
		const pageW = canvas.width / BITMAP_SCALE;
		const pageH = canvas.height / BITMAP_SCALE;
		const preserved = geometric
			.filter(b => !byId.has(b.id))
			.map(b => ({ id: b.id, box: pxOf.get(b.id)! }))
			.filter(p => !!p.box)
			// P2-14: 审计与扩展共用同一份墨迹遮挡物 —— 压住参考文献/表格原文的
			// 已提交块现在会被看见并回退。
			.concat(inkObstacles);
		let firstCount = 0;
		let adjusted = 0;
		let reverted = 0;
		const detail: string[] = [];
		// 每轮处置**全部**违例 (2.0.6, 审核 P3): 旧实现每轮只处置 violations[0]
		// 且硬上限 4 轮 —— 一页超过 4 个违例时,其余的既没被修也没进诊断,
		// 系统性低报。处置只会收缩/回退盒子(不会制造新重叠),整轮处置后
		// 再复审仍然单调收敛;4 轮上限保留为病态防线(同轮内每个 offender
		// 只处置一次)。
		for (let round = 0; round < 4; round++) {
			const placed: AuditBox[] = items
				.filter(i => i.committed && !i.abandoned)
				.map(i => ({ id: i.id, box: i.box, originalBox: i.originalBox }));
			const violations = auditPlacedBoxes(placed, { images: imageBoxes, preserved }, pageW, pageH);
			if (!violations.length) {
				break;
			}
			if (round === 0) {
				firstCount = violations.length;
			}
			const handledThisRound = new Set<string>();
			for (const v of violations) {
				if (handledThisRound.has(v.id)) {
					continue; // 同一 offender 在多条违例里出现: 一轮只处置一次
				}
				// 陈旧违例重验 (2.0.10, 审核 P3): 违例清单是处置前的快照 ——
				// 同轮内先处置的 offender 收缩后,归责给后处置者的重叠可能已经
				// 消失;不重验就会把只有靠扩展才放得下的块无谓地**永久**回退成
				// 英文。用当前盒重算该条违例,已低于容差则跳过。
				const currentPlaced: AuditBox[] = items
					.filter(i => i.committed && !i.abandoned)
					.map(i => ({ id: i.id, box: i.box, originalBox: i.originalBox }));
				if (!violationStillPresent(v, currentPlaced, { images: imageBoxes, preserved }, pageW, pageH)) {
					continue;
				}
				handledThisRound.add(v.id);
				detail.push(`${v.kind}:${v.id}${v.otherId ? '→' + v.otherId : ''}(${Math.round(v.area)}px²)`);
				const item = byId.get(v.id);
				if (!item || !item.committed || item.abandoned) {
					continue;
				}
				applyBox(item, item.originalBox.width, item.originalBox.height);
				let fits = ladderFits(item);
				if (!fits) {
					for (const factor of SHRINK_STEPS) {
						const px = Math.max(SHRINK_FLOOR_PX, item.fontPx * factor);
						item.node.style.fontSize = `${px.toFixed(2)}px`;
						fits = ladderFits(item);
						if (fits || px <= SHRINK_FLOOR_PX) {
							break;
						}
					}
				}
				if (fits) {
					adjusted++;
				}
				else {
					clearMask(item.id);
					item.committed = false;
					item.abandoned = true;
					item.node.style.visibility = 'hidden';
					item.node.setAttribute('data-pm-unfit', 'true');
					item.node.style.fontSize = `${item.fontPx.toFixed(2)}px`;
					reverted++;
				}
			}
		}
		return { violations: firstCount, adjusted, reverted, detail };
	};

	// ---- placement probe: localise a blank-where-text-should-be -------------
	// Samples the base bitmap + mask under each block. Diagnostic only (guarded,
	// geometry/booleans, never text). See probeStrictPlacement() for the 口径.
	(page as HTMLElement & { pmProbe?: () => StrictProbeRow[] }).pmProbe = (): StrictProbeRow[] => {
		const [pr, pg, pb] = parseRgb(paper);
		const w = ctx?.canvas.width ?? 1;
		const h = ctx?.canvas.height ?? 1;
		const rows: StrictProbeRow[] = [];
		for (const item of items) {
			const state: StrictProbeRow['state'] = item.committed ? 'committed' : item.abandoned ? 'abandoned' : 'pending';
			let baseInk = false;
			let maskOpaque = false;
			try {
				for (const line of lineBoxesFor.get(item.id) ?? []) {
					const pts: [number, number][] = [
						[line.left + line.width * 0.5, line.top + line.height * 0.5],
						[line.left + line.width * 0.2, line.top + line.height * 0.5],
						[line.left + line.width * 0.8, line.top + line.height * 0.5]
					];
					for (const [px, py] of pts) {
						const bx = Math.max(0, Math.min(w - 1, Math.round(px * BITMAP_SCALE)));
						const by = Math.max(0, Math.min(h - 1, Math.round(py * BITMAP_SCALE)));
						if (ctx) {
							const d = ctx.getImageData(bx, by, 1, 1).data;
							if (Math.abs((d[0] ?? 0) - pr) + Math.abs((d[1] ?? 0) - pg) + Math.abs((d[2] ?? 0) - pb) > 48) {
								baseInk = true;
							}
						}
						if (maskCtx && (maskCtx.getImageData(bx, by, 1, 1).data[3] ?? 0) > 12) {
							maskOpaque = true;
						}
					}
				}
			}
			catch { /* 探针纯诊断: 取样失败留默认值 */ }
			rows.push({
				id: item.id,
				type: item.node.getAttribute('data-pm-type') ?? '',
				state,
				left: Math.round(item.box.left), top: Math.round(item.box.top),
				width: Math.round(item.box.width), height: Math.round(item.box.height),
				baseInk, maskOpaque,
				...(item.node.hasAttribute('data-pm-annex') ? { annex: true } : {})
			});
		}
		return rows;
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
			tableIntentional, tableFailed, imageExcluded, untranslated, tooSmall, annexed, inkBlocked
		};
	};

	logger.debug(MODULE, `page ${input.pageIndex + 1}: ${items.length} strict block(s), ${guard.regions.length} protected table(s)`);
	return {
		element: page,
		blocksPlaced: items.length,
		stats: {
			replaceable: items.length,
			committed: 0, abandoned: 0, pending: items.length,
			tableIntentional, tableFailed, imageExcluded, untranslated, tooSmall, annexed: 0, inkBlocked: 0
		}
	};
}

/** Read a strict page's live placement stats, or null if not a strict page. */
export interface GeometryAuditResult {
	violations: number;
	adjusted: number;
	reverted: number;
	/** 每轮处置的违例: kind:块id[→对方id](新增面积) — 只有 id 与几何,无文本。 */
	detail?: string[];
}

/**
 * 排版后的几何安全复核(纯审计在 layoutSafety.ts;处置在页内钩子)。由
 * reportPlacement 在页面达到 FINAL 状态后调用一次;返回 null 表示该元素
 * 不是 strict 页。
 */
export function auditStrictGeometry(element: HTMLElement): GeometryAuditResult | null {
	const fn = (element as HTMLElement & { pmGeometryAudit?: () => GeometryAuditResult }).pmGeometryAudit;
	return fn ? fn() : null;
}

export function strictPageStats(element: HTMLElement): StrictPageStats | null {
	const fn = (element as HTMLElement & { pmStats?: () => StrictPageStats }).pmStats;
	return fn ? fn() : null;
}

/**
 * Per-block placement probe (审核: 封面「标题空洞」定位). For each replaceable
 * block it reports whether the BASE page bitmap still shows ink under the block
 * and whether the mask is opaque there — separating two causes of a blank where
 * text should be:
 *   baseInk=false                → the independent page.render() never drew those
 *                                  glyphs; the abandon fallback (show-original-
 *                                  through) has nothing to reveal. A base-bitmap
 *                                  render/font/timing gap, NOT a placement bug.
 *   baseInk=true & maskOpaque=true (but not committed) → a mask is covering the
 *                                  original that should be showing — a real mask
 *                                  leak / mis-placed line rects.
 * Geometry + booleans only, never text. Returns null on a non-strict element.
 */
export interface StrictProbeRow {
	id: string;
	type: string;
	state: 'committed' | 'abandoned' | 'pending';
	left: number;
	top: number;
	width: number;
	height: number;
	/** Base page bitmap still has ink under the block (original would show if unmasked). */
	baseInk: boolean;
	/** The mask is opaque over the block (original covered). */
	maskOpaque: boolean;
	/** LO-7 (2.4.0): 该块是「整体另置」的大标题译文(原文未遮,box 是另置位置)。 */
	annex?: boolean;
}

export function probeStrictPlacement(element: HTMLElement): StrictProbeRow[] | null {
	const fn = (element as HTMLElement & { pmProbe?: () => StrictProbeRow[] }).pmProbe;
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
export function settleStrictPage(
	element: HTMLElement,
	onMeasured: (unfit: UnfitBlock[], final: boolean) => void,
	fontTimeoutMs = 5000
): void {
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
	// 超时保险 + 单次 final 闸 (1.2.2, 审核项): document.fonts.ready 是一个可以
	// 永不 resolve 的 Promise(字体源挂起、隐藏文档)。没有超时,final 测量永远
	// 不来,整页停在 provisional、一个块都不 reveal —— 用户看到"翻译完成但页面
	// 还是英文"。fireFinal 由闸保证至多执行一次,无论它来自 ready、第二波、
	// 超时还是异常兜底,竞争各方都安全;超时触发时用当时已渲染的字体测量,
	// 比永远不显示强。
	let finalFired = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const fireFinal = (): void => {
		if (finalFired) {
			return;
		}
		finalFired = true;
		if (timer !== null) {
			try {
				clearTimeout(timer);
			}
			catch { /* timers may be gone in a tearing-down document */ }
			timer = null;
		}
		if (element.isConnected) {
			onMeasured(settle(true), true);
		}
	};
	try {
		timer = setTimeout(fireFinal, fontTimeoutMs);
	}
	catch { /* no timer API — ready / 兜底 still fire the final */ }
	onMeasured(settle(false), false); // provisional: measure only, reveal nothing
	try {
		void ready.then(() => {
			if (finalFired || !element.isConnected) {
				return;
			}
			const secondWave = f.status === 'loading' ? f.ready : undefined;
			if (secondWave) {
				// A second load wave started — one more provisional pass now,
				// the final one when it completes (or when the timeout wins).
				onMeasured(settle(false), false);
				void secondWave.then(() => {
					fireFinal();
				});
				return;
			}
			fireFinal();
		});
	}
	catch {
		fireFinal(); // insurance: never leave the caller waiting
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
/**
 * 「查看保留原文」的可见定位指示 (2.0.5, 审核 P2-19)。
 *
 * 保留原文的块 (`[data-pm-unfit]`) 是被 `visibility:hidden` 的**译文** div ——
 * 用户看到的是位图上同一矩形里的原文。旧实现直接给这个隐藏节点描边/加
 * 动画类: `visibility:hidden` 连 outline 和背景一起隐藏,用户点「查看保留
 * 原文」什么也看不到。
 *
 * 修复: 不动隐藏节点本身,而是在其 offsetParent 里按同一几何画一个**独立
 * 的可见标记层**(visibility:hidden 不影响布局,offsetLeft/Top/Width/Height
 * 仍是原文所在矩形),限时后自动移除。返回 null 表示无法定位(节点已脱离
 * 文档/无宿主)—— 调用方应把 null 视为「没有闪到任何东西」,继续走回退
 * 路径,而不是像旧代码那样凭节点存在就返回 true 屏蔽回退。
 */
export function flashKeptIndicator(node: HTMLElement, durationMs = 2000): HTMLElement | null {
	const doc = node.ownerDocument;
	// 只认 offsetParent (2.0.10, 审核 P3): 旧的 `?? parentElement` 兜底在
	// display:none 的面板里伪造「闪成功」—— offsetParent 为 null 但 parentElement
	// 在,0 几何 marker 照建、返回非 null,调用方以为闪到了就不走回退路径,
	// 覆盖模式点「查看保留原文」依旧什么也看不见。定位不了就如实返回 null。
	const host = node.offsetParent as HTMLElement | null;
	if (!doc || !host || !node.isConnected) {
		return null;
	}
	const marker = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
	marker.className = 'pm-kept-indicator';
	marker.style.position = 'absolute';
	marker.style.left = `${node.offsetLeft}px`;
	marker.style.top = `${node.offsetTop}px`;
	marker.style.width = `${node.offsetWidth}px`;
	marker.style.height = `${node.offsetHeight}px`;
	marker.style.outline = '2px solid rgba(240, 173, 78, 0.95)';
	marker.style.background = 'rgba(240, 173, 78, 0.18)';
	marker.style.pointerEvents = 'none';
	marker.style.zIndex = '10';
	host.appendChild(marker);
	doc.defaultView?.setTimeout(() => marker.remove(), durationMs);
	return marker;
}

/**
 * 墨迹遮挡物选择 (2.0.4, 审核 P2-14) — pure, unit-tested。
 * 与 `geometric` 的过滤条件 (`!isReference && type !== 'table'`) 严格互补:
 * 被排除出替换流水线、但墨迹仍留在位图上的块。没有 lineRectsPdf 的块没有
 * 可用几何,无从避让,只能排除。
 */
export function selectInkObstacleBlocks<T extends { isReference?: boolean; type?: string; lineRectsPdf?: unknown[] }>(blocks: T[]): T[] {
	return blocks.filter(b => (b.isReference || b.type === 'table') && !!b.lineRectsPdf?.length);
}

/**
 * 图像准入规则 (2.0.4, 审核 P2-15) — pure, unit-tested。
 * 遮罩对图像是硬裁剪 (paintMask 的 clearRect 保证 mask∩image === 0),
 * 因此文本盒的准入必须服从同一条规则: 与任何图像的重叠超过盒面积 2%
 * (几何噪声容差,与 layoutSafety 审计的 tol 同数量级) 即拒绝替换。
 * 旧阈值 15% 留下一条"英文透出 + 中文叠印"的容差带。
 */
export function overlapsImageInk(box: PixelBox, imageBoxes: PixelBox[]): boolean {
	const area = box.width * box.height;
	return area > 0 && imageBoxes.some(img => intersectArea(box, img) > area * 0.02);
}

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
		// 1.1.4 字段修复 (首字下沉页 overlap:region-7→region-8): 判据从"起点在
		// 我边缘之外"改为"延伸超过我的边缘"——与我已有轻微重叠的邻居(drop cap
		// 行矩形常态)此前不算遮挡物,扩张会径直穿过它;现在一律按其近边截断,
		// 已重叠者截为 0。
		const vOverlap = Math.min(box.top + box.height, other.top + other.height) - Math.max(box.top, other.top);
		if (vOverlap > 2 && other.left + other.width > box.left + box.width - 1) {
			right = Math.min(right, other.left - (box.left + box.width) - 3);
		}
		const hOverlap = Math.min(box.left + box.width, other.left + other.width) - Math.max(box.left, other.left);
		if (hOverlap > 2 && other.top + other.height > box.top + box.height - 1) {
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

/**
 * 无损扩边优先 (2.2.2, 计划 第三批 item3): 压缩/缩字之前先只靠邻近安全空白
 * (原字号、原文不动)救回能救的块。返回仍未适配的 id —— 只有这些才需要进入
 * 后续的压缩→缩字→保留原文流程。找不到 hook(理论上不会)时保守返回全部。
 */
export function expandStrictBlocks(element: HTMLElement, ids: string[]): string[] {
	const expand = (element as HTMLElement & { pmExpandFit?: (ids: string[]) => string[] }).pmExpandFit;
	return expand ? expand(ids) : ids;
}
