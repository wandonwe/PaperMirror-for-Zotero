/**
 * Region coalescing — the pass between block extraction and translation.
 *
 * Extraction sometimes shreds a visual region into fragments: a structured
 * abstract becomes a dozen one-line "paragraphs", each translated in
 * isolation, each typeset in isolation — broken sentences on the way in,
 * scattered boxes on the way out. This pass rebuilds the SEMANTIC unit first:
 * consecutive body blocks that sit in the same column, at the same type size,
 * with only line-spacing between them, are one region. The region is
 * translated as one block (whole sentences, coherent terminology) and
 * typeset into its own union bounding box.
 *
 * Paragraph roles survive by construction: a genuine paragraph boundary
 * (blank line, or a role lead-in like "Methods and Results—" following a
 * finished sentence) joins with "\n\n", so the translator sees — and the
 * typesetter re-renders — the Background / Methods / Conclusions / Key Words
 * structure instead of one run-on wall.
 *
 * Pure logic, no DOM — fully unit-testable.
 */

import type { SourceBlock } from '../types/models';

type Rect = [number, number, number, number];

/** Providers cap request sizes; a region never exceeds this many characters. */
const MAX_REGION_CHARS = 2600;

/** Body types that may merge. Headings/titles/captions/tables never do. */
function isBodyBlock(block: SourceBlock): boolean {
	return (block.type === 'paragraph' || block.type === 'list')
		&& !block.isReference
		&& !!block.lineRectsPdf?.length;
}

function unionRect(rects: Rect[]): Rect {
	let x1 = Infinity;
	let y1 = Infinity;
	let x2 = -Infinity;
	let y2 = -Infinity;
	for (const r of rects) {
		x1 = Math.min(x1, r[0]);
		y1 = Math.min(y1, r[1]);
		x2 = Math.max(x2, r[2]);
		y2 = Math.max(y2, r[3]);
	}
	return [x1, y1, x2, y2];
}

/** Same column: x-overlap covers ≥55% of the wider box. */
function sameColumn(a: Rect, b: Rect): boolean {
	const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	const wider = Math.max(a[2] - a[0], b[2] - b[0]);
	return wider > 0 && overlap / wider >= 0.55;
}

function endsSentence(text: string): boolean {
	return /[.!?。！？:：][)\]"'”’]?\s*$/.test(text.trim());
}

/** "word-" → next fragment continues the same word. */
function endsHyphenated(text: string): boolean {
	return /[A-Za-z]-$/.test(text.trim());
}

export function canMerge(a: SourceBlock, b: SourceBlock): boolean {
	if (!isBodyBlock(a) || !isBodyBlock(b)) {
		return false;
	}
	const ra = unionRect(a.lineRectsPdf as Rect[]);
	const rb = unionRect(b.lineRectsPdf as Rect[]);
	if (!sameColumn(ra, rb)) {
		return false;
	}
	// b must sit BELOW a (PDF y grows upward): a's bottom edge above b's top.
	const gap = ra[1] - rb[3];
	const em = Math.max(a.fontSize ?? 10, 6);
	if (gap < -em * 0.6 || gap > em * 1.9) {
		return false;
	}
	// A type-size jump marks a boundary (a caption, a sidebar, a footnote).
	const fa = a.fontSize ?? 0;
	const fb = b.fontSize ?? 0;
	if (fa > 0 && fb > 0 && Math.abs(fa - fb) > Math.max(fa, fb) * 0.16) {
		return false;
	}
	if ((a.sourceText.length + b.sourceText.length) > MAX_REGION_CHARS) {
		return false;
	}
	return true;
}

/**
 * The separator between two merged fragments.
 *
 * A fragment that ends mid-sentence continues with a space (or joins directly
 * after a hyphenated line break); a finished sentence followed by a new
 * fragment is a PARAGRAPH boundary and keeps "\n\n", which is what carries
 * the Background / Methods / Conclusions structure through translation.
 */
export function separatorBetween(a: SourceBlock, b: SourceBlock): string {
	if (endsHyphenated(a.sourceText)) {
		return '';
	}
	if (!endsSentence(a.sourceText)) {
		return ' ';
	}
	// Both finished sentences and a visible line of spacing → new paragraph.
	const ra = unionRect(a.lineRectsPdf as Rect[]);
	const rb = unionRect(b.lineRectsPdf as Rect[]);
	const gap = ra[1] - rb[3];
	const em = Math.max(a.fontSize ?? 10, 6);
	return gap > em * 0.55 ? '\n\n' : ' ';
}

function mergeTwo(a: SourceBlock, b: SourceBlock): SourceBlock {
	const sep = separatorBetween(a, b);
	const joined = sep === '' && endsHyphenated(a.sourceText)
		? a.sourceText.trim().replace(/-$/, '') + b.sourceText.trim()
		: `${a.sourceText.trim()}${sep}${b.sourceText.trim()}`;
	return {
		...a,
		sourceText: joined,
		// Representative size follows the LONGER text, not blindly the first
		// fragment — fragment one may carry a drop cap or lead-in styling.
		fontSize: (b.sourceText.length > a.sourceText.length ? b.fontSize : a.fontSize) ?? a.fontSize,
		lineRectsPdf: [...(a.lineRectsPdf ?? []), ...(b.lineRectsPdf ?? [])],
		boundingBox: a.boundingBox && b.boundingBox
			? {
				x: Math.min(a.boundingBox.x, b.boundingBox.x),
				y: Math.min(a.boundingBox.y, b.boundingBox.y),
				width: Math.max(a.boundingBox.x + a.boundingBox.width, b.boundingBox.x + b.boundingBox.width)
					- Math.min(a.boundingBox.x, b.boundingBox.x),
				height: Math.max(a.boundingBox.y + a.boundingBox.height, b.boundingBox.y + b.boundingBox.height)
					- Math.min(a.boundingBox.y, b.boundingBox.y)
			}
			: a.boundingBox ?? b.boundingBox
	};
}

/**
 * A SHARD: a fragment extraction should never have made a block of — a bare
 * citation marker "(5,6).", a superscript run, or the torn-off tail of a
 * sentence ("ated light is isolated…"). Left alone, shards either translate
 * as gibberish or fall below the replacement size threshold and survive as
 * English crumbs inside a Chinese paragraph.
 */
export function isShard(block: SourceBlock): boolean {
	if (!isBodyBlock(block)) {
		return false;
	}
	const t = block.sourceText.trim();
	if (!t) {
		return false;
	}
	// Bare citation/reference markers.
	if (/^[[(]?\d+(\s*[,–—-]\s*\d+)*[\])]?[.,]?$/.test(t)) {
		return true;
	}
	// Tiny fragments of any kind.
	if (t.length <= 12) {
		return true;
	}
	// A torn-off continuation: starts lowercase mid-word/mid-sentence.
	return t.length <= 60 && /^[a-z]/.test(t);
}

/**
 * Absorption is deliberately LOOSER than canMerge: a shard belongs to its
 * neighbour even when the font drifted (superscripts) or the gap is odd —
 * geometry only has to say "same column, adjacent-ish".
 */
export function canAbsorb(host: SourceBlock, shard: SourceBlock): boolean {
	if (!isBodyBlock(host) || !host.lineRectsPdf?.length || !shard.lineRectsPdf?.length) {
		return false;
	}
	const rh = unionRect(host.lineRectsPdf as Rect[]);
	const rs = unionRect(shard.lineRectsPdf as Rect[]);
	// Same column at a relaxed 40%, or the shard sits inside the host's span.
	const overlap = Math.min(rh[2], rs[2]) - Math.max(rh[0], rs[0]);
	const narrower = Math.min(rh[2] - rh[0], rs[2] - rs[0]);
	if (narrower > 0 && overlap / narrower < 0.4) {
		return false;
	}
	const em = Math.max(host.fontSize ?? 10, 6);
	// Vertically adjacent or overlapping, up to 3em apart either way.
	const gap = Math.max(rh[1] - rs[3], rs[1] - rh[3]);
	if ((host.sourceText.length + shard.sourceText.length) > MAX_REGION_CHARS) {
		return false;
	}
	return gap <= em * 3;
}

/**
 * Coalesce a page's blocks into regions. Order is preserved; only
 * consecutive-in-reading-order body blocks merge, so a heading between two
 * paragraphs always splits them. Shards then get a second, looser pass:
 * anything that should never have been its own block is absorbed into the
 * nearest adjacent body region (previous first, next as fallback).
 */
export function coalesceRegions(blocks: SourceBlock[]): SourceBlock[] {
	const out: SourceBlock[] = [];
	for (const block of blocks) {
		const last = out[out.length - 1];
		if (last && canMerge(last, block)) {
			out[out.length - 1] = mergeTwo(last, block);
		}
		else {
			out.push({ ...block });
		}
	}
	// Shard absorption. Backward into the previous region reads naturally
	// (citations follow the text they cite); forward is the fallback.
	for (let i = out.length - 1; i >= 0; i--) {
		const shard = out[i]!;
		if (!isShard(shard)) {
			continue;
		}
		const prev = out[i - 1];
		const next = out[i + 1];
		if (prev && canAbsorb(prev, shard)) {
			out[i - 1] = mergeTwo(prev, shard);
			out.splice(i, 1);
		}
		else if (next && canAbsorb(next, shard)) {
			out[i + 1] = mergeTwo(shard, next);
			out.splice(i, 1);
		}
	}
	// Re-number so ids stay unique and ordered after merging.
	return out.map((block, index) => ({
		...block,
		id: `page-${block.pageIndex}-region-${index}`,
		order: index
	}));
}
