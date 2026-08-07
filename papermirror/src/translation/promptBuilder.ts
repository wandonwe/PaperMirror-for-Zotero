/**
 * Builds the system prompt + user payload for translation requests.
 * Pure module (unit-tested).
 */

import type { TranslationRequest } from '../types/models';

export const PROMPT_VERSION = 1;

export function languageDisplayName(code: string): string {
	switch (code) {
		case 'zh-CN': return 'Simplified Chinese (简体中文)';
		case 'zh-TW': return 'Traditional Chinese (繁體中文)';
		case 'zh': return 'Chinese';
		case 'en': return 'English';
		case 'auto': return 'the appropriate language';
		default: return code;
	}
}

export function buildSystemPrompt(request: TranslationRequest, customPrompt?: string): string {
	const target = languageDisplayName(request.targetLanguage);
	const lines: string[] = [
		`You are a professional academic translator. Translate scholarly text into ${target}.`,
		'',
		'Rules:',
		'- Translate each block faithfully. Do NOT add conclusions, summaries or facts that are not in the source.',
		'- Use standard academic terminology in the target language.',
		'- On first occurrence of a technical abbreviation, keep the original abbreviation in parentheses.',
		'- Never alter numbers, P values, confidence intervals, units, DOIs, URLs, citation markers (e.g. [12], (Smith et al., 2020)), gene names, chemical formulas, variable names, or math.',
		'- Tokens like ⟦PM0⟧ are protected placeholders; copy them into the translation UNCHANGED and in a natural position.',
		'- The previousContext field is for understanding only — do NOT translate or repeat it in the output.',
		'- Respond with ONLY a JSON object of this exact shape, no markdown fences, no commentary:',
		'  {"translations":[{"id":"<block id>","translatedText":"<translation>"}]}',
		'- Include every input block id exactly once.'
	];
	if (request.glossary && request.glossary.length) {
		lines.push('', 'Glossary:');
		for (const rule of request.glossary) {
			if (rule.mode === 'required') {
				lines.push(`- "${rule.source}" MUST be translated as "${rule.target}".`);
			}
			else {
				lines.push(`- "${rule.source}" is usually translated as "${rule.target}" (reference only).`);
			}
		}
	}
	if (customPrompt && customPrompt.trim()) {
		lines.push('', 'Additional user instructions:', customPrompt.trim());
	}
	return lines.join('\n');
}

export function buildUserPayload(request: TranslationRequest): string {
	return JSON.stringify({
		sourceLanguage: request.sourceLanguage,
		targetLanguage: request.targetLanguage,
		documentTitle: request.documentTitle,
		previousContext: request.previousContext,
		blocks: request.blocks
	});
}
