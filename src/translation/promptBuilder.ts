/**
 * Builds the system prompt + user payload for translation requests.
 * Pure module (unit-tested).
 */

import type { TranslationRequest } from '../types/models';

// v3: translate natural-language names and affiliations as well as prose.
// Cached original-language names from the previous policy must be retranslated.
export const PROMPT_VERSION = 3;

const allTextRule = 'Translate all natural-language content, including person names, company/manufacturer names, institutions, product names, author lists, affiliations and publication names. Use established target-language names where known, otherwise a faithful transliteration; do not invent an original spelling or identity. Translate surrounding titles and roles too. Preserve numerical values, formulas, URLs, DOIs and exact alphanumeric model identifiers.';

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
	// 按请求内容条件化规则行 (2.3.5, 第四批 item7 · API-4): 载荷里根本没有占位符/
	// 样式标记/上下文的请求,不再携带对应规则 —— 大多数请求省 ~50–120 输入 token,
	// 且对确实携带这些标记的请求一字不变(无需 bump PROMPT_VERSION、不作废缓存)。
	const hasPlaceholders = request.blocks.some(b => b.text.includes('⟦PM'));
	const referenceRule = 'In bibliography entries, translate the article or book TITLE into the target language. Translate author and journal names too; keep years, volumes, pages and DOIs unchanged. A reference title is natural language, not an identifier; do not copy the entire entry unchanged.';
	const hasStyleTags = request.blocks.some(b => b.text.includes('⟦b⟧') || b.text.includes('⟦i⟧'));
	if (request.plain) {
		// 纯文本兜底 (修复链路最后一环): the block failed the JSON path repeatedly —
		// strip every structural demand so nothing but translation can go wrong.
		const lines = [
			`Translate the academic text the user sends into ${target}.`,
			'Output ONLY the translation itself — no explanations, no quotes, no JSON, no markdown.',
			'Never alter numbers, statistics, citation markers, URLs, or math.',
            allTextRule
		];
		if (request.referenceContent) lines.push(referenceRule);
		if (hasPlaceholders) {
			lines.push('Tokens like ⟦PM0⟧ are protected placeholders; copy them into the translation unchanged.');
		}
		if (hasStyleTags) {
			lines.push('Paired tags like ⟦b⟧…⟦/b⟧ or ⟦i⟧…⟦/i⟧ mark bold/italic spans; keep each pair wrapping the corresponding translated words, or omit the pair entirely.');
		}
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
		allTextRule
	];
	if (request.referenceContent) lines.push('- ' + referenceRule);
	if (hasPlaceholders) {
		lines.push('- Tokens like ⟦PM0⟧ are protected placeholders; copy them into the translation UNCHANGED and in a natural position.');
	}
	if (hasStyleTags) {
		lines.push('- Paired tags like ⟦b⟧…⟦/b⟧ or ⟦i⟧…⟦/i⟧ mark bold/italic spans: keep each pair wrapping the corresponding translated words (open AND close), or omit the pair entirely. Never emit an unmatched tag.');
	}
	if (request.previousContext || request.moduleContext) {
		lines.push('- The previousContext and moduleContext fields are for understanding only — do NOT translate or repeat them in the output.');
	}
	lines.push(
		'- Respond with ONLY a JSON object of this exact shape, no markdown fences, no commentary:',
		'  {"translations":[{"id":"<block id>","translatedText":"<translation>"}]}',
		'- Include every input block id exactly once.'
	);
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
