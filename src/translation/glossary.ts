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

/**
 * 每次请求最多注入多少条**学得**术语 (2.5.9)。
 *
 * docMemory 边翻边学,上限 200 条,而缩写天然反复出现 —— 读到文末时命中的
 * 比例相当高,每条命中都会变成提示词里的一行。matchRules 已经把没出现的滤掉
 * 了,但没有上限:最坏情况一次请求多出两百行、数千输入 token,而且越往后越贵。
 *
 * 40 是天花板而不是常态:一页真正出现的**不同**缩写通常在二三十条以内,所以
 * 多数页面根本碰不到它。它挡的是长文末尾那种病态情形。
 */
export const MAX_LEARNED_RULES_PER_REQUEST = 40;

/**
 * 给注入的术语设上限 —— 用户词汇表一条不动,只裁**学得**的部分。
 *
 * 保留谁按「本页出现次数」排:出现得多的术语,前后一致的收益也大。次数相同时
 * 先留更长的 source(更具体,更不容易误替换),再按字典序,保证结果稳定可测。
 */
export function capLearnedRules(
	matched: GlossaryRule[],
	userSources: Set<string>,
	texts: string[],
	cap = MAX_LEARNED_RULES_PER_REQUEST
): GlossaryRule[] {
	const learned = matched.filter(r => !userSources.has(r.source.toLowerCase()));
	if (learned.length <= cap) {
		return matched;
	}
	const hay = texts.join('\n').toLowerCase();
	const hits = new Map<GlossaryRule, number>();
	for (const rule of learned) {
		const needle = rule.source.toLowerCase();
		hits.set(rule, needle ? hay.split(needle).length - 1 : 0);
	}
	const kept = new Set(
		[...learned].sort((a, b) =>
			(hits.get(b)! - hits.get(a)!)
			|| (b.source.length - a.source.length)
			|| a.source.localeCompare(b.source)
		).slice(0, cap)
	);
	return matched.filter(r => userSources.has(r.source.toLowerCase()) || kept.has(r));
}
