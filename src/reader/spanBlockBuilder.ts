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
import { insideObstacle, obstacleBetween } from './figureBarriers';
import { isMetadataBlock, isPublisherBoilerplateLine, isRunningHeadOrFoot } from './metaFilter';
import {
	columnOf,
	detectColumns,
	detectGutters,
	dominantFontSize,
	replacementFontSize,
	joinFragments,
	joinLines,
	hasLeaderDots,
	startsContinuation,
	linesShareColumn,
	looksLikeListStart,
	isOrderedListStart,
	isSectionNumberHeading,
	planMerges,
	reachesRightMargin,
	shouldBreak,
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
	return Math.max(fontSize * 1.6, 12);
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

function sizeOf(items: SpanItem[]): number {
	const sizes = items.map(i => i.fontSize ?? (i.rect[3] - i.rect[1])).filter(s => s > 0);
	// Dominant, not max: one superscript must not inflate the whole line.
	return dominantFontSize(sizes) || (sizes.length ? sizes[0]! : 10);
}

/** Step 1: items sharing a baseline band, left to right. No x constraint. */
function groupIntoRows(items: SpanItem[]): SpanItem[][] {
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
		const row = rows.find(r => Math.abs((r.top + r.bottom) / 2 - centre) <= height * 0.6);
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
	const gutters = detectGutters(rows.map(row => row.map(i => i.rect)), pageWidth);

	const lines: SpanLine[] = [];
	for (const row of rows) {
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
				const crossesGutter = gutters.some(g => previous.rect[2] <= g + slack && item.rect[0] >= g);
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
			fontJump: size > 0 && next.fontSize > 0 && Math.abs(next.fontSize - size) / size > 0.2,
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

function classify(text: string, fontSize: number, bodySize: number, lineCount: number): BlockType {
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
	if (lineCount <= 2 && ratio >= 1.35 && text.length < 250) {
		return 'title';
	}
	if (lineCount <= 2 && text.length < 160
		&& (ratio >= 1.1
			|| isSectionNumberHeading(text)
			|| /^(abstract|introduction|methods?|results|discussion|conclusions?|references|摘要|引言|方法|结果|讨论|结论)\s*$/i.test(text))) {
		return 'heading';
	}
	return 'paragraph';
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

export function buildBlocksFromSpans(items: SpanItem[], options: SpanBuildOptions): SpanBuildResult {
	const pageWidth = options.pageWidth && options.pageWidth > 0 ? options.pageWidth : 612;
	const obstacles = options.imageRectsPdf ?? [];
	const filteredItems = obstacles.length
		? items.filter(i => !insideObstacle(i.rect, obstacles))
		: items;
	const lines = groupIntoLines(filteredItems, pageWidth, options.pageHeight);
	const paragraphs = groupIntoParagraphs(lines, pageWidth, options.pageHeight, obstacles);

	const sizes = lines.map(l => l.fontSize).filter(s => s > 0).sort((a, b) => a - b);
	const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0;

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
		const type = classify(text, repSize, bodySize, group.length);
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
			gapAfter: undefined as number | undefined
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
	const blocks: SourceBlock[] = [];
	let order = 0;
	for (const p of merged) {
		if (p.type !== 'title' && p.type !== 'heading' && isMetadataBlock(p.text, p.rect, pageWidth)) {
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
		if (referencesStarted && !options.includeReferences && !REFERENCES_HEADINGS.test(p.text)) {
			continue;
		}
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
			column: columnOf(p.rect, columnBands, pageWidth),
			isReference: referencesStarted
		});
		order++;
	}
	return { blocks, referencesStarted };
}
