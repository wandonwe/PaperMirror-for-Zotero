/**
 * Google Gemini provider on the NATIVE generateContent API — the same design
 * as Bob's Gemini plugin (github.com/Brain777777/bob-plugin-gemini): Base URL
 * defaults to https://generativelanguage.googleapis.com (easy to point at a
 * proxy), the model is a plain string, and the key travels in a header.
 *
 * Why native instead of the OpenAI-compat layer we used before:
 *   - 深度思考 maps to the FIRST-CLASS thinkingConfig (thinkingBudget 0 = off,
 *     -1 = dynamic) instead of second-hand reasoning_effort emulation;
 *   - responseMimeType "application/json" is the canonical strict-JSON switch;
 *   - temperature / maxOutputTokens live in generationConfig as documented.
 *
 * Endpoint: {base}/v1beta/models/{model}:generateContent
 * Auth:     x-goog-api-key header (never in the URL, never logged).
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { parsePlainResponse, validateResponse } from '../responseValidator';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export function geminiGenerateURL(settings: ProviderSettings, defaultModel = DEFAULT_MODEL): string {
	const base = (settings.apiBaseURL || DEFAULT_BASE).replace(/\/+$/, '');
	const path = (settings.apiPath ?? '').trim();
	if (path) {
		// User takes full control of the path (proxy/gateway setups).
		return base + (path.startsWith('/') ? path : `/${path}`);
	}
	const model = (settings.model || defaultModel).trim();
	return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function headers(settings: ProviderSettings): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'x-goog-api-key': settings.apiKey
	};
}

/**
 * generationConfig from the advanced settings. 深度思考: 禁用思考 → budget 0,
 * 自动思考 → budget -1 (dynamic), 默认设置 → omitted entirely. Temperature
 * defaults to 0 (translation-stable); maxOutputTokens only when user-set.
 */
export function geminiGenerationConfig(settings: ProviderSettings, opts?: { json?: boolean }): Record<string, unknown> {
	const config: Record<string, unknown> = {
		temperature: typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)
			? settings.temperature
			: 0
	};
	if (typeof settings.maxOutputTokens === 'number' && settings.maxOutputTokens > 0) {
		config.maxOutputTokens = Math.floor(settings.maxOutputTokens);
	}
	if (opts?.json) {
		config.responseMimeType = 'application/json';
	}
	const r = settings.reasoning;
	if (r === 'disabled' || r === 'minimal') {
		config.thinkingConfig = { thinkingBudget: 0 };
	}
	else if (r === 'auto') {
		config.thinkingConfig = { thinkingBudget: -1 };
	}
	return config;
}

function extractText(json: unknown): string {
	const candidates = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates;
	const parts = candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts)) {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Gemini response shape.');
	}
	return parts.map(p => p.text ?? '').join('');
}

export const geminiNativeProvider: TranslationProvider = {
	id: 'gemini',
	displayName: 'Google Gemini',
	defaultBaseURL: DEFAULT_BASE,
	displayBaseURL: DEFAULT_BASE,
	defaultModel: DEFAULT_MODEL,
	requiresApiKey: true,
	supportsCharBudget: true,

	endpointFor(settings: ProviderSettings): string {
		return geminiGenerateURL(settings);
	},

	async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
		if (!settings.apiKey) {
			return { ok: false, message: 'NO_API_KEY' };
		}
		try {
			const { status, json, elapsedMs } = await requestJSON(geminiGenerateURL(settings), {
				headers: headers(settings),
				body: {
					contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
					generationConfig: {
						// Thinking off + a small cap keeps the probe fast and cheap
						// (with thinking on, a tiny cap can be eaten by thoughts).
						maxOutputTokens: 64,
						thinkingConfig: { thinkingBudget: 0 }
					}
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
		const { json } = await requestJSON(geminiGenerateURL(settings), {
			headers: headers(settings),
			body: {
				system_instruction: { parts: [{ text: buildSystemPrompt(request, settings.customPrompt) }] },
				contents: [{ role: 'user', parts: [{ text: buildUserPayload(request) }] }],
				generationConfig: geminiGenerationConfig(settings, { json: !request.plain })
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
		const { json } = await requestJSON(geminiGenerateURL(settings), {
			headers: headers(settings),
			body: {
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				generationConfig: geminiGenerationConfig(settings)
			},
			timeoutMs: settings.timeoutMs,
			signal: options.signal
		});
		return extractText(json);
	}
};
