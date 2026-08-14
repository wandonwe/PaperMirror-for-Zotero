/**
 * Anthropic Claude API provider (Messages API).
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { parsePlainResponse, validateResponse } from '../responseValidator';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';
import { anthropicMessagesURL } from './urls';

const DEFAULT_BASE = 'https://api.anthropic.com';
// claude-sonnet-5 is the current recommended Sonnet for translation (balanced
// quality/latency; 2026-08-10, platform.claude.com). Kept in sync w/ modelCatalog.
const DEFAULT_MODEL = 'claude-sonnet-5';
const API_VERSION = '2023-06-01';

function headers(settings: ProviderSettings): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'x-api-key': settings.apiKey,
		'anthropic-version': API_VERSION
	};
}

function messagesURL(settings: ProviderSettings): string {
	const path = (settings.apiPath ?? '').trim();
	if (path) {
		const b = (settings.apiBaseURL || DEFAULT_BASE).replace(/\/+$/, '');
		return b + (path.startsWith('/') ? path : `/${path}`);
	}
	return anthropicMessagesURL(settings.apiBaseURL, DEFAULT_BASE);
}

/**
 * Advanced body fields for Anthropic (opt-in). Extended thinking is enabled only
 * at reasoning 'high' (translation rarely needs it); thinking mode forbids a
 * custom temperature, so temperature is applied only when thinking is off. The
 * `thinking` blocks in the reply are ignored by extractText (text parts only).
 */
function advancedBody(settings: ProviderSettings, defaultMax: number): Record<string, unknown> {
	const maxTokens = settings.maxOutputTokens && settings.maxOutputTokens > 0
		? Math.floor(settings.maxOutputTokens)
		: defaultMax;
	const out: Record<string, unknown> = { max_tokens: maxTokens };
	if (settings.reasoning === 'high' || settings.reasoning === 'xhigh') {
		// The thinking budget is ADDED ON TOP of the output allowance — carving
		// it out of max_tokens starved big batches (8000-char chunks need
		// ~4000–6000 output tokens; thoughts ate half and the JSON truncated,
		// which surfaces as a non-retryable BAD_RESPONSE losing the whole chunk).
		const budget = 2048;
		out.thinking = { type: 'enabled', budget_tokens: budget };
		out.max_tokens = maxTokens + budget;
	}
	else {
		// 温度默认 0 — deterministic output suits translation (thinking mode
		// forbids a custom temperature, hence the else branch).
		out.temperature = typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)
			? settings.temperature
			: 0;
	}
	return out;
}

function extractText(json: unknown): string {
	const content = (json as { content?: { type?: string; text?: string }[] })?.content;
	if (!Array.isArray(content)) {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Anthropic response shape.');
	}
	return content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
}

export const anthropicProvider: TranslationProvider = {
	id: 'anthropic',
	displayName: 'Anthropic Claude',
	defaultBaseURL: DEFAULT_BASE,
	defaultModel: DEFAULT_MODEL,
	requiresApiKey: true,
	supportsCharBudget: true,

	endpointFor(settings: ProviderSettings): string {
		return messagesURL(settings);
	},

	async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
		if (!settings.apiKey) {
			return { ok: false, message: 'NO_API_KEY' };
		}
		try {
			const { status, json, elapsedMs } = await requestJSON(messagesURL(settings), {
				headers: headers(settings),
				body: {
					model: settings.model || DEFAULT_MODEL,
					max_tokens: 32,
					messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
				},
				timeoutMs: Math.min(settings.timeoutMs, 30000)
			});
			const text = extractText(json);
			return { ok: true, httpStatus: status, modelAvailable: text.length > 0, elapsedMs };
		}
		catch (e) {
			const err = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			return { ok: false, message: err.code, httpStatus: err.httpStatus };
		}
	},

	async translate(request: TranslationRequest, settings: ProviderSettings, options: TranslateOptions): Promise<TranslationResponse> {
		const { json } = await requestJSON(messagesURL(settings), {
			headers: headers(settings),
			body: {
				model: settings.model || DEFAULT_MODEL,
				// 16384 (was 8192): an 8000-char source batch translates to
				// ~4000–6000 CJK output tokens plus JSON/id overhead — 8192 was
				// borderline and truncated JSON kills the whole chunk.
				...advancedBody(settings, 16384),
				system: buildSystemPrompt(request, settings.customPrompt),
				messages: [{ role: 'user', content: buildUserPayload(request) }]
			},
			timeoutMs: settings.timeoutMs,
			signal: options.signal
		});
		const text = extractText(json);
		const { translations } = request.plain
			? parsePlainResponse(text, request.blocks[0]!.id)
			: validateResponse(text, request.blocks.map(b => b.id));
		return { translations };
	},

	async complete(prompt: string, settings: ProviderSettings, options: TranslateOptions): Promise<string> {
		const { json } = await requestJSON(messagesURL(settings), {
			headers: headers(settings),
			body: {
				model: settings.model || DEFAULT_MODEL,
				...advancedBody(settings, 4096),
				messages: [{ role: 'user', content: prompt }]
			},
			timeoutMs: settings.timeoutMs,
			signal: options.signal
		});
		return extractText(json);
	}
};
