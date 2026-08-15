/**
 * Formula / fragile-token protection. Pure module (unit-tested).
 *
 * Replaces content that must not be altered by the translator (math runs,
 * inline equations with heavy symbol density) with stable placeholders, and
 * restores them afterwards. DOIs, URLs, numbers, units, citation markers are
 * left inline (models keep them; the prompt also forbids changing them) —
 * placeholders are reserved for runs the model is likely to mangle.
 */

import type { PlaceholderEntry } from '../types/models';

const PLACEHOLDER_PREFIX = '⟦PM'; // ⟦PM0⟧
const PLACEHOLDER_SUFFIX = '⟧';

export function makePlaceholder(index: number): string {
	return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

const MATH_SYMBOLS = /[∑∏∫√∞≈≠≤≥±×÷∂∇∈∉⊂⊃∪∩⇒⇔→←↔αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/;

/** A token is "mathy" if dense in symbols/digits/operators and short on words. */
export function isFormulaRun(run: string): boolean {
	const trimmed = run.trim();
	if (trimmed.length < 3) {
		return false;
	}
	if (MATH_SYMBOLS.test(trimmed)) {
		return true;
	}
	const symbolish = (trimmed.match(/[=+\-*/^_(){}[\]|<>~]/g) ?? []).length;
	const letters = (trimmed.match(/[a-zA-Z一-鿿]/g) ?? []).length;
	const words = trimmed.split(/\s+/).filter(w => /^[a-zA-Z]{3,}$/.test(w)).length;
	return symbolish >= 3 && symbolish >= letters / 2 && words <= 1;
}

/**
 * Explicitly delimited math (LaTeX $...$, \(...\), \[...\]) is ALWAYS
 * protected — the delimiters are an unambiguous author signal.
 */
const DELIMITED_PATTERNS: RegExp[] = [
	/\$[^$]{1,200}\$/g,
	/\\\((?:[^\\]|\\[^)]){1,200}\\\)/g,
	/\\\[(?:[^\\]|\\[^\]]){1,200}\\\]/g
];

/**
 * 引用标记与统计量保护 (参照 retain-pdf 的类型化占位符思路): these runs must
 * reach the output byte-identical, and they are ALSO what used to poison the
 * "疑似未翻译" ratio check — a stats-dense line keeps its numerals and Latin
 * abbreviations in a perfect translation, scored low, and was rejected back to
 * English (斑马纹的一半成因). Masked before the request, they neither tempt the
 * model nor count against the prose-only validation.
 *
 * Deliberately conservative shapes only:
 *  - bracketed numeric citations  [12] [1,3–5] [4-6, 9]
 *  - p-values                     p < 0.001   P=.02
 *  - confidence intervals         95% CI: 0.71–0.94  (95% CI 1.2 to 3.4)
 *  - mean ± deviation             34.2 ± 5.1
 *  - sample sizes                 n = 342
 */
const CITATION_STAT_PATTERNS: RegExp[] = [
	/\[\d{1,3}(?:\s*[,;–—-]\s*\d{1,3}){0,8}\]/g,
	/\b[Pp]\s*[<>=≤≥]\s*\.?\d+(?:\.\d+)?/g,
	/\b\d{1,2}(?:\.\d)?%\s*CIs?\s*[:=,]?\s*\d[\d.]*\s*(?:[–—-]|to)\s*\d[\d.]*/g,
	/\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?/g,
	/\b[nN]\s*=\s*\d[\d,]*/g
];

/** Heuristic spans: symbol-dense inline runs, protected only if isFormulaRun. */
const HEURISTIC_PATTERNS: RegExp[] = [
	// e.g. "y = βx + ε" or "P(A|B) = P(B|A)P(A)/P(B)"
	/(?:[A-Za-zα-ωΑ-Ω0-9)\]]|\S)[^,。;；.!?]{0,80}?[=≈≠≤≥][^,。;；.!?]{1,120}/g
];

export interface ProtectResult {
	text: string;
	placeholders: PlaceholderEntry[];
}

export function protectFormulas(text: string, extraLiterals: string[] = []): ProtectResult {
	const placeholders: PlaceholderEntry[] = [];
	let out = text;
	let index = 0;
	const mask = (match: string): string => {
		const token = makePlaceholder(index++);
		placeholders.push({ token, original: match });
		return token;
	};
	for (const pattern of DELIMITED_PATTERNS) {
		out = out.replace(pattern, mask);
	}
	// 不译词列表 (user "do not translate" literals): masked like formulas, which
	// is far more reliable than asking the prompt nicely. Longest first so a
	// literal that contains another is masked whole.
	for (const literal of [...extraLiterals].sort((a, b) => b.length - a.length)) {
		const t = literal.trim();
		if (t.length < 2) {
			continue;
		}
		let next = '';
		let rest = out;
		for (;;) {
			const at = rest.indexOf(t);
			if (at < 0) {
				next += rest;
				break;
			}
			next += rest.slice(0, at) + mask(t);
			rest = rest.slice(at + t.length);
		}
		out = next;
	}
	for (const pattern of CITATION_STAT_PATTERNS) {
		out = out.replace(pattern, mask);
	}
	for (const pattern of HEURISTIC_PATTERNS) {
		out = out.replace(pattern, (match) => {
			if (!isFormulaRun(match)) {
				return match;
			}
			return mask(match);
		});
	}
	return { text: out, placeholders };
}

const TOKEN_RE = /⟦PM\d+⟧/g;

/**
 * Prose-only view of a text: protectable runs (math, citations, statistics)
 * and placeholder tokens removed. This is what the translated-or-not checks
 * should score — the stats are identical in source and translation BY DESIGN,
 * so counting them as "untranslated Latin" only produces false rejections.
 */
export function stripProtectable(text: string): string {
	return protectFormulas(text).text.replace(TOKEN_RE, ' ');
}

/**
 * 公式密集风险评分 — 移植自 RetainPDF `segment_risk.py::formula_risk_score`
 * 的可移植部分 (https://github.com/wxyhgk/retain-pdf, MIT License,
 * Copyright (c) 2026 RetainPDF contributors — 全文见 THIRD-PARTY-NOTICES.md). 高分的块正是模型最容易在批处理里搞砸的块(定义句、公式
 * 密集、占位符前置),它们应当走单块慢道。触发短语、阈值与加分值照搬原实现;
 * 依赖其内部分段计划的项目跳过。
 */
const FORMULA_RISK_TRIGGER_PHRASES = [
	'abbreviated as', 'defined as', 'denoted as', 'is defined as', 'can be defined as',
	'where ', 'represented by', 'expressed as', 'written as', 'calculated as',
	'corresponds to', 'refers to', 'stands for'
];

export function formulaRiskScore(maskedText: string, placeholderCount: number): number {
	const prose = stripProtectable(maskedText).replace(/\s+/g, ' ').trim();
	const lowered = prose.toLowerCase();
	const density = placeholderCount / Math.max(1, maskedText.length);
	let score = 0;
	if (FORMULA_RISK_TRIGGER_PHRASES.some(p => lowered.includes(p))) {
		score += 3;
	}
	if (placeholderCount >= 4) {
		score += 2;
	}
	if (placeholderCount >= 8) {
		score += 2;
	}
	if (prose.length >= 180) {
		score += 1;
	}
	if (density >= 0.015) {
		score += 1;
	}
	if (density >= 0.03) {
		score += 1;
	}
	// 占位符前置/中置各 +1 (原实现: skeleton 首尾位置判断的简化——token 出现
	// 在文本前 15% 或不在结尾,说明公式嵌在句子里而不是收尾)。
	const firstToken = maskedText.search(/⟦PM\d+⟧/);
	if (firstToken >= 0) {
		if (firstToken <= maskedText.length * 0.15) {
			score += 1;
		}
		const lastToken = maskedText.lastIndexOf('⟦PM');
		if (lastToken >= 0 && lastToken < maskedText.length - 24) {
			score += 1;
		}
	}
	return score;
}

/** 慢道判据 (segment_risk.py): 占位符 ≥4 且风险分 ≥6. */
export function isFormulaDenseRisk(maskedText: string, placeholderCount: number): boolean {
	return placeholderCount >= 4 && formulaRiskScore(maskedText, placeholderCount) >= 6;
}

export interface PlaceholderReport {
	ok: boolean;
	/** Tokens the translation lost entirely (neither ⟦PMn⟧ nor bare PMn). */
	missing: string[];
	/** ⟦PMn⟧-shaped tokens present in the output but never issued. */
	unexpected: string[];
}

/**
 * Inventory check (参照 retain-pdf: placeholder_inventory_mismatch /
 * unexpected_placeholder). ORDER is deliberately NOT checked — the target
 * language may legitimately reorder a citation or formula within the sentence.
 * The bare "PMn" form counts as present (models drop the brackets; restore
 * already handles that form).
 */
export function verifyPlaceholders(text: string, placeholders: PlaceholderEntry[]): PlaceholderReport {
	const missing = placeholders
		.filter((p) => {
			if (text.includes(p.token)) {
				return false;
			}
			// Same (?!\d) boundary as restore: "PM1" present must not be satisfied
			// by "PM10" (审核 P1 — the lost token was wrongly counted present and
			// the formula silently vanished after restore).
			const bare = p.token.replace(PLACEHOLDER_PREFIX, 'PM').replace(PLACEHOLDER_SUFFIX, '');
			return !new RegExp(`${bare}(?!\\d)`).test(text);
		})
		.map(p => p.token);
	const issued = new Set(placeholders.map(p => p.token));
	const unexpected = [...new Set((text.match(TOKEN_RE) ?? []).filter(t => !issued.has(t)))];
	return { ok: !missing.length && !unexpected.length, missing, unexpected };
}

export function restoreFormulas(text: string, placeholders: PlaceholderEntry[]): string {
	let out = text;
	for (const { token, original } of placeholders) {
		out = out.split(token).join(original);
		// Models sometimes drop the brackets; try a bare-number fallback token.
		// (?!\d) boundary (审核 P1): "PM1" is a PREFIX of "PM10"…"PM19" — the
		// old substring replace tore PM10 into original1+"0" whenever a block
		// carried ≥11 placeholders, which citation masking made routine.
		const bare = token.replace(PLACEHOLDER_PREFIX, 'PM').replace(PLACEHOLDER_SUFFIX, '');
		const bareRe = new RegExp(`${bare}(?!\\d)`, 'g');
		if (!out.includes(original) && bareRe.test(out)) {
			out = out.replace(bareRe, () => original);
		}
	}
	return out;
}

/** True when all placeholders survived translation (used for validation). */
export function placeholdersIntact(text: string, placeholders: PlaceholderEntry[]): boolean {
	return placeholders.every(p => text.includes(p.token));
}
