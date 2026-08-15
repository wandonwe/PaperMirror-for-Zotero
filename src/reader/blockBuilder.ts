/**
 * Pure logic that turns the char stream from Zotero's PDF.js fork
 * (pdfDocument.getPageData -> chars with break flags) into structured
 * SourceBlocks. No Zotero APIs here — fully unit-testable.
 */

import type { BlockType, BoundingBox, PdfChar, SourceBlock } from '../types/models';
import { insideObstacle, obstacleBetween } from './figureBarriers';
import { detectGlyphFormulaRuns } from './glyphFormula';
import { detectStyleRuns } from './styleRuns';
import { isMetadataBlock, isPublisherBoilerplateLine } from './metaFilter';
import {
	columnOf,
	detectColumns,
	dominantFontSize,
	endsSentence,
	isBoldFontName,
	joinFragments,
	LINE_HYPHENS,
	linesShareColumn,
	looksLikeListStart,
	hasLeaderDots,
	startsContinuation,
	isOrderedListStart,
	isSectionNumberHeading,
	planMerges,
	reachesRightMargin,
	shouldBreak,
	type ColumnBand,
	type Rect
} from './paragraphHeuristics';

export interface BuildOptions {
	pageIndex: number;
	/** Page height in PDF units (used to normalize Y and find header/footer bands). */
	pageHeight: number;
	pageWidth: number;
	/** Median body font size across the document, if known. */
	bodyFontSize?: number;
	/** Stop emitting blocks after a references heading is seen (spec 4.2). */
	includeReferences?: boolean;
	/** Whether a references heading was already seen on an earlier page. */
	referencesAlreadyStarted?: boolean;
	/**
	 * 边框硬屏障: real figure rectangles (operator list, PDF coords). Lines
	 * inside them are diagram labels (kept original, never translated); lines
	 * separated by them never merge into one paragraph.
	 */
	imageRectsPdf?: [number, number, number, number][];
}

export interface BuildResult {
	blocks: SourceBlock[];
	/** True if a References/参考文献 heading was seen on (or before) this page. */
	referencesStarted: boolean;
	/** Raw paragraph candidates before reference-filtering (for diagnostics). */
	totalParagraphs: number;
}

interface Line {
	start: number;
	end: number; // inclusive char indices
	rect: [number, number, number, number];
	fontSize: number;
	fontName: string;
}

interface Paragraph {
	lines: Line[];
	text: string;
	rect: [number, number, number, number];
	fontSize: number;
	fontName: string;
}

const REFERENCES_HEADINGS = /^(references|bibliography|literature\s+cited|参考文献|參考文獻|引用文献)\s*$/i;

const HEADER_FOOTER_BAND_RATIO = 0.05; // top/bottom 5% of the page
const MIN_PARAGRAPH_CHARS = 2;

function mergeRects(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function charRect(ch: PdfChar): [number, number, number, number] {
	return ch.rect;
}

/** Split chars into lines using the fork-provided break flags. */
export function buildLines(chars: PdfChar[]): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (!ch) {
			continue;
		}
		const isEnd = !!ch.lineBreakAfter || !!ch.paragraphBreakAfter || i === chars.length - 1;
		if (isEnd) {
			let rect: [number, number, number, number] | null = null;
			let fontSizeSum = 0;
			let fontSizeCount = 0;
			const fontSizes: number[] = [];
			let fontName = '';
			for (let j = start; j <= i; j++) {
				const c = chars[j];
				if (!c || c.ignorable) {
					continue;
				}
				rect = rect ? mergeRects(rect, charRect(c)) : [...charRect(c)] as [number, number, number, number];
				if (typeof c.fontSize === 'number') {
					fontSizeSum += c.fontSize;
					fontSizeCount++;
					fontSizes.push(c.fontSize);
				}
				if (!fontName && c.fontName) {
					fontName = c.fontName;
				}
			}
			if (rect) {
				lines.push({
					start,
					end: i,
					rect,
					// Dominant, NOT mean: one superscript citation or inline
					// math glyph used to drag the mean >20% and trip a bogus
					// paragraph break in the middle of a sentence.
					fontSize: dominantFontSize(fontSizes) || (fontSizeCount ? fontSizeSum / fontSizeCount : 0),
					fontName
				});
			}
			start = i + 1;
		}
	}
	return lines;
}

/** Compose display text for a char range, joining wrapped lines with spaces
 *  and removing hyphenation artifacts at line ends. */
export function textForRange(chars: PdfChar[], start: number, end: number): string {
	const parts: string[] = [];
	for (let i = start; i <= end; i++) {
		const ch = chars[i];
		if (!ch || ch.ignorable) {
			continue;
		}
		parts.push(ch.c);
		const isLineEnd = !!ch.lineBreakAfter || !!ch.paragraphBreakAfter;
		if (isLineEnd && i < end) {
			// De-hyphenate "exam-\nple" -> "example" for any line hyphen (- ­ ‐ ‑)
			// when a Latin letter sits on BOTH sides (so "3-\n5" ranges survive).
			const prev = parts[parts.length - 1];
			const beforeHyphen = parts[parts.length - 2];
			const next = chars
				.slice(i + 1, Math.min(i + 3, end + 1))
				.find(c => c && !c.ignorable);
			if (prev && new RegExp(`^[${LINE_HYPHENS}]$`).test(prev)
				&& beforeHyphen && /[A-Za-z]$/.test(beforeHyphen)
				&& next && /[A-Za-z]/.test(next.c)) {
				parts.pop();
				continue;
			}
			// CJK lines join without spaces
			const isCJKBoundary = /[一-鿿㐀-䶿]/.test(ch.c);
			if (!isCJKBoundary) {
				parts.push(' ');
			}
		}
		else if (ch.spaceAfter && i < end) {
			parts.push(' ');
		}
	}
	return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Group lines into paragraphs.
 *
 * The fork's `paragraphBreakAfter` flag is authoritative when present. Every
 * other signal (spacing, indentation, font change) is filtered through
 * shouldBreak(), which refuses to end a paragraph after a line that ran to its
 * column's right margin — such a line wrapped, so the sentence continues.
 * A final merge pass rejoins anything that still came out split mid-sentence.
 */
export function buildParagraphs(chars: PdfChar[], lines: Line[], pageWidth = 612, pageHeight = 0, obstacles: [number, number, number, number][] = []): Paragraph[] {
	if (!lines.length) {
		return [];
	}
	const bands = detectColumns(lines.map(l => l.rect as Rect), pageWidth, pageHeight);
	const columns = lines.map(l => columnOf(l.rect as Rect, bands, pageWidth));
	const marginOf = (index: number): { left: number; right: number } => {
		const column = columns[index]!;
		const band: ColumnBand | undefined = column >= 0 ? bands[column] : undefined;
		if (band) {
			return { left: band.left, right: band.right };
		}
		// Full-width line (or no columns detected): use the whole text extent.
		let left = Infinity;
		let right = -Infinity;
		for (const l of lines) {
			left = Math.min(left, l.rect[0]);
			right = Math.max(right, l.rect[2]);
		}
		return { left: Number.isFinite(left) ? left : 0, right: Number.isFinite(right) ? right : pageWidth };
	};

	// Break-flag sanity: some PDFs set paragraphBreakAfter on (nearly) EVERY
	// line — trusted as authoritative, that shreds each paragraph into
	// one-line blocks which then translate line-by-line (the EN/ZH zebra
	// pages). When >80% of lines carry the flag it carries no information:
	// ignore it and let geometry decide.
	const flagged = lines.filter(l => !!chars[l.end]?.paragraphBreakAfter).length;
	const distrustExplicit = lines.length >= 8 && flagged / lines.length > 0.8;

	// 中位行宽 (BabelDOC ParagraphFinding 步骤 3): 短行分段的基准。
	const widths = lines.map(l => l.rect[2] - l.rect[0]).filter(w => w > 0).sort((a, b) => a - b);
	const medianLineWidth = widths.length ? widths[Math.floor(widths.length / 2)]! : 0;

	const raw: Paragraph[] = [];
	const rawColumns: number[] = [];
	let group: Line[] = [];
	let groupStart = 0;
	const flush = (): void => {
		if (!group.length) {
			return;
		}
		const first = group[0]!;
		const last = group[group.length - 1]!;
		let rect = first.rect;
		for (const l of group) {
			rect = mergeRects(rect, l.rect);
		}
		const text = textForRange(chars, first.start, last.end);
		if (text.length >= MIN_PARAGRAPH_CHARS) {
			raw.push({
				lines: group,
				text,
				rect,
				fontSize: dominantFontSize(group.map(l => l.fontSize)) || first.fontSize,
				fontName: first.fontName
			});
			rawColumns.push(columns[groupStart] ?? 0);
		}
		group = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!group.length) {
			groupStart = i;
		}
		group.push(line);
		const next = lines[i + 1];
		if (!next) {
			break;
		}
		const explicitBreak = !distrustExplicit && !!chars[line.end]?.paragraphBreakAfter;
		// 边框硬屏障: a figure between two lines separates layout regions —
		// force the break no matter what the spacing/font signals say.
		if (obstacleBetween(line.rect as Rect, next.rect as Rect, obstacles)) {
			flush();
			continue;
		}
		const margins = marginOf(i);
		const size = line.fontSize > 0 ? line.fontSize : 10;
		const styleBreak = shouldBreak({
			fontSize: size,
			gap: line.rect[1] - next.rect[3],
			wrapped: reachesRightMargin(line.rect as Rect, margins.right, size),
			// Column continuity from GEOMETRY, not the (per-row unstable) band
			// index: two stacked lines sharing an x-range are one column; lines
			// in different columns never share an x-range. Trusting the index
			// fragmented paragraphs into one-line blocks on narrow 2-column pages.
			newColumn: (next.rect[1] > line.rect[3] + 5 && next.rect[0] > line.rect[0] + 50)
				|| !linesShareColumn(line.rect as Rect, next.rect as Rect),
			indented: next.rect[0] > margins.left + size * 0.8,
			fontJump: line.fontSize > 0 && next.fontSize > 0
				&& Math.abs(next.fontSize - line.fontSize) / line.fontSize > 0.2,
			listStart: looksLikeListStart(textForRange(chars, next.start, next.end)),
			// BabelDOC 短行/目录行信号 (来源见 paragraphHeuristics 注释)。
			shortLine: medianLineWidth > 0
				&& (line.rect[2] - line.rect[0]) < medianLineWidth * 0.7
				&& !startsContinuation(textForRange(chars, next.start, next.end)),
			leaderDots: hasLeaderDots(textForRange(chars, line.start, line.end))
		});
		if (explicitBreak || styleBreak) {
			flush();
		}
	}
	flush();

	// Repair pass: rejoin fragments that ended mid-sentence on the next line.
	const merged = planMerges(raw.map((p, i) => ({
		text: p.text,
		column: rawColumns[i],
		type: 'paragraph',
		fontSize: p.fontSize,
		rect: p.rect as Rect,
		gapAfter: raw[i + 1] ? p.rect[1] - raw[i + 1]!.rect[3] : undefined
	})));
	// 边框硬屏障 also vetoes the repair pass: never rejoin across a figure.
	const groups: number[][] = [];
	for (const g of merged) {
		let cur: number[] = [g[0]!];
		for (let k = 1; k < g.length; k++) {
			if (obstacleBetween(raw[g[k - 1]!]!.rect as Rect, raw[g[k]!]!.rect as Rect, obstacles)) {
				groups.push(cur);
				cur = [g[k]!];
			}
			else {
				cur.push(g[k]!);
			}
		}
		groups.push(cur);
	}
	if (groups.length === raw.length) {
		return raw;
	}
	return groups.map((indexes) => {
		const members = indexes.map(i => raw[i]!);
		const head = members[0]!;
		let rect = head.rect;
		const merged: Line[] = [];
		let text = '';
		for (const p of members) {
			rect = mergeRects(rect, p.rect);
			merged.push(...p.lines);
			text = joinFragments(text, p.text);
		}
		return { lines: merged, text, rect, fontSize: head.fontSize, fontName: head.fontName };
	});
}

/**
 * Order paragraphs for a (possibly) two-column page.
 * The fork's char stream is already in reading order, so ordering is usually
 * a no-op; this is a safety net for streams that interleave columns.
 */
export function orderParagraphs(paragraphs: Paragraph[], pageWidth: number): Paragraph[] {
	if (paragraphs.length < 4 || pageWidth <= 0) {
		return paragraphs;
	}
	const mid = pageWidth / 2;
	const left: Paragraph[] = [];
	const right: Paragraph[] = [];
	const wide: Paragraph[] = [];
	for (const p of paragraphs) {
		const [x1, , x2] = p.rect;
		const width = x2 - x1;
		if (width > pageWidth * 0.6) {
			wide.push(p);
		}
		else if ((x1 + x2) / 2 < mid) {
			left.push(p);
		}
		else {
			right.push(p);
		}
	}
	// Not a two-column layout
	if (!left.length || !right.length || wide.length > left.length + right.length) {
		return paragraphs;
	}
	// Detect interleaving: if input already goes all-left then all-right, keep it.
	let interleaved = false;
	let seenRight = false;
	for (const p of paragraphs) {
		if (right.includes(p)) {
			seenRight = true;
		}
		else if (left.includes(p) && seenRight) {
			interleaved = true;
			break;
		}
	}
	if (!interleaved) {
		return paragraphs;
	}
	const byY = (a: Paragraph, b: Paragraph): number => b.rect[3] - a.rect[3]; // top first (PDF y up)
	return [
		...wide.filter(w => w.rect[3] >= Math.max(...[...left, ...right].map(p => p.rect[3]))),
		...left.sort(byY),
		...right.sort(byY),
		...wide.filter(w => w.rect[3] < Math.max(...[...left, ...right].map(p => p.rect[3])))
	];
}

/** Repeated short strings at the extreme top/bottom of pages are headers/footers. */
export function isHeaderOrFooter(p: Paragraph, pageHeight: number): boolean {
	const [, y1, , y2] = p.rect;
	const band = pageHeight * HEADER_FOOTER_BAND_RATIO;
	const inTopBand = y1 > pageHeight - band * 1.6;
	const inBottomBand = y2 < band * 1.6;
	if (!inTopBand && !inBottomBand) {
		return false;
	}
	const text = p.text.trim();
	// Bare page numbers
	if (/^\d{1,4}$/.test(text)) {
		return true;
	}
	// Short single-line runs in the band: running titles, journal names, DOI lines
	if (p.lines.length <= 1 && text.length <= 120) {
		return true;
	}
	return false;
}

export function classifyBlock(p: Paragraph, bodyFontSize: number, pageWidth: number, chars?: PdfChar[]): BlockType {
	const text = p.text.trim();
	if (/^(figure|fig\.?|table|图|表|圖)\s*\d+/i.test(text)) {
		return text.toLowerCase().startsWith('table') || /^表/.test(text) ? 'table' : 'caption';
	}
	const fontRatio = bodyFontSize > 0 && p.fontSize > 0 ? p.fontSize / bodyFontSize : 1;
	// Bullet lists always; a single-level numbered item is a list only at body
	// font size — a larger numbered line ("3. Model Architecture") is a heading.
	if (/^[•▪◦‣·o*-]\s+/.test(text) || (isOrderedListStart(text) && fontRatio < 1.1)) {
		return 'list';
	}
	// 列表块检测 — 移植自 MinerU `backend/pipeline/para_split.py::__is_list_or_
	// index_block` (https://github.com/opendatalab/MinerU, Apache-2.0):
	// ≥80% 的行以列表终止符 (.。;;) 结尾 → 列表块,防止参考文献式列表被
	// planMerges 当正文并段。
	if (chars && p.lines.length >= 3) {
		const lineTexts = p.lines.map(l => textForRange(chars, l.start, l.end).trim()).filter(Boolean);
		const listEnded = lineTexts.filter(t => /[.。;;]$/.test(t)).length;
		if (lineTexts.length >= 3 && listEnded / lineTexts.length >= 0.8) {
			return 'list';
		}
	}
	if (p.lines.length <= 2 && fontRatio >= 1.35 && text.length < 250) {
		return 'title';
	}
	// A BOLD, short, left-standing line at (or near) body size is a subheading
	// even though its font size gives it away to nobody — this is the signal the
	// old size-only rule missed (spec §5). Guarded hard: ≤2 lines, under ~90
	// chars, and NOT ending like a sentence, so a bold emphasis run inside a
	// paragraph or a bold author line is not promoted to a heading.
	const boldHeading = isBoldFontName(p.fontName)
		&& p.lines.length <= 2
		&& fontRatio >= 0.98
		&& text.length < 90
		&& !endsSentence(text);
	if (p.lines.length <= 2 && text.length < 160
		&& (fontRatio >= 1.1
			|| isSectionNumberHeading(text)
			|| boldHeading
			|| /^(abstract|introduction|methods?|materials and methods|results|discussion|conclusions?|acknowledg(e)?ments?|references|摘要|引言|前言|方法|结果|讨论|结论|致谢)\s*$/i.test(text))) {
		return 'heading';
	}
	return 'paragraph';
}

export function medianFontSize(paragraphs: Paragraph[]): number {
	const sizes = paragraphs
		.filter(p => p.text.length > 100 && p.fontSize > 0)
		.map(p => p.fontSize)
		.sort((a, b) => a - b);
	if (!sizes.length) {
		const all = paragraphs.map(p => p.fontSize).filter(s => s > 0).sort((a, b) => a - b);
		return all.length ? all[Math.floor(all.length / 2)]! : 0;
	}
	return sizes[Math.floor(sizes.length / 2)]!;
}

function toBoundingBox(rect: [number, number, number, number], pageHeight: number): BoundingBox {
	// Convert PDF coords (origin bottom-left) to top-left origin for the UI.
	const [x1, y1, x2, y2] = rect;
	return { x: x1, y: pageHeight - y2, width: x2 - x1, height: y2 - y1 };
}

/**
 * Main entry: build ordered, classified SourceBlocks for one page.
 */
export function buildBlocks(chars: PdfChar[], options: BuildOptions): BuildResult {
	const { pageIndex, pageHeight, pageWidth } = options;
	const obstacles = options.imageRectsPdf ?? [];
	let lines = buildLines(chars);
	// 边框硬屏障 rule 1: lines INSIDE a figure are diagram labels ("X-rays",
	// "Low keV") — they stay on the original page and never enter the
	// translation flow, where they used to fuse with captions and body text.
	if (obstacles.length) {
		lines = lines.filter(l => !insideObstacle(l.rect as Rect, obstacles));
	}
	// Publisher boilerplate lines ("This copy is for personal use only…",
	// reprint/download notices) are dropped BY CONTENT before column detection:
	// on page 1 they sit mid-page across the gutter, where the position-based
	// furniture filter can't see them, and one such line bridges the columns.
	lines = lines.filter(l => !isPublisherBoilerplateLine(textForRange(chars, l.start, l.end)));
	let paragraphs = buildParagraphs(chars, lines, pageWidth, pageHeight, obstacles);
	paragraphs = paragraphs.filter(p => !isHeaderOrFooter(p, pageHeight));
	paragraphs = orderParagraphs(paragraphs, pageWidth);

	const bodySize = options.bodyFontSize || medianFontSize(paragraphs);

	// Column band per final paragraph, so semantic modules never cross columns.
	// Detected from LINE rects, not paragraph rects: paragraphs are too few for
	// the anti-weld coverage vote, and one union rect overhanging the gutter
	// would re-weld two columns at the stamping step (三栏首页回归).
	const columnBands = detectColumns(lines.map(l => l.rect as Rect), pageWidth, pageHeight);

	let referencesStarted = !!options.referencesAlreadyStarted;
	const blocks: SourceBlock[] = [];
	let order = 0;
	for (const p of paragraphs) {
		const type = classifyBlock(p, bodySize, pageWidth, chars);
		const text = p.text.trim();
		// Author lists, affiliations, copyright, DOI lines, watermarks: keep
		// them on the original page, keep them OUT of the translation.
		if (type !== 'title' && type !== 'heading' && isMetadataBlock(text, p.rect, pageWidth, { fontSize: p.fontSize, bodySize })) {
			continue;
		}
		if ((type === 'heading' || type === 'title') && REFERENCES_HEADINGS.test(text)) {
			referencesStarted = true;
		}
		const isReference = referencesStarted;
		if (isReference && !options.includeReferences) {
			// Keep the References heading itself so the panel can show a marker,
			// skip individual reference entries.
			if (!REFERENCES_HEADINGS.test(text)) {
				continue;
			}
		}
		// 字形级公式判定 (pdf2zh vflag / BabelDOC formular_helper 移植,见
		// glyphFormula.ts): 段落的字符序列直接给出应保护的公式字面量 —
		// formulaGuard 掩蔽时优先于文本正则。
		const paraChars: PdfChar[] = [];
		for (const line of p.lines) {
			for (let k = line.start; k <= line.end; k++) {
				const ch = chars[k];
				if (ch) {
					paraChars.push(ch);
				}
			}
		}
		const formulaRuns = detectGlyphFormulaRuns(paraChars, p.fontSize);
		// 段内粗/斜体跨度 (BabelDOC RichTextPlaceholder 思想,styleRuns.ts)。
		const styleRuns = detectStyleRuns(paraChars);
		blocks.push({
			id: `page-${pageIndex}-block-${order}`,
			pageIndex,
			order,
			type,
			sourceText: text,
			boundingBox: toBoundingBox(p.rect, pageHeight),
			lineRectsPdf: p.lines.map(line => [...line.rect] as [number, number, number, number]),
			fontSize: p.fontSize,
			column: columnOf(p.rect as Rect, columnBands, pageWidth),
			isReference,
			...(formulaRuns.length ? { formulaRuns } : {}),
			...(styleRuns.length ? { styleRuns } : {})
		});
		order++;
	}
	return { blocks, referencesStarted, totalParagraphs: paragraphs.length };
}

/**
 * Fallback path: build blocks from plain page text (PDFWorker.getFullText),
 * with no coordinates. Used when getPageData is unavailable.
 */
export function buildBlocksFromPlainText(pageText: string, pageIndex: number, options?: { includeReferences?: boolean; referencesAlreadyStarted?: boolean }): BuildResult {
	const rawParagraphs = pageText
		.split(/\n{2,}|\r\n\r\n/)
		.flatMap(part => part.split(/\n(?=[A-Z0-9•一-鿿].{0,2})/))
		.map(s => s.replace(/\s+/g, ' ').trim())
		.filter(s => s.length >= MIN_PARAGRAPH_CHARS);

	let referencesStarted = !!options?.referencesAlreadyStarted;
	const blocks: SourceBlock[] = [];
	let order = 0;
	for (const text of rawParagraphs) {
		if (REFERENCES_HEADINGS.test(text)) {
			referencesStarted = true;
		}
		if (referencesStarted && !options?.includeReferences && !REFERENCES_HEADINGS.test(text)) {
			continue;
		}
		blocks.push({
			id: `page-${pageIndex}-block-${order}`,
			pageIndex,
			order,
			type: 'unknown',
			sourceText: text,
			isReference: referencesStarted
		});
		order++;
	}
	return { blocks, referencesStarted, totalParagraphs: rawParagraphs.length };
}
