/**
 * 全篇文献样式 (5.0 结构层重构第 1 步)。
 *
 * 结构识别过去只看当前页,跨页事实靠"前面已经抽过的页"累积:
 *   - 参考文献续页认不出,要看用户是不是先翻过标题页(联网校验 3384);
 *   - 同一页的结构随翻页顺序变化,源文本哈希变了,缓存对不上;
 *   - 一旦进了参考文献就再不出来:手稿把表格、图注、附录排在文献之后,
 *     这些页整页按参考文献处理(只译标题、原样返回即接受)。
 *
 * 这里在建块之前对全篇做一次统计,产出与翻页顺序无关的事实。纯函数:
 * 输入是每页的 span(与 getTextContentItems 同形),不碰 DOM、不碰 Zotero。
 * 每个判断都带上逐页证据(`pages`),供诊断解释"为什么这页算 / 不算"。
 */
import { groupIntoLines, lineText, type SpanItem } from './spanBlockBuilder';
import { looksLikeBibliographicFragment, looksLikeReferencePage, startsReferenceEntry, startsUnnumberedEntry } from './referenceDetect';

export interface StylePage {
	items: SpanItem[];
	pageWidth: number;
	pageHeight: number;
}

export interface PageEvidence {
	/** 本页有一行就是参考文献标题("References" / "R E F E R E N C E S" / 参考文献)。 */
	heading: boolean;
	/** 标题之后(没有标题则全页)像参考文献条目开头的行数。 */
	entryStarts: number;
	/** 同一范围内出现的年份个数(条目跨行,年份常在最后一行)。 */
	years: number;
	/** 同一范围内的行数(条目页的行几乎都属于条目)。 */
	lines: number;
	/** 本页第一行正文(跳过页码等短行)就是条目或条目尾巴 —— 上一页的文献延续到这里。 */
	leadsWithReference: boolean;
	/** looksLikeReferencePage 的结论。 */
	referenceList: boolean;
}

export interface DocumentStyle {
	pageCount: number;
	/** 按字符数加权的正文字号(0.5pt 取整);没有文字时为 0。 */
	bodyFontSize: number;
	/**
	 * 参考文献所在的页范围(0 起,首尾都含)。合订本(正式版 + 手稿 / 补充材料)
	 * 可以有好几段;范围之后的页(表格、图注、附录)不再按参考文献处理。
	 */
	referenceRanges: Array<[number, number]>;
	/** 第一段的开始页;-1 = 没找到(诊断与旧接口用)。 */
	referencesStartPage: number;
	referencesEndPage: number;
	pages: PageEvidence[];
}

const REFERENCES_HEADING_LINE = /^\s*(?:\d{1,2}\.?\s*)?(?:r\s?e\s?f\s?e\s?r\s?e\s?n\s?c\s?e\s?s(?:\s+and\s+notes)?|bibliography|literature\s+cited|works\s+cited|参考文献|參考文獻|引用文献)\s*:?\s*$/i;
const YEAR = /\b(?:19|20)\d{2}\b/;

function pageLines(page: StylePage): string[] {
	if (!page.items.length) return [];
	return groupIntoLines(page.items, page.pageWidth, page.pageHeight).map(lineText).filter(t => t.trim());
}

function evidenceFor(lines: string[]): PageEvidence {
	const headingAt = lines.findIndex(l => REFERENCES_HEADING_LINE.test(l));
	const after = headingAt >= 0 ? lines.slice(headingAt + 1) : lines;
	// 跳过页码等短行后的前三行:有条目开头,或第一行是条目尾巴(页码区间、DOI、
	// "Available from:" —— 尾巴常常不带年份,3386 p14)。
	const lead = lines.filter(l => l.trim().length >= 25).slice(0, 3);
	const tail = /^\s*(?:\d+[–-]\d+\.|doi:|https?:\/\/|Available\s+(?:from|at):|\[PubMed)/i;
	return {
		leadsWithReference: lead.some(l => startsReferenceEntry(l) || startsUnnumberedEntry(l))
			|| (lead[0] !== undefined && (tail.test(lead[0]) || looksLikeBibliographicFragment(lead[0]))),
		heading: headingAt >= 0,
		entryStarts: after.filter(l => startsReferenceEntry(l) || startsUnnumberedEntry(l)).length,
		lines: after.length,
		years: after.reduce((n, l) => n + (l.match(new RegExp(YEAR.source, 'g'))?.length ?? 0), 0),
		referenceList: looksLikeReferencePage(lines)
	};
}

function bodySizeOf(pages: StylePage[], skip: (pageIndex: number) => boolean = () => false): number {
	const weight = new Map<number, number>();
	for (const [pageIndex, page] of pages.entries()) {
		if (skip(pageIndex)) continue;
		for (const item of page.items) {
			const size = Math.round((item.fontSize ?? 0) * 2) / 2;
			if (size <= 0) continue;
			weight.set(size, (weight.get(size) ?? 0) + item.text.replace(/\s+/g, '').length);
		}
	}
	let best = 0, bestWeight = 0;
	for (const [size, w] of weight) {
		if (w > bestWeight || (w === bestWeight && size < best)) { best = size; bestWeight = w; }
	}
	return best;
}

export function buildDocumentStyle(pages: StylePage[]): DocumentStyle {
	const evidence = pages.map(p => evidenceFor(pageLines(p)));
	const n = pages.length;
	// 条目页:≥2 条条目;或文献的最后一页 —— 只剩 1 条,但页上几乎没有别的行。
	const entries = (i: number): boolean => i < n && evidence[i]!.years >= 1
		&& (evidence[i]!.entryStarts >= 2 && evidence[i]!.years >= 2 || evidence[i]!.entryStarts >= 1 && evidence[i]!.lines <= evidence[i]!.entryStarts * 8);
	const isList = (i: number): boolean => i < n && (evidence[i]!.referenceList || (evidence[i]!.entryStarts >= 4 && evidence[i]!.years >= 4));
	const ranges: Array<[number, number]> = [];
	for (let i = 0; i < n; i++) {
		// 开始:有标题、且标题后(或下一页)紧跟着条目;没有标题时要连续两页都是
		// 条目页,或在后半篇 —— 避免把正文里的一页编号列表当文献。
		const startsHere = evidence[i]!.heading ? (entries(i) || isList(i + 1))
			: isList(i) && (isList(i + 1) || i >= n / 2);
		if (!startsHere) continue;
		let end = i;
		const continues = (j: number): boolean => !evidence[j]!.heading
			&& (isList(j) || entries(j) || evidence[j]!.leadsWithReference && evidence[j]!.years >= 1);
		while (end + 1 < n && continues(end + 1)) end++;
		ranges.push([i, end]);
		i = end;
	}
	return {
		pageCount: n,
		// 正文字号不算参考文献页:小字号的长文献列表字数常常压过正文(3332 算成 7pt)。
		bodyFontSize: bodySizeOf(pages, i => ranges.some(([a, b]) => i >= a && i <= b)) || bodySizeOf(pages),
		referenceRanges: ranges,
		referencesStartPage: ranges[0]?.[0] ?? -1,
		referencesEndPage: ranges[0]?.[1] ?? -1,
		pages: evidence
	};
}

/** 本页之前是否已进入参考文献、且本页仍在参考文献范围内。 */
export function referencesContinueOnto(style: DocumentStyle, pageIndex: number): boolean {
	return style.referenceRanges.some(([start, end]) => pageIndex > start && pageIndex <= end);
}
