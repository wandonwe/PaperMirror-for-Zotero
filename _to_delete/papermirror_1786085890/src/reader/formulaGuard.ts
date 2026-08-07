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

/** Heuristic spans: symbol-dense inline runs, protected only if isFormulaRun. */
const HEURISTIC_PATTERNS: RegExp[] = [
	// e.g. "y = βx + ε" or "P(A|B) = P(B|A)P(A)/P(B)"
	/(?:[A-Za-zα-ωΑ-Ω0-9)\]]|\S)[^,。;；.!?]{0,80}?[=≈≠≤≥][^,。;；.!?]{1,120}/g
];

export interface ProtectResult {
	text: string;
	placeholders: PlaceholderEntry[];
}

export function protectFormulas(text: string): ProtectResult {
	const placeholders: PlaceholderEntry[] = [];
	let out = text;
	let index = 0;
	for (const pattern of DELIMITED_PATTERNS) {
		out = out.replace(pattern, (match) => {
			const token = makePlaceholder(index++);
			placeholders.push({ token, original: match });
			return token;
		});
	}
	for (const pattern of HEURISTIC_PATTERNS) {
		out = out.replace(pattern, (match) => {
			if (!isFormulaRun(match)) {
				return match;
			}
			const token = makePlaceholder(index++);
			placeholders.push({ token, original: match });
			return token;
		});
	}
	return { text: out, placeholders };
}

export function restoreFormulas(text: string, placeholders: PlaceholderEntry[]): string {
	let out = text;
	for (const { token, original } of placeholders) {
		out = out.split(token).join(original);
		// Models sometimes drop the brackets; try a bare-number fallback token
		const bare = token.replace(PLACEHOLDER_PREFIX, 'PM').replace(PLACEHOLDER_SUFFIX, '');
		if (!out.includes(original) && out.includes(bare)) {
			out = out.split(bare).join(original);
		}
	}
	return out;
}

/** True when all placeholders survived translation (used for validation). */
export function placeholdersIntact(text: string, placeholders: PlaceholderEntry[]): boolean {
	return placeholders.every(p => text.includes(p.token));
}
