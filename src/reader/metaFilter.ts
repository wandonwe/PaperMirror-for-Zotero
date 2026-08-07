/**
 * Metadata / boilerplate detection — pure, no DOM.
 *
 * A journal page carries a lot of text that should NOT go through the
 * translator: author lists, affiliations, correspondence lines, copyright and
 * licence boilerplate, DOI/URL lines, download watermarks, running heads.
 * Sending them anyway produced the garbled 「Andreas Angelopoulos*, Andreas
 * Angelopoulos, 11」 output and let the author block bleed into the abstract.
 * The reader still sees all of it — untouched — on the original page; the
 * translation pane simply skips it.
 *
 * Rules are deliberately conservative: a false negative costs a poorly
 * translated author line (the status quo), a false positive would silently
 * drop real content. Anything ambiguous is kept.
 */

export type Rect = [number, number, number, number];

/** Text along a page edge rotated 90° — the download watermark shape. */
export function isVerticalSliver(rect: Rect): boolean {
	const width = rect[2] - rect[0];
	const height = rect[3] - rect[1];
	return width > 0 && height > 0 && height > width * 6 && width < 30;
}

const RE_RECEIVED = /\b(received|revised|accepted|published online|available online|publish-ahead-of-print)\b.{0,60}\b(20\d\d|19\d\d)\b/i;
const RE_COPYRIGHT = /©|\(c\)\s?20\d\d|\bcopyright\b|creative\s?commons|open access article|all rights reserved|licen[cs]e|\breuse\b.{0,40}\bdistribution\b|non-?commercial/i;
const RE_CORRESPONDENCE = /\b(corresponding author|correspondence to|e-?mail|电子邮件|通讯作者)\b|@[a-z0-9.-]+\.[a-z]{2,}/i;
const RE_DOI_URL = /\b(doi|https?):|doi\.org|academic\.oup\.com|downloaded from/i;
const RE_AFFILIATION_HEAD = /^[\d¹²³⁴⁵*†‡§,\s]{0,8}(department|division|institute|university|hospital|center|centre|school|laboratory|faculty|clinic)\b/i;
const RE_DEGREES = /\b(MD|PhD|MSc|MBBS|MBBCh|BChir|MB|DPhil|DrPH|FACC|FESC|FRCP|RN|MPH)\b/g;
const RE_AUTHOR_NOTES = /contributed equally|authors.{0,3} affiliations|conflicts? of interest|funding (?:statement|sources?)|appendix paragraph|supplementary (?:data|material).{0,30}(?:online|published)/i;

const INSTITUTION_WORDS = /\b(university|hospital|department|institute|center|centre|school|laboratory|clinic|college|academy)\b/gi;

/** Line naming the authors: mostly capitalised name tokens + marks/digits. */
function looksLikeAuthorList(text: string): boolean {
	if (text.length > 420 || text.length < 12) {
		return false;
	}
	// Sentences read like prose; author lines read like a roster. Initials
	// ("Alexios S. Antonopoulos") are not sentence boundaries, so strip
	// single-letter abbreviations before testing.
	const withoutInitials = text.replace(/\b[A-Z]\./g, '');
	if (/[.!?。][\s]/.test(withoutInitials.slice(0, -6))) {
		return false;
	}
	const commas = (text.match(/,/g) ?? []).length;
	if (commas < 2) {
		return false;
	}
	const tokens = text.split(/\s+/).filter(t => /[a-zA-Z]/.test(t));
	if (tokens.length < 4) {
		return false;
	}
	// Names often carry their superscript affiliations inline once extracted
	// ("Garg3," "Bax6,7,") — digits and marks are part of the roster look.
	const nameLike = tokens.filter(t => /^[A-Z][a-zA-Z'’.-]*[\d,;*†‡§]*$/.test(t)).length;
	const hasMarks = /[*†‡§]|\d/.test(text);
	return hasMarks && nameLike / tokens.length >= 0.66;
}

/** Three or more academic-degree tokens: nothing but an author roster has that. */
function hasDegreeRoster(text: string): boolean {
	const matches = text.match(RE_DEGREES);
	return (matches?.length ?? 0) >= 3;
}

/** Affiliation line: institutions strung together with commas. */
function looksLikeAffiliation(text: string): boolean {
	if (text.length > 600) {
		return false;
	}
	if (RE_AFFILIATION_HEAD.test(text)) {
		return true;
	}
	const institutions = (text.match(INSTITUTION_WORDS) ?? []).length;
	const commas = (text.match(/,/g) ?? []).length;
	return institutions >= 2 && commas >= 3;
}

/**
 * Should this block be excluded from translation and from the pane?
 * The original page keeps showing it either way.
 */
export function isMetadataBlock(text: string, rect?: Rect): boolean {
	const t = text.trim();
	if (!t) {
		return true;
	}
	if (rect && isVerticalSliver(rect)) {
		return true;
	}
	// Orphan digits/marks: stray superscript affiliation numbers or page
	// numbers extracted as their own blocks. Nothing to translate.
	if (t.length < 40 && /^[\d\s.,;:*†‡§()\-–—]+$/.test(t)) {
		return true;
	}
	if (RE_AUTHOR_NOTES.test(t) && t.length < 300) {
		return true;
	}
	if (hasDegreeRoster(t) && t.length < 900) {
		return true;
	}
	if (RE_RECEIVED.test(t)) {
		return true;
	}
	if (RE_COPYRIGHT.test(t)) {
		return true;
	}
	if (RE_CORRESPONDENCE.test(t)) {
		return true;
	}
	// URL/DOI lines are short; a body paragraph that merely CITES a URL is
	// long and must be kept.
	if (RE_DOI_URL.test(t) && t.length < 220) {
		return true;
	}
	if (looksLikeAuthorList(t)) {
		return true;
	}
	if (looksLikeAffiliation(t)) {
		return true;
	}
	return false;
}
