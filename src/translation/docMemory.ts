/**
 * 文档级术语记忆 (参照 retain-pdf 的自动 document memory, matched 注入).
 *
 * A long paper translates the same term dozens of times, and nothing used to
 * force page 12 to pick the same rendering page 2 did. This module learns the
 * pairs the model itself established and feeds them back as SUGGESTED glossary
 * rules on later requests — only when the term actually occurs (matched mode),
 * never as a hard override of the user's own glossary.
 *
 * The only extraction pattern is the one that is reliably right: the standard
 * academic first-occurrence form in the TRANSLATION —「中文术语(ABBR)」—
 * cross-checked against the SOURCE containing that abbreviation. Free-form
 * alignment would need a model call; this needs none and cannot hallucinate.
 *
 * Pure module — unit-testable, no Zotero APIs.
 */

import type { GlossaryRule } from '../types/models';

/** 「中文术语(ABBR)」 in a translation: CJK run directly before (ALLCAPS-ish). */
const PAIR_RE = /([一-鿿]{2,14})\s*[(（]\s*([A-Z][A-Za-z0-9-]{1,11})\s*[)）]/g;

/** Abbreviations that are ordinary words/units, not terms worth remembering. */
const STOP_ABBRS = new Set(['CI', 'SD', 'OR', 'HR', 'RR', 'IQR', 'AUC', 'N', 'P', 'ID', 'DOI', 'URL', 'PDF', 'FIG', 'EQ']);

export interface TermPair {
	source: string;
	target: string;
}

/**
 * Extract first-occurrence term pairs from one accepted translation. The
 * abbreviation must ALSO appear in the source text — that is what ties the
 * Chinese term to a real source-side concept instead of a model flourish.
 */
export function extractTermPairs(sourceText: string, translatedText: string): TermPair[] {
	const pairs: TermPair[] = [];
	if (!sourceText || !translatedText) {
		return pairs;
	}
	PAIR_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PAIR_RE.exec(translatedText)) !== null) {
		const term = m[1]!;
		const abbr = m[2]!;
		if (STOP_ABBRS.has(abbr.toUpperCase())) {
			continue;
		}
		// Require ≥2 uppercase letters (a real abbreviation, not "Figure").
		if ((abbr.match(/[A-Z]/g) ?? []).length < 2) {
			continue;
		}
		if (!sourceText.includes(abbr)) {
			continue;
		}
		pairs.push({ source: abbr, target: term });
	}
	return pairs;
}

const MAX_ENTRIES = 200;

export class DocumentMemory {
	private entries = new Map<string, string>();

	/** First occurrence wins — the paper's own first expansion is authoritative. */
	learn(pairs: TermPair[]): void {
		for (const pair of pairs) {
			if (this.entries.size >= MAX_ENTRIES) {
				return;
			}
			if (!this.entries.has(pair.source)) {
				this.entries.set(pair.source, pair.target);
			}
		}
	}

	/** All remembered pairs as SUGGESTED rules (user glossary outranks them). */
	rules(): GlossaryRule[] {
		return [...this.entries].map(([source, target]) => ({ source, target, mode: 'suggested' as const }));
	}

	size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}
}
