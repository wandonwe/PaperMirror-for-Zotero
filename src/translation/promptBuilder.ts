/**
 * Builds the system prompt + user payload for translation requests.
 * Pure module (unit-tested).
 */

import type { TranslationRequest } from '../types/models';

// v4: preserve technical units through placeholder protection and validation.
// Both page and segment cache identities include this policy version, so a
// translation accepted before the integrity checks cannot bypass them.
export const PROMPT_VERSION = 4;

// 5.0 (校验 2877, 用户 2026-11-21 同意): person names keep their source
// spelling. A transliteration of a pinyin name back into characters is a guess
// ("Naying He" → 「何娜英」) that the reader cannot verify against the original.
const allTextRule = 'Translate all natural-language content, including company/manufacturer names, institutions, product names, affiliations and publication names. Use established target-language names where known, otherwise a faithful transliteration; do not invent an original spelling or identity. Keep PERSON names (authors, investigators, contact persons, author lists) exactly as written in the source: never transliterate them or guess characters for romanized names. Translate surrounding titles and roles. Preserve numerical values, formulas, URLs, e-mail addresses, DOIs and exact alphanumeric model identifiers.';
const continuationRule = 'A block with continuationContext is a source sentence fragment split by layout (possibly across columns or pages). Read before + text + after together to understand the sentence. Translate only this block\'s text, keeping its role in that sentence: preserve negation, before/after conditions, and the ordered correspondence of metrics and values. Keep the translation in source-fragment order so adjacent translated fragments join coherently; do not prematurely close a sentence or move a condition/list into another fragment. The before/after source evidence is not additional content to translate or repeat. Where target-language grammar needs it, repeat only the minimal governing predicate to make a continuation unambiguous.';
const continuationUnitRule = 'Blocks sharing continuationUnit.id are ordered PARTS OF ONE COMPLETE SOURCE SENTENCE. Translate continuationUnit.source ONCE as a complete faithful sentence, then partition that ONE translation into contiguous natural phrase fragments for the part ids in order. The fragments concatenated must contain all original measurements, subjects, predicates, conjunctions, negation, timing conditions, and ordered metric/value relationships exactly once. Target-language grammar may redistribute meaning between neighbouring parts; never delete meaning to force word-by-word ownership. Keep fragment lengths roughly proportional to the corresponding source parts when possible. Every part.text is source content, even when repeated in the reference copy continuationUnit.source. Return every part id exactly once with a nonempty fragment. Do not translate the parts independently, repeat the whole sentence in each part, or leave natural-language words untranslated because a part is unfinished.';

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
	// 5.0 (联网校验 3384/3132): author names were transliterated ("Simsek ME" →
	// "西姆谢克 ME") and journal abbreviations paraphrased ("J Imaging Inf Med" →
	// 《影像信息医学》), which breaks looking the reference up. Only the title translates.
	const referenceRule = 'In bibliography entries, translate ONLY the article or book TITLE into the target language. Copy author names (including "et al."), journal names and abbreviations, years, volumes, issues, pages, DOIs and URLs exactly as written in the source; never transliterate or translate them. A reference title is natural language, not an identifier; do not copy the entire entry unchanged.';
	const hasStyleTags = request.blocks.some(b => b.text.includes('⟦b⟧') || b.text.includes('⟦i⟧'));
 const hasContinuation = request.blocks.some(b => b.continuationContext);
 const hasContinuationUnits = request.blocks.some(b => b.continuationUnit);
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
  if (hasContinuation) lines.push(continuationRule);
  if (hasContinuationUnits) lines.push(continuationUnitRule);
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
 if (hasContinuation) lines.push('- ' + continuationRule);
 if (hasContinuationUnits) lines.push('- ' + continuationUnitRule);
	if (hasPlaceholders) {
		lines.push('- Tokens like ⟦PM0⟧ are protected placeholders; copy them into the translation UNCHANGED and in a natural position.');
	}
	if (hasStyleTags) {
		lines.push('- Paired tags like ⟦b⟧…⟦/b⟧ or ⟦i⟧…⟦/i⟧ mark bold/italic spans: keep each pair wrapping the corresponding translated words (open AND close), or omit the pair entirely. Never emit an unmatched tag.');
	}
	if (request.previousContext || request.moduleContext) {
		lines.push('- The previousContext and moduleContext fields are for understanding only — do NOT translate or repeat them in the output.');
	}
	// 5.1: table cells with their headers (3023: scanner models "Alpha", "Force" → 阿尔法 / 力).
	if (request.blocks.some(b => b.tableHeaders)) {
		lines.push('- A block\'s "tableHeaders" (the column and row headers of that table cell) is for understanding only — do NOT translate or return it. Product, device, scanner, software and model names in table cells are proper names: copy them exactly as written. "productName": true marks a cell that is such a name (also where it is reused as a row label): return it unchanged.');
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
  const block = request.blocks[0];
  if (block?.continuationContext) {
   return JSON.stringify({ continuationContext: block.continuationContext, text: block.text });
  }
  return block?.text ?? '';
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
