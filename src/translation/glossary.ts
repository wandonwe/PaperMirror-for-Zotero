/**
 * Glossary (术语表) management and matching. Pure module (unit-tested).
 */

import type { GlossaryRule } from '../types/models';

export function parseGlossaryJSON(json: string): GlossaryRule[] {
	try {
		const data = JSON.parse(json);
		if (!Array.isArray(data)) {
			return [];
		}
		const rules: GlossaryRule[] = [];
		for (const entry of data) {
			if (entry && typeof entry.source === 'string' && typeof entry.target === 'string' && entry.source.trim()) {
				rules.push({
					source: entry.source.trim(),
					target: entry.target.trim(),
					mode: entry.mode === 'suggested' ? 'suggested' : 'required'
				});
			}
		}
		return rules;
	}
	catch {
		return [];
	}
}

export function serializeGlossary(rules: GlossaryRule[]): string {
	return JSON.stringify(rules, null, '\t');
}

/**
 * Parse the simple "source → target" one-per-line format used in the UI.
 * Also accepts "->" and tab separators. Lines starting with # are comments.
 * A trailing "?" marks a suggested (reference-only) rule.
 */
export function parseGlossaryLines(text: string): GlossaryRule[] {
	const rules: GlossaryRule[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const match = line.match(/^(.+?)(?:\s*(?:→|->)\s*|\t+)(.+?)(\s*\?)?$/);
		if (!match) {
			continue;
		}
		rules.push({
			source: match[1]!.trim(),
			target: match[2]!.trim(),
			mode: match[3] ? 'suggested' : 'required'
		});
	}
	return rules;
}

export function serializeGlossaryLines(rules: GlossaryRule[]): string {
	return rules
		.map(r => `${r.source} → ${r.target}${r.mode === 'suggested' ? ' ?' : ''}`)
		.join('\n');
}

/**
 * Return only the rules that actually occur in the given texts, so requests
 * carry a minimal glossary payload (spec 4.5).
 */
export function matchRules(rules: GlossaryRule[], texts: string[]): GlossaryRule[] {
	if (!rules.length || !texts.length) {
		return [];
	}
	const haystack = texts.join('\n').toLowerCase();
	const matched: GlossaryRule[] = [];
	for (const rule of rules) {
		const needle = rule.source.toLowerCase();
		if (!needle) {
			continue;
		}
		if (haystack.includes(needle)) {
			matched.push(rule);
		}
	}
	return matched;
}

/** Merge glossaries with precedence: per-item > per-collection > global. */
export function mergeGlossaries(...layers: GlossaryRule[][]): GlossaryRule[] {
	const seen = new Map<string, GlossaryRule>();
	// Later layers have LOWER precedence, so iterate in order and keep first.
	for (const layer of layers) {
		for (const rule of layer) {
			const key = rule.source.toLowerCase();
			if (!seen.has(key)) {
				seen.set(key, rule);
			}
		}
	}
	return [...seen.values()];
}
