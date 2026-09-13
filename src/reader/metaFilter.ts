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
// 2.12.12 (内容保留规则审核第 2 条): 标签分两类。
//   书目类 —— Citation / Editor / Received / Published / Copyright —— 是标识,跳过;
//   说明类 —— Funding / Ethics / Patient consent / Data availability / Abbreviations /
//   Author contributions / Conflicts of interest / Trial registration —— 后面跟的是
//   读者要看的自然语言("Written informed consent was obtained."),以前整段丢弃。
// 说明类只在标签后面**没有自然语言**(纯资助号、纯注册号)时才算元数据。
const RE_META_LABEL = /^(citation|(?:academic|handling|section|associate|guest)\s+editor|editor|received|accepted|published|posted|copyright|provenance|peer review(?:er)?s?(?: information)?)\s*[::]/i;
const RE_EXPLANATORY_LABEL = /^(funding|competing interests?|conflicts? of interest|data availability(?: statement)?|abbreviations|author contributions?|ethics(?: statement)?|patient consent|trial registration)\s*[::]\s*(.*)$/is;
/** 标签后面有没有自然语言:至少 3 个普通词(≥3 字母、含小写)。 */
function hasNaturalLanguage(body: string, min = 3): boolean {
	const words = (body.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).filter(w => w.length >= 3 && /[a-z]{2}/.test(w));
	return words.length >= min;
}
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
	// 分隔符含 '·' (2.5.13, wu2026 实证): Springer 系署名行用间隔号分隔
	// ("Xiaofei Wu1 · Huiqing Gao2 · …"),只数逗号时整行漏网,作者名被逐个
	// 猜成汉字 (且同页两处两套猜法)。
	const commas = (text.match(/[,·]/g) ?? []).length;
	if (commas < 2) {
		return false;
	}
	const tokens = text.split(/\s+/).filter(t => /[a-zA-Z]/.test(t));
	if (tokens.length < 4) {
		return false;
	}
	// Names often carry their superscript affiliations inline once extracted
	// ("Garg3," "Bax6,7,") — digits and marks are part of the roster look.
	const nameLike = tokens.filter(t => /^[A-Z][a-zA-Z'’.-]*[\d,;*†‡§·]*$/.test(t)).length;
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
	if (RE_AFFILIATION_HEAD.test(text)) {
		return true;
	}
	const institutions = (text.match(INSTITUTION_WORDS) ?? []).length;
	const commas = (text.match(/,/g) ?? []).length;
	if (institutions < 2 || commas < 3) {
		return false;
	}
	// 密度判据取代长度上限 (2.5.6, jacc-ccta2020-p1 语料实证)。原先是
	// `text.length > 600 → 不是单位块`,可 20 位作者的单位块有 **1647 字符** ——
	// 恰好在它最像作者单位的时候被这条上限否掉,连同利益声明共约 2700 字符的
	// 前置信息被原样翻译。上限本意是防长正文段误伤,但长度本身分不开两者:
	// 该页单位块 **26 个机构词 / 49 个逗号**,摘要 **1 个机构词 / 10 个逗号**。
	// 改看密度 —— 机构词要随篇幅一起长,正文段偶尔提两所大学不会满足。
	return institutions >= text.length / 200;
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
 *   names         人名/作者名单/学位名单
 *   dates         收稿/接受/发表日期
 *   identifier    DOI、网址、纯资助号/注册号、纯标识行
 *   bibliographic Citation / Editor / Published 这类书目标签
 *   watermark     "Downloaded from …" 下载水印
 *   marks         孤立的数字/角标/页码
 *   banner        RESEARCH ARTICLE / OPEN ACCESS 这类栏目条
 *   boilerplate   短版权行(整句的开放获取声明会翻译)
 *   sliver        竖排细条(装订线文字)
 *   running-head  逐页重复的页眉/页脚(由 spanBlockBuilder 判定)
 */
export type PreserveReason = 'names' | 'dates' | 'identifier' | 'bibliographic' | 'watermark' | 'marks' | 'banner' | 'boilerplate' | 'sliver' | 'running-head';
export interface ContentClassification { decision: ContentDecision; reason?: PreserveReason }

const RE_WATERMARK = /^downloaded from\b/i;

/**
 * 内容决策 (2.12.13):这个块**要不要翻译**。
 *
 * 原则(用户 2026-09-13):原文侧负责忠实保留;译文侧负责完整理解。元素类别决定排版方式,
 * 不决定是否翻译。自然语言一律翻译;只有标识(人名、日期、DOI、网址、页码、水印)保留,
 * 而且保留必须带原因。**几何位置(页边栏)不再决定翻不翻** —— 以前页边栏里 <700 字符
 * 一票否决,PLOS 的 Funding / Data Availability 整段就这么没了。
 *
 * 与 2.12.12 之前的 isMetadataBlock 相比,翻转为"翻译"的有:作者单位、通讯句、
 * 整句版权/许可声明、资助句、作者贡献、"funders had no role" 尾句。
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
	// 日期行先于书目标签:"Received: … Accepted: …" 报 dates 比报 bibliographic 更有信息量。
	// 把日期词汇(received/revised/accepted/月份…)抠掉,剩下没有自然语言才算日期行。
	if (RE_RECEIVED.test(t) && !hasNaturalLanguage(stripDateVocabulary(t))) {
		return { decision: 'preserve', reason: 'dates' };
	}
	if (RE_META_LABEL.test(t) && t.length < 700) {
		return { decision: 'preserve', reason: 'bibliographic' };
	}
	const explanatory = RE_EXPLANATORY_LABEL.exec(t);
	if (explanatory) {
		return hasNaturalLanguage(explanatory[2] ?? '') ? { decision: 'translate' } : { decision: 'preserve', reason: 'identifier' };
	}
	if (t.length < 40 && RE_ARTICLE_BANNER.test(t)) {
		return { decision: 'preserve', reason: 'banner' };
	}
	// Orphan digits/marks: stray superscript affiliation numbers or page numbers.
	if (t.length < 40 && /^[\d\s.,;:*†‡§()\-–—]+$/.test(t)) {
		return { decision: 'preserve', reason: 'marks' };
	}
	if (hasDegreeRoster(t) && t.length < 900) {
		return { decision: 'preserve', reason: 'names' };
	}
	// 作者单位先于作者名单判:单位行里的机构专名 + 角标数字,形状上与署名行几乎一样
	// ("1st Department of Cardiology, Hippokration Hospital, …" 会被 looksLikeAuthorList 当名单)。
	// 单位翻译机构名称;署名保留。
	if (looksLikeAffiliation(t)) {
		return { decision: 'translate' };
	}
	if (looksLikeAuthorList(t) || plainNameRoster(t)) {
		return { decision: 'preserve', reason: 'names' };
	}
	// 标识行:DOI / 网址 / 邮箱 / 通讯作者标签。句子(有 ≥3 个小写起头的普通词:
	// "The CONFIRM registry data are publicly documented at https://…")翻译;
	// 标签行("European Journal of Preventive Cardiology (2022) 29, 608–624 doi:…"、
	// "* Corresponding author. Tel: …, Email: …")只有专名和标识,保留。
	if ((RE_DOI_URL.test(t) || RE_CORRESPONDENCE.test(t)) && !hasSentenceWords(stripIdentifiers(t))) {
		return { decision: 'preserve', reason: 'identifier' };
	}
	// 短版权行是样板;整句的开放获取声明是自然语言。
	if (RE_COPYRIGHT.test(t) && !hasNaturalLanguage(t, 6)) {
		return { decision: 'preserve', reason: 'boilerplate' };
	}
	if (RE_GRANT.test(t) && !hasNaturalLanguage(t.replace(RE_GRANT, ''))) {
		return { decision: 'preserve', reason: 'identifier' };
	}
	return { decision: 'translate' };
}

/**
 * 没有角标的纯人名名单:"John A Smith, Mary Jones, Wei Zhang, and Li Wang"。
 * looksLikeAuthorList 要求有角标/数字;residueRules.looksLikeAuthorNameList 太松
 * (把 "Note.—CNR = contrast-to-noise ratio, FDA = U.S. Food and Drug Administration" 也当名单)。
 * 这里从严:≥3 段,每段 2~4 个词,**每个词**都是首字母大写或首字母缩写,不含 = : 数字。
 */
function plainNameRoster(t: string): boolean {
	if (t.length > 300 || /[=:\d@]/.test(t)) { return false; }
	const segments = t.replace(/\band\b/g, ',').split(/[,;·]/).map(x => x.trim()).filter(Boolean);
	if (segments.length < 3) { return false; }
	return segments.every(seg => {
		const words = seg.split(/\s+/);
		return words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Z](?:[a-z'’-]+|\.?)$/.test(w));
	});
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
		.replace(/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g, ' ')
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
