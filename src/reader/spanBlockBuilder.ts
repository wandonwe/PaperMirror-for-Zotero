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
import { isMetadataBlock } from './metaFilter';
import {
	columnOf,
	detectColumns,
	detectGutters,
	dominantFontSize,
	joinFragments,
	linesShareColumn,
	looksLikeListStart,
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
	return Math.max(fontSize * 2.5, 18);
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
export function groupIntoLines(items: SpanItem[], pageWidth = 612): SpanLine[] {
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
				const crossesGutter = gutters.some(g => previous.rect[2] <= g && item.rect[0] >= g);
				const size = previous.fontSize || (previous.rect[3] - previous.rect[1]) || 10;
				if (crossesGutter || gap > columnGapThreshold(size)) {
					flush();
				}
			}
			current.push(item);
		}
		flush();
	}

	// Reading order: full-width lines first (title/abstract), then column by
	// column, each top to bottom.
	const bands = detectColumns(lines.map(l => l.rect), pageWidth);
	const columnFor = new Map<SpanLine, number>();
	for (const line of lines) {
		columnFor.set(line, columnOf(line.rect, bands, pageWidth));
	}
	lines.sort((a, b) => {
		const ca = columnFor.get(a)!;
		const cb = columnFor.get(b)!;
		return ca !== cb ? ca - cb : (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]);
	});
	return lines;
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
export function groupIntoParagraphs(lines: SpanLine[], pageWidth = 612): SpanLine[][] {
	if (!lines.length) {
		return [];
	}
	const bands = detectColumns(lines.map(l => l.rect), pageWidth);
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
		const size = line.fontSize > 0 ? line.fontSize : 10;
		const margins = marginOf(i);
		const brk = shouldBreak({
			fontSize: size,
			gap: line.rect[1] - next.rect[3],
			wrapped: reachesRightMargin(line.rect, margins.right, size),
			// The x-overlap test is the backstop for pages where column
			// detection fails (a big figure votes down the gutter): two lines
			// that do not share an x-range are NEVER one paragraph, so the
			// worst failure degrades to per-line blocks instead of the left
			// and right columns being interleaved into scrambled text.
			newColumn: columns[i] !== columns[i + 1]
				|| next.rect[3] > line.rect[3] + size
				|| !linesShareColumn(line.rect, next.rect),
			indented: next.rect[0] > margins.left + size * 0.8,
			fontJump: size > 0 && next.fontSize > 0 && Math.abs(next.fontSize - size) / size > 0.2,
			listStart: looksLikeListStart(lineText(next))
		});
		if (brk) {
			flush();
		}
	}
	flush();
	return paragraphs;
}

function classify(text: string, fontSize: number, bodySize: number, lineCount: number): BlockType {
	if (/^(figure|fig\.?|table|图|表|圖)\s*\d+/i.test(text)) {
		return /^(table|表)/i.test(text) ? 'table' : 'caption';
	}
	if (looksLikeListStart(text) && /^[•▪◦‣·*–—-]\s/.test(text.trim())) {
		return 'list';
	}
	const ratio = bodySize > 0 ? fontSize / bodySize : 1;
	if (lineCount <= 2 && ratio >= 1.35 && text.length < 250) {
		return 'title';
	}
	if (lineCount <= 2 && text.length < 160
		&& (ratio >= 1.1
			|| /^(\d+\.?)+\s+\S/.test(text)
			|| /^(abstract|introduction|methods?|results|discussion|conclusions?|references|摘要|引言|方法|结果|讨论|结论)\s*$/i.test(text))) {
		return 'heading';
	}
	return 'paragraph';
}

export interface SpanBuildOptions {
	pageIndex: number;
	pageHeight: number;
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
	const lines = groupIntoLines(items, pageWidth);
	const paragraphs = groupIntoParagraphs(lines, pageWidth);

	const sizes = lines.map(l => l.fontSize).filter(s => s > 0).sort((a, b) => a - b);
	const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0;

	// Materialise, then repair anything still split mid-sentence.
	const bands = detectColumns(lines.map(l => l.rect), pageWidth);
	const draft = paragraphs.map((group) => {
		const text = group.map(lineText).join(' ').replace(/\s+/g, ' ').trim();
		let rect = group[0]!.rect;
		for (const l of group) {
			rect = union(rect, l.rect);
		}
		return {
			group,
			text,
			rect,
			column: columnOf(rect, bands, pageWidth),
			type: classify(text, group[0]!.fontSize, bodySize, group.length),
			fontSize: group[0]!.fontSize,
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
		return { ...head, rect, text, group };
	});

	let referencesStarted = !!options.referencesAlreadyStarted;
	const blocks: SourceBlock[] = [];
	let order = 0;
	for (const p of merged) {
		if (p.type !== 'title' && p.type !== 'heading' && isMetadataBlock(p.text, p.rect)) {
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
			isReference: referencesStarted
		});
		order++;
	}
	return { blocks, referencesStarted };
}
