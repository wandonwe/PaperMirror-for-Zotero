/**
 * 参考文献续页识别 (5.0, 联网校验 3384 p10 / 3132 p13)。
 *
 * isReference 原来只从「本页或更早的页上出现过 References 标题」推出来,而
 * 更早的页要先被抽取过才知道。直接打开到末页、或预取先抽到后面的页时,续页
 * 上的条目被当成普通正文: 区域合并把十几条拼成一段 2000 多字、两端对齐的
 * 条目被当成表格拆碎、"回声可接受"的规则也不生效。这里按内容认: 页上有足够
 * 多的「编号 + 姓 + 首字母」条目开头,且大多带年份。
 */

/** "12. Zhang X," / "[12] J. Smith," / "12 Smith AB," —— 编号后跟姓与首字母。 */
// 校验 r23: surname particles ("1 van Everdingen KJ", "1. de Castro SM") and
// initials glued to the surname by the PDF's spacing ("3. SmitsFJ, van
// SantvoortHC", "4. NakataK,MoriY") — 3007 and 2845 had no reference pages at all.
/** Surname particles, as a regex source matching up to three of them (shared with translation acceptance). */
export const SURNAME_PARTICLES = String.raw`(?:(?:van|von|de|der|den|du|da|di|del|della|des|dos|das|le|la|ten|ter|zu|el|al)\s+){0,3}`;
// IEEE / book bibliographies put the initials first and may name one author:
// "[17] R. F. Ahlswede and G. Dueck." / "[27] R. B. Ash. Information Theory." (3200).
const SURNAME_INITIALS = String.raw`(?:(?:[A-Z]\.\s?){0,3}[A-Z][\p{L}'’\-]+(?:\s+[A-Z][\p{L}'’\-]+)?,?\s+(?:[A-Z]{1,3}\b|[A-Z]\.)|[A-Z][\p{L}'’\-]*\p{Ll}[A-Z]{1,3}[,.]|(?:[A-Z]\.\s?(?:-?[A-Z]\.\s?)?){1,3}${SURNAME_PARTICLES}[A-Z][\p{L}'’\-¨´\u0060]+(?:,|\.|\s+and\s))`;
// Without the period the label needs Vancouver punctuation after the initials
// ("20 Bogousslavsky J," — not the running head "3 The CT Coronary Analysis…").
const ENTRY_START = new RegExp(String.raw`^\s*(?:(?:\[\d{1,3}\]|\d{1,3}\.)\s+${SURNAME_PARTICLES}${SURNAME_INITIALS}|\d{1,3}\s+${SURNAME_PARTICLES}[A-Z][\p{L}'’\-]+(?:\s+[A-Z][\p{L}'’\-]+)?\s+[A-Z]{1,3}[,.:])`, 'u');
// A year glued to the journal by the PDF's spacing still counts ("Br J Surg2005;92", 校验 r23 3007).
export const YEAR = /(?<![\d.])(?:19|20)\d{2}(?!\d)/;

/** One line or paragraph that starts like a numbered reference entry. */
export function startsReferenceEntry(text: string): boolean {
	if (SUPERSCRIPT_ENTRY.test(text) || SUPERSCRIPT_ORG_ENTRY.test(text)) return true;
	return ENTRY_START.test(text.trim().slice(0, 80));
}

/**
 * Superscript-numbered entries (5.0, 校验 3084 Medical Physics / AIP style):
 * "⁷S. Rathee, B. G. Fallone, and D. Robinson," or "¹²E. Samei,". The label
 * arrives as raised small digits, which the extractor writes as superscripts.
 */
const SUPERSCRIPT_ENTRY = /^\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}\s*(?:(?:[A-Z]\.\s?(?:-?[A-Z]\.\s?)?){1,3}[A-Z][\p{L}'’\-]+|[A-Z][\p{L}'’\-]+,?\s+(?:[A-Z]{1,3}\b|[A-Z]\.))/u;

/**
 * Is this page (given its line texts, in any order) a reference list? At least
 * four entry starts, most entries carrying a year somewhere in the text, and
 * entry lines making up a real share of the page's lines.
 */
export function looksLikeReferencePage(lines: string[]): boolean {
	const starts = lines.filter(startsReferenceEntry).length;
	if (starts < 4) return false;
	const years = lines.filter(l => YEAR.test(l)).length;
	return years >= starts * 0.6 && starts >= lines.length * 0.08;
}

/**
 * A line that continues a reference entry even though it begins with a number:
 * "93. doi: 10.1007/…" is the tail of "474:2384–" from the line above, not
 * entry 93.
 */
export function isReferenceTailLine(text: string): boolean {
	return /^\s*\d{1,4}[.,;:)]?\s*(?:doi\b|https?:|www\.|PMID\b)/i.test(text);
}

/** 真机 4.99.16 (3084 p8): an organization as author — "³International Commission on Radiation Units…,". */
const SUPERSCRIPT_ORG_ENTRY = /^\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}\s*\p{Lu}[\p{L}'’\-]+(?:\s(?:(?:of|on|for|and|the|in)\s)*\p{Lu}[\p{L}'’\-]+){1,8}\s?,/u;
const SUPERSCRIPT_ENTRY_GLOBAL = /(?:^|\s)[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}\s*(?:[A-Z]\.\s?){1,3}[A-Z][\p{L}'’\-]+/gu;
// Raw page text has no line starts to anchor on: here the label keeps its period.
const ENTRY_START_GLOBAL = new RegExp(String.raw`(?:^|\s)(?:\[\d{1,3}\]|\d{1,3}\.)\s+${SURNAME_PARTICLES}${SURNAME_INITIALS}`, 'gu');

/**
 * The same judgement on raw page text, before lines exist (word order within
 * the text does not matter): at least five entry starts and years for most.
 */
export function looksLikeReferenceText(text: string): boolean {
	const starts = (text.match(ENTRY_START_GLOBAL) ?? []).length + (text.match(SUPERSCRIPT_ENTRY_GLOBAL) ?? []).length;
	if (starts < 5) return false;
	const years = (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).length;
	return years >= starts * 0.6;
}

/**
 * The tail of a reference entry torn from its start (a column or page break):
 * short, with a year and a volume/page locator, and little running prose —
 * "CT head scanner,” Med. Phys. 4(2), 163–167 (1977)." / "Scand 1952;26(4):312–327."
 */
export function looksLikeBibliographicFragment(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 400 || !/\b(?:19|20)\d{2}\b/.test(t)) return false;
	const locator = /\d+\s*\(\d+\)\s*[:,]\s*\d+|\b\d+\s*:\s*\d+(?:\s*[–-]\s*\d+)?|\bdoi\b|https?:\/\/|\(\s*(?:19|20)\d{2}\s*\)\.?$|\bReport No\./i;
	if (!locator.test(t)) return false;
	const lowerWords = (t.match(/\b[a-z]{4,}\b/g) ?? []).length;
	return lowerWords <= 12;
}

/**
 * 5.0 全篇样式用:不带编号的 Vancouver 条目开头 —— "Feigin VL, Brainin M, …"、
 * "McHugh ML. Interrater…"(AJR 手稿、PMC 作者手稿)。只用作页级证据计数,
 * 不参与断段(正文里"Smith J, …"开头的行会误伤)。
 */
const UNNUMBERED_ENTRY = /^\s*\p{Lu}[\p{L}'’-]+(?:[\s-]\p{Lu}[\p{L}'’-]+)?\s\p{Lu}{1,3}(?:,\s\p{Lu}[\p{L}'’-]+(?:[\s-]\p{Lu}[\p{L}'’-]+)?\s\p{Lu}{1,3}|\.\s\p{Lu})/u;
/** APA / Harvard: "Behrend, H., Giesinger, K. …", "Bistolfi, A. & Bellare, …", "Currier, J.H., …". */
const APA_ENTRY = /^\s*\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)?,\s(?:\p{Lu}\.\s?){1,3}(?:,\s\p{Lu}|\s?&\s\p{Lu}|\s\((?:19|20)\d{2})/u;
export function startsUnnumberedEntry(text: string): boolean {
	return UNNUMBERED_ENTRY.test(text) || APA_ENTRY.test(text);
}

/**
 * 校验 r23 (3200, a book's index): an alphabetical index — "transition matrix,
 * 77, 92, 98", "Trofimov, V.K., 706", locator-only wrap lines "517–519, 546,"
 * and "see also" cross references. Its two aligned columns of locators read
 * as a table, and every page of it was cut into ~90 table cells.
 */
const INDEX_LOCATOR = String.raw`(?:\d{1,4}|[ivxlc]{1,7})(?:[–-]\d{1,4})?[a-z]?`;
const INDEX_ENTRY = new RegExp(String.raw`^\s*\S.{0,90}?,\s*${INDEX_LOCATOR}(?:,\s*${INDEX_LOCATOR})*,?\s*$`, 'u');
const INDEX_WRAP = new RegExp(String.raw`^\s*${INDEX_LOCATOR}(?:,\s*${INDEX_LOCATOR})*,?\s*$`, 'u');
const INDEX_CROSS = /(?:^|,\s*)see(?:\s+also)?\s+\S/i;
export function looksLikeIndexPage(lines: string[]): boolean {
	const texts = lines.map(l => l.trim()).filter(Boolean);
	if (texts.length < 15) return false;
	const entries = texts.filter(t => INDEX_ENTRY.test(t) || INDEX_CROSS.test(t)).length;
	const wraps = texts.filter(t => INDEX_WRAP.test(t)).length;
	return entries >= texts.length * 0.5 && entries + wraps >= texts.length * 0.7;
}
/** A wrapped index line that holds only locators ("517–519, 546, 573,"). */
export function isIndexLocatorLine(text: string): boolean {
	return INDEX_WRAP.test(text);
}
