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
const RE_EXPLANATORY_LABEL = /^(funding|competing interests?|conflicts? of interest|data availability(?: statement)?|abbreviations|author contributions?|ethics(?: statement)?|patient consent|trial registration)\s*[::]\s*(.*)$/is;
/** 标签后面有没有自然语言:至少 3 个普通词(≥3 字母、含小写)。 */
function hasNaturalLanguage(body: string, min = 3): boolean {
	const words = (body.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).filter(w => w.length >= 3 && /[a-z]{2}/.test(w));
	return words.length >= min;
}
// Funding boilerplate: grant numbers and the funders-had-no-role sentence.
const RE_GRANT = /\bgrants?\s?(?:nos?|numbers?|#)\b\.?\s*:?\s*[\w-]/i;
const RE_CORRESPONDENCE = /\b(corresponding author|correspondence to|e-?mail|电子邮件|通讯作者)\b|@[a-z0-9.-]+\.[a-z]{2,}/i;
const RE_DOI_URL = /\b(doi|https?):|doi\.org|academic\.oup\.com|downloaded from/i;

const INSTITUTION_WORDS = /\b(university|hospital|department|institute|center|centre|school|laboratory|clinic|college|academy)\b/gi;

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
	// A run that BEGINS mid-sentence (lowercase first letter — a body line
	// "of lumbar disk herniation…" or a hyphenation fragment "agnostic
	// accuracy…") is body text that merely reached the margin on a dense page.
	// The `lineCount <= 2` shape test alone does NOT spare it: on pages whose
	// columns aren't coalesced every body line arrives as its own one-line
	// block, so the bottom lines of each column were dropped and the translated
	// page showed raw English at the column foot. BUT some genuine journal feet
	// are typeset lowercase too ("n engl j med 378;8 nejm.org February 22,
	// 2018") — those carry a bare domain and/or a volume;issue token that prose
	// continuations never do, so only spare a lowercase run that reads as plain
	// prose (no domain, no "N;M" citation number).
	const looksLikeJournalFoot =
		/\b[\w-]+\.(org|com|net|edu|gov|io|co|uk|de|fr)\b/i.test(t)
		|| /\d+\s*;\s*\d+/.test(t);
	if (/^[a-z]/.test(t) && !looksLikeJournalFoot) {
		return false;
	}
	// A run that ENDS mid-sentence is a wrapped body line too, even when it
	// begins with a capital (2.5.1, Radiology 语料: 「These features have been
	// reported to be associated with」 坐在左栏栏底,单行 54 字符、首字母大写,
	// 上面那条小写规则看不见它,于是整句正文被当页脚丢弃)。正文行在版心用尽处
	// 断开,断点常落在虚词或连字符上;页眉页脚是自足的标题/引文短语,绝不会以
	// 「with」「of」「and」收尾。
	if (!looksLikeJournalFoot && endsMidSentence(t)) {
		return false;
	}
	return lineCount <= 2 && t.length <= 140;
}

/** 虚词表:标题不会以此收尾,折行的正文行经常如此。 */
const TRAILING_FUNCTION_WORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'if', 'as', 'that', 'which', 'who', 'whom', 'whose',
	'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'without', 'within', 'into', 'onto',
	'upon', 'over', 'under', 'above', 'below', 'between', 'among', 'through', 'during', 'before',
	'after', 'since', 'until', 'while', 'when', 'where', 'than', 'then', 'because', 'although',
	'though', 'whether', 'via', 'per', 'about', 'against', 'toward', 'towards', 'across', 'along',
	'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had', 'having',
	'do', 'does', 'did', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would',
	'not', 'no', 'both', 'each', 'either', 'neither', 'all', 'any', 'some', 'such', 'more', 'most',
	'less', 'least', 'we', 'they', 'it', 'its', 'their', 'our', 'these', 'those', 'this', 'there',
	'using', 'used', 'based'
]);

/** 行尾停在连字符或虚词上 —— 句子还没说完,下一行才是续文。 */
export function endsMidSentence(text: string): boolean {
	const t = text.trim();
	// 跨行连字符断词
	if (/\p{L}-$/u.test(t)) {
		return true;
	}
	const tail = t.match(/([\p{L}\p{N}'’-]+)\s*$/u);
	const word = tail?.[1];
	if (!word) {
		return false;
	}
	return TRAILING_FUNCTION_WORDS.has(word.toLowerCase());
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

export type ContentDecision = 'translate' | 'preserve' | 'skip';
/**
 * 保留原因 —— 每一个不翻译的块都必须带一个,"无提示缺失"是被禁止的 (2.12.13)。
 *
 * 3.0.0:只剩**精确规则能认定**的两类。
 *   标识:dates(收稿/接受日期行)、identifier(DOI/网址/邮箱/纯资助号/纯注册号)、marks(孤立数字/角标/页码)
 *   页面附属物:watermark(下载水印)、sliver(竖排细条)、running-head(逐页页眉页脚)
 * 3.0.0 之前还有 names / bibliographic / banner / boilerplate —— 全是**猜形状**的规则
 * (作者名单像什么样、栏目条像什么样),猜错的代价是读者少看一段而不自知;猜对的收益只是
 * 省一次回声请求。两类错的代价不对称,所以"拿不准就翻译"。人名由提示词原样保留。
 */
export type PreserveReason = 'dates' | 'identifier' | 'marks' | 'watermark' | 'sliver' | 'running-head';
export interface ContentClassification { decision: ContentDecision; reason?: PreserveReason }

const RE_WATERMARK = /^downloaded from\b/i;

/**
 * 内容决策 (2.12.13 / 3.0.0):这个块**要不要翻译**。
 *
 * 原则(用户 2026-09-13):原文侧负责忠实保留;译文侧负责完整理解。元素类别决定排版方式,
 * 不决定是否翻译。有对照的双栏阅读里,故意留一块不译没有收益,只有误判的风险 ——
 * 所以只有能用**精确规则**认定的标识和页面附属物才保留,其余一律翻译,几何位置不参与判定。
 */
export function classifyContent(text: string, rect?: Rect, pageWidth?: number, type?: { fontSize?: number; bodySize?: number }): ContentClassification {
	void pageWidth; void type;
	const t = text.trim();
	if (!t) {
		return { decision: 'skip' };
	}
	if (rect && isVerticalSliver(rect)) {
		return { decision: 'preserve', reason: 'sliver' };
	}
	if (RE_WATERMARK.test(t)) {
		return { decision: 'preserve', reason: 'watermark' };
	}
	// 日期行:把日期词汇(received/revised/accepted/月份…)抠掉,剩下没有自然语言才算。
	if (RE_RECEIVED.test(t) && !hasNaturalLanguage(stripDateVocabulary(t))) {
		return { decision: 'preserve', reason: 'dates' };
	}
	// 说明类标签后面只有编号/标识(纯资助号、纯注册号)。
	const explanatory = RE_EXPLANATORY_LABEL.exec(t);
	if (explanatory && !hasNaturalLanguage(explanatory[2] ?? '')) {
		return { decision: 'preserve', reason: 'identifier' };
	}
	// 孤立的数字/角标/页码。
	if (t.length < 40 && /^[\d\s.,;:*†‡§()\-–—]+$/.test(t)) {
		return { decision: 'preserve', reason: 'marks' };
	}
	// A journal/year/volume/page locator has no title or explanatory prose.
	if ((RE_DOI_URL.test(t) || RE_CORRESPONDENCE.test(t))
		&& /^[A-Z][A-Za-z .&-]{1,80}\s+\(?(?:19|20)\d{2}\)?[\s;,]+\d[\d\s():,e–—.-]*[•|.\s]*$/.test(stripIdentifiers(t).trim())) {
		return { decision: 'preserve', reason: 'identifier' };
	}
	// Only bare identifiers stay unchanged; even short surrounding labels translate.
	if ((RE_DOI_URL.test(t) || RE_CORRESPONDENCE.test(t)) && !/[A-Za-z]{2,}|[\u3400-\u9fff]/.test(stripIdentifiers(t))) {
		return { decision: 'preserve', reason: 'identifier' };
	}
	if (RE_GRANT.test(t) && !hasNaturalLanguage(t.replace(RE_GRANT, ''))) {
		return { decision: 'preserve', reason: 'identifier' };
	}
	return { decision: 'translate' };
}

/** 小写起头的普通词(≥3 字母)至少 3 个 —— 专名与标签不算,句子才算。 */
function hasSentenceWords(body: string): boolean {
	return (body.match(/\b[a-z][a-z'’-]{2,}/g) ?? []).length >= 3;
}

const RE_DATE_VOCAB = /\b(received|revised|revision|requested|accepted|published|posted|online|available|final|publish-ahead-of-print|ahead|print|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi;
function stripDateVocabulary(t: string): string {
	return t.replace(RE_DATE_VOCAB, ' ');
}

/** 把邮箱/网址/DOI 从文本里抠掉,剩下的才拿去数自然语言词。 */
function stripIdentifiers(t: string): string {
	return t
		.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, ' ')
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/\b(?:doi|DOI)\s*[::]?\s*10\.\d{4,9}\/\S+/g, ' ')
		.replace(/\b10\.\d{4,9}\/\S+/g, ' ')
		.replace(/\b(?:doi|https?|www|academic|oup|com|org|downloaded|from|by|guest|on)\b/gi, ' ');
}

/**
 * Should this block be excluded from translation and from the pane?
 * The original page keeps showing it either way.
 *
 * 2.12.13 起只是 classifyContent 的影子:decision !== 'translate'。提取阶段已改用
 * classifyContent(不译的块保留并带原因);这里留给排版侧"没有译文时按元数据计"的判定和旧测试。
 */
export function isMetadataBlock(text: string, rect?: Rect, pageWidth?: number, type?: { fontSize?: number; bodySize?: number }): boolean {
	return classifyContent(text, rect, pageWidth, type).decision !== 'translate';
}

/** Keep identifier labels separate from surrounding prose even when translated.
 * This is a grouping hint only, never a reason to skip translation.
 */
export function isIdentifierLabel(text: string): boolean {
 return (RE_DOI_URL.test(text) || RE_CORRESPONDENCE.test(text)) && !hasSentenceWords(stripIdentifiers(text));
}
