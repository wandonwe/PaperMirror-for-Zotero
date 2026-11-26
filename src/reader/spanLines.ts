/**
 * Text-layer items to rows and lines (steps 1–3 of spanBlockBuilder):
 * item geometry and font sizes, decorative rules, sideways runs, rows sharing a
 * baseline, rows split at the gutters into lines, and the line-level rejoins
 * (tabbed labels, glossary rows).
 *
 * Split out of spanBlockBuilder.ts in 5.1 without changing behaviour.
 * Pure module — no DOM, no Zotero APIs.
 */
import { joinSemanticSpans } from './semanticSpans';
import { isDecorativeTextRule } from './textRules';
import { isPublisherBoilerplateLine } from './metaFilter';
import {
	columnOf,
	detectColumns,
	detectGutters,
	detectGuttersBanded,
	bandedColumnStamp,
	type BandedGutter,
	type Rect
} from './paragraphHeuristics';

/** One text run with its rect in PDF coordinates [x1, y1, x2, y2] (y up). */
export interface SpanItem {
	text: string;
	rect: Rect;
	fontSize?: number;
	/** 5.1: set in a bold face (embedded font name). Absent = not known / not bold. */
	bold?: boolean;
}

export interface SpanLine {
	items: SpanItem[];
	rect: Rect;
	fontSize: number;
}

/**
 * Fallback column split when there are too few rows for the gutter vote: any
 * horizontal gap this large inside one baseline is a column boundary, not a
 * word space (an inter-word space never exceeds ~1em, even when justified).
 */
export function columnGapThreshold(fontSize: number): number {
	// 1.6em (was 2.5em): standard journal gutters are 18-24pt while 10pt text
	// made the old threshold 25pt — left/right columns sharing a baseline were
	// concatenated. A justified inter-word space stays under ~1.3em, so 1.6em
	// still never splits inside a sentence.
	//
	// 下限 12 → 8 (2.5.6, jacc-ccta2020-p1 实证): 该页脚注是 **6pt**,页边那条
	// 音频摘要小栏(x 24–99)与正文脚注(x 110–)之间只有 11pt —— 1.6em 本该
	// 是 9.6pt、足以切开,却被 12 的下限抬过了头,于是那一行两栏文字焊成一句:
	// 「Listen to this manuscript's Michael A. Wiener Cardiovascular Institute…」。
	// 下限只对 7.5pt 以下的小字生效,而 1.6em 对 6pt 字仍远超任何两端对齐能
	// 拉出的词距(约 0.6em),不会在句子中间误切。
	return Math.max(fontSize * 1.6, 8);
}

/** A page-wide gutter without a matching vertical channel is weak evidence.
 * Slack admits real line overhangs, not ordinary word gaps inside the same line. */
export function crossesLineGutter(previousRight: number, nextLeft: number,
	gutter: Pick<BandedGutter, 'x' | 'top'>, slack: number, fontSize: number): boolean {
	const gap = nextLeft - previousRight;
	// The voted x is rounded to whole points: a column whose left edge sits at
	// 216.8 under a gutter voted at 217 is still right of it (校验 r23, 2845 p9:
	// the middle column of a three-column reference list welded to the left one
	// on every row that starts an entry).
	return previousRight <= gutter.x + slack && (nextLeft >= gutter.x || nextLeft >= gutter.x - 1 && gap >= fontSize * 0.25)
		&& (Number.isFinite(gutter.top) || previousRight <= gutter.x || gap >= fontSize * 0.25);
}

/** 5.0 版面模型: the row lies where most of the channel's cells hold (or the channel has no core recorded). */
export function inChannelCore(g: BandedGutter, rowMid: number): boolean {
	return g.coreTop === undefined || g.coreBottom === undefined || (rowMid <= g.coreTop + 2 && rowMid >= g.coreBottom - 2);
}

export function union(a: Rect, b: Rect): Rect {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function rectOf(items: SpanItem[]): Rect {
	let rect: Rect = [...items[0]!.rect] as Rect;
	for (const item of items) {
		rect = union(rect, item.rect);
	}
	return rect;
}

/**
 * 字号跳变判据 (2.5.4)。
 *
 * 原判据是 `> 0.2`,而 sizeOf 把字号按半点分桶 —— 10pt 正文接 12pt 小节标题
 * 算出来**恰好是 0.2,不大于**,于是期刊排版里最常见的一档标题级差从来断不开
 * 段。chen2023-p3 的 "Results" 就这样被焊在「…(version 4.1.1;www.R-project.org).」
 * 尾巴上,整节结构在译文页上消失。改成 `>=` 让这一档落进来;更小的级差
 * (10→11 = 0.1)仍然不算跳变,以免正文里的字号抖动把段落切碎。
 */
export const FONT_JUMP_RATIO = 0.2;

export function sizeOf(items: SpanItem[]): number {
	// Dominant by CHARACTER COUNT, not by span count: one superscript must not
	// inflate the whole line, and neither must a drop cap. A drop-cap line has
	// exactly two spans — "A" (25pt) + "cute coronary …" (10pt) — and a
	// span-count vote TIES, where the ties-go-larger rule (meant for
	// subscripts) crowned the drop cap: the welded line became a fake 25pt
	// mid-column "title". One char of 25pt vs fifty chars of 10pt is not a tie.
	const counts = new Map<number, number>();
	for (const i of items) {
		const s = i.fontSize ?? (i.rect[3] - i.rect[1]);
		if (!(Number.isFinite(s) && s > 0)) {
			continue;
		}
		const bucket = Math.round(s * 2) / 2;
		counts.set(bucket, (counts.get(bucket) ?? 0) + Math.max(1, i.text.trim().length));
	}
	let best = 0;
	let bestCount = -1;
	for (const [bucket, count] of counts) {
		if (count > bestCount || (count === bestCount && bucket > best)) {
			best = bucket;
			bestCount = count;
		}
	}
	return best || 10;
}

/** Some PDFs draw dotted section rules as text. They have no linguistic
 * content: including their full-width rect in prose welds neighbouring label
 * and value columns, and their dots then enter the translated paragraph.
 * Leave the original drawing intact, but exclude only independent, long dot
 * rows from text extraction. Inline ellipses, leaders with labels/page numbers,
 * short punctuation, and table rows of missing-value dashes remain content. */
export function removeDecorativeTextRules(items: SpanItem[]): SpanItem[] {
	const rules = new Set(decorativeTextRows(items).flat());
	return rules.size ? items.filter(i => !rules.has(i)) : items;
}

export function decorativeTextRows(items: SpanItem[]): SpanItem[][] {
	return groupIntoRows(items).filter(row => isDecorativeTextRule(row.map(i => i.text).join(''), rectOf(row), sizeOf(row)));
}

/** Step 1: items sharing a baseline band, left to right. No x constraint. */
/** 同基线的 run 成行 —— 导出仅为可测性 (2.4.9): 白槽投票在这一层做,
 * 切分后的 SpanLine 已经看不到「一行横跨两栏」,拿它做探针必然测不出东西。 */
/**
 * 该行是否由一个「下沉首字」领起 —— 行内最高的 item 只有 1–2 个字符,
 * 绝对高度 ≥ 18pt,且比来客高出 1.8 倍以上。
 */
export function hasDropCapLead(
	row: { items: SpanItem[]; top: number; bottom: number },
	incomingHeight: number
): boolean {
	let lead: SpanItem | undefined;
	let leadHeight = 0;
	for (const it of row.items) {
		const h = it.rect[3] - it.rect[1];
		if (h > leadHeight) {
			leadHeight = h;
			lead = it;
		}
	}
	if (!lead) {
		return false;
	}
	return lead.text.trim().length <= 2
		&& leadHeight >= 18
		&& leadHeight >= incomingHeight * 1.8;
}

/** 一个 run 的字号 —— 缺字号时退回盒高。 */
export function fontSizeOf(item: SpanItem): number {
	const s = item.fontSize ?? (item.rect[3] - item.rect[1]);
	return Number.isFinite(s) && s > 0 ? s : 0;
}

/** 行的代表字号 = 行内最大的那个,用来认出比它明显小的上下标。 */
export function rowFontSize(row: { items: SpanItem[] }): number {
	let max = 0;
	for (const it of row.items) {
		max = Math.max(max, fontSizeOf(it));
	}
	return max;
}

/**
 * 全页正文字号 —— classify 里 `ratio = fontSize / bodySize` 的分母 (2.5.7)。
 *
 * `dominantFontSize` 按**行数**取众数,而这个分母问的是「正文有多大」。封面页
 * 上两者会分道扬镳:jacc-ccta2020-p1 的 6pt 前置信息(单位、利益声明)占了
 * **57.8% 的字符 / 27 行**,7.5pt 的摘要只有 33.1% / 17 行 —— 众数判成 6pt,
 * 于是页面上**任何**比 6pt 大的东西 ratio 都 ≥ 1.1:摘要末行「American College
 * of Cardiology Foundation.」被撕下来当标题(摘要因此断在「on behalf of the」),
 * 栏目条与副题也一并够上了 title 的门槛。2.4.7 曾把 heading 臂的长度上限从
 * 160 收到 70 来压住症状,病灶一直没动。
 *
 * 两条修正:① 按**字符数**计权,一行长正文不该和一行两字的标签同票;
 * ② 众数之上若还有一档**份量可观**的更大字号(≥25% 字符且大出 15% 以上),
 * 取它 —— 小字是脚注,正文不会比脚注还小。份量门槛挡住的是标题:标题只占
 * 百分之几的字符,永远够不上 25%。
 */
export function pageBodySize(lines: SpanLine[]): number {
	const weight = new Map<number, number>();
	const lineCount = new Map<number, number>();
	let total = 0;
	for (const line of lines) {
		const size = line.fontSize;
		if (!(Number.isFinite(size) && size > 0)) {
			continue;
		}
		const chars = Math.max(1, lineText(line).trim().length);
		const bucket = Math.round(size * 2) / 2;
		weight.set(bucket, (weight.get(bucket) ?? 0) + chars);
		lineCount.set(bucket, (lineCount.get(bucket) ?? 0) + 1);
		total += chars;
	}
	if (!total) {
		return 0;
	}
	// 正文按定义是**多行**的。只有一行的字号档不能当正文 —— 否则一个 25 字的
	// 标题就能压过三行短正文(单测「a large short line is classified as a
	// title」正是这个形状)。没有任何一档够两行时退回全部参与,聊胜于无。
	const eligible = [...weight].filter(([bucket]) => (lineCount.get(bucket) ?? 0) >= 2);
	const pool = eligible.length ? eligible : [...weight];
	let mode = 0;
	let modeWeight = -1;
	for (const [bucket, w] of pool) {
		// 同票取大者 —— 与 dominantFontSize 一致(正文压过一串下标)。
		if (w > modeWeight || (w === modeWeight && bucket > mode)) {
			mode = bucket;
			modeWeight = w;
		}
	}
	let best = mode;
	for (const [bucket, w] of pool) {
		if (bucket > best && bucket >= mode * 1.15 && w >= total * 0.25) {
			best = bucket;
		}
	}
	return best;
}

/** A small raised/lowered run is read beside its local base, not beside
 * whichever whole-page row happens to overlap it first. Resolve anchors from
 * all runs before y-sorting: superscripts can appear before their base row. */
export function scriptRowAnchors(items: SpanItem[]): Map<SpanItem, SpanItem> {
	const anchors = new Map<SpanItem, SpanItem>();
	for (const script of items) {
		const token = script.text.trim();
		// Resolve compact indices/references (including alphabetic subscripts),
		// never defer a smaller-font prose sentence or a complete heading.
		const numericIndex = /^[+−-]?\d{1,6}$/u.test(token);
		if (!token || (!numericIndex && [...token].length > 4) || /\s/u.test(token)) continue;
		const size = fontSizeOf(script);
		let nearest: SpanItem | undefined;
		let best = Infinity;
		for (const base of items) {
			const font = fontSizeOf(base);
			if (base === script || size < font * 0.45 || size > font * 0.86 || font <= 0) continue;
			// 5.0 (校验 3084, Medical Physics): a raised number can also PRECEDE
			// its base — the label of a superscript-numbered reference
			// ("⁷S. Rathee, …"). Without this it was read with the row above and
			// fused into a page number there ("12(4), 7437–442").
			const after = script.rect[0] - base.rect[2];
			const before = base.rect[0] - script.rect[2];
			const gap = numericIndex && before >= -font * 0.2 && before <= font * 0.65 && !(after >= -font * 0.2 && after <= font * 0.65) ? before : after;
			if (gap < -font * 0.2 || gap > font * 0.65) continue;
			const rise = script.rect[1] - base.rect[1];
			const lowered = base.rect[3] - script.rect[3];
			const raised = rise >= font * 0.2 && rise <= font * 0.85 && script.rect[3] <= base.rect[3] + font * 0.4;
			const subscript = lowered >= font * 0.2 && lowered <= font * 0.85
				&& script.rect[1] <= base.rect[1] - font * 0.1;
			if (!raised && !subscript) continue;
			const score = Math.abs(gap) / font + Math.abs((script.rect[1] + script.rect[3]) - (base.rect[1] + base.rect[3])) / font * 0.05;
			if (score < best) { best = score; nearest = base; }
		}
		if (nearest) anchors.set(script, nearest);
	}
	return anchors;
}

/** A run set sideways: far taller than wide (the same test groupIntoRows drops). */
export function isSidewaysRun(i: SpanItem): boolean {
	if (i.text.trim().length < 2) return false;
	const w = i.rect[2] - i.rect[0], h = i.rect[3] - i.rect[1];
	// 5.0 (校验 r22, 3322): a short word turned 90° ("ARTICLE" on the edge tab,
	// 11 wide × 29 tall at 11pt) is not 3× taller than wide, but its box is one
	// font-size wide and several tall — no upright run looks like that. It
	// bridged two reference rows and pulled label "16." onto the line above.
	const size = i.fontSize ?? 0;
	return h > w * 3 || (size > 0 && w <= size * 1.3 && h >= size * 2.2);
}

/**
 * 5.0 (推荐模型校验 2897 末页 / 3386 p9–10): characters of sideways text away
 * from the page edges — a table or caption printed rotated 90° on an upright
 * page. Those runs are dropped from extraction (see groupIntoRows), so the
 * reader is told the table stays in the source language. Edge strips (the
 * "Author Manuscript" / journal watermark down the margin) do not count.
 */
export function sidewaysBodyChars(items: SpanItem[], pageWidth: number): number {
	const edge = pageWidth * 0.08;
	let chars = 0;
	for (const i of items) {
		if (!isSidewaysRun(i)) continue;
		const cx = (i.rect[0] + i.rect[2]) / 2;
		if (cx < edge || cx > pageWidth - edge) continue;
		chars += i.text.replace(/\s+/g, '').length;
	}
	return chars;
}

/** Enough sideways body text to be a rotated table, not a stray rotated label. */
export const ROTATED_TABLE_MIN_CHARS = 120;

/**
 * 真机 4.99.16 (3386 p10): with a rotated table kept original, its SHORT runs
 * ("Value", "–", "99)") are not three times taller than wide and leaked into
 * extraction as fragments. Inside the rotated table's box, runs that are
 * narrow or a few characters long belong to the table and are dropped too;
 * wide upright lines (the page footer, body text) are kept.
 */
export function dropRotatedTableRemnants(items: SpanItem[], pageWidth: number): SpanItem[] {
	if (sidewaysBodyChars(items, pageWidth) < ROTATED_TABLE_MIN_CHARS) return items;
	const edge = pageWidth * 0.08;
	const runs = items.filter(i => {
		const cx = (i.rect[0] + i.rect[2]) / 2;
		return isSidewaysRun(i) && cx >= edge && cx <= pageWidth - edge;
	});
	const pad = Math.max(...runs.map(i => i.rect[2] - i.rect[0]), 6);
	const box: Rect = [Math.min(...runs.map(i => i.rect[0])) - pad, Math.min(...runs.map(i => i.rect[1])) - pad,
		Math.max(...runs.map(i => i.rect[2])) + pad, Math.max(...runs.map(i => i.rect[3])) + pad];
	return items.filter(i => {
		const cx = (i.rect[0] + i.rect[2]) / 2, cy = (i.rect[1] + i.rect[3]) / 2;
		if (cx < box[0] || cx > box[2] || cy < box[1] || cy > box[3]) return true;
		const w = i.rect[2] - i.rect[0], h = i.rect[3] - i.rect[1];
		return !(h >= w || i.text.trim().length <= 3);
	});
}

export function groupIntoRows(items: SpanItem[]): SpanItem[][] {
	const usable = items.filter((i) => {
		if (!i.text.trim().length || !Number.isFinite(i.rect[1]) || !Number.isFinite(i.rect[3])) {
			return false;
		}
		// Rotated runs — the vertical journal strip along the page edge
		// ("EuroIntervention 2023;18:e1307-e1327") — have boxes far taller
		// than wide. Left in, they share a baseline band with the TITLE and
		// get concatenated into it ("1307− 冠状动脉…"). A normal narrow glyph
		// ("I", "1") is a single character and is kept.
		if (isSidewaysRun(i)) {
			return false;
		}
		return true;
	});
	if (!usable.length) {
		return [];
	}
	const anchors = scriptRowAnchors(usable);
	const sorted = usable.filter(item => !anchors.has(item)).sort((a, b) => (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]));
	const rows: { items: SpanItem[]; top: number; bottom: number }[] = [];
	for (const item of sorted) {
		const height = Math.max(1, item.rect[3] - item.rect[1]);
		const centre = (item.rect[1] + item.rect[3]) / 2;
		const itemFont = fontSizeOf(item);
		// 首字下沉 (2.5.1): 段首那个 2–3 行高的大写字母,盒心正好落在【第二行】
		// 的基线带里,于是按中心配对会把它焊成「Acauses of morbidity…」,而真正
		// 的第一行 "cute coronary syndrome…" 反被挤成独立行。下沉首字与第一行是
		// 【顶边】对齐的 (A 顶 167.48 / 第一行顶 167.33,差 0.15;第二行顶
		// 155.34,差 12.1),所以含下沉首字的行改按顶边配对。判据落在「行内最高
		// 的 item 是个 1–2 字符的大字母」上,标题行、上标都不满足,不受影响。
		const row = rows.find((r) => {
			if (hasDropCapLead(r, height)) {
				return Math.abs(r.top - item.rect[3]) <= height * 0.5;
			}
			// 上下标按【纵向重叠】归行 (2.5.4)。按盒心配对时容差取的是**来客
			// 自身**的高度,而下标又矮又偏:chen2023-p2 里 FFR 的下标 CT 高
			// 4.9pt,离本行中心 3.7、离下一行中心 5.8 —— 容差只有 ±2.9,两边都
			// 够不着,于是自成一行。这一行随后被当成新段落的开头:第 2 页输出
			// 「MACE = major adverseCT cardiac events」(下标掉进了下一行),
			// 第 3 页整个右栏段落被劈成两块、第二块以「CT on MACE was
			// explored…」起头。上下标与它所属的那一行必然大面积重叠,与相邻行
			// 只擦一点边,重叠度是比盒心距离稳得多的判据。
			// 判据用【字号】而不是行盒高度: 行盒会随成员增长,一旦它被某个高
			// glyph 撑高,后面每个正常行都会被误判成"小来客"而走上宽松的重叠
			// 匹配 —— aquino2023-p2 的「Exclusion criteria were (a) refusal…」
			// 就是这样被下一行的「…tion to iodine-based…」污染的。上下标的本质
			// 是**字号更小**,这一点不会被行盒的成长带偏。
			if (itemFont > 0 && rowFontSize(r) > 0 && itemFont < rowFontSize(r) * 0.75) {
				// A larger heading in another column can share the row's band.
				// It must not make the next normal body line look like a script.
				// Same-sized runs already overlapping this x-range provide the
				// stable local baseline; unrelated columns cannot move its centre.
				const sameSize = r.items.filter(peer => {
					const size = fontSizeOf(peer);
					return size > 0 && Math.abs(size - itemFont) <= Math.min(size, itemFont) * 0.15;
				});
				const peers = sameSize.filter(peer =>
					Math.min(peer.rect[2], item.rect[2]) > Math.max(peer.rect[0], item.rect[0]));
				const larger = r.items.filter(peer => itemFont < fontSizeOf(peer) * 0.75);
				const separateColumn = larger.every(big => sameSize.every(peer =>
					Math.max(big.rect[0] - peer.rect[2], peer.rect[0] - big.rect[2]) >= itemFont * 0.8));
				if (peers.length && separateColumn) {
					const band = rectOf(peers);
					return Math.abs((band[1] + band[3]) / 2 - centre) <= height * 0.6;
				}
				const overlap = Math.min(r.top, item.rect[3]) - Math.max(r.bottom, item.rect[1]);
				return overlap >= height * 0.5;
			}
			return Math.abs((r.top + r.bottom) / 2 - centre) <= height * 0.6;
		});
		if (row) {
			row.items.push(item);
			row.top = Math.max(row.top, item.rect[3]);
			row.bottom = Math.min(row.bottom, item.rect[1]);
		}
		else {
			rows.push({ items: [item], top: item.rect[3], bottom: item.rect[1] });
		}
	}
	const rowFor = new Map(rows.flatMap(row => row.items.map(item => [item, row] as const)));
	for (const [script, base] of anchors) {
		let anchor = base;
		while (anchors.has(anchor)) anchor = anchors.get(anchor)!; // Font sizes strictly increase; no cycles.
		const row = rowFor.get(anchor)!;
		row.items.push(script);
		row.top = Math.max(row.top, script.rect[3]);
		row.bottom = Math.min(row.bottom, script.rect[1]);
	}
	for (const row of rows) {
		row.items.sort((a, b) => a.rect[0] - b.rect[0]);
	}
	rows.sort((a, b) => b.top - a.top);
	return rows.map(r => r.items);
}

/**
 * Group items into visual lines, never merging across a column gutter.
 * `pageWidth` lets the gutter vote work; without it a conservative gap
 * threshold is used instead.
 */
export function groupIntoLines(items: SpanItem[], pageWidth = 612, pageHeight = 0, referenceList = false, knownGutters: number[] = []): SpanLine[] {
	const rows = groupIntoRows(items);
	if (!rows.length) {
		return [];
	}
	// 分带栏沟 (2.5.10): a page whose column count changes down the page — a
	// two-column body over a three-column reference list — cannot be split by a
	// single page-wide gutter vote (the reference middle column covers the body
	// gutter, so the body columns weld and the whole two-column body's
	// translation is lost). Only when such a regime shift is actually present do
	// we switch to y-aware banded gutters; every uniform page keeps the exact
	// page-wide detectGutters vote, so its line splitting is byte-identical.
	const rowRects = rows.map(row => row.map(i => i.rect));
	// 2.6.0 (radiology2023-p3): 闸门同样喂 plainBandCount —— 表格格子把
	// detectColumns 的 x 投影焊成假单带时 (plainCollapsed),不换分带栏沟就会把
	// "Virtual monoenergetic│Images based on…" 这类相邻列的行焊成一条,后续
	// 网格化只能看到跨列碎片。行还不存在,带数用原始 span 矩形近似 —— 只作
	// 触发判据,真正的分栏证据仍是分带栏沟本身。
	const rawBands = detectColumns(items.map(i => i.rect), pageWidth, pageHeight);
	// 全局沟按分带证据限定纵向作用域 (2.6.3, fletcher2024-p5 实证): 全局投票
	// 的沟从前不限 y,整页每一行都按它切 —— 图注横贯栏沟的页上,注文行恰有
	// 词间隙落在沟 x 处就被拦腰切开("Figure 3:" 被切离注文,注文并进邻栏
	// 正文,译文注文叠印原文)。分带检测知道这条沟的真实纵向通道
	// ([433..21],图注区不在内): 有 ±20pt 对得上的分带沟就用它的跨度(同
	// 一 x 被打断成多段时逐段生效),分带没看见的沟保持不限 (老行为兜底)。
	const bandedAll = detectGuttersBanded(rowRects, pageWidth);
	const bandedActive = !!bandedColumnStamp(rowRects, pageWidth, pageHeight, rawBands.length);
	const gutters: BandedGutter[] = bandedActive
		? bandedAll
		: detectGutters(rowRects, pageWidth).flatMap((x): BandedGutter[] => {
			const matches = bandedAll.filter(g => Math.abs(g.x - x) <= 20);
			return matches.length
				? matches.map(g => ({ x, top: g.top, bottom: g.bottom, coreTop: g.coreTop, coreBottom: g.coreBottom }))
				: [{ x, top: Infinity, bottom: -Infinity }];
		});
	// 弱沟 (审核 2.6.3): 分带通道之外的行不是"这条沟不存在",而是"分带没
	// 凑够 5 行连续证据"—— 一块不足 5 行的短双栏区 (图下两栏说明、双栏作者
	// 单位) 若栏沟又窄于 columnGapThreshold (1.6em),限定作用域后就会左右焊成
	// 一行,而 2.6.3 前不限 y 的全局沟是切开它的。折中: 通道外的行只在间隙
	// ≥1.05em 时按全局沟切 —— 词间隙 (p5 "Figure 3:" 后 0.9em) 保持一行,
	// 真栏沟 (≥1.1em) 照切。
	const pageGutterXs: number[] = detectGutters(rowRects, pageWidth);
	const weakGutterXs: number[] = bandedActive ? [] : pageGutterXs;
	// 5.0 全篇样式: gutters the document's body pages agree on. One applies here
	// only when this page also finds a gutter within 15pt (it really has columns
	// there) — then it decides where the channel is, even if items reach into it
	// (3064 reference pages: right-column numbers at x 303 pushed the page's own
	// gutter centre to 306, and "5. Hoppe … 22. Devresse" welded into one line).
	const confirmedGutters = knownGutters.filter(k => pageGutterXs.some(x => Math.abs(x - k) <= 15));

	// Short multi-column bands can be outvoted by full-width figures/captions.
	// Require three nearby rows with matching gap edges, not a page-wide vote.
	const localGaps = rows.flatMap(row => {
		// 5.0 (联网校验 3384 p10, reference lists only): a justified line spreads ALL its word gaps
		// to ~1.4em. Three such rows can line up by chance and pass the 1.05em
		// test, splitting a reference entry into nine "columns". A gutter is
		// wide compared with the row's own word spacing; a justified gap is not.
		const gaps = row.slice(1).map((item, i) => item.rect[0] - row[i]!.rect[2]).filter(g => g > 0).sort((a, b) => a - b);
		const wordGap = referenceList && gaps.length >= 4 ? gaps[Math.floor(gaps.length / 2)]! : 0;
		return row.slice(1).flatMap((item, i) => {
		const prev = row[i]!;
		const size = fontSizeOf(prev) || 10;
		return Math.abs(fontSizeOf(item) - size) <= size * 0.15
			&& prev.rect[2] - row[0]!.rect[0] >= size * 8
			&& row[row.length - 1]!.rect[2] - item.rect[0] >= size * 8
			&& item.rect[0] - prev.rect[2] >= size * 1.05
			&& item.rect[0] - prev.rect[2] >= wordGap * 1.8
			? [{ left: prev.rect[2], right: item.rect[0], y: (item.rect[1] + item.rect[3]) / 2 }] : [];
		});
	});
	// Track a genuinely wide caption band, without imposing its geometry on
	// body rows or a caption printed beside another column.
	const captionRows=new Set<SpanItem[]>();
	let tail: {left:number;bottom:number;size:number}|undefined;
	for(const row of [...rows].sort((a,b)=>rectOf(b)[3]-rectOf(a)[3])) {
		const rect=rectOf(row),size=sizeOf(row),text=row.map(i=>i.text).join(' ');
		const starts=rect[2]-rect[0]>pageWidth*0.7 && /^(?:Figure|Fig\.?|Table)\s*\d+[.:]/i.test(text.trim());
		const continues=tail && Math.abs(rect[0]-tail.left)<size
			&& tail.bottom-rect[3]>=-1 && tail.bottom-rect[3]<size*0.8 && Math.abs(size-tail.size)<size*0.1;
		const separated=row.some((item,i)=>i>0 && !(i===1 && /^(?:Figure|Fig\.?|Table)\s*\d+[.:]$/i.test(row[0]!.text.trim())) && item.rect[0]-row[i-1]!.rect[2]>=size*0.8);
		if((starts || continues) && !separated) {captionRows.add(row);tail={left:rect[0],bottom:rect[1],size};}
		else tail=undefined;
	}
	const lines: SpanLine[] = [];
	for (const row of rows) {
		let rowTop = -Infinity;
		let rowBottom = Infinity;
		for (const it of row) {
			rowTop = Math.max(rowTop, it.rect[3]);
			rowBottom = Math.min(rowBottom, it.rect[1]);
		}
		const rowMid = (rowTop + rowBottom) / 2;
		// Only the gutters whose vertical channel spans this row apply (2pt
		// tolerance so a row exactly at a band edge still counts).
		const rowGutters = gutters.filter(g => rowMid <= g.top + 2 && rowMid >= g.bottom - 2);
		// 5.0 (联网校验 3384 p10): banded detection can find "gutters" in a
		// few heavily justified rows whose word gaps line up by chance. Away
		// from the page-wide gutters, a split must beat the row's own word
		// spacing clearly.
		const rowGaps = row.slice(1).map((it, i) => it.rect[0] - row[i]!.rect[2]).filter(g => g > 0).sort((a, b) => a - b);
		const rowWordGap = referenceList && rowGaps.length >= 4 ? rowGaps[Math.floor(rowGaps.length / 2)]! : 0;
		const beatsWordGap = (g: BandedGutter, gap: number): boolean => rowWordGap === 0 || pageGutterXs.some(x => Math.abs(x - g.x) <= 20) || gap >= rowWordGap * 1.8;
		let current: SpanItem[] = [];
		const flush = (): void => {
			if (current.length) {
				lines.push({ items: current, rect: rectOf(current), fontSize: sizeOf(current) });
				current = [];
			}
		};
		for (const item of row) {
			const previous = current[current.length - 1];
			if (previous) {
				const gap = item.rect[0] - previous.rect[2];
				const size = previous.fontSize || (previous.rect[3] - previous.rect[1]) || 10;
				// Slack on the LEFT of the voted gutter: a hyphenated line overhangs
				// a few points into the gutter, and requiring the line to end
				// strictly before the gutter centre let that single line bridge the
				// two columns into one scrambled line (三栏页连字符悬垂焊行).
				const slack = Math.min(6, size * 0.6);
				const crossesGutter = (gap >= size * 0.8 && confirmedGutters.some(k => previous.rect[2] <= k + slack && item.rect[0] >= k - 1))
					|| ((!captionRows.has(row) || gap >= size * 0.8) && rowGutters.some(g => crossesLineGutter(previous.rect[2], item.rect[0], g, slack, size) && beatsWordGap(g, gap)
						&& (inChannelCore(g, rowMid) || gap >= size * 0.8)
						// 校验 r24 (2795 p2): a channel only the banded vote sees, far from
						// every page-wide gutter, splits at a column-sized gap, not a word gap
						// (five sparse wide rows — a heading beside the other column — made a
						// "gutter" inside the left column of a justified page).
						&& (gap >= size * 0.8 || pageGutterXs.length === 0 || pageGutterXs.some(x => Math.abs(x - g.x) <= 20))))
					|| (gap >= size * 1.05
						&& weakGutterXs.some(x => previous.rect[2] <= x + slack && item.rect[0] >= x));
				const repeatedLocalGap = gap >= size * 1.05
					&& Math.abs(fontSizeOf(item) - size) <= size * 0.15
					&& previous.rect[2] - row[0]!.rect[0] >= size * 8
					&& row[row.length - 1]!.rect[2] - item.rect[0] >= size * 8
					&& localGaps.filter(g =>
					Math.abs(g.y - rowMid) <= size * 4
					&& Math.abs(g.left - previous.rect[2]) <= 2
					&& Math.abs(g.right - item.rect[0]) <= 2).length >= 3;
				// A wide gap in a heavily justified row is word spacing, unless it
				// spans a page-wide gutter or clearly beats the row's spacing (5.0).
				const spansPageGutter = pageGutterXs.some(x => previous.rect[2] <= x + slack && item.rect[0] >= x - slack);
				const wideGap = gap > columnGapThreshold(size) && (rowWordGap === 0 || spansPageGutter || gap >= rowWordGap * 1.8);
				if (crossesGutter || repeatedLocalGap || wideGap) {
					flush();
				}
			}
			current.push(item);
		}
		flush();
	}
	rejoinTabbedLabels(lines, referenceList);
	rejoinGlossaryRows(lines);

	// Publisher boilerplate ("This copy is for personal use only…") is dropped
	// BY CONTENT here, BEFORE the ordering pass runs its own column detection —
	// on page 1 the notice sits mid-page across the gutter where the
	// position-based furniture filter can't see it.
	const kept = lines.flatMap(l => {
  if(!isPublisherBoilerplateLine(lineText(l)))return [l];
  // A conclusion may finish with one word on the copyright baseline. Keep
  // that independently positioned word instead of dropping it with the imprint.
  const at=l.items.findIndex(i=>isPublisherBoilerplateLine(i.text));
  const prefix=at>0?l.items.slice(0,at):[];
  if(prefix.length===1 && /^[a-z][A-Za-z-]+[.!?]$/.test(prefix[0]!.text.trim()))
   return [{items:prefix,rect:rectOf(prefix),fontSize:sizeOf(prefix)}];
  return [];
 });

	// Reading order: full-width lines first (title/abstract), then column by
	// column, each top to bottom.
	const bands = detectColumns(kept.map(l => l.rect), pageWidth, pageHeight);
	const columnFor = new Map<SpanLine, number>();
	for (const line of kept) {
		columnFor.set(line, columnOf(line.rect, bands, pageWidth));
	}
	kept.sort((a, b) => {
		const ca = columnFor.get(a)!;
		const cb = columnFor.get(b)!;
		return ca !== cb ? ca - cb : (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]);
	});
	return kept;
}

export const TABBED_LABEL = /^(?:\(?\d{1,3}[.)]|\[\d{1,3}\]|[•▪●◦–-])$/;

/**
 * 5.0 (推荐模型校验 2721): a manuscript list written "13.⇥Feuchtner G, …" puts
 * a tab of ~1.75em after the number, which the column-gap rule splits off.
 * The label then joined the entry ABOVE. When the entry's next lines return
 * to the label's left edge (not the text's), the label and text are one
 * line; a real label column would have its continuation under the text.
 */
export function rejoinTabbedLabels(lines: SpanLine[], referenceList = false): void {
	for (let i = 0; i < lines.length; i++) {
		const label = lines[i]!;
		if (label.items.length !== 1 || !TABBED_LABEL.test(label.items[0]!.text.trim())) continue;
		const size = label.fontSize || 10;
		if (label.rect[2] - label.rect[0] > size * 2.5) continue;
		const sameRow = (l: SpanLine): boolean => Math.abs(l.rect[3] - label.rect[3]) <= size * 0.3 && Math.abs(l.rect[1] - label.rect[1]) <= size * 0.3;
		const textIndex = lines.findIndex((l, j) => j !== i && sameRow(l) && l.rect[0] > label.rect[2]
			&& l.rect[0] - label.rect[2] <= size * 4 && Math.abs(l.fontSize - size) <= size * 0.15
			&& !lines.some(m => m !== l && m !== label && sameRow(m) && m.rect[0] > label.rect[2] && m.rect[0] < l.rect[0]));
		if (textIndex < 0) continue;
		const text = lines[textIndex]!;
		const below = (l: SpanLine): boolean => l.rect[3] < label.rect[1] && label.rect[1] - l.rect[3] <= size * 2.6 && Math.abs(l.fontSize - size) <= size * 0.15;
		const underLabel = lines.some(l => below(l) && Math.abs(l.rect[0] - label.rect[0]) <= 1.5 && l.rect[2] > text.rect[0] + size * 4);
		const underText = lines.some(l => below(l) && Math.abs(l.rect[0] - text.rect[0]) <= 1.5);
		// 5.0 (校验 r22, 3036 p5 / 3322 p11): on a reference list a label column
		// with the continuation under the TEXT is a hanging indent — the label
		// still belongs to the text on its own row. Left apart, the bare "13."
		// joined the column above as a block of its own and the unlabelled
		// entries welded in pairs.
		if (!referenceList && (!underLabel || underText)) continue;
		const items = [...label.items, ...text.items];
		lines[i] = { items, rect: rectOf(items), fontSize: sizeOf(items) };
		lines.splice(textIndex, 1);
		if (textIndex < i) i--;
	}
}

/**
 * 校验 r23 (3276 p7): an abbreviation list sets the term and its expansion
 * in two aligned columns ("CI │ Confidence interval"). Each row is one entry;
 * split, the terms and expansions were stacked as two lists and a narrow gap
 * ("PCCT Photon counting CT") welded one row into the stack above. At least
 * three rows whose terms share a left edge and whose expansions share another.
 */
export const GLOSSARY_TERM = /^[A-Z][A-Za-z0-9\-/]{0,7}$/;

/** Lines that are one entry of a list each (glossary rows): never welded to a neighbour. */
export const ENTRY_LINES = new WeakSet<SpanLine>();

export function rejoinGlossaryRows(lines: SpanLine[]): void {
	const terms = lines.filter(l => GLOSSARY_TERM.test(lineText(l).trim()) && (lineText(l).match(/[A-Z]/g) ?? []).length >= 2);
	const size = (l: SpanLine): number => l.fontSize || 10;
	const sameRow = (a: SpanLine, b: SpanLine): boolean => Math.abs(a.rect[1] - b.rect[1]) <= size(a) * 0.3 && Math.abs(a.rect[3] - b.rect[3]) <= size(a) * 0.3;
	const pairs: Array<[SpanLine, SpanLine]> = [];
	for (const term of terms) {
		// The row holds exactly the term and a worded expansion — a table row has
		// more cells, or numbers beside its label.
		// (Lines left of the term are another column.)
		const row = lines.filter(l => l !== term && sameRow(l, term) && l.rect[0] > term.rect[2] - 1).sort((a, b) => a.rect[0] - b.rect[0]);
		const right = row[0] && !(row[1] && row[1].rect[0] - row[0].rect[2] <= size(term) * 6) ? row[0] : undefined;
		if (right && right.rect[0] > term.rect[2] && right.rect[0] - term.rect[2] <= size(term) * 6
			&& Math.abs(right.fontSize - term.fontSize) <= size(term) * 0.15
			&& /^\p{L}[\p{L}'’\-]*(?:\s+\p{L}[\p{L}'’\-]*)*$/u.test(lineText(right).trim()) && /\p{Ll}{3}/u.test(lineText(right))) pairs.push([term, right]);
	}
	const joined = new Set<SpanLine>();
	for (const [term, right] of pairs) {
		const aligned = pairs.filter(([t, r]) => Math.abs(t.rect[0] - term.rect[0]) <= 1.5 && Math.abs(r.rect[0] - right.rect[0]) <= 1.5
			&& Math.abs(t.rect[1] - term.rect[1]) <= size(term) * 8);
		if (aligned.length < 3) continue;
		const i = lines.indexOf(term);
		const j = lines.indexOf(right);
		if (i < 0 || j < 0 || joined.has(term)) continue;
		const items = [...term.items, ...right.items];
		const line = { items, rect: rectOf(items), fontSize: sizeOf(items) };
		ENTRY_LINES.add(line);
		joined.add(term);
		lines[i] = line;
		lines.splice(j, 1);
	}
}

/** Join the runs of a line into text, inserting spaces where there are gaps. */
/**
 * 5.1: a line set entirely in bold — the letters, not the punctuation or a
 * section number, decide ("4. Discussion" has a bold "4." too, but a regular
 * "2." before a bold word still counts). Undefined weights read as regular.
 */
export function lineIsBold(line: SpanLine): boolean {
	let bold = 0, regular = 0;
	for (const it of line.items) {
		const letters = it.text.replace(/[^\p{L}]/gu, '').length;
		if (it.bold) bold += letters; else regular += letters;
	}
	return bold >= 3 && regular <= bold * 0.05;
}

export function lineText(line: SpanLine): string {
	return joinSemanticSpans(line.items, {fontSize: line.fontSize, spaceThreshold: .18});
}
