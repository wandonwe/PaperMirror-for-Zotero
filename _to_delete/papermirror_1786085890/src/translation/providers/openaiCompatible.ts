/**
 * OpenAI-compatible chat-completions provider. Used directly for
 * "OpenAI-compatible" endpoints and subclassed (parameterized) for OpenAI
 * itself and for custom endpoints.
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { validateResponse } from '../responseValidator';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';

export interface OpenAICompatibleConfig {
	id: string;
	displayName: string;
	defaultBaseURL: string;
	defaultModel: string;
	/** Whether an API key is required (default true; e.g. false for Ollama). */
	requiresApiKey?: boolean;
	/** Base URL is already complete — don't append a /v1 segment (e.g. Gemini's
	 *  OpenAI-compat endpoint ".../v1beta/openai"). */
	noV1Suffix?: boolean;
	/** Allow plain-HTTP when user has opted in (custom endpoints / Ollama). */
	allowInsecureHTTP?: (settings: ProviderSettings) => boolean;
}

export function chatURL(settings: ProviderSettings, defaultBase: string, noV1Suffix = false): string {
	let base = (settings.apiBaseURL || defaultBase).replace(/\/+$/, '');
	// Accept bases with or without a version segment
	if (!noV1Suffix && !/\/v\d+[a-z]*$/.test(base) && !base.includes('/chat/completions')) {
		base += '/v1';
	}
	if (base.includes('/chat/completions')) {
		return base;
	}
	return `${base}/chat/completions`;
}

function extractText(json: unknown): string {
	const choices = (json as { choices?: { message?: { content?: string } }[] })?.choices;
	const content = choices?.[0]?.message?.content;
	if (typeof content !== 'string') {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected chat-completions response shape.');
	}
	return content;
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): TranslationProvider {
	const headers = (settings: ProviderSettings): Record<string, string> => {
		const h: Record<string, string> = { 'Content-Type': 'application/json' };
		if (settings.apiKey) {
			h.Authorization = `Bearer ${settings.apiKey}`;
		}
		return h;
	};

	// e.g. "https://api.openai.com" -> "https://api.openai.com/v1"
	const displayBaseURL = config.defaultBaseURL
		? chatURL({ apiBaseURL: '' } as ProviderSettings, config.defaultBaseURL, config.noV1Suffix)
			.replace(/\/chat\/completions$/, '')
		: '';

	return {
		id: config.id,
		displayName: config.displayName,
		defaultBaseURL: config.defaultBaseURL,
		displayBaseURL,
		defaultModel: config.defaultModel,
		requiresApiKey: config.requiresApiKey ?? (config.id !== 'custom'),

		async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
			try {
				const { status, json, elapsedMs } = await requestJSON(chatURL(settings, config.defaultBaseURL, config.noV1Suffix), {
					headers: headers(settings),
					body: {
						model: settings.model || config.defaultModel,
						max_tokens: 32,
						messages: [
							{ role: 'user', content: 'Reply with the single word: ok' }
						]
					},
					timeoutMs: Math.min(settings.timeoutMs, 30000),
					allowInsecureHTTP: config.allowInsecureHTTP?.(settings) ?? false
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
			const { json } = await requestJSON(chatURL(settings, config.defaultBaseURL, config.noV1Suffix), {
				headers: headers(settings),
				body: {
					model: settings.model || config.defaultModel,
					messages: [
						{ role: 'system', content: buildSystemPrompt(request, settings.customPrompt) },
						{ role: 'user', content: buildUserPayload(request) }
					],
					// Ask compliant servers for strict JSON; harmless elsewhere
					response_format: { type: 'json_object' }
				},
				timeoutMs: settings.timeoutMs,
				signal: options.signal,
				allowInsecureHTTP: config.allowInsecureHTTP?.(settings) ?? false
			});
			const text = extractText(json);
			const { translations } = validateResponse(text, request.blocks.map(b => b.id));
			return { translations };
		},

		async complete(prompt: string, settings: ProviderSettings, options: TranslateOptions): Promise<string> {
			const { json } = await requestJSON(chatURL(settings, config.defaultBaseURL, config.noV1Suffix), {
				headers: headers(settings),
				body: {
					model: settings.model || config.defaultModel,
					messages: [{ role: 'user', content: prompt }]
				},
				timeoutMs: settings.timeoutMs,
				signal: options.signal,
				allowInsecureHTTP: config.allowInsecureHTTP?.(settings) ?? false
			});
			return extractText(json);
		}
	};
}
