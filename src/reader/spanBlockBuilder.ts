/**
 * Build SourceBlocks from positioned text items (the PDF.js text layer).
 *
 * This is the robust extraction path: the text layer is ordinary DOM in the
 * PDF iframe, so it is readable from the plugin sandbox without any Xray /
 * wrapper concerns, and it is exactly the text the user can select with the
 * mouse. It carries no paragraph-break flags, so structure is inferred from
 * geometry.
 *
 * Order of operations matters, and getting it wrong is what produced scrambled
 * text before:
 *
 *   1. rows   — items sharing a baseline, WITHOUT any horizontal constraint
 *   2. gutters— vertical whitespace channels, voted on across all wide rows
 *               (a full-width title covers the gutter, so no single row can
 *               reveal it; the body rows outvote the title)
 *   3. lines  — each row split at the gutters, so a left-column line is never
 *               concatenated with the right-column line beside it
 *   4. paragraphs — merged within a column, with a wrapped-line guard so a
 *               sentence is not cut where the text simply reached the margin
 *
 * Pure module — no DOM, no Zotero APIs.
 */

import type { BlockType, SourceBlock } from '../types/models';
import { detectTableRegions } from './tableGuard';
import { insideObstacle, obstacleBetween } from './figureBarriers';
import { endsMidSentence, isMetadataBlock, isPublisherBoilerplateLine, isRunningHeadOrFoot } from './metaFilter';
import {
	columnOf,
	detectColumns,
	detectGutters,
	detectGuttersBanded,
	bandedColumnStamp,
	dominantFontSize,
	replacementFontSize,
	joinFragments,
	joinLines,
	hasLeaderDots,
	startsContinuation,
	linesShareColumn,
	looksLikeListStart,
	looksLikeListBlock,
	isOrderedListStart,
	isSectionNumberHeading,
	planMerges,
	reachesRightMargin,
	shouldBreak,
	type BandedGutter,
	type ColumnBand,
	type Rect
} from './paragraphHeuristics';

/** One text run with its rect in PDF coordinates [x1, y1, x2, y2] (y up). */
export interface SpanItem {
	text: string;
	rect: Rect;
	fontSize?: number;
}

export interface SpanLine {
	items: SpanItem[];
	rect: Rect;
	fontSize: number;
}

const REFERENCES_HEADINGS = /^(references|bibliography|literature\s+cited|参考文献|參考文獻|引用文献)\s*$/i;

/**
 * Fallback column split when there are too few rows for the gutter vote: any
 * horizontal gap this large inside one baseline is a column boundary, not a
 * word space (an inter-word space never exceeds ~1em, even when justified).
 */
function columnGapThreshold(fontSize: number): number {
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

function union(a: Rect, b: Rect): Rect {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function rectOf(items: SpanItem[]): Rect {
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
const FONT_JUMP_RATIO = 0.2;

function sizeOf(items: SpanItem[]): number {
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

/** Step 1: items sharing a baseline band, left to right. No x constraint. */
/** 同基线的 run 成行 —— 导出仅为可测性 (2.4.9): 白槽投票在这一层做,
 * 切分后的 SpanLine 已经看不到「一行横跨两栏」,拿它做探针必然测不出东西。 */
/**
 * 该行是否由一个「下沉首字」领起 —— 行内最高的 item 只有 1–2 个字符,
 * 绝对高度 ≥ 18pt,且比来客高出 1.8 倍以上。
 */
function hasDropCapLead(
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
function fontSizeOf(item: SpanItem): number {
	const s = item.fontSize ?? (item.rect[3] - item.rect[1]);
	return Number.isFinite(s) && s > 0 ? s : 0;
}

/** 行的代表字号 = 行内最大的那个,用来认出比它明显小的上下标。 */
function rowFontSize(row: { items: SpanItem[] }): number {
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
		const w = i.rect[2] - i.rect[0];
		const h = i.rect[3] - i.rect[1];
		if (i.text.trim().length >= 2 && h > w * 3) {
			return false;
		}
		return true;
	});
	if (!usable.length) {
		return [];
	}
	const sorted = [...usable].sort((a, b) => (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]));
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
export function groupIntoLines(items: SpanItem[], pageWidth = 612, pageHeight = 0): SpanLine[] {
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
	const gutters: BandedGutter[] = bandedColumnStamp(rowRects, pageWidth, pageHeight)
		? detectGuttersBanded(rowRects, pageWidth)
		: detectGutters(rowRects, pageWidth).map(x => ({ x, top: Infinity, bottom: -Infinity }));

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
				const crossesGutter = rowGutters.some(g => previous.rect[2] <= g.x + slack && item.rect[0] >= g.x);
				if (crossesGutter || gap > columnGapThreshold(size)) {
					flush();
				}
			}
			current.push(item);
		}
		flush();
	}

	// Publisher boilerplate ("This copy is for personal use only…") is dropped
	// BY CONTENT here, BEFORE the ordering pass runs its own column detection —
	// on page 1 the notice sits mid-page across the gutter where the
	// position-based furniture filter can't see it.
	const kept = lines.filter(l => !isPublisherBoilerplateLine(lineText(l)));

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

/** Join the runs of a line into text, inserting spaces where there are gaps. */
export function lineText(line: SpanLine): string {
	let out = '';
	let previousRight: number | null = null;
	for (const item of line.items) {
		const text = item.text;
		if (previousRight !== null) {
			const gap = item.rect[0] - previousRight;
			const isCJKJoin = /[一-鿿]$/.test(out) && /^[一-鿿]/.test(text);
			if (gap > (line.fontSize || 10) * 0.18 && !/\s$/.test(out) && !isCJKJoin) {
				out += ' ';
			}
		}
		out += text;
		previousRight = item.rect[2];
	}
	return out.replace(/\s+/g, ' ').trim();
}

/**
 * Merge consecutive lines into paragraphs.
 *
 * Every geometric break signal is filtered through shouldBreak(), which
 * refuses to end a paragraph after a line that ran to its column's right
 * margin — that line wrapped, so the sentence continues on the next one.
 */
export function groupIntoParagraphs(lines: SpanLine[], pageWidth = 612, pageHeight = 0, obstacles: Rect[] = []): SpanLine[][] {
	if (!lines.length) {
		return [];
	}
	const bands = detectColumns(lines.map(l => l.rect), pageWidth, pageHeight);
	const columns = lines.map(l => columnOf(l.rect, bands, pageWidth));
	let textLeft = Infinity;
	let textRight = -Infinity;
	for (const line of lines) {
		textLeft = Math.min(textLeft, line.rect[0]);
		textRight = Math.max(textRight, line.rect[2]);
	}
	const marginOf = (index: number): ColumnBand => {
		const column = columns[index]!;
		const band = column >= 0 ? bands[column] : undefined;
		return band ?? {
			left: Number.isFinite(textLeft) ? textLeft : 0,
			right: Number.isFinite(textRight) ? textRight : pageWidth
		};
	};

	// 中位行宽 (BabelDOC ParagraphFinding): 短行分段基准。
	const widths = lines.map(l => l.rect[2] - l.rect[0]).filter(w => w > 0).sort((a, b) => a - b);
	const medianLineWidth = widths.length ? widths[Math.floor(widths.length / 2)]! : 0;

	const paragraphs: SpanLine[][] = [];
	let current: SpanLine[] = [];
	const flush = (): void => {
		if (current.length) {
			paragraphs.push(current);
			current = [];
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		current.push(line);
		const next = lines[i + 1];
		if (!next) {
			break;
		}
		// 边框硬屏障: a figure between two lines separates layout regions.
		if (obstacleBetween(line.rect, next.rect, obstacles)) {
			flush();
			continue;
		}
		const size = line.fontSize > 0 ? line.fontSize : 10;
		const margins = marginOf(i);
		const brk = shouldBreak({
			fontSize: size,
			gap: line.rect[1] - next.rect[3],
			wrapped: reachesRightMargin(line.rect, margins.right, size),
			// Column continuity is decided by GEOMETRY, not the band index. On a
			// narrow two-column page the column detector flips a line's index
			// from one row to the next; trusting that index cut paragraphs into
			// one-line blocks (each then translated alone and half of them left
			// in English). Two stacked lines that share an x-range are the same
			// column whatever the index said; lines in different columns never
			// share an x-range, so this can't interleave the two columns either.
			newColumn: next.rect[3] > line.rect[3] + size
				|| !linesShareColumn(line.rect, next.rect),
			indented: next.rect[0] > margins.left + size * 0.8,
			fontJump: size > 0 && next.fontSize > 0 && Math.abs(next.fontSize - size) / size >= FONT_JUMP_RATIO,
			listStart: looksLikeListStart(lineText(next)),
			shortLine: medianLineWidth > 0
				&& (line.rect[2] - line.rect[0]) < medianLineWidth * 0.7
				&& !startsContinuation(lineText(next)),
			leaderDots: hasLeaderDots(lineText(line))
		});
		if (brk) {
			flush();
		}
	}
	flush();
	return paragraphs;
}

/**
 * A block that is ONLY a figure label — "Figure 6:", "Fig. 2.", "图 3" —
 * with the caption text torn into the next block.
 */
export function isBareFigureLabel(text: string): boolean {
	return /^(figure|fig\.?|图)\s*\d+\s*[.:：]?\s*$/i.test(text.trim());
}

function classify(text: string, fontSize: number, bodySize: number, lineCount: number, lines: string[] = [], isTableLine = false): BlockType {
	if (/^(figure|fig\.?|table|图|表|圖)\s*\d+/i.test(text)) {
		return /^(table|表)/i.test(text) ? 'table' : 'caption';
	}
	const ratio = bodySize > 0 ? fontSize / bodySize : 1;
	// Bullet lists are always lists; a single-level numbered item ("1." "2)"
	// "10.") is a list ONLY at body font size — a larger "3. Model Architecture"
	// is a section heading, so it falls through to the heading test below. This is
	// what keeps a page-foot numbered list from being read as a big heading while
	// still recognising numbered section headings.
	if ((looksLikeListStart(text) && /^[•▪◦‣·*–—-]\s/.test(text.trim()))
		|| (isOrderedListStart(text) && ratio < 1.1)) {
		return 'list';
	}
	// 块级列表/目录判定 (2.4.4, 移植自 MinerU `__is_list_or_index_block`): 上面
	// 两条只看块**开头**那一行 —— 多个条目被黏成一个块时,后续条目的标记都在
	// 块中间,看不见。这条改看**行的分布**,把黏成一团的参考文献/条目列表/目录
	// 认回列表,从而不再被 planMerges 并进相邻正文段。排在 title/heading 之前:
	// 三行各自以句号收尾的块是条目列表,不是标题,即便它的字号偏大。
	if (looksLikeListBlock(lines)) {
		return 'list';
	}
	// A title is a large, short block — but it WRAPS. "Virtual Noncalcium
	// Dual-Energy CT: Detection of Lumbar Disk Herniation in Comparison with
	// Standard Gray-Scale CT" is 3 lines at 2× body; the old `lineCount <= 2`
	// gate dropped it to `paragraph`, so the strict page rendered it at body
	// anchor size, un-bold — the translated title looked missing. The strong
	// ratio (≥1.35) + short length (<250) still pin it to a real title; only
	// the wrap tolerance widens (a large multi-line BODY block would exceed
	// 250 chars long before 4 lines).
	if (lineCount <= 4 && ratio >= 1.35 && text.length < 250) {
		return 'title';
	}
	// The ratio arm below must not promote prose: a body line that merely runs
	// slightly larger than the page's front matter would qualify. A run that
	// BEGINS mid-sentence (lowercase) or ENDS mid-sentence (explicit
	// hyphenation, or a trailing comma) is a prose continuation, never a
	// heading. NOT applied to the title arm above: a real wrapped title splits
	// into fragments that can end with a hyphen ("… Pediatric Photon-") or
	// begin lowercase ("counting CT").
	//
	// 长度上限 160 → 70 (2.4.7, 由 jacc-ccta2020-p1 语料实证): ratio ≥ 1.1 这条
	// 门槛在**字号种类多的封面页**上会连环误判 —— 该页 6.0pt 的单位/披露声明有
	// 26 行、7.5pt 的摘要只有 17 行,于是 dominantFontSize 把 bodySize 判成 6.0pt,
	// 摘要行 ratio = 1.249 越过 1.1,整段摘要被切成「heading + 正文 + heading +
	// heading」四块。真 heading 是**短标签**:全语料 22 个 heading 中位 16 字、
	// 除这两处误判外最长 42 字,而误判的是 108/112 字的摘要行 —— 43~107 之间
	// 是一条干净的空隙,70 落在正中,两侧余量都充足。收紧后该页摘要合并回一整块,
	// 其余 12 页语料快照零改动。
	const proseContinuation = /^[a-z]/.test(text.trim()) || /[-,]$/.test(text.trim());
	if (lineCount <= 2 && text.length < 70
		&& ((ratio >= 1.1 && !proseContinuation)
			|| isSectionNumberHeading(text)
			|| /^(abstract|introduction|methods?|results|discussion|conclusions?|references|摘要|引言|方法|结果|讨论|结论)\s*$/i.test(text))) {
		return 'heading';
	}
	// 与正文同号的加粗小节标题 (2.5.5, chen2023-p3/p6 实证)。文本层只给
	// text/rect/fontSize —— **看不见 bold**,于是「Model Prognosis Assessment
	// (Study 2)」「Study Sample Characteristics」这类 10pt 加粗小节标题全部落成
	// paragraph,随后被 coalesceRegions 并进邻段,整节结构在译文页上消失
	// (第 6 页最终只剩 3 块)。字号帮不上忙,只能靠排印形态:自成一行、短、
	// 不以句读收尾、每个实词都大写。
	if (!isTableLine && lineCount === 1 && ratio >= 0.95 && ratio <= 1.25
		&& looksLikeTitleCaseHeading(text)) {
		return 'heading';
	}
	return 'paragraph';
}

/** 标题式排印: 短、无句读收尾、无逗号、每个实词首字母大写。 */
function looksLikeTitleCaseHeading(text: string): boolean {
	const t = text.trim();
	// 长度上限与既有 heading 臂一致;逗号是关键的排除项 —— 作者行
	// (「Qian Chen, MD*」)同样满足"实词全大写",但它带逗号,而小节标题几乎
	// 不带。heading 是元数据过滤的豁免类型,误判会把作者名单放回正文。
	if (t.length < 4 || t.length > 60 || /[,，]/.test(t)) {
		return false;
	}
	if (/[.。;；:：?!？!]$/.test(t)) {
		return false;
	}
	// 停在虚词上的行是没说完的句子,不是标题 —— 复用 2.5.1 的行尾判据。
	// 「Dr. Valentin Fuster on」「Odds Ratio or」都是被版面截断的碎片,
	// 实词确实全大写,却绝不是小节标题。
	if (endsMidSentence(t)) {
		return false;
	}
	const words = t.split(/\s+/).filter(w => /[A-Za-z]/.test(w));
	if (words.length < 2 || words.length > 8) {
		return false;
	}
	// 虚词不参与判定 ——「Study Design and Sample」里的 and 本就该小写。
	const MINOR = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with', 'vs', 'versus', 'per', 'by', 'from']);
	let significant = 0;
	let capitalised = 0;
	for (const w of words) {
		const bare = w.replace(/^[^A-Za-z]+/, '');
		if (!bare || MINOR.has(bare.toLowerCase())) {
			continue;
		}
		significant++;
		if (/^[A-Z]/.test(bare)) {
			capitalised++;
		}
	}
	// 全部实词都大写才算 —— 放宽到"多数"会把「Clinical presentation」「Risk
	// factor」这类表格行标签一并卷进来。
	return significant >= 2 && capitalised === significant;
}

export interface SpanBuildOptions {
	pageIndex: number;
	pageHeight: number;
	/** 边框硬屏障: figure rects — in-figure labels dropped, no merges across. */
	imageRectsPdf?: Rect[];
	pageWidth?: number;
	includeReferences?: boolean;
	referencesAlreadyStarted?: boolean;
}

export interface SpanBuildResult {
	blocks: SourceBlock[];
	referencesStarted: boolean;
}

/**
 * Which line indices fall inside a detected table region (1.2.0). Runs the same
 * geometric table detector used downstream, but at the LINE level — before prose
 * paragraph grouping welds the grid — so those lines can be held out and gridded
 * cleanly. Conservative by construction: detectTableRegions needs ≥4 aligned
 * numeric-dense cells (or a Table caption), so a prose page yields an empty set
 * and the whole reorder is inert.
 */
function detectTableLineIndices(lines: SpanLine[], pageHeight: number, em: number, obstaclesPdf: Rect[] = []): Set<number> {
	const out = new Set<number>();
	if (lines.length < 6) {
		return out;
	}
	const items = lines.map((l, i) => ({
		id: String(i),
		text: lineText(l),
		type: 'paragraph' as const,
		box: { left: l.rect[0], top: pageHeight - l.rect[3], width: l.rect[2] - l.rect[0], height: l.rect[3] - l.rect[1] },
		fontSize: l.fontSize
	}));
	// 图片矩形转 top-down 后作为列合并的硬屏障 (1.2.2): 两个数值簇之间隔着一张
	// 图,就绝不是同一张表的相邻列。
	const obstacleBoxes = obstaclesPdf.map(r => ({
		left: r[0], top: pageHeight - r[3], width: r[2] - r[0], height: r[3] - r[1]
	}));
	const guard = detectTableRegions(items, em, obstacleBoxes);
	if (!guard.regions.length) {
		return out;
	}
	for (const id of guard.excluded) {
		const n = Number(id);
		if (Number.isInteger(n)) {
			out.add(n);
		}
	}
	return out;
}

export function buildBlocksFromSpans(items: SpanItem[], options: SpanBuildOptions): SpanBuildResult {
	const pageWidth = options.pageWidth && options.pageWidth > 0 ? options.pageWidth : 612;
	const obstacles = options.imageRectsPdf ?? [];
	const filteredItems = obstacles.length
		? items.filter(i => !insideObstacle(i.rect, obstacles))
		: items;
	const lines = groupIntoLines(filteredItems, pageWidth, options.pageHeight);

	// 页面正文字号 = 行字号的众数,不是中位数 (1.2.5)。封面页的前置件
	// (7pt 作者单位 17 行 + 8.5pt 摘要 18 行) 在行数上压过 10pt 正文 (28 行),
	// 中位数落在 8.5 —— 于是每一行 10pt 正文 ratio=1.176 ≥ 1.1 全部被判成
	// heading,逐行走 heading 通道后大面积 unrecovered,译文页整栏保留英文。
	// 众数(0.5pt 桶、平票取大)正确取到 10。
	const bodySize = pageBodySize(lines);

	// 表格行先摘出去 (1.2.0): 数值表的行/列本是网格,但 groupIntoParagraphs 是给
	// 散文设计的 —— 它把标签列跨行黏成一堵墙、把数字列纵向并块,等 structureTableCells
	// 拿到时网格早已被毁 (NEJM「Clinical and Imaging Outcomes」的标签列坍成一块
	// 443 字符、数字列碎成两行小表)。所以先在「行」这一层探出表格区域,把落在表格
	// 里的行整条摘出散文分组,各自成一行块,交给下游 structureTableCells 重新组网格
	// (标签列作 tableCol=0)。非表格页探不到区域 → 摘出集为空 → 行为与从前逐字节
	// 一致,不影响任何非表格版面。
	const tableLineIdx = detectTableLineIndices(lines, options.pageHeight, Math.max(6, bodySize || 10), obstacles);
	const proseLines = tableLineIdx.size ? lines.filter((_, i) => !tableLineIdx.has(i)) : lines;
	const paragraphs = groupIntoParagraphs(proseLines, pageWidth, options.pageHeight, obstacles);

	// Materialise, then repair anything still split mid-sentence.
	const bands = detectColumns(lines.map(l => l.rect), pageWidth, options.pageHeight);
	const draft = paragraphs.map((group) => {
		// joinLines de-hyphenates line-broken words (ional/est/sory residue) and
		// joins CJK without spaces, instead of the naive space-join that left the
		// broken-word fragments in the source text.
		const text = joinLines(group.map(lineText));
		let rect = group[0]!.rect;
		for (const l of group) {
			rect = union(rect, l.rect);
		}
		// Representative size = the MODE of the paragraph's line sizes, not the
		// first line's: line one may carry a drop cap, a superscript-heavy
		// span, or a heading-styled lead-in, and using it skewed the whole
		// block's translated type size.
		const repSize = dominantFontSize(group.map(l => l.fontSize)) || group[0]!.fontSize;
		const type = classify(text, repSize, bodySize, group.length, group.map(lineText));
		// Body text is typeset at the MINIMUM of its own body cluster (drop
		// caps and superscripts excluded); headings keep the dominant size.
		const fontSize = (type === 'paragraph' || type === 'list' || type === 'caption')
			? (replacementFontSize(group.map(l => l.fontSize)) || repSize)
			: repSize;
		return {
			group,
			text,
			rect,
			column: columnOf(rect, bands, pageWidth),
			type,
			fontSize,
			gapAfter: undefined as number | undefined,
			isTableLine: false
		};
	}).filter(p => p.text.length >= 2);
	for (let i = 0; i < draft.length - 1; i++) {
		draft[i]!.gapAfter = draft[i]!.rect[1] - draft[i + 1]!.rect[3];
	}

	const merged = planMerges(draft).map((indexes) => {
		const members = indexes.map(i => draft[i]!);
		const head = members[0]!;
		let rect = head.rect;
		let text = '';
		const group: SpanLine[] = [];
		for (const p of members) {
			rect = union(rect, p.rect);
			text = joinFragments(text, p.text);
			group.push(...p.group);
		}
		// A merge must re-derive its representative size from ALL member lines
		// — inheriting the head's alone re-introduces the first-line skew.
		const sizes = group.map(l => l.fontSize);
		const fontSize = (head.type === 'paragraph' || head.type === 'list' || head.type === 'caption')
			? (replacementFontSize(sizes) || head.fontSize)
			: (dominantFontSize(sizes) || head.fontSize);
		return { ...head, rect, text, group, fontSize };
	});

	// Caption label reunification. PDF.js frequently tears "Figure 6:" off
	// its caption text: the label alone classifies as a caption, and the
	// description behind it degrades to ordinary body text (translated and
	// re-flowed away from its figure) while the tiny English label survives
	// untouched. A bare label merges with the block that follows it in the
	// same column, and the union is a caption.
	for (let i = merged.length - 2; i >= 0; i--) {
		const label = merged[i]!;
		const rest = merged[i + 1]!;
		if (!isBareFigureLabel(label.text)) {
			continue;
		}
		const vGap = label.rect[1] - rest.rect[3];
		const hOverlap = Math.min(label.rect[2], rest.rect[2]) - Math.max(label.rect[0], rest.rect[0]);
		const em = Math.max(label.fontSize, 6);
		if (vGap > em * 1.6 || vGap < -em * 1.2 || hOverlap < -em) {
			continue;
		}
		const rect = union(label.rect, rest.rect);
		const group = [...label.group, ...rest.group];
		merged.splice(i, 2, {
			...label,
			rect,
			text: joinFragments(label.text, rest.text),
			group,
			type: 'caption',
			fontSize: replacementFontSize(group.map(l => l.fontSize)) || rest.fontSize
		});
	}

	// Table lines rejoin here as one-line blocks (never through prose grouping,
	// planMerges or caption reunification), so structureTableCells sees a clean
	// per-cell grid — labels included — instead of a collapsed wall.
	const tableParas = [...tableLineIdx].sort((a, b) => a - b).map((i) => {
		const line = lines[i]!;
		const text = joinLines([lineText(line)]);
		const type = classify(text, line.fontSize, bodySize, 1, [lineText(line)], true);
		const fontSize = (type === 'paragraph' || type === 'list' || type === 'caption')
			? (replacementFontSize([line.fontSize]) || line.fontSize)
			: line.fontSize;
		return {
			group: [line],
			text,
			rect: line.rect,
			column: columnOf(line.rect, bands, pageWidth),
			type,
			fontSize,
			gapAfter: undefined as number | undefined,
			isTableLine: true
		};
	}).filter(p => p.text.length >= 1);

	let referencesStarted = !!options.referencesAlreadyStarted;
	// Column stamp (was MISSING on this path): without it every text-layer
	// block defaulted to column 0 downstream, so semantic modules ran straight
	// through the gutter and the same PDF extracted differently depending on
	// which extraction path won.
	// LINE rects, not merged paragraph rects: a page yields only a handful of
	// paragraphs — too few for the anti-weld coverage vote — and one paragraph
	// whose union rect overhangs the gutter re-welds two columns at the stamping
	// step even after line-level detection got them right (三栏首页回归).
	const columnBands = detectColumns(lines.map(l => l.rect), pageWidth, options.pageHeight);
	// 分带栏归属 (2.5.10): non-null only when the column count changes down the
	// page (2-col body over 3-col references). On every uniform page it is null
	// and the detectColumns/columnOf path below is used unchanged. Fed with the
	// PRE-SPLIT rows (glyph rects per baseline) — the banded gutter vote needs
	// the full-width rows, which the already-column-split `lines` no longer are.
	const bandedStamp = bandedColumnStamp(
		groupIntoRows(filteredItems).map(row => row.map(i => i.rect)),
		pageWidth,
		options.pageHeight
	);
	const stampColumn = (rect: Rect, isTableLine: boolean): number =>
		bandedStamp && !isTableLine ? bandedStamp(rect) : columnOf(rect, columnBands, pageWidth);
	const blocks: SourceBlock[] = [];
	let order = 0;
	for (const p of [...merged, ...tableParas]) {
		// Table-line blocks bypass the prose furniture filters: a detected table
		// cell is content, never a running head / metadata, and the numeric cells
		// that look furniture-ish must survive to be gridded. The REFERENCES
		// exclusion however applies to them too (1.2.2, 审核项): tableParas are
		// appended after the merged loop, so `referencesStarted` here is the
		// page's final state — on a references(-continuation) page the citation
		// years/numbers must not sneak back in as "table cells" when the user
		// excluded references. Edge case documented: a genuine table ABOVE a
		// same-page References heading is also skipped — it stays untranslated
		// in the original layout, which errs conservative.
		if (p.isTableLine) {
			if (referencesStarted && !options.includeReferences) {
				continue;
			}
		}
		else {
			// 图表说明豁免元数据过滤 (2.5.4, chen2023-p3 语料实证): 图 1 说明整段
			// 消失 —— 这篇的队列名就是医院名(「Huaian set = Affiliated Huaian
			// No. 1 People's Hospital of Nanjing Medical University set; PUMCH
			// set = Peking Union Medical College Hospital set」),looksLikeAffiliation
			// 数到 ≥2 个机构词 + ≥3 个逗号就判作者单位,连同全部缩写定义一起丢掉。
			// caption/table 这两个类型只由「Figure N/Table N」开头产生 —— 那是
			// 内容的自证,作者单位块永远不会这样起头,所以按 title/heading 一样豁免。
			const isFigureOrTableCaption = p.type === 'caption' || p.type === 'table';
			if (p.type !== 'title' && p.type !== 'heading' && !isFigureOrTableCaption
				&& isMetadataBlock(p.text, p.rect, pageWidth, { fontSize: p.fontSize, bodySize })) {
				continue;
			}
			// Running heads and page-foot lines repeat the journal's furniture on
			// every page. Translating them is pure noise. `title` is exempt: on a
			// cover page with no masthead the paper's own title can sit inside the
			// band, and losing it is far worse than translating one running head.
			if (p.type !== 'title' && isRunningHeadOrFoot(p.rect, options.pageHeight, p.group.length, p.text)) {
				continue;
			}
			if ((p.type === 'heading' || p.type === 'title') && REFERENCES_HEADINGS.test(p.text)) {
				referencesStarted = true;
			}
		}
		// 不译参考文献时保留为 preserve 块 (2.0.8, 审核 P2-5),与 blockBuilder
		// 同规则: 墨迹几何要进 inkObstacles,丢弃即失明。
		const isRef = p.isTableLine ? false : referencesStarted;
		const preserveReference = isRef && !options.includeReferences && !REFERENCES_HEADINGS.test(p.text);
		blocks.push({
			id: `page-${options.pageIndex}-block-${order}`,
			pageIndex: options.pageIndex,
			order,
			type: p.type,
			sourceText: p.text,
			boundingBox: {
				x: p.rect[0],
				y: options.pageHeight - p.rect[3],
				width: p.rect[2] - p.rect[0],
				height: p.rect[3] - p.rect[1]
			},
			lineRectsPdf: p.group.map(l => [...l.rect] as Rect),
			fontSize: p.fontSize,
			column: stampColumn(p.rect, !!p.isTableLine),
			isReference: isRef,
			...(preserveReference ? { translationMode: 'preserve' as const } : {})
		});
		order++;
	}
	return { blocks, referencesStarted };
}
