/**
 * Sentence deep-explanation (选中句子深度讲解), inspired by Read Frog's
 * article-analysis mode, adapted for academic reading: full translation,
 * key terms with field-specific meaning, grammar/structure notes and
 * abbreviation expansion for a selected sentence or passage.
 *
 * Requires an LLM provider (one that implements `complete`); the free MT
 * engines cannot explain.
 */

import type { ProviderSettings } from '../types/models';
import { PaperMirrorError } from '../types/models';
import type { TranslationProvider } from './providers/types';

export const MAX_EXPLAIN_CHARS = 2000;

export function explanationLanguageName(targetLanguage: string): string {
	switch (targetLanguage) {
		case 'en': return 'English';
		case 'zh-TW': return '繁體中文';
		default: return '简体中文';
	}
}

export function buildExplainPrompt(options: {
	text: string;
	targetLanguage: string;
	documentTitle?: string;
	context?: string;
}): string {
	const lang = explanationLanguageName(options.targetLanguage);
	const lines: string[] = [
		`You are an expert academic reading tutor. Explain the following passage from a scholarly paper in ${lang}. Structure your answer in plain text (no markdown headers) with these labeled sections:`,
		'',
		`1. 整体翻译 — a faithful ${lang} translation of the passage.`,
		'2. 关键术语 — key technical terms with their field-specific meaning; keep the original term, then explain it.',
		'3. 句法结构 — a brief analysis of the sentence structure (main clause, subordinate clauses, referents of pronouns) that helps a non-native reader parse it.',
		'4. 缩写与符号 — expand any abbreviations, acronyms, statistical notations (e.g. HR, CI, P values); skip this section if none.',
		'',
		'Rules: do not invent facts beyond the passage; keep numbers, units and citations unchanged; be concise and educational.'
	];
	if (options.documentTitle) {
		lines.push('', `Paper title (for context only): ${options.documentTitle}`);
	}
	if (options.context && options.context.trim()) {
		lines.push('', 'Surrounding context (for understanding only — do NOT explain or translate it):', options.context.trim().slice(0, 600));
	}
	lines.push('', 'Passage to explain:', options.text.trim());
	return lines.join('\n');
}

export async function explainText(
	provider: TranslationProvider,
	settings: ProviderSettings,
	options: {
		text: string;
		targetLanguage: string;
		documentTitle?: string;
		context?: string;
		signal?: AbortSignal;
	}
): Promise<string> {
	const text = options.text.trim();
	if (!text) {
		throw new PaperMirrorError('UNKNOWN', 'Nothing selected to explain.', { retryable: false });
	}
	if (!provider.complete) {
		throw new PaperMirrorError('UNKNOWN', 'EXPLAIN_UNSUPPORTED', { retryable: false });
	}
	if (provider.requiresApiKey && !settings.apiKey) {
		throw new PaperMirrorError('NO_API_KEY', 'No API key configured for the current provider.', { retryable: false });
	}
	const prompt = buildExplainPrompt({
		text: text.slice(0, MAX_EXPLAIN_CHARS),
		targetLanguage: options.targetLanguage,
		documentTitle: options.documentTitle,
		context: options.context
	});
	const result = await provider.complete(prompt, settings, { signal: options.signal });
	return result.trim();
}

/** True if this provider can power the explain feature. */
export function canExplain(provider: TranslationProvider): boolean {
	return typeof provider.complete === 'function';
}

// ---- output parsing (for the structured explain card) ----------------------

export interface ExplanationSection {
	label: string;
	text: string;
}

const SECTION_LABELS = [
	'整体翻译', '關鍵術語', '关键术语', '句法结构', '句法結構',
	'缩写与符号', '縮寫與符號', 'Full translation', 'Key terms',
	'Syntax', 'Sentence structure', 'Abbreviations'
];

/**
 * Split the LLM's labeled-section answer into (label, text) pairs for the
 * card layout. Tolerates "1. 整体翻译 —", "整体翻译:", "**整体翻译**" etc.
 * Falls back to a single unlabeled section when nothing matches.
 */
export function parseExplanationSections(raw: string): ExplanationSection[] {
	const text = raw.trim();
	if (!text) {
		return [];
	}
	const labelAlternation = SECTION_LABELS
		.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('|');
	const headerPattern = new RegExp(
		`^\\s*(?:\\d+[.)、]?\\s*)?(?:\\*\\*)?(${labelAlternation})(?:\\*\\*)?\\s*[—\\-–::]?\\s*`,
		'i'
	);
	const sections: ExplanationSection[] = [];
	let current: ExplanationSection | null = null;
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(headerPattern);
		if (match && match[1]) {
			if (current) {
				current.text = current.text.trim();
				sections.push(current);
			}
			current = { label: match[1], text: line.slice(match[0].length) };
		}
		else if (current) {
			current.text += (current.text ? '\n' : '') + line;
		}
		else if (line.trim()) {
			current = { label: '', text: line };
		}
	}
	if (current) {
		current.text = current.text.trim();
		sections.push(current);
	}
	const labeled = sections.filter(s => s.label && s.text);
	if (labeled.length >= 2) {
		return labeled;
	}
	return [{ label: '', text }];
}
