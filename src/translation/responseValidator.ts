/**
 * Validates and repairs model responses. Pure module (unit-tested).
 */

import type { TranslatedBlock, TranslationResponse } from '../types/models';
import { PaperMirrorError } from '../types/models';

/** Extract the first JSON object from raw model output (handles ``` fences). */
export function extractJSON(raw: string): unknown {
	let text = raw.trim();
	// Strip markdown fences
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch && fenceMatch[1]) {
		text = fenceMatch[1].trim();
	}
	try {
		return JSON.parse(text);
	}
	catch {
		// Fall through to brace scanning
	}
	const start = text.indexOf('{');
	if (start === -1) {
		throw new PaperMirrorError('BAD_RESPONSE', 'The translation service did not return JSON.');
	}
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === '\\') {
			escape = inString;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}
		if (ch === '{') {
			depth++;
		}
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				const candidate = text.slice(start, i + 1);
				try {
					return JSON.parse(candidate);
				}
				catch {
					throw new PaperMirrorError('BAD_RESPONSE', 'The translation service returned malformed JSON.');
				}
			}
		}
	}
	throw new PaperMirrorError('BAD_RESPONSE', 'The translation service returned truncated JSON.');
}

/**
 * 纯文本兜底解析: the whole response IS the translation. Strips code fences,
 * surrounding quotes and a leading "Translation:"-style label if the model
 * added one despite instructions. Empty output throws BAD_RESPONSE so the
 * caller's repair chain sees a normal failure.
 */
export function parsePlainResponse(raw: string, id: string): ValidatedResponse {
	let text = raw.trim();
	const fence = text.match(/^```(?:\w+)?\s*([\s\S]*?)```$/);
	if (fence?.[1]) {
		text = fence[1].trim();
	}
	text = text.replace(/^(?:translation|译文|翻译)\s*[:：]\s*/i, '').trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
		text = text.slice(1, -1).trim();
	}
	if (!text) {
		throw new PaperMirrorError('BAD_RESPONSE', 'The plain-mode translation came back empty.');
	}
	return { translations: [{ id, translatedText: text }], missingIds: [], extraIds: [] };
}

export interface ValidatedResponse {
	translations: TranslatedBlock[];
	missingIds: string[];
	extraIds: string[];
}

export function validateResponse(raw: string | unknown, expectedIds: string[]): ValidatedResponse {
	const data = typeof raw === 'string' ? extractJSON(raw) : raw;
	if (!data || typeof data !== 'object') {
		throw new PaperMirrorError('BAD_RESPONSE', 'The translation response is not an object.');
	}
	const translationsRaw = (data as TranslationResponse).translations;
	if (!Array.isArray(translationsRaw)) {
		throw new PaperMirrorError('BAD_RESPONSE', 'The translation response is missing the "translations" array.');
	}
	const expected = new Set(expectedIds);
	const seen = new Set<string>();
	const translations: TranslatedBlock[] = [];
	const extraIds: string[] = [];
	for (const entry of translationsRaw) {
		if (!entry || typeof entry.id !== 'string' || typeof entry.translatedText !== 'string') {
			continue;
		}
		if (seen.has(entry.id)) {
			continue; // ignore duplicates, keep first
		}
		seen.add(entry.id);
		if (expected.has(entry.id)) {
			translations.push({ id: entry.id, translatedText: entry.translatedText });
		}
		else {
			extraIds.push(entry.id);
		}
	}
	const missingIds = expectedIds.filter(id => !seen.has(id));
	return { translations, missingIds, extraIds };
}
