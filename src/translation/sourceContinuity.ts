/**
 * Translation-only links between source sentence fragments. A link never
 * changes a block's text, ID, page, geometry or order. The graph is built from
 * the complete source order, before cached/missing/risky blocks are filtered.
 */
import type { SourceBlock } from '../types/models';

export interface ContinuationContext {
	before: string;
	after: string;
}

type Rect = [number, number, number, number];
type Candidate = { block: SourceBlock; index: number; all: SourceBlock[] };
type Node = Candidate & { previous?: Node; next?: Node };

// Keep a complete sentence-side or omit it. Taking the last N characters of
// an oversized sentence could remove its negation, subject or temporal clause.
const MAX_SIDE_CHARS = 1800;
const CLOSERS = /[)\]}'"”’»」』]/;
const SUPERSCRIPTS = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;
const TERMINALS = /[.!?。！？]/;

// Recognise specific abbreviation roles, rather than suppressing every stop
// before a lower-case letter or every capitalised token. At the end of the
// available text even a known abbreviation remains an ambiguous sentence end.
const SENTENCE_STARTER = /^(?:A|An|The|This|That|These|Those|It|We|They|He|She|Our|However|Therefore|Furthermore|Moreover|Nevertheless|In|For|After|Before|When|No|Neither|All|There|Both|Each|Results|Methods|Conclusions?|Discussion)\b/;

function abbreviationPeriod(text: string, index: number, end: number): boolean {
	const following = text.slice(end).trimStart();
	if (!following) return false;
	const prefix = text.slice(0, index + 1);
	// Internal dots of an initialism (i.e., e.g., U.S.) cannot end a sentence.
	if (/^[A-Za-z]\./.test(text.slice(index + 1))) return true;
	// Explanatory/comparison abbreviations can introduce names or acronyms too.
	if (/\b(?:i\.e|e\.g|viz|cf|vs|resp)\.$/i.test(prefix)) return true;
	// Figure/equation/reference labels use numbers, letter-number labels or a
	// single/roman label. A following ordinary capitalised sentence is excluded.
	if (/\b(?:figs?|eqs?|refs?|secs?|vols?|nos?|pp?|chaps?|arts?|apps?|suppl)\.$/i.test(prefix)
		&& /^[([]?(?:[A-Z]?\d|[IVX]+\b|[A-Z]\b)/.test(following)) return true;
	// Titles and personal initials are followed by a name/initial chain, not an
	// arbitrary capitalised sentence. Common sentence openers veto that reading.
	const nameFollows = !SENTENCE_STARTER.test(following)
		&& /^(?:(?:[A-Z]\.)\s*)*(?:[A-Z][\p{Ll}\p{M}'’\-]+|(?:van|von|de|del|da|di)\s+[A-Z][\p{Ll}\p{M}'’\-]+)/u.test(following);
	if (nameFollows && (/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)\.$/i.test(prefix) || /\b[A-Z]\.$/.test(prefix))) return true;
	// These abbreviations can finish a sentence, so only visible continuation
	// evidence lets their internal stop remain part of the unfinished sentence.
	const continues = /^[\p{Ll}\p{N},;:]/u.test(following);
	if (continues && /\b(?:et\s+al|etc|approx|ca|Inc|Ltd|Co|Ph\.D|M\.D|B\.Sc|M\.Sc|D\.Phil)\.$/i.test(prefix)) return true;
	return continues && /(?:\b[A-Za-z]\.){2,}$/.test(prefix);
}

function clean(text: string): string {
	return text.trim().replace(/\s+/g, ' ');
}

/** Sentence stops, excluding decimals and dotted initials such as i.e./e.g. */
function sentenceStops(text: string): number[] {
	const stops: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (!TERMINALS.test(char)) continue;
		if (char === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) continue;
		let end = i + 1;
		while (end < text.length && (CLOSERS.test(text[end]!) || SUPERSCRIPTS.test(text[end]!))) end++;
		if (char === '.' && abbreviationPeriod(text, i, end)) continue;
		// Punctuation embedded in a word/identifier is not a sentence boundary.
		if (end < text.length && !/\s/.test(text[end]!)) continue;
		stops.push(end);
	}
	return stops;
}

function unfinished(text: string): boolean {
	const value = clean(text);
	if (!value) return false;
	const stops = sentenceStops(value);
	return stops[stops.length - 1] !== value.length;
}

function tailSentence(text: string): { text: string; hasStart: boolean } {
	const value = clean(text);
	const stops = sentenceStops(value);
	const last = stops[stops.length - 1];
	return { text: last === undefined ? value : value.slice(last).trim(), hasStart: last !== undefined };
}

function headSentence(text: string): { text: string; hasEnd: boolean } {
	const value = clean(text);
	const end = sentenceStops(value)[0];
	return { text: end === undefined ? value : value.slice(0, end).trim(), hasEnd: end !== undefined };
}

function startsContinuation(text: string): boolean {
	const value = clean(text);
	// Capitals alone cannot establish continuation into a new paragraph. A
	// lower-case word, number, unfinished parenthesis/list, or comparator can.
	return /^[\p{Ll}\p{N},;:)\]\-–—(<≤≥=]/u.test(value);
}

function isBody(block: SourceBlock): boolean {
	if (block.type !== 'paragraph' && block.type !== 'list') return false;
	if (block.translationMode === 'preserve' || block.isReference || block.imageTextRegionPdf) return false;
	if (block.tableId !== undefined || block.tableRow !== undefined || block.tableCol !== undefined) return false;
	return !block.sourceRegion || block.sourceRegion.kind === 'body-column';
}

function isSectionBarrier(block: SourceBlock): boolean {
	if (block.type !== 'heading' && block.type !== 'title') return false;
	if ((block.sourceRegion && block.sourceRegion.kind !== 'body-column') || block.imageTextRegionPdf) return false;
	// A figure/table title is not a section boundary in the body stream.
	return !/^(?:fig(?:ure)?\.?|table|图|表|圖)\s*\d/iu.test(clean(block.sourceText));
}

function candidates(blocks: SourceBlock[]): Candidate[] {
	const hasOwnedBody = blocks.some(b => isBody(b) && b.sourceRegion?.kind === 'body-column');
	return blocks.flatMap((block, index) => isBody(block)
		&& (!hasOwnedBody || block.sourceRegion?.kind === 'body-column')
		&& clean(block.sourceText)
		? [{ block, index, all: blocks }]
		: []);
}

function rects(block: SourceBlock): Rect[] | undefined {
	const lines = block.lineRectsPdf;
	if (!lines?.length || !lines.every(r => r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1])) return undefined;
	const box = block.boundingBox;
	if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return undefined;
	return lines;
}

function width(block: SourceBlock): number {
	const owned = block.sourceRegion?.kind === 'body-column' ? block.sourceRegion.boundsPdf : undefined;
	return owned && owned.every(Number.isFinite) && owned[2] > owned[0]
		? owned[2] - owned[0]
		: block.boundingBox?.width ?? 0;
}

function fontSize(block: SourceBlock): number {
	if (Number.isFinite(block.fontSize) && block.fontSize! > 0) return block.fontSize!;
	const line = block.lineRectsPdf?.[0];
	return line ? line[3] - line[1] : 0;
}

function comparable(a: SourceBlock, b: SourceBlock): boolean {
	if (!rects(a) || !rects(b)) return false;
	const wa = width(a), wb = width(b);
	const fa = fontSize(a), fb = fontSize(b);
	return Math.min(wa, wb) / Math.max(wa, wb) >= 0.75
		&& Math.min(fa, fb) / Math.max(fa, fb) >= 0.8;
}

function filledTail(block: SourceBlock): boolean {
	const lines = rects(block);
	if (!lines) return false;
	const last = lines[lines.length - 1]!;
	const owned = block.sourceRegion?.kind === 'body-column' ? block.sourceRegion.boundsPdf : undefined;
	const right = owned?.every(Number.isFinite) ? owned[2] : block.boundingBox!.x + block.boundingBox!.width;
	const w = width(block);
	return last[2] - last[0] >= w * 0.75
		&& Math.abs(right - last[2]) <= Math.max(fontSize(block) * 1.5, w * 0.035);
}

function sectionBetween(a: Candidate, b: Candidate): boolean {
	return a.all.slice(a.index + 1, b.index).some(isSectionBarrier);
}

function boundaryHasSection(item: Candidate, side: 'before' | 'after'): boolean {
	return (side === 'before' ? item.all.slice(0, item.index) : item.all.slice(item.index + 1)).some(isSectionBarrier);
}

function samePageLink(a: Candidate, b: Candidate): boolean {
	const x = a.block, y = b.block;
	if (x.pageIndex !== y.pageIndex || sectionBetween(a, b)) return false;
	if (!unfinished(x.sourceText) || !startsContinuation(y.sourceText) || !comparable(x, y)) return false;
	const bx = x.boundingBox!, by = y.boundingBox!;
	const overlap = Math.min(bx.x + bx.width, by.x + by.width) - Math.max(bx.x, by.x);
	const sameColumn = typeof x.column === 'number' && typeof y.column === 'number'
		? x.column === y.column
		: overlap >= Math.max(bx.width, by.width) * 0.55;
	if (sameColumn) {
		const gap = by.y - (bx.y + bx.height);
		return overlap >= Math.max(bx.width, by.width) * 0.55
			&& gap >= -fontSize(x) * 0.5 && gap <= Math.max(fontSize(x), fontSize(y)) * 2.5;
	}
	// A column wrap must proceed to the immediately following column. Missing
	// column stamps cannot prove a wrap, so they are deliberately not guessed.
	return typeof x.column === 'number' && x.column >= 0 && y.column === x.column + 1
		&& by.x > bx.x && filledTail(x);
}

function crossPageLink(a: Candidate, b: Candidate): boolean {
	return b.block.pageIndex === a.block.pageIndex + 1
		&& !boundaryHasSection(a, 'after') && !boundaryHasSection(b, 'before')
		&& unfinished(a.block.sourceText) && startsContinuation(b.block.sourceText)
		&& comparable(a.block, b.block) && filledTail(a.block);
}

/** Whether bounded adjacent-page extraction can supply missing body context. */
export function pageContinuityNeeds(blocks: SourceBlock[]): { previous: boolean; next: boolean } {
	const body = candidates(blocks);
	const first = body[0], last = body[body.length - 1];
	return {
		previous: !!first && first.block.pageIndex > 0 && !!rects(first.block)
			&& startsContinuation(first.block.sourceText) && !boundaryHasSection(first, 'before'),
		next: !!last && unfinished(last.block.sourceText) && filledTail(last.block)
			&& !boundaryHasSection(last, 'after')
	};
}

function beforeContext(node: Node): string {
	let cursor = node.previous;
	let result = '';
	let first: Node | undefined;
	let confirmedStart = false;
	while (cursor) {
		first = cursor;
		const part = tailSentence(cursor.block.sourceText);
		result = clean(`${part.text} ${result}`);
		if (result.length > MAX_SIDE_CHARS) return '';
		if (part.hasStart) { confirmedStart = true; break; }
		cursor = cursor.previous;
	}
	return first && (confirmedStart || reliableStart(first)) ? result : '';
}

function reliableStart(node: Node): boolean {
	// A source sentence can begin with an uppercase name/acronym, including
	// opening quotation/parenthesis. A lower-case/numeric graph boundary alone
	// cannot establish that a negation was not on an unavailable earlier page.
	if (/^[“‘"'(\[]*\p{Lu}/u.test(clean(node.block.sourceText))) return true;
	const samePageBefore = node.all.slice(0, node.index).filter(b => b.pageIndex === node.block.pageIndex);
	if (node.block.pageIndex === 0 && !samePageBefore.some(isBody)) return true;
	for (let i = samePageBefore.length - 1; i >= 0; i--) {
		const preceding = samePageBefore[i]!;
		if (isSectionBarrier(preceding)) return true;
		if (isBody(preceding)) return false;
	}
	return false;
}

function afterContext(node: Node): string {
	let cursor = node.next;
	let result = '';
	while (cursor) {
		const part = headSentence(cursor.block.sourceText);
		result = clean(`${result} ${part.text}`);
		if (result.length > MAX_SIDE_CHARS) return '';
		if (part.hasEnd) return result;
		cursor = cursor.next;
	}
	// Reaching a bounded graph edge without a full stop leaves a partial
	// thought. Do not present that partial side as a complete semantic context.
	return '';
}

/**
 * Neighbours are source-only and must belong to the immediately adjacent
 * pages. Contexts are returned only for the supplied current-page blocks.
 */
export function buildContinuityContexts(
	blocks: SourceBlock[],
	neighbors: { previous?: SourceBlock[]; next?: SourceBlock[] } = {}
): Map<string, ContinuationContext> {
	const current = candidates(blocks);
	const result = new Map<string, ContinuationContext>();
	if (!current.length) return result;
	const page = current[0]!.block.pageIndex;
	if (current.some(item => item.block.pageIndex !== page)) return result;
	const previous = candidates(neighbors.previous ?? []).filter(item => item.block.pageIndex === page - 1);
	const next = candidates(neighbors.next ?? []).filter(item => item.block.pageIndex === page + 1);
	const groups = [previous, current, next].map(group => group.map(item => ({ ...item } as Node)));
	for (const group of groups) {
		for (let i = 1; i < group.length; i++) {
			const before = group[i - 1]!, after = group[i]!;
			if (samePageLink(before, after)) { before.next = after; after.previous = before; }
		}
	}
	for (let i = 1; i < groups.length; i++) {
		const a = groups[i - 1]!, b = groups[i]!;
		const before = a[a.length - 1], after = b[0];
		if (before && after && crossPageLink(before, after)) { before.next = after; after.previous = before; }
	}
	const ids = new Map<string, number>();
	for (const node of groups[1]!) ids.set(node.block.id, (ids.get(node.block.id) ?? 0) + 1);
	for (const node of groups[1]!) {
		if (ids.get(node.block.id) !== 1) continue;
		const before = beforeContext(node), after = afterContext(node);
		if (before || after) result.set(node.block.id, { before, after });
	}
	return result;
}

/** Empty explicit contexts also version the identity after a neighbour failure. */
export function contextualSourceText(block: SourceBlock): string {
	const context = block.continuationContext;
	return context === undefined ? block.sourceText : JSON.stringify([
		'PaperMirror.source-continuity.v3', block.sourceText, context.before, context.after,
  ...(context.identity ? [context.identity] : [])
	]);
}
