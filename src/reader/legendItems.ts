/** Keep repeated, marker-aligned diagram labels in their own source rectangles.
 * The original PDF paints the markers and their colours; this pass only owns
 * the adjacent text. Unmarked text keeps the existing extraction path. */
import type { SourceBlock } from '../types/models';
import { joinSemanticSpans } from './semanticSpans';
import { columnOf, detectColumns, joinLines } from './paragraphHeuristics';

export type LegendRect = [number, number, number, number];
export interface LegendSpan { text: string; rect: LegendRect; fontSize?: number }
export interface LegendOptions {
	pageIndex: number;
	pageWidth: number;
	pageHeight: number;
	segments: readonly LegendRect[];
	obstacles?: readonly LegendRect[];
}
type Line = { items: LegendSpan[]; rect: LegendRect; fontSize: number; text: string };
type Anchor = { marker: LegendRect; line: Line };
const size = (item: LegendSpan): number => item.fontSize && item.fontSize > 0 ? item.fontSize : item.rect[3] - item.rect[1];
const valid = (r: LegendRect): boolean => r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1];
const union = (rs: readonly LegendRect[]): LegendRect => [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3]))];
const overlaps = (a: LegendRect, b: LegendRect): boolean => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
function representative(items: readonly LegendSpan[]): number {
	const weights = new Map<number, number>();
	for (const item of items) weights.set(size(item), (weights.get(size(item)) ?? 0) + item.text.trim().length);
	return [...weights].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}
function sourceLines(items: readonly LegendSpan[]): Line[] {
	const rows: LegendSpan[][] = [];
	for (const item of items.filter(i => i.text.trim() && valid(i.rect) && Number.isFinite(size(i)) && size(i) > 0)
		.slice().sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0])) {
		const row = rows.find(r => r.some(other => {
			const h = Math.min(other.rect[3] - other.rect[1], item.rect[3] - item.rect[1]);
			return Math.min(other.rect[3], item.rect[3]) - Math.max(other.rect[1], item.rect[1]) >= h * .55;
		}));
		if (row) row.push(item); else rows.push([item]);
	}
	const lines: Line[] = [];
	for (const row of rows) {
		row.sort((a, b) => a.rect[0] - b.rect[0]);
		const groups: LegendSpan[][] = [];
		for (const item of row) {
			const group = groups.at(-1), previous = group?.at(-1);
			if (!group || !previous || item.rect[0] - previous.rect[2] > Math.max(size(previous), size(item)) * 1.6) groups.push([item]);
			else group.push(item);
		}
		for (const group of groups) {
			const fontSize = representative(group);
			lines.push({ items: group, rect: union(group.map(i => i.rect)), fontSize, text: joinSemanticSpans(group, { fontSize }) });
		}
	}
	return lines.sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
}
function connected(marker: LegendRect, segments: readonly LegendRect[], em: number): boolean {
	return segments.some(edge => Math.abs(edge[2] - edge[0]) <= em * .08
		&& Math.abs(edge[3] - edge[1]) >= em * .8
		&& [marker[0], marker[2]].some(x => Math.abs(x - edge[0]) <= em * .12)
		&& marker[1] >= Math.min(edge[1], edge[3]) - em * .12 && marker[1] <= Math.max(edge[1], edge[3]) + em * .12);
}
function matchMarker(segment: LegendRect, lines: readonly Line[], options: LegendOptions): Anchor | null {
	if (!segment.every(Number.isFinite)) return null;
	const marker: LegendRect = [Math.min(segment[0], segment[2]), (segment[1] + segment[3]) / 2, Math.max(segment[0], segment[2]), (segment[1] + segment[3]) / 2];
	const length = marker[2] - marker[0];
	if (!(length > 0) || Math.abs(segment[3] - segment[1]) > length * .035) return null;
	const matches = lines.filter(line => {
		const em = line.fontSize, r = line.rect;
		return em > 0 && length >= em * .5 && length <= em * 2.75
			&& r[0] - marker[2] >= em * .03 && r[0] - marker[2] <= em * .9
			&& marker[1] >= r[1] + em * .2 && marker[1] <= r[3] - em * .1
			&& (line.text.match(/\p{L}/gu) ?? []).length >= 3
			&& !connected(marker, options.segments, em)
			// A second short mark inside a text row is evidence that a row
			// builder joined neighbouring panels. Never mask that other mark.
			&& !options.segments.some(other => {
				const left = Math.min(other[0], other[2]), right = Math.max(other[0], other[2]);
				const width = right - left, y = (other[1] + other[3]) / 2;
				return width >= em * .5 && width <= em * 2.75 && Math.abs(other[3] - other[1]) <= width * .035
					&& left > r[0] + em * .3 && right < r[2] - em * .1
					&& y >= r[1] + em * .2 && y <= r[3] - em * .1;
			})
			&& !(options.obstacles ?? []).some(o => overlaps(r, o)
				|| marker[0] < o[2] && marker[2] > o[0] && marker[1] > o[1] && marker[1] < o[3]);
	});
	return matches.length === 1 ? { marker, line: matches[0]! } : null;
}
function sameStack(a: Anchor, b: Anchor): boolean {
	const em = Math.max(a.line.fontSize, b.line.fontSize);
	return Math.abs(a.line.fontSize - b.line.fontSize) <= em * .15
		&& Math.abs(a.marker[0] - b.marker[0]) <= em * .2
		&& Math.abs(a.marker[2] - b.marker[2]) <= em * .25
		&& Math.abs(a.line.rect[0] - b.line.rect[0]) <= em * .2;
}

/** Three or more repeated short horizontal marks are the structural evidence.
 * No model name, measurement, colour value or natural-language keyword is
 * needed to establish ownership. Ambiguous/shared source lines fail closed. */
export function extractLegendItems(items: readonly LegendSpan[], options: LegendOptions): { rest: LegendSpan[]; blocks: SourceBlock[] } {
	const unchanged = (): { rest: LegendSpan[]; blocks: SourceBlock[] } => ({ rest: items.slice(), blocks: [] });
	if (items.length < 3 || options.segments.length < 3 || !(options.pageWidth > 0 && options.pageHeight > 0)) return unchanged();
	const lines = sourceLines(items), anchors: Anchor[] = [], ambiguousLines = new Set<Line>();
	for (const segment of options.segments) {
		const anchor = matchMarker(segment, lines, options);
		if (!anchor) continue;
		const same = anchors.find(a => a.line === anchor.line);
		if (same) {
			// Duplicate edges of a thin painted rule are one marker. Distinct
			// marks claiming one line are ambiguous, so keep that source outside.
			if (Math.abs(same.marker[0] - anchor.marker[0]) > anchor.line.fontSize * .12
				|| Math.abs(same.marker[2] - anchor.marker[2]) > anchor.line.fontSize * .12) ambiguousLines.add(same.line);
			continue;
		}
		anchors.push(anchor);
	}
	const stacks: Anchor[][] = [];
	for (const anchor of anchors.filter(a => !ambiguousLines.has(a.line)).sort((a, b) => a.marker[0] - b.marker[0] || b.marker[1] - a.marker[1])) {
		const stack = stacks.find(s => sameStack(s[0]!, anchor));
		if (stack) stack.push(anchor); else stacks.push([anchor]);
	}
	const groups: { anchor: Anchor; lines: Line[] }[] = [];
	for (const column of stacks) {
		column.sort((a, b) => b.marker[1] - a.marker[1]);
		const bands: Anchor[][] = [];
		for (const anchor of column) {
			const band = bands.at(-1), previous = band?.at(-1), em = anchor.line.fontSize;
			if (!band || !previous || previous.marker[1] - anchor.marker[1] > em * 8) bands.push([anchor]); else band.push(anchor);
		}
		for (const band of bands.filter(b => b.length >= 3)) {
			const em = band[0]!.line.fontSize;
			if (band.some((a, i) => i > 0 && band[i - 1]!.marker[1] - a.marker[1] < em * 1.1)) continue;
			const maxStep = Math.max(...band.slice(1).map((a, i) => band[i]!.line.rect[3] - a.line.rect[3]));
			const right = Math.max(...band.map(a => a.line.rect[2])) + em * .6;
			const entries: { anchor: Anchor; lines: Line[] }[] = [];
			let safe = true;
			for (let index = 0; index < band.length; index++) {
				const anchor = band[index]!, next = band[index + 1];
				const bottom = next ? next.line.rect[3] + em * .05 : anchor.line.rect[3] - maxStep * 1.1;
				const own = [anchor.line];
				let raggedTail = false;
				const follows = (line: Line, previous: Line): boolean => Math.abs(line.rect[0] - anchor.line.rect[0]) <= em * .3
					&& Math.abs(line.fontSize - em) <= em * .15
					&& line.rect[2] <= right && previous.rect[1] - line.rect[3] >= -em * .1
					&& previous.rect[1] - line.rect[3] <= em * .75;
				for (const line of lines) {
					if (!next && own.length > 1 && own.at(-1)!.rect[2] - own.at(-1)!.rect[0]
						< (anchor.line.rect[2] - anchor.line.rect[0]) * .9) { raggedTail = true; break; }
					if (line === anchor.line || line.rect[3] >= anchor.line.rect[3] - em * .25 || line.rect[3] < bottom) continue;
					if (!follows(line, own.at(-1)!)) continue;
					if (ambiguousLines.has(line) || (options.obstacles ?? []).some(o => overlaps(line.rect, o)) || band.some(a => a !== anchor && a.line === line)) { safe = false; break; }
					own.push(line);
				}
				if (!safe || own.length > 5) { safe = false; break; }
				if (!next && entries.length && own.length > Math.max(...entries.map(entry => entry.lines.length))) { safe = false; break; }
				// A ragged tail followed immediately by same-style aligned text
				// might be either a deliberately wrapped label or a new caption.
				// Do not guess where that ambiguous flow changes ownership.
				if (!next && raggedTail && lines.some(l => !own.includes(l)
					&& l.rect[3] < own.at(-1)!.rect[3] - em * .25 && follows(l, own.at(-1)!))) { safe = false; break; }
				// A continuation running past the bounded final entry cannot be
				// safely separated from a neighbouring prose flow.
				if (!next && !raggedTail && lines.some(l => l.rect[3] < bottom && follows(l, own.at(-1)!))) { safe = false; break; }
				entries.push({ anchor, lines: own });
			}
			if (safe) groups.push(...entries);
		}
	}
	const ownership = new Map<LegendSpan, number>();
	groups.forEach(group => group.lines.flatMap(l => l.items).forEach(item => ownership.set(item, (ownership.get(item) ?? 0) + 1)));
	const accepted = groups.filter(group => group.lines.every(line => line.items.every(item => ownership.get(item) === 1)));
	const claimed = new Set<LegendSpan>();
	const columns = detectColumns(lines.map(line => line.rect), options.pageWidth, options.pageHeight);
	const blocks: SourceBlock[] = accepted.map((group, index) => {
		const rects = group.lines.map(line => [...line.rect] as LegendRect), area = union(rects), id = `page-${options.pageIndex}-legend-item-${index}`;
		group.lines.forEach(line => line.items.forEach(item => claimed.add(item)));
		return { id, pageIndex: options.pageIndex, order: index, type: 'paragraph', sourceText: joinLines(group.lines.map(l => l.text)),
			column: columnOf(area, columns, options.pageWidth),
			fontSize: group.anchor.line.fontSize, lineRectsPdf: rects,
			boundingBox: { x: area[0], y: options.pageHeight - area[3], width: area[2] - area[0], height: area[3] - area[1] },
			sourceRegion: { id, kind: 'legend-item', boundsPdf: area, evidence: 'marker-aligned-lines', markerPdf: [...group.anchor.marker] } };
	});
	return { rest: items.filter(item => !claimed.has(item)), blocks };
}
