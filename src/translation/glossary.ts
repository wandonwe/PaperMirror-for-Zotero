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

/**
 * 学得术语与词汇表去重 (2.3.1, 第四批 item3 · WF-8) — pure。
 * 返回**尚不在**词汇表里的学得术语(source 大小写不敏感比较);对学得列表自身
 * 也去重(同 source 学得多次取首个)。空 target/source 的脏条目被丢弃。
 */
export function dedupeLearnedTerms(
	existing: GlossaryRule[],
	learned: { source: string; target: string }[]
): { source: string; target: string }[] {
	const known = new Set(existing.map(r => r.source.toLowerCase()));
	const fresh: { source: string; target: string }[] = [];
	for (const t of learned) {
		const source = t.source?.trim();
		const target = t.target?.trim();
		if (!source || !target) {
			continue;
		}
		const key = source.toLowerCase();
		if (!known.has(key)) {
			known.add(key);
			fresh.push({ source, target });
		}
	}
	return fresh;
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
