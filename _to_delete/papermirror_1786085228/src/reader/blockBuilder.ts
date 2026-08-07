/**
 * Pure logic that turns the char stream from Zotero's PDF.js fork
 * (pdfDocument.getPageData -> chars with break flags) into structured
 * SourceBlocks. No Zotero APIs here — fully unit-testable.
 */

import type { BlockType, BoundingBox, PdfChar, SourceBlock } from '../types/models';

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
					fontSize: fontSizeCount ? fontSizeSum / fontSizeCount : 0,
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
			// De-hyphenate: "exam-\nple" -> "example". Only for pure ASCII word joins.
			const prev = parts[parts.length - 1];
			const next = chars
				.slice(i + 1, Math.min(i + 3, end + 1))
				.find(c => c && !c.ignorable);
			if (prev === '-' && next && /[a-z]/.test(next.c)) {
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

/** Group lines into paragraphs using explicit break flags plus indent heuristics. */
export function buildParagraphs(chars: PdfChar[], lines: Line[]): Paragraph[] {
	if (!lines.length) {
		return [];
	}
	const paragraphs: Paragraph[] = [];
	let group: Line[] = [];
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
			paragraphs.push({
				lines: group,
				text,
				rect,
				fontSize: first.fontSize,
				fontName: first.fontName
			});
		}
		group = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		group.push(line);
		const lastChar = chars[line.end];
		const explicitBreak = !!lastChar?.paragraphBreakAfter;
		let styleBreak = false;
		const next = lines[i + 1];
		if (next) {
			// Column switch: next line starts far to the right or jumps back up
			const movedRight = next.rect[0] > line.rect[2] + 30;
			const jumpedUp = next.rect[1] > line.rect[3] + 5 && next.rect[0] > line.rect[0] + 50;
			// Large font-size change means a structural boundary
			const fontJump = line.fontSize > 0 && next.fontSize > 0
				&& Math.abs(next.fontSize - line.fontSize) / line.fontSize > 0.2;
			styleBreak = movedRight || jumpedUp || fontJump;
		}
		if (explicitBreak || styleBreak || i === lines.length - 1) {
			flush();
		}
	}
	flush();
	return paragraphs;
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

export function classifyBlock(p: Paragraph, bodyFontSize: number, pageWidth: number): BlockType {
	const text = p.text.trim();
	if (/^(figure|fig\.?|table|图|表|圖)\s*\d+/i.test(text)) {
		return text.toLowerCase().startsWith('table') || /^表/.test(text) ? 'table' : 'caption';
	}
	if (/^[•▪◦‣·o*-]\s+/.test(text) || /^\(?\d{1,2}[.)]\s+\S/.test(text) && text.length < 300) {
		if (/^[•▪◦‣·*-]\s+/.test(text)) {
			return 'list';
		}
	}
	const fontRatio = bodyFontSize > 0 && p.fontSize > 0 ? p.fontSize / bodyFontSize : 1;
	if (p.lines.length <= 2 && fontRatio >= 1.35 && text.length < 250) {
		return 'title';
	}
	if (p.lines.length <= 2 && text.length < 160
		&& (fontRatio >= 1.1
			|| /^(\d+\.?)+\s+\S/.test(text)
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
	const lines = buildLines(chars);
	let paragraphs = buildParagraphs(chars, lines);
	paragraphs = paragraphs.filter(p => !isHeaderOrFooter(p, pageHeight));
	paragraphs = orderParagraphs(paragraphs, pageWidth);

	const bodySize = options.bodyFontSize || medianFontSize(paragraphs);

	let referencesStarted = !!options.referencesAlreadyStarted;
	const blocks: SourceBlock[] = [];
	let order = 0;
	for (const p of paragraphs) {
		const type = classifyBlock(p, bodySize, pageWidth);
		const text = p.text.trim();
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
		blocks.push({
			id: `page-${pageIndex}-block-${order}`,
			pageIndex,
			order,
			type,
			sourceText: text,
			boundingBox: toBoundingBox(p.rect, pageHeight),
			isReference
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
