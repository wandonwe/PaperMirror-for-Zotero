/**
 * 译文验收 (5.0 从 translationManager 拆出): 判断一段模型响应是不是**真的**
 * 译文 —— 不是英文回声、不是半译、没有截断、没有残留整句英文,参考文献与
 * 作者名单的正当保留除外;以及给诊断用的、不含任何文本的拒绝原因码。
 *
 * 全部为纯函数,不依赖 Zotero / DOM / 管理器状态,单测直接覆盖。
 */

import { numericPowerIssue } from './numericPowers';
import { technicalUnitIssue, protectTechnicalUnits } from './technicalUnits';
import { referenceAlignmentIssue } from './referenceAlignment';
import { stripProtectable } from '../reader/formulaGuard';
import {
	hasMixedCopiedResidue,
	isTruncatedTranslation,
	longEnglishResidueSpans,
	looksLikeAuthorNameList
} from './residueRules';

/**
 * Accept a response as a REAL translation, not an echo or a half-translation.
 * For a Chinese target a prose source (≥PROSE_WORD_GATE Latin words — a real
 * sentence, not a label or an acronym/numeric cell) must come back
 * predominantly Chinese; empty, echoed-English, and half-in-English responses
 * are rejected and routed through retry/salvage instead of stored as "done".
 * Short cells/labels and non-CJK targets have no cheap check and pass.
 */
export function looksTranslated(source: string, translated: string, targetLang: string, opts?: { isReference?: boolean }): boolean {
	const t = translated.trim();
	if (technicalUnitIssue(source, t) || numericPowerIssue(source, t)) return false;
	if (introducesInvalidCharacters(source, t)) return false;
	if (referenceAlignmentIssue(source, t)) return false;
	if (!t) {
		return false;
	}
	if (!/^zh/i.test(targetLang)) {
		return true;
	}
	// A provider that preserves paragraph boundaries can be validated locally:
 // an unchanged byline must not dominate the language score of translated prose.
 const sourceParts=source.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
 const targetParts=t.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
 if(sourceParts.length>1 && sourceParts.length===targetParts.length
  && sourceParts.some(p=>looksLikeAuthorNameList(p)||looksLikePersonNames(p))) {
  return sourceParts.every((p,i)=>looksTranslated(p,targetParts[i]!,targetLang,opts));
 }
	// 5.0 (联网校验 3384): authors stay in their source spelling — "Simsek ME"
	// must not come back as "西姆谢克 ME".
	if (opts?.isReference && referenceAuthorsChanged(source, t)) return false;
	if (contactNamesChanged(source, t)) return false;
	// Preserve only identifiable author/journal fragments, never all reference prose.
	if (opts?.isReference && isEcho(source, t) && (looksLikeAuthorNameList(source.replace(/^\d+\.\s*/, ''))
		|| looksLikePersonNames(source.replace(/^\d+\.\s*/, ''))
|| /^(?:\d+\.\s*)?(?:[A-Z][a-z'’-]+\s+[A-Z]{1,4},\s*)+(?:[A-Z][a-z'’-]+\s+[A-Z]{1,4},?\s*)?et al\.$/.test(source.trim())
		|| /^[A-Z][A-Za-z .&-]{1,70}\s+(?:19|20)\d{2}\s*;\s*\d+[\d:()–—-]*[.:]?\s*$/.test(source.trim()))) {
		return true;
	}
	// 参考文献条目原样(或标题照抄)返回 (5.0, 真机 Frontiers 一文第 9/12/13/14 页):
	// 作者、期刊、英文标题原样保留是正当的,以前判为没翻、每条补救 2–3 次后
	// 仍留英文,还触发「引擎不稳定」换引擎。现在当作「保持原文」接受。只对
	// 结构上确实是参考文献条目的块生效(looksLikeReferenceEntry: 年份 + 至少两种
	// 书目特征),正文即使被误标为参考文献区,也不会因此被放过不翻。
	if (opts?.isReference && looksLikeReferenceBlock(source)
		&& !isTruncatedTranslation(stripProtectable(source), stripProtectable(t))
		&& (isEcho(source, t) || hasMixedCopiedResidue(source, t))) {
		return true;
	}
	// 5.0 (校验 r22, 2852 p74): a reference whose author list dwarfs its title —
	// "Katsanos AH, Giannopoulos S, … Parissis J, et al." before eight title
	// words — fails the whole-entry ratio although every copied part is copied
	// BY RULE. Judge the part that was not copied: it must be Chinese and cover
	// the source words that are not in the translation.
	if (opts?.isReference && looksLikeReferenceEntryOrHead(source) && referenceTitleTranslated(source, t)) {
		return true;
	}
	// PROSE-ONLY scoring (审核项: 统计密集行被误拒): citations, p-values, CIs and
	// formulas are byte-identical in source and translation BY DESIGN — counting
	// them as "untranslated Latin" rejected perfect translations of stats-dense
	// lines back to English. Both sides are stripped to their prose before any
	// ratio is computed; works whether the caller passes masked or raw text.
	const proseSource = stripProtectable(source);
	const proseWords = (proseSource.match(/[A-Za-z]{2,}/g) ?? []).length;
	if (proseWords < PROSE_WORD_GATE) {
		// 短块没有廉价的比率判据,但**照抄**判得出来 (2.12.12, 内容保留规则审核第 1 条):
		// 以前这里无条件放行,"No evidence of benefit" / "Document Title" / "Year Published"
		// 原样返回都被计作成功、写进缓存,短标题和表头就此永远留英文。
		// "允许原样保留"与"译文合格"是两件事:数字、缩写、人名、单位原样返回是正当的;
		// 一句自然语言原样返回就是没译。这里只拦**内容相同**的回声,不要求短块必含中文 ——
		// 否则 CT / MRI / p < 0.05 全会被推进无效重试。
		if (isEcho(source, t) && !mayStayUntranslated(proseSource) && !isAuthorCitation(source) && !isContactRecord(source)) {
			return false;
		}
		return true; // label / acronym / numeric cell — may legitimately be CJK-free
	}
	// 作者名单豁免 (retain-pdf): a byline legitimately stays Latin — rejecting
	// it buys a doomed retry on every page-1.
	if (looksLikeAuthorNameList(proseSource) || looksLikePersonNames(proseSource)) {
		return true;
	}
	const proseT = stripProtectable(t);
	// 截断硬判据 (retain-pdf quality.py): a long source answered with <15% of
	// its length is a tail/half output — the ratio test alone scores a short
	// all-Chinese fragment as "translated" and stored the loss silently.
	if (isTruncatedTranslation(proseSource, proseT)) {
		return false;
	}
	// 小样本验收 (1.1.8, Horst 2024 第 1 页 region-2/region-4 连拒): 比率是一个
	// 比例估计,分母越小噪声越大。一条 56–58 字符的标题/署名里保留 4–5 个专名
	// 与缩写是忠实翻译的常态,却足以把比率压到 0.45 以下 —— 同样的噪声在
	// 800/1783 字符的正文段落里根本不存在(同页那三段全部一次通过)。短源文
	// 因此换一把小样本安全的尺子;正文段落一律走下面原来的比率阈值,验收
	// 强度一个字都没动。
	if (proseSource.length <= SHORT_SOURCE_PROSE_CHARS) {
		return shortSourceTranslated(proseSource, proseT) && !hasMixedCopiedResidue(source, t);
	}
	// A PROSE source must come back predominantly Chinese. This rejects not
	// only echoed English (ratio 0) but a HALF-translated / mixed response,
	// which the old "contains any CJK" test accepted.
	if (targetLanguageRatio(proseT) < MIN_TARGET_RATIO) {
		return false;
	}
	// 混合残留硬判据 (retain-pdf): the ratio passes on a LONG paragraph whose
	// tail is still a copied English span — Chinese-dominant overall, one
	// clause silently untranslated. A ≥12-word span that is surface-identical
	// (or ≥0.82 similar) to the source is copied, not translated.
	if (hasMixedCopiedResidue(source, t)) {
		return false;
	}
	return true;
}

/**
 * context_bleed 校验 (参照 retain-pdf blocking issue): a translation that is
 * FAR longer than its source can support usually swallowed the injected
 * context (previous page tail / section heading) into the output. EN→ZH runs
 * ~1.1–1.6 hanzi per source word; 2.4× with a floor is safely above any
 * legitimate translation. Only meaningful when context was injected.
 */
export function looksContextBleed(source: string, translated: string, hadContext: boolean): boolean {
	if (!hadContext) {
		return false;
	}
	const words = (stripProtectable(source).match(/[A-Za-z]{2,}/g) ?? []).length;
	if (words < 8) {
		return false;
	}
	const cjk = (translated.match(CJK_RE) ?? []).length;
	return cjk > Math.max(80, words * 2.4);
}

/** A run of this many consecutive plain-English words is untranslated prose. */
const RESIDUE_WORD_RUN = 6;

/**
 * 局部英文残留检测: does a (mostly-Chinese) translation still contain a run of
 * plain untranslated English prose? Six+ CONSECUTIVE lowercase English words is
 * essentially always a dropped clause — acronyms (ALLCAPS), drug/gene symbols
 * and proper nouns (Title-case) are excluded by the lowercase-only rule, URLs
 * and emails are stripped first, and a short Latin idiom ("in vitro", "et al")
 * is below the run threshold. Deliberately strict: a false positive costs one
 * wasted re-translation, so we only fire on a clear untranslated sentence.
 */
export function hasEnglishResidue(text: string): boolean {
	const cleaned = text.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+/gi, ' ');
	let run = 0;
	for (const tok of cleaned.split(/\s+/)) {
		const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
		if (/^[a-z]{2,}$/.test(w)) {
			run++;
			if (run >= RESIDUE_WORD_RUN) {
				return true;
			}
		}
		// 中性 token 不打断连跑 (2.5.12, wu2026-p4 实证): "with a standard ROI
		// area of 3 mm² for polyps ≥5 mm in diameter" 这段典型残留被 'a'(单字母
		// 不满足 {2,})、'ROI'(全大写)、'3'(纯数字)各重置一次,6 词连跑永远
		// 凑不满,夹生译文年久失修。数字/符号、单字母 (a, I)、全大写缩写
		// (ROI, CT, PCD-CT) 本就同时出现在残留英文与合格译文里,不是"已翻译"
		// 的证据 —— 既不计数也不重置。含 CJK 的 token 仍然重置: 中文字符才是
		// 真正的翻译证据,否则整段中文里零星散布的 6 个英文虚词会被误连成跑。
		else if (!/[㐀-鿿]/.test(tok)
			&& (w === '' || /^[A-Za-z]$/.test(w) || /^[A-Z]{2,}(?:-[A-Z0-9]+)*$/.test(w))) {
			// neutral: keep the run
		}
		else {
			run = 0;
		}
	}
	// 跨度规则 (retain-pdf _has_long_english_residue_span): a ≥10-word Latin
	// prose span — Title-Case words count too, which the lowercase run above
	// deliberately skips — that is NOT data-dense (NMR lines, numeric strings
	// stay exempt) is a dropped clause. Catches "The Results Showed That..."
	// style residue the run rule missed.
	return longEnglishResidueSpans(stripProtectable(cleaned), 10).length > 0;
}

/** CJK ideograph ranges used for the target-language ratio. */
const CJK_RE = /[㐀-鿿豈-﫿]/g;

/** A source with at least this many Latin words is prose worth validating. */
const PROSE_WORD_GATE = 6;

/** 内容相同(忽略大小写、标点、空白)= 回声。 */
/**
 * 结构上像一条参考文献 (5.0)。必须有年份,并且至少具备两种书目特征: 编号开头、
 * 作者缩写名、et al.、DOI/PMID、卷(期):页码、期刊式「年;卷」。正文段落偶尔
 * 带一个引用年份或 et al.,但很少同时凑齐两种,而且限长,长段正文直接排除。
 */
export function looksLikeReferenceEntry(source: string): boolean {
	const text = source.replace(/\s+/g, ' ').trim();
	if (!text || text.length > 600 || !/\b(?:19|20)\d{2}[a-z]?\b/.test(text)) return false;
	const features = [
		/^\[?\d{1,3}[\].)]\s/.test(text),
		/\b[A-Z][A-Za-z'’-]+,?\s+(?:[A-Z]\.?\s?){1,3}[,.]/.test(text),
		/\bet al\b/i.test(text),
		/\b(?:doi|pmid|pmcid)\b|10\.\d{4,9}\//i.test(text),
		// Article numbers may carry a letter (SPIE "2012:83134B").
		/\b\d+\s*(?:\(\s*\d+[–-]?\d*\s*\))?\s*:\s*[eE]?\d+[A-Z]?(?:[–-][eE]?\d+[A-Z]?)?(?!\w)/.test(text),
		/\b(?:19|20)\d{2}\s*[;,]\s*\d+/.test(text),
		// Elsevier: "J. Am. Coll. Cardiol. 75 (5) (2020) 453–463"; initials-first authors.
		/\b\d+\s*(?:\(\s*\d+[–-]?\d*\s*\)\s*)?\((?:19|20)\d{2}\)\s*[eE]?\d+(?:[–-][eE]?\d+)?/.test(text),
		/(?:^|[\]).]\s)(?:[A-Z]\.\s?-?){1,3}\s?[A-Z][\p{L}'’-]+,/u.test(text)
	].filter(Boolean).length;
	return features >= 2;
}

const VANCOUVER_NAME = /[A-Z][\p{L}'’-]+(?:\s[A-Z][\p{L}'’-]+)?\s[A-Z]{1,3},\s/gu;
const INITIALS_NAME = /(?:[A-Z]\.\s?-?){1,3}\s?[A-Z][\p{L}'’¨-]+(?:\s[a-z]{1,3}\s[A-Z][\p{L}'’-]+)?,\s/gu;
const ENTRY_BOUNDARY = /(?<=[.\]])\s+(?=\[?\d{1,3}[\].)]\s|[A-Z][\p{L}'’-]+(?:\s[A-Z][\p{L}'’-]+)?\s[A-Z]{1,3}[,.]\s)/u;

/**
 * A reference block too long for looksLikeReferenceEntry (5.0, 推荐模型校验
 * 2897 p10 959 字 / 2638 p7 684 字): either one entry whose author list alone
 * runs past 600 characters, or several whole entries merged into one block.
 * Prose never qualifies: every merged segment must itself be an entry, and a
 * long single entry must be long because of its names.
 */
export function looksLikeReferenceBlock(source: string): boolean {
	const text = source.replace(/\s+/g, ' ').trim();
	if (looksLikeReferenceEntry(text)) return true;
	if (text.length > 4000) return false;
	const parts = text.split(new RegExp(ENTRY_BOUNDARY.source, 'gu')).filter(p => p.trim());
	if (parts.length >= 2 && parts.every(p => looksLikeReferenceEntry(p))) return true;
	for (const re of [INITIALS_NAME, VANCOUVER_NAME]) {
		const names = text.match(re) ?? [];
		if (names.length < 8) continue;
		let kept = 0;
		const compact = text.replace(re, m => (kept++ === 0 ? m : ''));
		if (compact.length <= 600 && looksLikeReferenceEntry(compact)) return true;
	}
	return false;
}

/**
 * The leading authors of a reference entry, by surname (5.0): Vancouver
 * "Simsek ME, Akkaya M" or initials-first "J. Smith, A. Brown". Only the first
 * two are taken, so a capitalised title word is never mistaken for one.
 */
export function referenceLeadSurnames(source: string): string[] {
	if (!looksLikeReferenceEntry(source)) return [];
	const head = source.replace(/\s+/g, ' ').trim().replace(/^\[?\d{1,3}[\].)]?\s*/, '').slice(0, 140);
	const out: string[] = [];
	const vancouver = /(?:^|,\s*)([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?)\s+(?:[A-Z]{1,3}|(?:[A-Z]\.\s?){1,3})(?=[,.\s]|$)/gu;
	const initialsFirst = /(?:^|,\s*)(?:[A-Z]\.\s?){1,3}\s?([A-Z][\p{L}'’-]+)/gu;
	for (const re of [vancouver, initialsFirst]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(head)) && out.length < 2) {
			if (m.index > 0 && out.length === 0) break; // must start the entry
			out.push(m[1]!);
		}
		if (out.length) break;
	}
	return out;
}

const CONTACT_NAME = /(?:^|[\s;:(])((?:[A-Z][\p{L}'’-]+\s){1,3}[A-Z][\p{L}'’-]+),\s*[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/gu;

/**
 * 5.0 (推荐模型校验 2877): a "Name, e-mail" record keeps the person's name as
 * written. The prompt says so since 4.99.15; this check also retires older
 * cached translations ("Naying He" → "何娜英") when they are reused, without
 * invalidating every cached page through a prompt-version bump.
 */
export function contactNamesChanged(source: string, translated: string): boolean {
	CONTACT_NAME.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CONTACT_NAME.exec(source))) {
		if (!translated.includes(m[1]!)) return true;
	}
	return false;
}

/** "Naying He, hny12267@rjh.com.cn": a person's name and address, kept as written (5.0). */
export function isContactRecord(source: string): boolean {
	return /^\s*(?:\p{Lu}[\p{L}'’-]+\s){1,3}\p{Lu}[\p{L}'’-]+,\s*[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\s*[.;]?\s*$/u.test(source);
}

/** An entry, or the head of one cut at a column end ("530. Katsanos AH, …, et al. The diagnostic yield of … in patients"). */
function looksLikeReferenceEntryOrHead(source: string): boolean {
	return looksLikeReferenceEntry(source) || /^\s*\[?\d{1,4}[.\]]\s+\p{Lu}[\p{L}'’-]+\s+\p{Lu}{1,3},\s/u.test(source);
}

/**
 * The translation with every Latin run copied verbatim from the source taken
 * out (authors, journal, volume, DOI) must still carry the title in Chinese:
 * ≥ 0.8 hanzi per source word missing from the translation, and next to no
 * Latin left over. A title echoed in English leaves nothing Chinese → false.
 */
export function referenceTitleTranslated(source: string, translated: string): boolean {
	const norm = (x: string): string => x.replace(/\s+/g, ' ');
	const src = norm(source);
	let rest = norm(translated);
	const runs = rest.match(/[A-Za-z0-9][A-Za-z0-9 .,;:'’&()/–—-]*[A-Za-z0-9.)]/g) ?? [];
	// Spaces do not count: glued initials in the PDF text ("MasdeuJC,IrimiaP")
	// may come back spaced, and that is still the source spelling.
	const compact = src.replace(/\s+/g, '');
	// Title words left in English are not "copied by rule": a run with two or
	// more lower-case words is prose and stays counted against the translation.
	const prose = (run: string): boolean => (run.match(/\b[a-z]{4,}\b/g) ?? []).length >= 2;
	for (const run of runs.sort((a, b) => b.length - a.length)) {
		if (!prose(run) && compact.includes(run.replace(/\s+/g, ''))) rest = rest.split(run).join(' ');
	}
	const cjk = (rest.match(CJK_RE) ?? []).length;
	const latinLeft = (rest.match(/[A-Za-z]/g) ?? []).length;
	const kept = new Set((translated.match(/[A-Za-z]{2,}/g) ?? []).map(w => w.toLowerCase()));
	const missing = (source.match(/[A-Za-z]{2,}/g) ?? []).filter(w => !kept.has(w.toLowerCase())).length;
	return cjk >= 4 && latinLeft <= cjk * 0.5 && cjk >= missing * 0.8;
}

/** True when a translated reference entry lost a leading author's source spelling. */
export function referenceAuthorsChanged(source: string, translated: string): boolean {
	const names = referenceLeadSurnames(source);
	return names.length > 0 && names.some(n => !translated.includes(n));
}

function isEcho(source: string, translated: string): boolean {
	const norm = (x: string): string => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
	const a = norm(source);
	return a.length > 0 && a === norm(translated);
}

/**
 * 这段短文本**原样保留**是不是正当的 (2.12.12)。
 *
 * 正当:没有自然语言词(数字、单位、符号)、全是缩写(CT / MRI / COVID-19 / IIa)、
 * 人名("Powers WJ" / "J. Smith" / "Zhang W, Li M")。
 * 不正当:含至少一个普通词(≥3 个字母且至少 2 个小写)—— "Document Title"、
 * "Not recommended"、"Table 3" 原样返回就是没译。
 *
 * 专名(药名、机构名)会被算成普通词而进入重试;重试链有上限,最终失败仍显示原文。
 * 这是有意的取舍:把没译的标为已译、写进缓存,比多花一两次请求坏得多。
 */
/**
 * An author cited by number or year (5.0, 校验 3332: 系统综述表格首列 100 格):
 * "Cademartiri [44]", "Kim et al. [50]", "Smith and Jones (2019)".
 */
function isAuthorCitation(source: string): boolean {
	return /^[A-Z][\p{L}'’-]+(?:\s+(?:et\s+al\.?|and|&)(?:\s+[A-Z][\p{L}'’-]+)?)?\s*(?:\[\d+(?:\s*[,–-]\s*\d+)*\]|\(\d{4}[a-z]?\))\.?$/u.test(source.trim());
}

function mayStayUntranslated(proseSource: string): boolean {
	let t = proseSource.trim();
	if (!t) { return true; }
	// 5.0 (联网校验 3064/3132: 表格单元格回声被拒 3–4 次): domain names and
	// e-mail-like tokens ("uclouvain.be") are identifiers, and a bare journal
	// locator ("Curr Opin Nephrol Hypertens. 2019;28:316-320.") is a citation —
	// models rightly return both unchanged.
	t = t.replace(/\b[\w.+-]*[A-Za-z][\w-]*\.(?:[A-Za-z]{2,}\.)*[A-Za-z]{2,}\b(?:\/\S*)?/g, m => /^[A-Z][a-z]+\.\s?[A-Z]/.test(m) ? m : ' ').trim();
	// "40 keV" / "120 kVp" in a table header is a value with its unit (校验 2638).
	t = protectTechnicalUnits(t, () => ' ').trim();
	if (!t || !/[A-Za-z]{3}/.test(t)) { return true; }

	if (/\b(?:19|20)\d{2}\s*[;:]\s*\d+/.test(t) && !/\b[a-z][a-z'’-]{3,}\b/.test(t.replace(/\b(?:doi|pmid|et al)\b/gi, ''))) { return true; }
	const words = (t.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [])
		.filter(w => w.replace(/[^A-Za-z]/g, '').length >= 3 && (w.match(/[a-z]/g) ?? []).length >= 2);
	if (words.length === 0) { return true; }
	// 作者名单(≥3 段、每段 ≥2 词)至少 6 个词,根本到不了这个分支 —— 它在上面的
	// PROSE_WORD_GATE 之后另有豁免;这里只需要认短形式的人名。
	// 姓 + 首字母缩写(可逗号连排),或 首字母. 姓。
	const surnameInitials = /^(?:[A-Z][a-z'’-]+(?:[\s-][A-Z][a-z'’-]+)?\s+[A-Z]{1,3}\.?\s*(?:,\s*|$))+$/;
	const initialSurname = /^(?:[A-Z]\.\s*){1,2}[A-Z][a-z'’-]+$/;
	return surnameInitials.test(t) || initialSurname.test(t) || looksLikePersonNames(t) || looksLikeCitationTail(t);
}

/** 学位/职称缩写 —— 署名行里跟在人名后面、原样保留是正当的。 */
const DEGREE_TOKENS = new Set(['MD', 'PhD', 'DPhil', 'RT', 'RN', 'MS', 'MSc', 'MA', 'BA', 'BS', 'BSc', 'MPH', 'MHS', 'MBA', 'DO', 'DDS', 'DVM', 'PharmD', 'ScD', 'DrPH', 'MBBS', 'MBChB', 'FRCR', 'FRCP', 'FACR', 'FACC', 'FAHA', 'FESC', 'FSIR', 'FRCPC', 'MRCP', 'DMD', 'OD', 'PA', 'NP', 'Dr', 'Prof', 'Jr', 'Sr', 'II', 'III']);

/**
 * 署名行 / 作者串 (3.1.3, Goenka 2016 p1、p8 实证): "Nancy A. Obuchowski, PhD"、
 * "Wadih Karim, RT"、"Morsbach F, Bickelhaupt S, Rätzer S," 原样返回被 2.12.12 的回声
 * 规则判成没译 → 反复重试、最后 unrecovered —— 而"人名原样保留"正是提示词要求的。
 * 判据全是形态的:按逗号/分号/and 切段,每段只许由 首字母大写的名字词(含变音符号、
 * 连字符、撇号)、首字母缩写(A. / AB)、学位缩写 组成,且至少含一个名字词;不许出现
 * 任何普通小写词 —— "Nancy and the team" 不算。
 */
export function looksLikePersonNames(text: string): boolean {
	const t = text.trim().replace(/[.,;]\s*$/, '');
	if (!t) {
		return false;
	}
	const segments = t.split(/\s*(?:,|;|\band\b|&)\s*/).filter(Boolean);
	if (!segments.length || segments.length > 12) {
		return false;
	}
	const nameWord = /^\p{Lu}[\p{Ll}\p{Lu}'’-]*\p{Ll}[\p{Ll}'’-]*$/u;   // Nancy / Obuchowski / Ramirez-Giraldo / O'Neil / Rätzer / McDonald
	// 首字母缩写:A. / A.B. / AB / F —— 至多两个字母。三个大写字母(CNR / MRI)是缩写词,不是人名。
	const initials = /^(?:\p{Lu}\.){1,2}$|^\p{Lu}{1,2}$/u;
	const particle = /^(?:van|von|de|der|den|del|da|di|la|le|du|dos|das|bin|ibn|ter|ten|af|el)$/;
	// 首字母大写的词串本身证明不了什么 —— "Document Title" / "No Evidence" 形态上与
	// "Nancy Obuchowski" 无法区分。必须有**人名专属**的证据:首字母缩写或学位缩写。
	let evidence = false;
	let named = 0;
	for (const seg of segments) {
		const tokens = seg.split(/\s+/).filter(Boolean);
		if (!tokens.length || tokens.length > 6) {
			return false;
		}
		let segNames = 0;
		let segDegrees = 0;
		for (const tok of tokens) {
			const bare = tok.replace(/[.,]+$/, '');
			if (DEGREE_TOKENS.has(bare)) {
				segDegrees++;
				evidence = true;
			}
			else if (nameWord.test(bare)) {
				segNames++;
			}
			else if (initials.test(bare)) {
				evidence = true;
			}
			else if (!particle.test(bare)) {
				return false;
			}
		}
		// 每一段要么是人名(≥1 个名字词),要么只是跟在人名后的学位("…, MD, PhD")。
		if (segNames === 0 && !(segDegrees > 0 && segDegrees === tokens.length)) {
			return false;
		}
		named += segNames;
	}
	return named > 0 && evidence;
}

/**
 * 参考文献的期刊尾段 (3.1.3, Goenka 2016 p8): "Radiol 2013;48(1):32–40." /
 * "2013;201(4):W626–W632." —— 刊名缩写 + 年;卷(期):页。原样返回是正当的。
 */
export function looksLikeCitationTail(text: string): boolean {
	const t = text.trim();
	return /^(?:[\p{Lu}][\p{L}.]*\s+){0,5}(?:19|20)\d{2}\s*;\s*\d+\s*(?:\(\d+(?:[–-]\d+)?\))?\s*:\s*[\p{Lu}]?\d+(?:[–-][\p{Lu}]?\d+)?\.?$/u.test(t);
}
/** Below this CJK ratio on a prose source, the response was not really translated. */
const MIN_TARGET_RATIO = 0.45;

/**
 * 短源文分界 (1.1.8): 散文部分不超过这么多字符的块 —— 标题、小标题、署名行、
 * 图注标签 —— 走小样本安全的验收。真正的正文段落差着一个数量级(Horst 2024
 * 第 1 页的三段正文分别是 839 / 1783 / 1761 字符),永远走原来的比率阈值。
 */
const SHORT_SOURCE_PROSE_CHARS = 80;

/**
 * 「还没翻译的拉丁词」计数: 只算以小写字母开头的普通词。全大写缩写
 * (CT, PCD, MRI, MD, PhD) 与 Title-Case 专名 (Siemens, Naeotom, Siegel,
 * Ramirez-Giraldo) 在忠实译文里本来就该原样保留 —— 把它们算成「未翻译的
 * 拉丁词」正是短标题被反复拒收的直接原因。
 *
 * 注意首词效应: 句首的普通词也是 Title-Case, 所以这个计数在长段落上会偏低。
 * 它因此只用于 SHORT_SOURCE_PROSE_CHARS 以内的短块, 长段落仍用
 * targetLanguageRatio 的全量拉丁词计数。
 */
export function untranslatedLatinWords(text: string): number {
	return (text.match(/[A-Za-z][A-Za-z'-]+/g) ?? []).filter(w => /^[a-z]/.test(w)).length;
}

/**
 * 短源文的验收。两条,都比原来的比率判定更贴合小样本:
 *
 *  1. 专名直接放行: 源文里一个可译的普通词都没有(整块是人名、机构名、
 *     缩写、学位后缀 —— "Marilyn J. Siegel, MD • Juan Carlos Ramirez-Giraldo,
 *     PhD •" 就是这样的一行),那么原样返回就是正确答案,拒收只会白烧请求。
 *     这是 looksLikeAuthorNameList 的推广: 那条规则要求 ≥3 个人名分段,
 *     署名被拆到第二行只剩 2 个名字时就失效了。
 *  2. 否则仍看中文占比,但分母只数「还没翻译的普通词」。
 *
 * 关键不变量: 分子(中文字数)与原来一致,分母只会变小或不变,所以对短块
 * 而言这只可能把「拒」变成「收」,不可能反过来 —— 不存在新的误收路径。
 * 纯回声依然被拒: 回声里的普通词原封不动地留着,中文字数为 0,比率就是 0。
 */
function shortSourceTranslated(proseSource: string, proseTranslation: string): boolean {
	if (untranslatedLatinWords(proseSource) === 0) {
		return true;
	}
	const cjk = (proseTranslation.match(CJK_RE) ?? []).length;
	const residual = untranslatedLatinWords(proseTranslation);
	const denom = cjk + residual;
	if (denom === 0) {
		return false;
	}
	return cjk / denom >= MIN_TARGET_RATIO;
}

/**
 * Fraction of a Chinese translation that is actually Chinese: CJK characters
 * over (CJK characters + Latin words). A whole translation scores high (a few
 * embedded acronyms like PCCT/MRI are normal); a half-translated or mixed
 * response scores low; pure echoed English scores 0.
 */
function targetLanguageRatio(text: string): number {
	const cjk = (text.match(CJK_RE) ?? []).length;
	const latinWords = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
	const denom = cjk + latinWords;
	return denom === 0 ? 0 : cjk / denom;
}

/**
 * Control characters / U+FFFD the source did not have (5.0, 联网校验 2958 p3):
 * a paragraph whose PDF font could not be decoded carries U+FFFD itself, and a
 * faithful translation copies it — rejecting that failed the block four times.
 */
function introducesInvalidCharacters(source: string, translated: string): boolean {
	const bad = /[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFD]/g;
	return (translated.match(bad) ?? []).length > (source.match(bad) ?? []).length;
}

/** Reason codes contain no source or response text and are safe for diagnostics. */
export function referenceRejectReason(source: string, translated: string, phase: string): string {
 const alignment = referenceAlignmentIssue(source, translated);
 if (alignment) return `${phase}:${alignment}`;
 if(!translated.trim()) return `${phase}:empty`;
 if(referenceAuthorsChanged(source,translated)) return `${phase}:reference-authors`;
 if(isEcho(source,translated)) return `${phase}:reference-echo`;
 if(isTruncatedTranslation(stripProtectable(source),stripProtectable(translated))) return `${phase}:reference-truncated`;
 return `${phase}:reference-${translationRejectReason(source,translated,'zh-CN') ?? 'integrity'}`;
}

/** Same validator, with a stable, text-free explanation for its rejection. */
export function translationRejectReason(source: string, translated: string, target: string): string | null {
 if (introducesInvalidCharacters(source, translated)) return 'invalid-character';
 const alignment = referenceAlignmentIssue(source, translated);
 if (alignment) return alignment;
 const unitIssue = technicalUnitIssue(source, translated) || numericPowerIssue(source, translated);
 if (unitIssue) return unitIssue;
 if (looksTranslated(source, translated, target)) return null;
 if (!translated.trim()) return 'empty';
 if (isEcho(source, translated)) return 'echo';
 if (isTruncatedTranslation(stripProtectable(source), stripProtectable(translated))) return 'truncated';
 if (hasMixedCopiedResidue(source, translated)) return 'copied-residue';
 return 'target-language-ratio';
}
