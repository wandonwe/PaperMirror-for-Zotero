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
const ENTRY_START = /(?:^|\s)(?:\[\d{1,3}\]|\d{1,3}\.)\s+(?:[A-Z]\.\s?){0,3}[A-Z][\p{L}'’\-]+(?:\s+[A-Z][\p{L}'’\-]+)?,?\s+(?:[A-Z]{1,3}\b|[A-Z]\.)/u;
const YEAR = /\b(?:19|20)\d{2}\b/;

/** One line or paragraph that starts like a numbered reference entry. */
export function startsReferenceEntry(text: string): boolean {
	return ENTRY_START.test(' ' + text.trim().slice(0, 80)) && /^\s*(?:\[\d{1,3}\]|\d{1,3}\.)/.test(text);
}

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

const ENTRY_START_GLOBAL = /(?:^|\s)(?:\[\d{1,3}\]|\d{1,3}\.)\s+(?:[A-Z]\.\s?){0,3}[A-Z][\p{L}'’\-]+(?:\s+[A-Z][\p{L}'’\-]+)?,?\s+(?:[A-Z]{1,3}\b|[A-Z]\.)/gu;

/**
 * The same judgement on raw page text, before lines exist (word order within
 * the text does not matter): at least five entry starts and years for most.
 */
export function looksLikeReferenceText(text: string): boolean {
	const starts = (text.match(ENTRY_START_GLOBAL) ?? []).length;
	if (starts < 5) return false;
	const years = (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).length;
	return years >= starts * 0.6;
}
