/**
 * Lines to paragraphs (step 4 of spanBlockBuilder): the paragraph break
 * decision with its context, block classification (heading, list, caption…),
 * contact stacks, entry numbers and table-grid cell stacks.
 *
 * Split out of spanBlockBuilder.ts in 5.1 without changing behaviour.
 * Pure module — no DOM, no Zotero APIs.
 */
import { isReferenceTailLine, isIndexLocatorLine, startsReferenceEntry, startsUnnumberedEntry } from './referenceDetect';
import { semanticBoundary } from './semanticBoundary';
import type { BlockType } from '../types/models';
import type { BorderGrid } from './tableBorders';
import { obstacleBetween } from './figureBarriers';
import { isFooterDate, isJournalFurniture, endsMidSentence } from './metaFilter';
import {
	columnOf,
	detectColumns,
	hasLeaderDots,
	startsContinuation,
	linesShareColumn,
	looksLikeListStart,
	looksLikeListBlock,
	isOrderedListStart,
	isSectionNumberHeading,
	reachesRightMargin,
	shouldBreak,
	type ColumnBand,
	type Rect
} from './paragraphHeuristics';
import { ENTRY_LINES, FONT_JUMP_RATIO, type SpanLine, lineIsBold, lineText } from './spanLines';

export const HAS_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/;

/**
 * Merge consecutive lines into paragraphs.
 *
 * Every geometric break signal is filtered through shouldBreak(), which
 * refuses to end a paragraph after a line that ran to its column's right
 * margin — that line wrapped, so the sentence continues on the next one.
 */
/** 5.0: a line that ends the way a reference entry ends — year, volume:pages, DOI, URL, PubMed tag. */
export const ENTRY_END = /(?:\b(?:19|20)\d{2}[a-z]?\)?|\d+\s*[-–]\s*[eE]?\d+|\d+:\s*[eE]?\d+[A-Z]?|doi:\s*\S+|https?:\/\/\S+|\[PubMed[^\]]*\]|PMID:?\s*\d+)\s*\.?\s*$/;

/** "Weifeng Han" / "Mary-Jo O'Neil" — two to four capitalised words, nothing else. */
export const PERSON_NAME_LINE = /^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}$/u;

export const BARE_EMAIL_LINE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;

/** Directly below, left-aligned, at most a line gap apart. */
export function lineStacksOver(a: SpanLine, b: SpanLine): boolean {
	const size = a.fontSize > 0 ? a.fontSize : 10;
	const gap = a.rect[1] - b.rect[3];
	return gap >= -size * 0.3 && gap < size * 0.8 && Math.abs(a.rect[0] - b.rect[0]) <= size * 0.5;
}

/**
 * 5.0 第 5 步 (wu2026-p1): a contact record set as a name over its e-mail
 * address is one item. Two contact columns side by side interleave in line
 * order, so the pair is never adjacent there; the name broke off alone
 * ("Weifeng Han", open to transliteration) and whether the two were rejoined
 * hung on a table guess elsewhere on the page. Join them by geometry.
 */
export function joinContactStacks(paragraphs: SpanLine[][]): SpanLine[][] {
	const out = paragraphs.map(p => [...p]);
	for (let i = 0; i < out.length; i++) {
		const name = out[i]!;
		if (name.length !== 1 || !PERSON_NAME_LINE.test(lineText(name[0]!).trim())) continue;
		const j = out.findIndex((p, k) => k !== i && p.length === 1 && BARE_EMAIL_LINE.test(lineText(p[0]!).trim()) && lineStacksOver(name[0]!, p[0]!));
		if (j < 0) continue;
		out[i] = [...name, ...out[j]!];
		out.splice(j, 1);
		if (j < i) i--;
	}
	return out;
}

/** How far a numbered list may jump (a mis-set label, a dropped line) and still count as the same list. */
export const ENTRY_NUMBER_SKIP = 5;

/**
 * The label of a numbered entry: "521. Carotid…" / "[12] Smith" → 521 / 12.
 * Not a tail line ("93. doi: 10…" continues the entry above), not a bare
 * number, not a year or a volume.
 */
export function entryNumberOf(text: string): number | null {
	const m = /^\s*(?:\[(\d{1,4})\]|(\d{1,4})\.)\s+(?=\S)/.exec(text)
		// Karger / Vancouver variants set the label without a period ("1 van Everdingen KJ,").
		?? (startsReferenceEntry(text) ? /^\s*(\d{1,4})\s+(?=\S)/.exec(text) : null);
	if (!m || isReferenceTailLine(text)) return null;
	const n = Number(m[1] ?? m[2]);
	return n >= 1 && n < 1900 ? n : null;
}

export interface ParagraphContext {
	/** The whole page is (part of) a reference list: entry boundaries count as breaks. */
	referencePage?: boolean;
	/**
	 * The page carries the heading that starts a reference list: only lines
	 * below it in its own column are in the list — the body above the heading
	 * and the other columns keep body rules.
	 */
	referenceHeadingRect?: Rect;
	/** The page is a book index: one entry per line (校验 r23, 3200). */
	indexPage?: boolean;
	/** 5.0 全篇样式: measured first-line indent (pt) and the body size it was measured at. */
	paragraphIndent?: number;
	bodyFontSize?: number;
	/**
	 * Median line width to judge short lines by, when the lines passed are a
	 * subset of the page's (furniture taken out): the short-line test must not
	 * shift because a few short page-number lines left the stream.
	 */
	medianLineWidth?: number;
}

/** 中位行宽 (BabelDOC ParagraphFinding): 短行分段基准。 */
export function medianLineWidthOf(lines: SpanLine[]): number {
	const widths = lines.map(l => l.rect[2] - l.rect[0]).filter(w => w > 0).sort((a, b) => a - b);
	return widths.length ? widths[Math.floor(widths.length / 2)]! : 0;
}

export function groupIntoParagraphs(lines: SpanLine[], pageWidth = 612, pageHeight = 0, obstacles: Rect[] = [], gridRows: GridRowBarriers | GridRowBarriers[] | null = null, context: ParagraphContext = {}): SpanLine[][] {
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

	const medianLineWidth = context.medianLineWidth ?? medianLineWidthOf(lines);

	const paragraphs: SpanLine[][] = [];
	let current: SpanLine[] = [];
	// 5.0 (校验 r22, 2852 p74): the running entry number of a numbered list. The
	// next number is the next entry whatever follows it — an organisation author
	// ("521. Carotid Stenting Guidelines Committee"), glued initials
	// ("524. Masdeu JC, Irimia P,Asenbaum S"), "535. Deleted in proof.",
	// a lower-case particle ("536. de Bruijn SF") — none of which the author
	// patterns recognise.
	let entryNo: number | null = null;
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
		if (semanticBoundary(lineText(line), lineText(next))) { flush(); continue; }
		// 校验 r23 (3200): on an index page every line is an entry; only a line of
		// bare locators wraps the entry above.
		if (context.indexPage) { if (!isIndexLocatorLine(lineText(next)) || !linesShareColumn(line.rect, next.rect)) flush(); continue; }
		if (ENTRY_LINES.has(line) || ENTRY_LINES.has(next)) { flush(); continue; }
		// Isolate page furniture before a full-width body line can absorb it.
		const footer = (l: SpanLine): boolean => isFooterDate(lineText(l), l.rect, pageHeight) || isJournalFurniture(lineText(l), l.rect, pageHeight) || pageHeight > 0 && l.rect[3] < pageHeight * 0.1
			&& (/^\d{1,4}$/.test(lineText(l).trim()) || /^(?:[\w.-]+\.(?:org|com|edu)\b|Radiology:\s*Volume\b)/i.test(lineText(l).trim()));
		if (footer(line) !== footer(next)) { flush(); continue; }
		// 边框硬屏障: a figure between two lines separates layout regions.
		if (obstacleBetween(line.rect, next.rect, obstacles)) {
			flush();
			continue;
		}
		// 网格行线硬屏障 (2.12.15):两行之间隔着一条表格行线,就是两个格。
		if (gridRows && gridRowBetween(line.rect, next.rect, gridRows)) {
			flush();
			continue;
		}

		const size = line.fontSize > 0 ? line.fontSize : 10;
		const margins = marginOf(i);
		const heading = context.referenceHeadingRect;
		// Below the heading in the heading's own column only: what sits in another
		// column on that page may be body or declarations (3285 p8, 2721 p8).
		const inList = (l: SpanLine): boolean => !!heading && l.rect[3] <= heading[1] + 1
			&& Math.min(l.rect[2], margins.right) - Math.max(l.rect[0], margins.left) > 0
			// the heading overlaps this column or hangs in the margin just left of it
			// (PMC manuscripts set "References" at x 90 beside a column starting at 150)
			&& heading[0] <= margins.right && heading[2] >= margins.left - 80;
		const referenceContext = !!context.referencePage || (inList(line) && inList(next));
		const lineNo = referenceContext ? entryNumberOf(lineText(line)) : null;
		// A mis-set label (2852: entry 531 printed as "535") must not derail the rest.
		if (lineNo !== null && (entryNo === null || Math.abs(lineNo - entryNo) <= ENTRY_NUMBER_SKIP)) entryNo = lineNo;
		const nextNo = referenceContext ? entryNumberOf(lineText(next)) : null;
		const nextInSequence = entryNo !== null && nextNo === entryNo + 1;
		// 5.0 全篇样式: a body-size line is indented relative to this document's
		// measured first-line indent (0.75em in 2757 / 3285 — the fixed 0.8em never
		// saw it); other sizes, or no measurement, keep the old 0.8em.
		const indentThreshold = (l: SpanLine): number => {
			const measured = context.paragraphIndent ?? 0;
			const lineSize = l.fontSize > 0 ? l.fontSize : size;
			return measured > 0 && context.bodyFontSize && Math.abs(lineSize - context.bodyFontSize) < 0.6
				? measured * 0.6 : lineSize * 0.8;
		};
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
			// 真机 4.99.16 (3084 p8): a line starting where the line above starts
			// continues it — hanging-label reference lists sit 0.8em right of the
			// band edge on EVERY continuation line, not just the first.
			// 校验 r23 (3363 / 3007): under a line that starts a numbered entry, the
			// next line sits at the text edge after the label — a hanging indent,
			// not a new paragraph — unless it starts the next entry itself.
			indented: !(lineNo !== null && nextNo === null)
				&& next.rect[0] > margins.left + indentThreshold(next) && next.rect[0] > line.rect[0] + Math.min(size * 0.5, indentThreshold(next)),
			// 对称跳变 (2.5.13, wu2026-p4 实证): 除数取两行字号的较小者。原式
			// 除以【当前行】字号,于是 10pt 正文接 12pt 标题 = 2/10 = 0.20 能断,
			// 而 12pt 标题接 10pt 正文 = 2/12 = 0.167 断不了 —— 每个压在正文上
			// 的小节标题都向下焊死(标题恰好接近满栏宽时,wrapped 守卫又拦掉
			// 兜底的间距断段)。"Polyp detection rate and reader confidence"
			// 就这样连标题带首段焊成一块,标题结构在译文页消失。
			fontJump: size > 0 && next.fontSize > 0
				&& Math.abs(next.fontSize - size) / Math.min(size, next.fontSize) >= FONT_JUMP_RATIO,
			// 5.0 (校验 2877): one contact record per line — two consecutive
			// lines that each carry an e-mail address are separate items.
			listStart: looksLikeListStart(lineText(next)) || (HAS_EMAIL.test(lineText(line)) && HAS_EMAIL.test(lineText(next)))
				|| /^\s*[■□●○•▪▫◆◇▶►‣⁃]\s/.test(lineText(next))
				// "…(jh11200@rjh.com.cn)." then "Published Online: …" / "doi:10…": a new field.
				// Not inside a reference list, where "doi:10…" continues the entry above.
				|| (!referenceContext && /[.)]\s*$/.test(lineText(line)) && /^\s*(?:\p{Lu}[\p{Ll}]+(?:\s\p{Lu}?[\p{Ll}]+){0,3}:\s|doi:\s?10\.)/u.test(lineText(next))),
			// In a reference list, line length says nothing (an author line ends
			// early, 3064 entry 16); only the start of the next entry does.
			shortLine: medianLineWidth > 0
				&& (line.rect[2] - line.rect[0]) < medianLineWidth * 0.7
				&& !startsContinuation(lineText(next))
				&& (!referenceContext || startsReferenceEntry(lineText(next)) || startsUnnumberedEntry(lineText(next))),
			leaderDots: hasLeaderDots(lineText(line)),
			// 5.1: a body-size heading set in bold ("4. Discussion" in 2638) sits on
			// the paragraph above with a gap under 1.7em and is short, so only the
			// break after it fired — it was welded onto the previous paragraph's
			// last line. A change between an all-bold short line and a regular line
			// ends the paragraph. Not in reference lists (bold volume numbers,
			// bold author names) and not for a bold line that fills the column
			// (a bold sentence inside a paragraph, a highlighted finding).
			weightChange: !referenceContext && weightBoundary(line, next, medianLineWidth),
			// 5.0 (2877 p18): unnumbered entries ("…In, 2011" / "Benomar A, Zarour E, …")
			// were welded in pairs — the first line filled its column. On a known
			// reference page an entry end followed by an entry start is a boundary.
			entryBoundary: nextInSequence || (referenceContext && ENTRY_END.test(lineText(line))
				&& (startsReferenceEntry(lineText(next)) || startsUnnumberedEntry(lineText(next))))
		});
		if (brk) {
			flush();
		}
	}
	flush();
	return paragraphs;
}

/** 5.1: one of the two lines is a short all-bold heading line and the other is regular text. */
export function weightBoundary(line: SpanLine, next: SpanLine, medianLineWidth: number): boolean {
	const a = lineIsBold(line), b = lineIsBold(next);
	if (a === b) return false;
	const heading = a ? line : next;
	const text = lineText(heading).trim();
	const width = heading.rect[2] - heading.rect[0];
	const other = lineText(a ? next : line).trim();
	return text.length <= 90 && (medianLineWidth <= 0 || width < medianLineWidth * 0.85)
		// the regular side must be text, not a lone page number or a symbol
		&& /\p{L}{2,}/u.test(other)
		// a bold caption label keeps its caption ("Fig. 4. Follow-up MRI of the brain." + panels, 2827)
		&& !/^(?:fig(?:ure)?\.?|table|图|表)\s*\d/i.test(text)
		// a bold run inside a sentence is not a heading: before a bold line the
		// regular line must have ended its sentence ("…Mono+ or" / "Conv. CT.", 3225);
		// after one, the regular line must not start in lower case
		&& (a ? !/^[a-z]/.test(other) : /[.:!?)\]]$/.test(other));
}

/**
 * A block that is ONLY a figure label — "Figure 6:", "Fig. 2.", "图 3" —
 * with the caption text torn into the next block.
 */
export function isBareFigureLabel(text: string): boolean {
	return /^(figure|fig\.?|图)\s*\d+\s*[.:：]?\s*$/i.test(text.trim());
}

export function classify(text: string, fontSize: number, bodySize: number, lineCount: number, lines: string[] = [], isTableLine = false, allBold = false): BlockType {
	if (/^(figure|fig\.?|table|图|表|圖)\s*\d+/i.test(text)) {
		return /^(table|表)/i.test(text) ? 'table' : 'caption';
	}
	const ratio = bodySize > 0 ? fontSize / bodySize : 1;
	// 5.1: the weight the text layer never had. Before the list arms: "4."
	// opens an ordered list at body size, and the coalescer welds lists onto
	// the paragraph above. A short block whose every line
	// is bold, at body size or larger, is a subheading ("4. Discussion" in 2638,
	// glued onto the paragraph above by the region coalescer as a "paragraph").
	// A bold run that ends a sentence and runs on is a highlighted finding, not a
	// heading — the length cap keeps those out.
	// Larger bold type is left to the title arm below (a wrapped title arrives line
	// by line and is rejoined only as 'title').
	if (allBold && !isTableLine && lineCount <= 2 && text.length < 90 && ratio >= 0.9 && ratio < 1.35
		&& !/^[a-z]/.test(text.trim()) && !/[,;]$/.test(text.trim())) {
		return 'heading';
	}
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
export function looksLikeTitleCaseHeading(text: string): boolean {
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

/** 网格行线(PDF y-up)与它们的横向范围。 */
export interface GridRowBarriers { ys: number[]; left: number; right: number }

export function gridRowBarriers(grid: BorderGrid, pageHeight: number): GridRowBarriers {
	return {
		ys: grid.rows.map(y => pageHeight - y),
		left: grid.region.left,
		right: grid.region.left + grid.region.width
	};
}

/** 两行(PDF y-up 矩形 [x1, 底, x2, 顶])之间是否隔着一条网格行线,且两行都在网格横向范围内。 */
export function gridRowBetween(a: Rect, b: Rect, rows: GridRowBarriers | GridRowBarriers[]): boolean {
	if (Array.isArray(rows)) return rows.some(r => gridRowBetween(a, b, r));
	// 竖向间隙 = [下面那行的顶边, 上面那行的底边]。
	const lo = Math.min(a[3], b[3]);
	const hi = Math.max(a[1], b[1]);
	if (hi <= lo) { return false; }
	const inGrid = (r: Rect): boolean => r[2] > rows.left && r[0] < rows.right;
	if (!inGrid(a) || !inGrid(b)) { return false; }
	return rows.ys.some(y => y >= lo - 0.5 && y <= hi + 0.5);
}

/**
 * 同一格里上下紧邻的两个段落合成一个 (2.12.15)。
 *
 * 判据:都在网格里、中间没有行线、x 重叠、间距不到一个字号、字号相同。段落启发式
 * 再怎么想断也不断 —— ESC p16 第三条标题带折成两行,第二行 "oral anticoagulation—Section 4"
 * 被单独切成一块,译文页上留着英文。在段落层做而不是行层:那一行在行序里排在第 0 位
 * (行序是老问题),行层的相邻判断根本碰不到它。
 */
export function mergeGridCellStacks(paragraphs: SpanLine[][], rows: GridRowBarriers | null, allRows: GridRowBarriers[] = []): SpanLine[][] {
	if (!rows || paragraphs.length < 2) { return paragraphs; }
	const out = paragraphs.map(p => [...p]);
	const bottomLine = (p: SpanLine[]): SpanLine => p.reduce((m, l) => (l.rect[1] < m.rect[1] ? l : m), p[0]!);
	const topLine = (p: SpanLine[]): SpanLine => p.reduce((m, l) => (l.rect[3] > m.rect[3] ? l : m), p[0]!);
	let merged = true;
	while (merged) {
		merged = false;
		for (let i = 0; i < out.length && !merged; i++) {
			const b = bottomLine(out[i]!);
			for (let j = 0; j < out.length; j++) {
				if (i === j) { continue; }
				if (sameGridCellStack(b, topLine(out[j]!), rows, allRows)) {
					out[i] = [...out[i]!, ...out[j]!];
					out.splice(j, 1);
					merged = true;
					break;
				}
			}
		}
	}
	return out;
}

export function sameGridCellStack(a: SpanLine, b: SpanLine, rows: GridRowBarriers, allRows: GridRowBarriers[]): boolean {
	const inGrid = (r: Rect): boolean => r[0] >= rows.left - 1 && r[2] <= rows.right + 1;
	if (!inGrid(a.rect) || !inGrid(b.rect)) { return false; }
	// 5.0 第 5 步 (校验 r22, 2852 p50): a rule of ANY table on the page stops it.
	// Two recommendation tables share one x range down the page; the lower
	// table's pass merged the upper table's section heading into its first
	// recommendation, because none of the LOWER table's rules lies between them.
	if (gridRowBetween(a.rect, b.rect, allRows.length ? allRows : rows)) { return false; }
	const overlapX = Math.min(a.rect[2], b.rect[2]) - Math.max(a.rect[0], b.rect[0]);
	if (overlapX <= 0) { return false; }
	const size = a.fontSize > 0 ? a.fontSize : 10;
	if (b.fontSize > 0 && Math.abs(b.fontSize - size) > 0.5) { return false; }
	const gap = a.rect[1] - b.rect[3];
	return gap >= -0.5 && gap < size;
}
