/**
 * Column and gutter detection: page columns from line rects, whitespace
 * gutters voted across rows (whole page and per band), the banded column stamp,
 * and which column a rect belongs to.
 *
 * Split out of paragraphHeuristics.ts in 5.1 without changing behaviour.
 * Pure module — no DOM, no Zotero APIs.
 */

/** [x1, y1, x2, y2] in PDF coordinates (origin bottom-left, y grows upward). */
export type Rect = [number, number, number, number];

export interface ColumnBand {
	left: number;
	right: number;
}

/** Lines wider than this fraction of the page span the gutter (titles, abstracts). */
export const FULL_WIDTH_RATIO = 0.62;

/**
 * Detect text columns by projecting line rects onto the x axis and splitting
 * on gaps wider than the gutter threshold. Full-width lines are excluded from
 * the projection — otherwise a single spanning title bridges the gutter and
 * the whole page looks like one column.
 */
export function detectColumns(rects: Rect[], pageWidth: number, pageHeight = 0): ColumnBand[] {
	const width = pageWidth > 0 ? pageWidth : 612;
	const gutter = Math.max(11, width * 0.018);
	const valid = rects.filter(r => Number.isFinite(r[0]) && Number.isFinite(r[2]) && r[2] > r[0]);
	// PAGE FURNITURE must not vote: a centered footer ("This copy is for
	// personal use only…"), running head or page number sits ACROSS the gutter
	// and, fed into the greedy chain below, bridges the two columns into one
	// band — after which the whole page reads as single-column and the real
	// right column gets shredded line-by-line by the indent rule. Exclude
	// (a) rects in the top/bottom 6% bands (when the page height is known) and
	// (b) tiny rects (page numbers, drop caps, equation numbers) < 5% width.
	const furnitureBand = pageHeight > 0 ? pageHeight * 0.06 : 0;
	const usable = valid.filter((r) => {
		if (r[2] - r[0] < width * 0.05) {
			return false;
		}
		if (furnitureBand && (r[1] > pageHeight - furnitureBand || r[3] < furnitureBand)) {
			return false;
		}
		return true;
	});
	// Spanning lines (titles, abstracts) bridge the gutter, so they are left
	// out of the projection. If EVERY line spans, the page is single-column
	// and the spanning lines are all we have to measure.
	const pool = usable.length ? usable : valid;
	const candidates = pool.filter(r => r[2] - r[0] < width * FULL_WIDTH_RATIO);
	const narrow = (candidates.length ? candidates : pool).sort((a, b) => a[0] - b[0]);
	if (!narrow.length) {
		return [];
	}
	const chained: ColumnBand[] = [];
	const chainMembers: Rect[][] = [];
	for (const r of narrow) {
		const last = chained[chained.length - 1];
		if (last && r[0] <= last.right + gutter) {
			last.right = Math.max(last.right, r[2]);
			chainMembers[chainMembers.length - 1]!.push(r);
		}
		else {
			chained.push({ left: r[0], right: r[2] });
			chainMembers.push([r]);
		}
	}
	// 反焊接 (三栏首页斑马纹 root cause): the greedy chain above lets ONE rect
	// weld two real columns into a single band — a hyphen overhang spilling a
	// few points into the gutter, or a three-column gutter that is simply
	// narrower than the chain threshold, and columns 1+2 fuse. Fused bands
	// collapse the column stamps, the canonical reading order bails (or
	// interleaves the two columns by baseline), the coalescer can never rejoin
	// same-column neighbours, and the pair of columns degrades to line-level
	// shreds — half translated, half rejected. One bad rect must not outvote
	// every clean line, so each band gets a coverage vote (the detectGutters
	// idea, applied to band members): a sustained channel that ≥90% of members
	// avoid is a gutter, and the band splits there.
	const bands: ColumnBand[] = [];
	const memberLefts: number[][] = [];
	for (let i = 0; i < chained.length; i++) {
		for (const seg of splitBandByCoverage(chainMembers[i]!)) {
			let left = Infinity;
			let right = -Infinity;
			for (const r of seg.members) {
				left = Math.min(left, r[0]);
				right = Math.max(right, r[2]);
			}
			// Clamp to the channel edges: the welding rect stays a member of its
			// own side, but its protruding edge must not stretch the band across
			// the gutter (a band reaching into the neighbour column made columnOf
			// tie-break wrong for every line in that column).
			bands.push({
				left: Math.max(left, seg.clampLeft),
				right: Math.min(right, seg.clampRight)
			});
			memberLefts.push(seg.members.map(r => r[0]));
		}
	}
	// Robust left edge: the MEDIAN of member lefts, not the minimum. One
	// outdented bullet / hanging-indent reference lowered the min by ~1em,
	// after which every ordinary line in the column tested as "indented" and
	// the paragraph broke after every single line (逐行断段 root cause #2).
	for (let i = 0; i < bands.length; i++) {
		const lefts = memberLefts[i]!.slice().sort((a, b) => a - b);
		bands[i]!.left = Math.max(bands[i]!.left, lefts[Math.floor(lefts.length / 2)]!);
	}
	// Ignore slivers (equation numbers, margin notes) — they are not columns.
	// When NOTHING significant remains, report NO columns (single full-width
	// flow) instead of promoting the slivers: a page-number band as "the
	// column" made every line read as wrapped/indented.
	const significant = bands.filter(b => b.right - b.left >= width * 0.12);
	// 满幅前言压倒双栏正文时的兜底 (2.5.0, 由 radiology-radiomics2023-p1 实证)。
	// 上面的贪心链条按 x 投影,而**满幅段落的末行天然短**(封面页的作者串、单位、
	// 摘要末行都是 250–350pt),躲过 FULL_WIDTH_RATIO 混进投影,横跨白槽把左右栏
	// 焊成一栏 —— 该页 43 行宽行里只有 12 行看得见白槽,反焊接的 10% 侵入配额被
	// 10+ 行桥接行击穿。只在**一栏都没分出来**时才跑,已经分对的页面逐字节不变。
	if (significant.length < 2) {
		const byLeft = columnsByLeftEdge(pool, width);
		if (byLeft.length >= 2) {
			return byLeft;
		}
	}
	return significant;
}

/**
 * 左边缘聚类分栏 — `detectColumns` 的兜底。
 *
 * 关键洞察:满幅前言和左栏**共用左边缘**(都从版心左界起排),靠宽度分不开;
 * 但右栏的左边缘是独立的强信号 —— 一堆行整齐地从版心中部起排,只可能是第二栏。
 * 所以按左边缘聚类,而**栏的右边界只由「不越过下一栏左缘」的成员决定**:满幅行
 * 会伸过去,于是自动被排除在右边界之外,再也焊不动两栏。
 *
 * 三道闸,缺一不可(全部由 14 页语料实测定标):
 *  - 每簇 ≥6 个成员:零星的缩进行不能立栏;
 *  - 相邻簇中位左缘相距 ≥15% 版心宽:那是分栏,不是首行缩进(缩进只有 1em);
 *  - **均衡性**:最窄栏 ≥ 最宽栏的 60% —— 真分栏各栏宽度相近,而 4:1 的
 *    「窄标签列 + 宽内容列」是表格,横向切开它会毁掉表格的阅读序。
 */
export function columnsByLeftEdge(rects: Rect[], width: number): ColumnBand[] {
	if (rects.length < 12) {
		return [];
	}
	const tolerance = width * 0.06;
	const sorted = [...rects].sort((a, b) => a[0] - b[0]);
	const clusters: { seed: number; members: Rect[] }[] = [];
	for (const r of sorted) {
		const last = clusters[clusters.length - 1];
		if (last && r[0] - last.seed <= tolerance) {
			last.members.push(r);
			last.seed = r[0];
		}
		else {
			clusters.push({ seed: r[0], members: [r] });
		}
	}
	const big = clusters.filter(c => c.members.length >= 6);
	if (big.length < 2) {
		return [];
	}
	const centres = big.map((c) => {
		const lefts = c.members.map(r => r[0]).sort((a, b) => a - b);
		return lefts[Math.floor(lefts.length / 2)]!;
	});
	const out: ColumnBand[] = [];
	for (let i = 0; i < big.length; i++) {
		const left = centres[i]!;
		const nextLeft = i + 1 < big.length ? centres[i + 1]! : Infinity;
		if (i + 1 < big.length && nextLeft - left < width * 0.15) {
			return []; // 簇挨得太近 —— 是缩进,不是分栏
		}
		const inColumn = big[i]!.members.filter(r => r[2] <= nextLeft - 2);
		if (!inColumn.length) {
			return [];
		}
		out.push({ left, right: Math.max(...inColumn.map(r => r[2])) });
	}
	const kept = out.filter(b => b.right - b.left >= width * 0.12);
	if (kept.length < 2) {
		return [];
	}
	const widths = kept.map(b => b.right - b.left);
	if (Math.min(...widths) < Math.max(...widths) * 0.6) {
		return []; // 宽度悬殊 → 表格的标签列,不是分栏
	}
	return kept;
}

export interface BandSegment {
	members: Rect[];
	/** Channel edges bounding this segment (±Infinity at the band's ends). */
	clampLeft: number;
	clampRight: number;
}

/**
 * Split one chained band at internal whitespace channels its members agree on.
 * Conservative on purpose: needs ≥6 members to vote, a ≥6pt interior channel
 * that at most ~10% of members intrude into, and ≥3 members on every side —
 * a ragged right edge, an indented first line or a couple of stray rects can
 * never trigger it, so ordinary single-column bands pass through untouched.
 */
export function splitBandByCoverage(members: Rect[]): BandSegment[] {
	const whole: BandSegment[] = [{ members, clampLeft: -Infinity, clampRight: Infinity }];
	if (members.length < 6) {
		return whole;
	}
	const STEP = 2;
	let left = Infinity;
	let right = -Infinity;
	for (const r of members) {
		left = Math.min(left, r[0]);
		right = Math.max(right, r[2]);
	}
	const cells = Math.ceil((right - left) / STEP);
	if (!Number.isFinite(cells) || cells <= 2) {
		return whole;
	}
	const cover = new Array<number>(cells).fill(0);
	for (const r of members) {
		const from = Math.max(0, Math.round((r[0] - left) / STEP));
		const to = Math.min(cells - 1, Math.round((r[2] - left) / STEP) - 1);
		for (let k = from; k <= to; k++) {
			cover[k]!++;
		}
	}
	const allow = Math.max(1, Math.floor(members.length * 0.1));
	const channels: { start: number; end: number }[] = [];
	let runStart = -1;
	for (let k = 0; k <= cells; k++) {
		const isGap = k < cells && cover[k]! <= allow;
		if (isGap && runStart < 0) {
			runStart = k;
		}
		else if (!isGap && runStart >= 0) {
			const startX = left + runStart * STEP;
			const endX = left + k * STEP;
			// Interior only: a low-coverage run touching the band's own edge is
			// a ragged margin (indented first lines, short final lines), not a
			// gutter between two columns.
			if (endX - startX >= 6 && startX > left + 1 && endX < right - 1) {
				channels.push({ start: startX, end: endX });
			}
			runStart = -1;
		}
	}
	if (!channels.length) {
		return whole;
	}
	const segments: BandSegment[] = [];
	for (let s = 0; s <= channels.length; s++) {
		segments.push({
			members: [],
			clampLeft: s > 0 ? channels[s - 1]!.end : -Infinity,
			clampRight: s < channels.length ? channels[s]!.start : Infinity
		});
	}
	for (const r of members) {
		const centre = (r[0] + r[2]) / 2;
		let s = 0;
		while (s < channels.length && centre > (channels[s]!.start + channels[s]!.end) / 2) {
			s++;
		}
		segments[s]!.members.push(r);
	}
	// Every side needs real support, or the "channel" was noise.
	return segments.every(seg => seg.members.length >= 3) ? segments : whole;
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
			// ROUND, not floor/ceil: the old marking over-covered ~2pt on each
			// side of every glyph run, so gutters narrower than ~12pt could never
			// win a cell and were undetectable (audit P0).
			const from = Math.max(0, Math.round(r[0] / STEP));
			const to = Math.min(cells - 1, Math.round(r[2] / STEP) - 1);
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
			// A real gutter is a sustained channel, not a word space. 6pt (was 8):
			// with exact coverage marking a tight 12–14pt gutter now shows as a
			// ~6–10pt uncovered run and must still count.
			if (endX - startX >= 6 && startX > width * 0.12 && endX < width * 0.88) {
				gutters.push((startX + endX) / 2);
			}
			runStart = -1;
		}
	}
	return gutters;
}

/** A gutter channel with the vertical span over which it actually holds. */
export interface BandedGutter {
	/** x centre of the channel (PDF user space). */
	x: number;
	/** Highest (top) y the channel spans; PDF bottom-origin, so top > bottom. */
	top: number;
	/** Lowest (bottom) y the channel spans. */
	bottom: number;
	/**
	 * 5.0 版面模型: the span most of the channel's cells hold (median of the
	 * per-cell runs). Rows between core and union were reached by a few edge
	 * cells only — a word gap that happens to sit at the gutter's x.
	 */
	coreTop?: number;
	coreBottom?: number;
}

/**
 * 分带栏沟检测 (2.5.10, JACC 尾页实证): the global {@link detectGutters} takes
 * ONE page-wide vote, which is structurally wrong for a page whose column count
 * changes down the page — the classic journal end page with a **two-column
 * body over a three-column reference list**. There the reference middle column
 * sits right on top of the body gutter, so the body channel never reaches
 * quorum and the two body columns weld into one scrambled line (translation of
 * the whole two-column body then fails). This variant finds each gutter as a
 * vertical CHANNEL that persists over a run of consecutive wide rows, and
 * returns the y-span over which it holds, so a caller splits a row only at the
 * gutters that actually exist at that row's height.
 *
 * Same coverage model as detectGutters (2pt cells, rounded glyph marking, a
 * gap must be ≥6pt wide and sit inside the middle 76% of the page). A channel
 * counts only where ≥MIN_RUN consecutive wide rows leave it uncovered.
 */
export function detectGuttersBanded(rows: Rect[][], pageWidth: number): BandedGutter[] {
	const width = pageWidth > 0 ? pageWidth : 612;
	const STEP = 2;
	const cells = Math.ceil(width / STEP);
	if (cells <= 0) {
		return [];
	}
	/** A gutter must hold over at least this many wide rows to be real — the
	 *  vertical analogue of detectGutters' 60% quorum, but LOCAL so a channel
	 *  present in only part of the page still counts there. */
	const MIN_RUN = 5;
	/** A channel tolerates up to this many CONSECUTIVE covered rows (a heading
	 *  or a hyphen-overhang welding rect crossing the gutter) without ending —
	 *  but a regime change (a whole band of rows covering the gutter) far
	 *  exceeds it, so bands stay distinct. */
	const HOLE_TOL = 2;
	/** …and across the whole span the uncovered rows must stay a clear majority,
	 *  so a scatter of short-line gaps down a justified column never accretes
	 *  into a phantom gutter. */
	const MIN_DENSITY = 0.6;
	interface WideRow { top: number; bottom: number; gap: boolean[]; }
	const wide: WideRow[] = [];
	for (const row of rows) {
		if (!row.length) {
			continue;
		}
		let rowLeft = Infinity;
		let rowRight = -Infinity;
		let top = -Infinity;
		let bottom = Infinity;
		for (const r of row) {
			rowLeft = Math.min(rowLeft, r[0]);
			rowRight = Math.max(rowRight, r[2]);
			top = Math.max(top, r[3]);
			bottom = Math.min(bottom, r[1]);
		}
		if (!Number.isFinite(rowLeft) || rowRight - rowLeft < width * 0.5) {
			continue;
		}
		const covered = new Array<boolean>(cells).fill(false);
		for (const r of row) {
			const from = Math.max(0, Math.round(r[0] / STEP));
			const to = Math.min(cells - 1, Math.round(r[2] / STEP) - 1);
			for (let k = from; k <= to; k++) {
				covered[k] = true;
			}
		}
		const gap = new Array<boolean>(cells).fill(false);
		const from = Math.max(0, Math.ceil(rowLeft / STEP));
		const to = Math.min(cells - 1, Math.floor(rowRight / STEP));
		for (let k = from; k <= to; k++) {
			gap[k] = !covered[k];
		}
		wide.push({ top, bottom, gap });
	}
	if (wide.length < MIN_RUN) {
		return [];
	}
	// Rows top-of-page first (higher y first) so a run's [top, bottom] reads
	// naturally; the input is usually already in this order, but don't rely on it.
	wide.sort((a, b) => b.top - a.top);
	// For each x-cell, the vertical runs of consecutive wide rows that leave it
	// uncovered. A qualifying run (≥MIN_RUN) is a per-cell gutter candidate.
	interface Cand { cell: number; top: number; bottom: number; }
	const cands: Cand[] = [];
	for (let k = 0; k < cells; k++) {
		// Maximal runs of wide rows uncovered at cell k, bridging up to HOLE_TOL
		// consecutive covered rows. runStart/lastGap track the first and last
		// UNCOVERED row of the current run; uncovered counts its uncovered rows.
		let runStart = -1;
		let lastGap = -1;
		let uncovered = 0;
		let holes = 0;
		const close = (): void => {
			if (runStart >= 0 && uncovered >= MIN_RUN) {
				const span = lastGap - runStart + 1;
				if (uncovered / span >= MIN_DENSITY) {
					cands.push({ cell: k, top: wide[runStart]!.top, bottom: wide[lastGap]!.bottom });
				}
			}
			runStart = -1;
			lastGap = -1;
			uncovered = 0;
			holes = 0;
		};
		for (let i = 0; i < wide.length; i++) {
			if (wide[i]!.gap[k]!) {
				if (runStart < 0) {
					runStart = i;
				}
				lastGap = i;
				uncovered++;
				holes = 0;
			}
			else if (runStart >= 0) {
				holes++;
				if (holes > HOLE_TOL) {
					close();
				}
			}
		}
		close();
	}
	if (!cands.length) {
		return [];
	}
	// Merge horizontally-contiguous candidate cells whose vertical spans overlap
	// into one channel. Cells of the same physical gutter share the same run, so
	// their spans coincide; the overlap test keeps two different-height gutters
	// at nearby x (rare) apart.
	cands.sort((a, b) => a.cell - b.cell || b.top - a.top);
	const result: BandedGutter[] = [];
	let startCell = cands[0]!.cell;
	let endCell = cands[0]!.cell;
	let top = cands[0]!.top;
	let bottom = cands[0]!.bottom;
	let members: Cand[] = [cands[0]!];
	const median = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	const flush = (): void => {
		const startX = startCell * STEP;
		const endX = (endCell + 1) * STEP;
		if (endX - startX >= 6 && startX > width * 0.12 && endX < width * 0.88) {
			// 5.0 版面模型 (校验 r22, 2852 p1 / 2721 p1): where MOST of the channel's
			// cells hold is its core. A keyword line set across the page leaves a
			// word gap on a few of the gutter's cells ("◼ critical care ◼ disease
			// management": 292–297 of the 280–304 channel), stretching the union
			// over it; outside the core a row splits only at a real gap.
			result.push({ x: (startX + endX) / 2, top, bottom, coreTop: median(members.map(m => m.top)), coreBottom: median(members.map(m => m.bottom)) });
		}
	};
	for (let i = 1; i < cands.length; i++) {
		const c = cands[i]!;
		const overlaps = c.cell <= endCell + 1 && c.bottom <= top && c.top >= bottom;
		if (overlaps) {
			endCell = Math.max(endCell, c.cell);
			top = Math.max(top, c.top);
			bottom = Math.min(bottom, c.bottom);
			members.push(c);
		}
		else {
			flush();
			startCell = endCell = c.cell;
			top = c.top;
			bottom = c.bottom;
			members = [c];
		}
	}
	flush();
	return result;
}

/**
 * 分带栏归属 (2.5.10): a page whose column count changes down the page — a
 * two-column body over a three-column reference list — has NO single set of
 * column bands. {@link detectColumns} collapses it to one wrong band and every
 * block stamps to column 0, so the canonical reading order can't separate the
 * columns and the two-column body reads line-interleaved (left line, right
 * line, …), scrambling its translation.
 *
 * This derives vertical REGIMES from the banded gutters (each regime = a set of
 * gutters that share a vertical span) and returns a stamp that assigns each
 * block a COMPOSITE column index `regimeRank * 100 + localColumn`. Ordering by
 * that index then emits every column of the upper regime (top band) before any
 * column of the lower one, each column top-to-bottom — the correct reading
 * order without needing a full-width separator between the bands.
 *
 * Returns `null` when the page has ≤1 regime (the overwhelmingly common case:
 * one uniform 1/2/3-column flow), so the caller keeps the existing
 * detectColumns/columnOf path and every uniform page is byte-for-byte
 * unchanged.
 */
export function bandedColumnStamp(
	rows: Rect[][],
	pageWidth: number,
	pageHeight: number,
	/** detectColumns 在同一页认出的显著带数 (2.6.0): 满幅表格的格子行会把
	 *  x 投影链焊成一条假单带,此时散文 regime 的栏结构只有分带检测知道 ——
	 *  分带栏数超过普通路径带数即触发抢救。不传则不启用该触发。 */
	plainBandCount?: number
): ((rect: Rect) => number) | null {
	// A page-level column REGIME spans a large fraction of the page. Short
	// channels — a header-band or footnote gutter tens of points tall — must not
	// define a regime (they made ordinary two-column pages with a distinct
	// header band read as multi-regime). Splitting still uses every channel;
	// only this page-structure decision drops the short ones.
	const minSpan = (pageHeight > 0 ? pageHeight : 792) * 0.2;
	const gutters = detectGuttersBanded(rows, pageWidth).filter(g => g.top - g.bottom >= minSpan);
	// 2.6.3 (fletcher2024-p7 实证): 门槛 <2 → 0。此前"只有一条合格分带沟"
	// 直接退全局,但 p7 正是【单条正文沟 + 全局投票全盲 (detectGutters=[]) +
	// detectColumns 焊成单带】—— 两个抢救触发都会命中,却死在这道早门上,
	// 底部双栏正文整节逐行拉链。单沟页走到下面的触发判定: 均匀页在那里
	// 照旧 null (全局看得见沟 → 不抢救),逐字节不变。
	if (!gutters.length) {
		return null;
	}
	// Group gutters that overlap vertically into regimes.
	const sorted = [...gutters].sort((a, b) => b.top - a.top);
	interface Regime { top: number; bottom: number; xs: number[]; }
	// A gutter joins a regime only when it SUBSTANTIALLY overlaps it vertically
	// (≥50% of the shorter span). A body gutter that a hole-bridge stretched a
	// row or two into the reference zone still touches the reference regime, but
	// that sliver is far below 50%, so the two-column body band and the
	// three-column reference band stay distinct.
	const overlaps = (r: Regime, g: BandedGutter): boolean => {
		const lo = Math.max(r.bottom, g.bottom);
		const hi = Math.min(r.top, g.top);
		const inter = hi - lo;
		if (inter <= 0) {
			return false;
		}
		const shorter = Math.min(r.top - r.bottom, g.top - g.bottom);
		return shorter <= 0 || inter >= shorter * 0.5;
	};
	const regimes: Regime[] = [];
	for (const g of sorted) {
		const host = regimes.find(r => overlaps(r, g));
		if (host) {
			host.top = Math.max(host.top, g.top);
			host.bottom = Math.min(host.bottom, g.bottom);
			host.xs.push(g.x);
		}
		else {
			regimes.push({ top: g.top, bottom: g.bottom, xs: [g.x] });
		}
	}
	// A regime with three or more gutters (≥4 columns) is a data TABLE, not a
	// prose column band — tables have their own structuring pass, and letting a
	// table define a page regime made table-bearing pages re-split. Prose
	// columns are 1–3 wide (≤2 gutters).
	const proseRegimes = regimes.filter(r => r.xs.length <= 2);
	if (!proseRegimes.length) {
		return null;
	}
	// 散文 regime 抢救 (2.6.0, radiology2023 p3/p11 实证): 满幅数据表把全局
	// detectGutters 的投票整个盖死 (quorum 永远不满,返回 []),正文栏沟只有
	// 分带检测看得见 —— 但此前这里要求 ≥2 个散文 regime 才激活,「一个双栏
	// 正文带 + 若干表格带」的页面被判 null 回退全局,左右栏的行按基线交错、
	// 逐行成段,整节译文变成拉链。新触发: 哪怕只有一个散文 regime,只要
	// 【全局投票漏掉了它的任何一条栏沟】(±8pt 内无全局沟),就必须走分带 ——
	// 全局什么都没看见,不存在"回退到它"这回事。全局没漏时逐字节走老路。
	// 「漏」的判据是【数量】+【位置】双条件:
	// - 数量: 全局沟数 < regime 沟数 —— 全局投票在结构上撑不起这个 regime
	//   的栏数,普通路径必然把某两栏拉成拉链。只看位置不看数量会误伤两类页:
	//   chen2023-p10 (全局 301 vs 分带 292,同一条物理沟被跨带行拉偏 9pt,
	//   全局其实看见了) 和 hakime2007-p2 (分带在第 2 栏中间多投出一条 338 的
	//   假沟,全局 [222,391] 明明是对的 —— 按位置匹配反而判全局"漏")。
	// - 位置: 容差 20pt (≠ 盖章的 ±8pt 骑缝容差),防跨带行把沟心拉偏。
	const globalGutters = detectGutters(rows, pageWidth > 0 ? pageWidth : 612);
	// 校验 r24 (2795 p4): a global gutter that is one of a TABLE regime's column
	// gaps says nothing about the prose band — counted, it hid that the global
	// vote missed the body gutter, and the two-column body under a full-width
	// table was read line by line in turn.
	const tableXs = regimes.filter(r => r.xs.length > 2).flatMap(r => r.xs);
	const globalProse = globalGutters.filter(g => !tableXs.some(x => Math.abs(g - x) <= 8));
	const globalMissed = proseRegimes.some(r =>
		r.xs.length > globalProse.length
		&& r.xs.some(x => !globalProse.some(g => Math.abs(g - x) <= 20)));
	// 第二触发 (2.6.0, radiology2023-p3 实证): 全局沟虽在,detectColumns 的
	// x 投影链却被表格格子行焊成一条假单带 —— 散文 regime 知道的栏数
	// (沟数+1) 超过普通路径的带数时,普通盖章必然把两栏拉成拉链,同样只能
	// 靠分带抢救。detectColumns 认出的带数不少于散文栏数的页面 (chen/wu 系
	// 全部夹具) 不触发,逐字节走老路。
	// 只信【全局也确认过的】regime: p3 的机理是分带和全局对沟的位置意见一致
	// (297 vs 292/303),坏在 detectColumns 的 x 投影被表格格子行焊死;而
	// wu2026-p6 里分带 regime 混进了全局根本不认的表格碎沟 (253/351/406),
	// 按它的"栏数"去比 band 数是拿坏证据翻好判决 —— 含未确认沟的 regime
	// 不参与本触发。
	const confirmed = (r: Regime): boolean =>
		r.xs.every(x => globalGutters.some(g => Math.abs(g - x) <= 20));
	const plainCollapsed = plainBandCount !== undefined
		&& proseRegimes.some(r => confirmed(r) && r.xs.length + 1 > plainBandCount);
	const rescueNeeded = globalMissed || plainCollapsed;
	if (proseRegimes.length < 2 && !rescueNeeded) {
		return null;
	}
	regimes.length = 0;
	regimes.push(...proseRegimes);
	// Rank regimes top-of-page first (higher y first).
	regimes.sort((a, b) => b.top - a.top);
	for (const r of regimes) {
		r.xs.sort((a, b) => a - b);
	}
	// Only a genuine change in column STRUCTURE down the page justifies the
	// banded path — UNLESS the global vote missed the gutters entirely (then
	// there is nothing to defer to). If every regime has the same gutter x's (a
	// single uniform multi-column flow whose gutter merely broke around a
	// mid-page heading and re-formed at the same x) AND the global vote sees
	// those gutters, defer to the plain detectColumns/columnOf path so that
	// page stays byte-identical.
	const signature = (r: Regime): string => r.xs.map(x => Math.round(x / 8)).join(',');
	const sig0 = signature(regimes[0]!);
	if (!rescueNeeded && regimes.every(r => signature(r) === sig0)) {
		return null;
	}
	const width = pageWidth > 0 ? pageWidth : 612;
	return (rect: Rect): number => {
		const midY = (rect[1] + rect[3]) / 2;
		const midX = (rect[0] + rect[2]) / 2;
		// The regime containing this block's mid-y; when a hole-bridged gutter
		// makes two regimes' spans overlap, the one whose centre is nearest wins,
		// so a reference row inside the body gutter's leaked tail still lands in
		// the reference regime.
		let rank = -1;
		let bestDist = Infinity;
		for (let i = 0; i < regimes.length; i++) {
			const r = regimes[i]!;
			if (midY <= r.top + 2 && midY >= r.bottom - 2) {
				const dist = Math.abs(midY - (r.top + r.bottom) / 2);
				if (dist < bestDist) {
					bestDist = dist;
					rank = i;
				}
			}
		}
		// Outside every regime (page furniture above the top band, a heading in
		// the transition gap between two bands): treat as a full-width separator
		// so reading order flushes the band above before the band below.
		// 近邻并入 (2.6.3, fletcher2024-p7 实证): 栏沟通道要两侧都有字才测得到,
		// 双栏区左栏先于右栏起笔的头一两行落在 regime 顶界之外,骑界块被判 -1
		// 插进阅读序中间。距 regime 边界 ≤24pt (约两行) 且不跨该 regime 任何
		// 栏沟的块并入该 regime;更远的 (表格区、页面家具) 仍是 -1 分隔,
		// p11 Table 4 的 -1 语义不受影响。
		if (rank < 0) {
			let nearDist = Infinity;
			let nearRank = -1;
			for (let i = 0; i < regimes.length; i++) {
				const r = regimes[i]!;
				const d = midY > r.top ? midY - r.top : r.bottom - midY;
				if (d < nearDist) {
					nearDist = d;
					nearRank = i;
				}
			}
			// 宽度门 (审核 2.6.3): 并入的必须像一【行正文】—— 至少占本 regime 一栏
			// 宽的 40%。未被探成表格的表尾格 (窄小碎片) 贴着正文 regime 时不能
			// 借近邻并入混进栏序,仍作 -1 分隔。
			const colW = width / (nearRank >= 0 ? regimes[nearRank]!.xs.length + 1 : 1);
			if (nearRank >= 0 && nearDist <= 24
				&& rect[2] - rect[0] >= colW * 0.4
				&& !regimes[nearRank]!.xs.some(x => rect[0] < x - 8 && rect[2] > x + 8)) {
				rank = nearRank;
			}
			else {
				return -1;
			}
		}
		const r = regimes[rank]!;
		// A block that straddles one of this regime's gutters spans the whole
		// band width — a section heading or full-width line — and separates.
		// Margin 8pt, NOT 2pt (审核 2.5.10): groupIntoLines lets a hyphenated
		// line overhang up to min(6, 0.6em) past the gutter centre, so an
		// ordinary left-column paragraph can end ~6pt past x. With a 2pt margin
		// that paragraph stamped -1 and became a band SEPARATOR mid-column —
		// reading order then cut both columns at its height and the coalescer
		// broke the paragraph mid-sentence. 8pt clears the maximum overhang; a
		// genuine spanning heading extends far beyond 8pt on both sides.
		if (r.xs.some(x => rect[0] < x - 8 && rect[2] > x + 8)) {
			return -1;
		}
		let local = 0;
		for (const x of r.xs) {
			if (midX > x) {
				local++;
			}
		}
		return rank * 100 + local;
	};
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
	if (best >= 0) {
		return best;
	}
	// 落在**版心之外**的内容自成一栏 (2.5.6)。原先的兜底一律判 0 栏,于是页边
	// 窄栏与正文按 y 交错排列:jacc-ccta2020-p1 页脚那条音频摘要小栏
	// (x 24–99,而版心是 110–452)被拆成碎片塞进利益声明中间 ——「…SINO
	// Medical Technology, / Dr. Valentin Fuster on / ReCore, Terumo
	// Corporation…」,声明本身被切成六块。
	//
	// 判据必须是「版心之外」,不能是「不落在任何栏带里」: 后者在表格页上会
	// 一炮打翻整张表 —— chen2023-p5 的 198 行里有 **109 行**落在栏带之间
	// (栏带只认出 63–158 与 410–485,单元格大多在缝隙里),给它们独立栏号会
	// 把整张表从行序读成列序。
	//
	// 而且只认**左**边:23 页语料里落在版心左侧的一共 8 行 —— 3 个页码
	// (「4」「8」「714」)加上 JACC 那条音频摘要小栏的 5 行,没有一行是正文
	// 或表格。右侧则有 42 行,其中 37 行是 chen2023-p5 的表格单元格(那页栏带
	// 只认到 485,P 值列在 510 开外),把它们判成页边内容同样会打乱表格阅读序。
	// 右页边栏在期刊里确实存在,等语料里真出现一例再放开,不为想象中的版式
	// 冒打乱真实表格的风险。
	return rect[2] <= bands[0]!.left ? bands.length : 0;
}
