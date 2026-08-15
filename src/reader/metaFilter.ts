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

/**
 * Publisher watermark/boilerplate LINE — dropped from extraction entirely,
 * BEFORE column detection, wherever it sits on the page.
 *
 * Position-based furniture filters (bottom/top 6%) miss these on PAGE 1, where
 * "This copy is for personal use only. To order copies, contact
 * reprints@rsna.org" often sits mid-page near the abstract — a centered line
 * across the gutter that bridges the two columns into one band and shreds the
 * whole page. Content is the reliable signal: these phrases never occur in
 * body prose. Short-line cap so a real paragraph QUOTING such text survives.
 */
const RE_BOILERPLATE_LINE = new RegExp(
	[
		'this copy is for personal use',
		'for personal use only',
		'to order (?:printed )?copies',
		'reprints?@',
		'contact reprints',
		'downloaded (?:from|by)',
		'all rights reserved',
		'©\\s*(?:[A-Za-z]+\\s*)?(?:19|20)\\d\\d'
	].join('|'),
	'i'
);

export function isPublisherBoilerplateLine(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 180) {
		return false;
	}
	return RE_BOILERPLATE_LINE.test(t);
}

/** Text along a page edge rotated 90° — the download watermark shape. */
export function isVerticalSliver(rect: Rect): boolean {
	const width = rect[2] - rect[0];
	const height = rect[3] - rect[1];
	return width > 0 && height > 0 && height > width * 6 && width < 30;
}

const RE_RECEIVED = /\b(received|revised|accepted|published online|available online|publish-ahead-of-print)\b.{0,60}\b(20\d\d|19\d\d)\b/i;
// Front-matter labels journals set in the margin sidebar or above the title
// (PLOS, Frontiers, MDPI…): "Citation:", "Academic Editor:", "Funding:" …
// The colon is required so body prose starting with the same word survives.
const RE_META_LABEL = /^(citation|(?:academic|handling|section|associate|guest)\s+editor|editor|received|accepted|published|posted|copyright|funding|competing interests?|conflicts? of interest|data availability(?: statement)?|abbreviations|author contributions?|provenance|peer review(?:er)?s?(?: information)?|ethics(?: statement)?|patient consent|trial registration)\s*[::]/i;
// Standalone article-type banners and badges.
const RE_ARTICLE_BANNER = /^(research article|review(?: article)?|original (?:article|research|investigation)|open access|case report|short communication|brief report|editorial|systematic review|meta-analysis|clinical trial|letter to the editor|perspective|commentary|rapid communication|technical note|crossmark|check for updates)$/i;
// Funding boilerplate: grant numbers and the funders-had-no-role sentence.
const RE_GRANT = /\bgrants?\s?(?:nos?|numbers?|#)\b\.?\s*:?\s*[\w-]/i;
// Licence tails split off from the © head block ("…provided the original
// author and source are credited.").
const RE_LICENSE_TAIL = /provided the original (?:work|author|source)|source are credited|reproduction in any medium|funders? had no role|decision to publish|preparation of the manuscript/i;
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
 * Running head / running foot: the journal's own furniture repeated on every
 * page — the article title strip at the top, and the
 * "PLOS ONE | DOI:10.1371/… March 17, 2015    1 / 13" line at the bottom.
 *
 * Purely geometric plus a shape test, because the text itself is often a
 * verbatim copy of the paper's title and cannot be told apart by wording. Only
 * SHORT runs in the top/bottom 8% band qualify: a body paragraph that happens
 * to reach into the band is many lines long and stays.
 */
export function isRunningHeadOrFoot(
	rect: Rect,
	pageHeight: number,
	lineCount: number,
	text: string
): boolean {
	if (pageHeight <= 0) {
		return false;
	}
	const band = pageHeight * 0.08;
	const inTop = rect[1] > pageHeight - band;
	const inBottom = rect[3] < band;
	if (!inTop && !inBottom) {
		return false;
	}
	const t = text.trim();
	if (/^\d{1,4}$/.test(t) || /^\d{1,3}\s*[/／|]\s*\d{1,3}$/.test(t)) {
		return true;
	}
	return lineCount <= 2 && t.length <= 140;
}

/**
 * Narrow outer-margin sidebar column — the PLOS/Frontiers front-matter strip
 * (citation, editor, dates, copyright, funding). Real reading columns are far
 * wider: a two-column page's columns run ~0.44 of the page width, a
 * three-column page's ~0.28.
 */
export function isMarginSidebar(rect: Rect, pageWidth: number, type?: { fontSize?: number; bodySize?: number }): boolean {
	const width = rect[2] - rect[0];
	const height = rect[3] - rect[1];
	if (width <= 0 || pageWidth <= 0) {
		return false;
	}
	// 正文尺寸的窄栏是正文,不是页边栏 (1.1.9, Horst 2024 第 5/11 页实证):
	// 期刊正文在整版图旁边会挤成一条 <24% 页宽的窄栏 (第 11 页左栏 96pt),尺寸
	// 与真页边栏 (narrow + tall + outer) 完全重合,于是整列正文被当页边引用/
	// 编辑栏静默丢弃 —— 只有被词距意外撕成单行的碎片 (高度 < 30pt) 侥幸活下来,
	// 就是用户看到的那一小撮孤立中文。真页边栏一定比正文排得小 (期刊页边 7pt
	// vs 正文 10pt),所以字号 ≥ 正文字号 × 0.9 的块直接排除在页边栏判定之外。
	// 这不放松任何一条文本规则 (RE_META_LABEL / 作者名单 / 版权 等照旧生效)。
	const fs = type?.fontSize ?? 0;
	const bs = type?.bodySize ?? 0;
	if (fs > 0 && bs > 0 && fs >= bs * 0.9) {
		return false;
	}
	const narrow = width < pageWidth * 0.24;
	// A sidebar entry is a stack of wrapped lines; a single short body line
	// that happens to sit at the left margin is not (label-style one-liners
	// like "Published: …" are caught by the text rules instead).
	const tall = height >= 30;
	const outerLeft = rect[2] < pageWidth * 0.34;
	const outerRight = rect[0] > pageWidth * 0.66;
	return narrow && tall && (outerLeft || outerRight);
}

/**
 * Should this block be excluded from translation and from the pane?
 * The original page keeps showing it either way.
 */
export function isMetadataBlock(text: string, rect?: Rect, pageWidth?: number, type?: { fontSize?: number; bodySize?: number }): boolean {
	const t = text.trim();
	if (!t) {
		return true;
	}
	if (rect && isVerticalSliver(rect)) {
		return true;
	}
	// Anything living in the narrow outer sidebar is front matter, whatever it
	// says — that strip is where journals put the citation/editor/funding
	// stack, and its entries keep leaking past the text rules one novel
	// format at a time.
	if (rect && pageWidth && isMarginSidebar(rect, pageWidth, type) && t.length < 700) {
		return true;
	}
	if (RE_META_LABEL.test(t) && t.length < 700) {
		return true;
	}
	if (t.length < 40 && RE_ARTICLE_BANNER.test(t)) {
		return true;
	}
	if (RE_GRANT.test(t) && t.length < 700) {
		return true;
	}
	if (RE_LICENSE_TAIL.test(t) && t.length < 700) {
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
