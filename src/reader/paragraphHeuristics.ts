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

import { isReferenceTailLine, startsReferenceEntry } from './referenceDetect';
import { endsMidSentence } from './metaFilter';
import { type Rect } from './columnGeometry';
export { bandedColumnStamp, columnOf, detectColumns, detectGutters, detectGuttersBanded } from './columnGeometry';
export type { BandedGutter, ColumnBand, Rect } from './columnGeometry';

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
	// 5.0: "93. doi: 10.1007/…" is the tail of a reference entry, not item 93.
	if (isReferenceTailLine(text)) return false;
	// 5.0 (校验 2757 p10: "100. …" 与 "101. Strain WD, …" 并成一块): three-digit
	// reference numbers, recognised by the author–initials that follow.
	if (startsReferenceEntry(text)) return true;
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
		// 断词连字符是唯一无歧义的续接信号 (2.5.7): 一段以「photon-」收尾、
		// 下一段以「counting detector scans…」起头,这不可能是两段东西。图注
		// 被版面切开时(horst2024-p5 的图 6 说明就断在 photon-/counting 之间)
		// bodyOnly 会挡住修复,而恰好在这里放行不会带来别的风险 —— 标题、
		// 列表项都不会以连字符收尾。
		const hyphenSplit = /\p{L}-$/u.test(prev.text.trim())
			&& (p.type ?? 'paragraph') === 'paragraph';
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
		// 行尾停在虚词或连字符上同样是"话没说完" (2.5.7): jacc-ccta2020-p1 的
		// 摘要末行被 shortLine 撕成独立块,前一块正好收在「…on behalf of the」——
		// 逗号判据看不见这种收尾,于是摘要在译文页上断在半句话上。复用 2.5.1
		// 的行尾判据。前一块若已经收了句号,endsSentence 早就把合并挡掉了,
		// 所以这条只会作用在真正被拆开的段落上。
		const danglingEnd = /[,，、;；:：]$/.test(prev.text.trim())
			|| endsMidSentence(prev.text);
		const mergeable = sameColumn
			&& (bodyOnly || hyphenSplit)
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
	/**
	 * 5.0: 已知参考文献页上,上一行像条目的结尾(年份、卷期页、DOI),下一行像
	 * 条目的开头(带编号或不带编号的作者)。
	 */
	entryBoundary?: boolean;
	/** 5.1: an all-bold short heading line meets a regular line. */
	weightChange?: boolean;
}

/**
 * 断段证据 (5.0 结构层重构第 2 步)。
 *
 * 原来的 shouldBreak 是一串按顺序执行的 if:先命中谁就听谁的。改成"各项证据
 * 并列、带权重相加":
 *   - 强证据(换栏、列表开头、引导点、短行、大间距、缩进、字号跳变、条目边界)各 +3;
 *   - 行宽撑满本栏(句子在续)−2;
 *   - 中等间距(> 0.75em)+1;
 * 总分 > 0 即断。这组权重与旧级联**逐例等价**(任一强证据都压过"撑满";
 * 撑满压过中等间距;都没有就不断),所以替换本身不改变任何结果 —— 本机语料
 * 234 页逐页核对。之后加新证据或改权重,改动都落在一处,且每个断点都说得出理由。
 */
export type BreakReason = 'new-column' | 'list-start' | 'leader-dots' | 'short-line' | 'large-gap'
	| 'indent' | 'font-jump' | 'entry-boundary' | 'weight-change' | 'wrapped' | 'gap';

export interface BreakEvidence { reason: BreakReason; weight: number }

export interface BreakDecision { brk: boolean; score: number; evidence: BreakEvidence[] }

export const BREAK_WEIGHTS = { strong: 3, wrapped: -2, gap: 1 } as const;

export function decideBreak(ctx: BreakContext): BreakDecision {
	const size = ctx.fontSize > 0 ? ctx.fontSize : 10;
	const evidence: BreakEvidence[] = [];
	const strong = (on: boolean | undefined, reason: BreakReason): void => {
		if (on) evidence.push({ reason, weight: BREAK_WEIGHTS.strong });
	};
	strong(ctx.newColumn, 'new-column');
	strong(ctx.listStart, 'list-start');
	// 目录行/短行 (BabelDOC): 连点号行自成一段;明显短于中位行宽的行是段末。
	strong(ctx.leaderDots, 'leader-dots');
	strong(ctx.shortLine && !ctx.wrapped, 'short-line');
	// A gap this big is a section break no matter what the line looked like.
	strong(ctx.gap > size * 1.7, 'large-gap');
	// Indentation is measured against the COLUMN's left margin, and a font-size
	// change is measured from dominant (not mean) sizes — both are strong
	// enough to end a paragraph on their own.
	strong(ctx.indented, 'indent');
	strong(ctx.fontJump, 'font-jump');
	// 5.0: inside a known reference list, the previous line ends an entry and
	// the next starts one (numbered or not).
	strong(ctx.entryBoundary, 'entry-boundary');
	strong(ctx.weightChange, 'weight-change');
	// A line that filled its column wrapped, so the sentence continues.
	// Line-spacing wobble — a tall glyph, an inline formula, a superscript —
	// must not cut it in half.
	if (ctx.wrapped) evidence.push({ reason: 'wrapped', weight: BREAK_WEIGHTS.wrapped });
	if (ctx.gap > size * 0.75) evidence.push({ reason: 'gap', weight: BREAK_WEIGHTS.gap });
	const score = evidence.reduce((n, e) => n + e.weight, 0);
	return { brk: score > 0, score, evidence };
}

export function shouldBreak(ctx: BreakContext): boolean {
	return decideBreak(ctx).brk;
}
