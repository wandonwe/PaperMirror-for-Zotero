/**
 * Builds the system prompt + user payload for translation requests.
 * Pure module (unit-tested).
 */

import type { TranslationRequest } from '../types/models';

// v2: layout budgets (charBudget) + compact-translation rules for strict
// in-place replacement. The bump also invalidates every cached translation
// produced under the old prompts — old long-form output must not resurface
// inside fixed-geometry boxes.
export const PROMPT_VERSION = 2;

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
	if (request.plain) {
		// 纯文本兜底 (修复链路最后一环): the block failed the JSON path repeatedly —
		// strip every structural demand so nothing but translation can go wrong.
		const lines = [
			`Translate the academic text the user sends into ${target}.`,
			'Output ONLY the translation itself — no explanations, no quotes, no JSON, no markdown.',
			'Never alter numbers, statistics, citation markers, URLs, or math.',
			'Tokens like ⟦PM0⟧ are protected placeholders; copy them into the translation unchanged.'
		];
		if (request.glossary?.length) {
			lines.push('Terminology: ' + request.glossary.map(r => `"${r.source}" → "${r.target}"`).join('; ') + '.');
		}
		if (customPrompt && customPrompt.trim()) {
			lines.push(customPrompt.trim());
		}
		return lines.join('\n');
	}
	const lines: string[] = [
		`You are a professional academic translator. Translate scholarly text into ${target}.`,
		'',
		'Rules:',
		'- Translate each block faithfully. Do NOT add conclusions, summaries or facts that are not in the source.',
		'- Use standard academic terminology in the target language.',
		'- On first occurrence of a technical abbreviation, keep the original abbreviation in parentheses.',
		'- Never alter numbers, P values, confidence intervals, units, DOIs, URLs, citation markers (e.g. [12], (Smith et al., 2020)), gene names, chemical formulas, variable names, or math.',
		'- Tokens like ⟦PM0⟧ are protected placeholders; copy them into the translation UNCHANGED and in a natural position.',
		'- The previousContext and moduleContext fields are for understanding only — do NOT translate or repeat them in the output.',
		'- Respond with ONLY a JSON object of this exact shape, no markdown fences, no commentary:',
		'  {"translations":[{"id":"<block id>","translatedText":"<translation>"}]}',
		'- Include every input block id exactly once.'
	];
	if (request.blocks.some(b => typeof b.charBudget === 'number')) {
		lines.push(
			'',
			'Layout budgets:',
			'- Blocks carrying "charBudget" are re-typeset INSIDE their original rectangle: the translation MUST fit within roughly that many target-language characters.',
			'- Compress by using dense, standard academic phrasing — never by dropping facts, numbers, units, statistics or citation markers.',
			'- Do not add explanations, parenthetical glosses, or synonym doubling.',
			'- Keep abbreviations as-is instead of expanding them when space is tight.'
		);
	}
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
	if (request.plain) {
		return request.blocks[0]?.text ?? '';
	}
	return JSON.stringify({
		sourceLanguage: request.sourceLanguage,
		targetLanguage: request.targetLanguage,
		documentTitle: request.documentTitle,
		previousContext: request.previousContext,
		...(request.moduleContext ? { moduleContext: request.moduleContext } : {}),
		blocks: request.blocks
	});
}
