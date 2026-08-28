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
function columnsByLeftEdge(rects: Rect[], width: number): ColumnBand[] {
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

interface BandSegment {
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
function splitBandByCoverage(members: Rect[]): BandSegment[] {
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

/**
 * 目录引导行 (BabelDOC ParagraphFinding): ≥4 个连续(或点-空格交替)点号,
 * "1. Introduction ......... 5" 这种行必须自成一段。
 */
export function hasLeaderDots(text: string): boolean {
	return /(?:\.{4,}|(?:\.\s){4,})/.test(text);
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
 * 块级列表/目录判定 (移植自 MinerU `para_split.py::__is_list_or_index_block`,
 * opendatalab/MinerU, Apache-2.0 — 完整致谢见 THIRD-PARTY-NOTICES.md)。
 *
 * `looksLikeListStart` 只看**一行的开头**;当多个条目被 groupIntoParagraphs
 * 黏成一个块时,块的开头只有第一个条目的标记,后面的条目就此消失在正文段里
 * (参考文献列表、图注列表被并进正文段的根因)。MinerU 的判据在**块的行分布**
 * 上做,三条任一成立即列表块:
 *
 *   (a) ≥60% 的行以条目标记开头 —— 「[1]…/[2]…」「• …」这类被黏在一起的列表;
 *   (b) ≥60% 的行是目录引导点行 —— 「Introduction ...... 5」这类目录块;
 *   (c) ≥80% 的行以句末标点 `.。;；` 收尾(MinerU 主判据,要求 ≥3 行)——
 *       散文段是**折行**的,除末行外都停在句子中间;每行各自收尾的块是列表。
 *
 * (c) 要求 ≥3 行是本移植加的保守边界:两行都恰好以句号结尾在真散文里并不罕见
 * (「…et al.」/「…2019.」),3 行连续对齐才足以排除巧合。
 *
 * 影响面:块型从 paragraph 变 list —— 下游锚字号、缩字许可、coalesce、跨页
 * 续接对两者完全同权,唯一改变的是 `planMerges` 的 bodyOnly 门不再把它们黏进
 * 相邻正文段。Pure — 只看文本,可单测。
 */
export function looksLikeListBlock(lines: string[]): boolean {
	const usable = lines.map(l => l.trim()).filter(l => l.length > 0);
	if (usable.length < 2) {
		return false; // 单行块无「行分布」可言,交给逐行的 looksLikeListStart
	}
	const share = (pred: (line: string) => boolean): number =>
		usable.filter(pred).length / usable.length;
	if (share(looksLikeListStart) >= 0.6) {
		return true; // (a) 多个条目标记 → 被黏在一起的列表
	}
	if (share(hasLeaderDots) >= 0.6) {
		return true; // (b) 目录块
	}
	if (usable.length >= 3 && share(line => /[.。;；]$/.test(line)) >= 0.8) {
		return true; // (c) 每行各自收尾 → 条目,不是折行的散文
	}
	return false;
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

/**
 * Is this a BOLD font, judging by the PDF font name? Embedded fonts name their
 * weight in the PostScript name — "…-Bold", "…,Bold", "Helvetica-Black",
 * "NimbusRomNo9L-Medi", Computer Modern's "CMBX10" (bold extended), TeX's
 * "…-bx". A bold subheading typeset at the body size is invisible to a
 * size-only classifier; this is the extra signal that catches it (spec §5).
 * Deliberately conservative — "-Medi"/"Semilight" style ambiguous weights are
 * treated as NOT bold to avoid promoting body text.
 */
export function isBoldFontName(fontName: string | undefined): boolean {
	if (!fontName) {
		return false;
	}
	const n = fontName.toLowerCase();
	if (/(semilight|extralight|ultralight|thin|light|regular|roman|book|medium|-medi\b)/.test(n)) {
		// An explicit non-bold weight wins even if "black" appears as a family
		// name (rare), so check these first and bail.
		if (!/bold|black|heavy/.test(n)) {
			return false;
		}
	}
	return /(bold|black|heavy|semibold|demibold|-bd\b|,bd\b|cmbx|-bx\b|[-_]b\b)/.test(n);
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
		// 间距要**双向**卡死 (2.5.4 → 2.5.5, chen2023-p4/p10 实证)。原判据只拦
		// 「离得太远」,却放过了负间距 —— 而阅读序把满幅块排在分栏块**之前**,
		// 于是「下一段」常常在页面上方几百点处:表 1 底下那条以逗号收尾的
		// 「Note.—…BMI = body mass index,」后面跟的是页顶的页眉,gapAfter = −349,
		// `-349 <= 10.8` 照样成立,两者被焊成一个纵跨整页的块(页眉因此混进正文,
		// 还把表格区域从页顶一路撑到页底)。往回跳的"下一段"从来不是被拆开的
		// 同一段;只容忍上下标/悬挂标点造成的轻微重叠。
		const adjacent = prev.gapAfter === undefined
			|| (prev.gapAfter <= size * 1.2 && prev.gapAfter >= -size * 0.5);
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
	/**
	 * 短行分段 (移植自 BabelDOC ParagraphFinding `split_short_lines`,
	 * https://github.com/funstory-ai/BabelDOC, AGPL-3.0): 当前行显著短于页面
	 * 中位行宽(< 0.7×)且下一行不是续接 → 段落在此结束,即使行距不大。
	 */
	shortLine?: boolean;
	/**
	 * 目录行 (BabelDOC ParagraphFinding): 连续点号引导行 ("Introduction .... 5")
	 * 自成一段,不与上下行合并。
	 */
	leaderDots?: boolean;
}

export function shouldBreak(ctx: BreakContext): boolean {
	const size = ctx.fontSize > 0 ? ctx.fontSize : 10;
	if (ctx.newColumn || ctx.listStart) {
		return true;
	}
	// 目录行/短行 (BabelDOC): 连点号行自成一段;明显短于中位行宽的行是段末。
	if (ctx.leaderDots) {
		return true;
	}
	if (ctx.shortLine && !ctx.wrapped) {
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
