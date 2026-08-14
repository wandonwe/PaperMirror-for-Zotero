/**
 * 残留/质量判定规则 — 逐条移植自 retain-pdf 的生产级实现
 * (`llm/validation/english_residue.py` + `quality.py` 的可移植部分).
 *
 * 那套规则是在真实失败样本上磨出来的,几个关键思想:
 *  - "未翻译"的硬判据是 COPY-DOMINANCE(译文表面与原文表面相似度 ≥0.82),
 *    不是单纯的语言比例——比例低但不是抄原文的输出,重试大概率同样失败,
 *    硬拒只会烧请求(english_residue_repeated 止损的根源认识)。
 *  - 数据密集片段(NMR 谱线、数值串: 数字 ≥ max(6, 字母×0.35))是合法保留的
 *    数据,永远不算残留。
 *  - 作者名单(≥3 段、每段 2–5 个人名词)合法保留拉丁文。
 *  - 截断输出(原文 ≥200 字符、译文/原文 < 0.15)是硬错误——EN→ZH 正常比例
 *    0.3–0.5,0.15 以下必是尾巴/半截。
 *  - 混合残留: 译文有中文,但仍含 ≥12 词、与原文 copy-similar 的英文长跨度。
 *
 * Pure module — unit-testable.
 */

/** retain-pdf text_features.py 的原样常量. */
const EN_WORD_RE = /[A-Za-z]+(?:[-'][A-Za-z]+)?/g;
const EN_RESIDUE_SEGMENT_RE = /[A-Za-z][A-Za-z0-9\s,;:()'./%+-]{30,}/g;
const AUTHOR_NAME_TOKEN_RE = /\b(?:[A-Z]\.\s*)?[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'`´.-]+\b/g;

/** EN→ZH 截断判定 (quality.py): 原文下限与比例上限. */
const TRUNCATION_MIN_SOURCE_CHARS = 200;
const TRUNCATION_MAX_RATIO = 0.15;

/** copy-dominance 阈值 (english_residue.py: SequenceMatcher ≥ 0.82). */
const COPY_SIMILARITY = 0.82;
const COPY_MIN_SURFACE = 32;

export function englishWordCount(text: string): number {
	return (text.match(EN_WORD_RE) ?? []).length;
}

export function zhCharCount(text: string): number {
	let n = 0;
	for (const ch of text) {
		if (ch >= '一' && ch <= '鿿') {
			n++;
		}
	}
	return n;
}

/**
 * 归一化英文表面 (retain-pdf _normalized_english_surface): 小写、去非字母数字,
 * 用于 copy-dominance 比较 — 标点/空白差异不该掩盖"就是抄的原文"。
 */
export function normalizedSurface(text: string): string {
	return (text || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/**
 * 表面相似度 — bigram Dice 系数,近似 difflib SequenceMatcher.ratio 的量级。
 * 完全相同 = 1;无共同 bigram = 0。
 */
export function surfaceSimilarity(a: string, b: string): number {
	if (a === b) {
		return 1;
	}
	if (a.length < 2 || b.length < 2) {
		return 0;
	}
	const grams = (s: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const g = s.slice(i, i + 2);
			m.set(g, (m.get(g) ?? 0) + 1);
		}
		return m;
	};
	const ga = grams(a);
	const gb = grams(b);
	let shared = 0;
	for (const [g, ca] of ga) {
		const cb = gb.get(g);
		if (cb) {
			shared += Math.min(ca, cb);
		}
	}
	return (2 * shared) / (a.length - 1 + b.length - 1);
}

/** 译文表面 ≈ 原文表面 → 这是回声/抄写,不是翻译 (retain-pdf 硬判据). */
export function copyDominant(sourceText: string, translatedText: string): boolean {
	const a = normalizedSurface(sourceText);
	const b = normalizedSurface(translatedText);
	if (!a || !b) {
		return false;
	}
	if (a === b) {
		return true;
	}
	if (Math.min(a.length, b.length) < COPY_MIN_SURFACE) {
		return false;
	}
	return surfaceSimilarity(a, b) >= COPY_SIMILARITY;
}

/**
 * 数据密集片段 (retain-pdf _looks_like_data_dense_segment): 数字 ≥
 * max(6, 字母×0.35) → 合法保留的数据,不是待译散文。曾让 NMR 谱线/数值列表
 * 触发注定失败的重试。
 */
export function isDataDenseSegment(segment: string): boolean {
	let alpha = 0;
	let digits = 0;
	for (const ch of segment) {
		if (/[A-Za-z]/.test(ch)) {
			alpha++;
		}
		else if (/[0-9]/.test(ch)) {
			digits++;
		}
	}
	if (alpha <= 0) {
		return true;
	}
	return digits >= Math.max(6, Math.floor(alpha * 0.35));
}

/** 像英文散文: ≥minWords 个词且 ≥30 个字母,非 URL/邮箱. */
export function looksLikeEnglishProse(text: string, minWords = 6): boolean {
	const cleaned = text.trim();
	if (!cleaned) {
		return false;
	}
	if (/@|https?:\/\//.test(cleaned)) {
		return false;
	}
	if (englishWordCount(cleaned) < minWords) {
		return false;
	}
	let alpha = 0;
	for (const ch of cleaned) {
		if (/[A-Za-z]/.test(ch)) {
			alpha++;
		}
	}
	return alpha >= 30;
}

/**
 * 长英文残留跨度 (retain-pdf _long_english_residue_spans): ≥30 字符的拉丁段,
 * ≥minWords 个词、像散文、且不是数据密集。
 */
export function longEnglishResidueSpans(text: string, minWords = 10): string[] {
	const spans: string[] = [];
	for (const match of text.matchAll(EN_RESIDUE_SEGMENT_RE)) {
		const segment = (match[0] ?? '').split(/\s+/).join(' ');
		if (isDataDenseSegment(segment)) {
			continue;
		}
		if (englishWordCount(segment) >= minWords && looksLikeEnglishProse(segment, Math.min(minWords, 8))) {
			spans.push(segment);
		}
	}
	return spans;
}

/**
 * 作者名单 (retain-pdf _looks_like_author_name_list): ≥3 个逗号/and 分段、
 * 几乎每段都是 2–5 个人名词 → 合法保留拉丁文,不判残留。
 */
export function looksLikeAuthorNameList(text: string): boolean {
	const cleaned = text.trim();
	if (!cleaned || cleaned.length > 240 || /@|https?:\/\//.test(cleaned)) {
		return false;
	}
	const normalized = cleaned.replace(/ and /g, ', ');
	const segments = normalized
		.split(/,|;|\band\b/)
		.map(s => s.replace(/^[\s*†‡§,;]+|[\s*†‡§,;]+$/g, ''))
		.filter(Boolean);
	if (segments.length < 3) {
		return false;
	}
	let nameLike = 0;
	for (const segment of segments) {
		const words = segment.match(AUTHOR_NAME_TOKEN_RE) ?? [];
		if (words.length >= 2 && words.length <= 5) {
			nameLike++;
		}
	}
	return nameLike >= Math.max(3, segments.length - 1);
}

/**
 * 截断判定 (retain-pdf _truncated_translation_issue): 原文够长而译文异常短
 * → 模型只回了尾巴/半截,硬错误。
 */
export function isTruncatedTranslation(sourceText: string, translatedText: string): boolean {
	const source = sourceText.trim();
	const translated = translatedText.trim();
	if (source.length < TRUNCATION_MIN_SOURCE_CHARS || !translated) {
		return false;
	}
	return translated.length / source.length < TRUNCATION_MAX_RATIO;
}

/**
 * 混合残留 (retain-pdf looks_like_mixed_english_residue_output): 译文有中文,
 * 但仍带着与原文 copy-similar 的 ≥12 词英文长跨度 — 半翻半抄,应拒收重取。
 */
export function hasMixedCopiedResidue(sourceText: string, translatedText: string): boolean {
	if (zhCharCount(translatedText) <= 0) {
		return false;
	}
	const sourceSurface = normalizedSurface(sourceText);
	if (!sourceSurface) {
		return false;
	}
	for (const span of longEnglishResidueSpans(translatedText, 12)) {
		const spanSurface = normalizedSurface(span);
		if (spanSurface.length < COPY_MIN_SURFACE) {
			continue;
		}
		// 跨度是原文的子串(表面层面),或与原文整体高度相似 → 抄来的残留。
		if (sourceSurface.includes(spanSurface) || surfaceSimilarity(sourceSurface, spanSurface) >= COPY_SIMILARITY) {
			return true;
		}
	}
	return false;
}
