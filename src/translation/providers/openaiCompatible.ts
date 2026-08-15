/**
 * OpenAI-compatible chat-completions provider. Used directly for
 * "OpenAI-compatible" endpoints and subclassed (parameterized) for OpenAI
 * itself and for custom endpoints.
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { parsePlainResponse, validateResponse } from '../responseValidator';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';
import { openaiChatURL, resolveChatURL } from './urls';
import {
	openaiChatExtras,
	isReasoningEffortRejection,
	markReasoningEffortUnsupported,
	reasoningEffortUnsupported
} from './advancedParams';

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
	return resolveChatURL(settings.apiBaseURL, defaultBase, noV1Suffix, settings.apiPath);
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

	/**
	 * POST a chat request built from `baseBody` + the opt-in advanced extras
	 * (reasoning_effort / temperature / max tokens), with reasoning_effort
	 * self-healing (1.1.11): non-reasoning models on openai/openrouter (and many
	 * OpenAI-compatible servers) 400 on reasoning_effort. When they do, strip
	 * that one param and retry once, and remember the model rejects it so the
	 * next request omits it up front. Every other error propagates unchanged;
	 * a profile that never set reasoning produces no reasoning_effort at all, so
	 * this path is inert for it.
	 */
	const postChat = async (
		baseBody: Record<string, unknown>,
		settings: ProviderSettings,
		options: TranslateOptions
	): Promise<unknown> => {
		const url = chatURL(settings, config.defaultBaseURL, config.noV1Suffix);
		const model = settings.model || config.defaultModel;
		const bodyWith = (dropReasoning: boolean): Record<string, unknown> => {
			const extras = openaiChatExtras(settings, config.id);
			if (dropReasoning) {
				delete extras.reasoning_effort;
			}
			return { ...baseBody, ...extras };
		};
		const known = reasoningEffortUnsupported(config.id, model);
		const post = (dropReasoning: boolean): Promise<{ json: unknown }> => requestJSON(url, {
			headers: headers(settings),
			body: bodyWith(dropReasoning),
			timeoutMs: settings.timeoutMs,
			signal: options.signal,
			allowInsecureHTTP: config.allowInsecureHTTP?.(settings) ?? false
		});
		try {
			return (await post(known)).json;
		}
		catch (e) {
			// Retry-once only if reasoning_effort was actually in this request
			// (i.e. we hadn't already learned to drop it) and the server named it.
			if (!known && isReasoningEffortRejection(e)) {
				markReasoningEffortUnsupported(config.id, model);
				return (await post(true)).json;
			}
			throw e;
		}
	};

	return {
		id: config.id,
		displayName: config.displayName,
		defaultBaseURL: config.defaultBaseURL,
		displayBaseURL,
		defaultModel: config.defaultModel,
		requiresApiKey: config.requiresApiKey ?? (config.id !== 'custom'),
		supportsCharBudget: true,

		endpointFor(settings: ProviderSettings): string {
			return chatURL(settings, config.defaultBaseURL, config.noV1Suffix);
		},

		async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
			try {
				const { status, json, elapsedMs } = await requestJSON(chatURL(settings, config.defaultBaseURL, config.noV1Suffix), {
					headers: headers(settings),
					body: {
						model: settings.model || config.defaultModel,
						// OpenAI's reasoning models (gpt-5.x) REJECT the legacy
						// `max_tokens` on chat/completions — they require
						// `max_completion_tokens`. Use the new key for the official
						// OpenAI endpoint (works for gpt-4o and gpt-5.x alike) and
						// keep `max_tokens` for other OpenAI-compatible servers that
						// don't recognise the new one. Without this, a valid gpt-5.x
						// model tests as "模型不存在" (a 400 that mentions "model").
						...(config.id === 'openai' ? { max_completion_tokens: 32 } : { max_tokens: 32 }),
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
			const json = await postChat({
				model: settings.model || config.defaultModel,
				messages: [
					{ role: 'system', content: buildSystemPrompt(request, settings.customPrompt) },
					{ role: 'user', content: buildUserPayload(request) }
				],
				// Ask compliant servers for strict JSON; harmless elsewhere.
				// Plain-mode (兜底重译) answers are bare text — no JSON coercion.
				...(request.plain ? {} : { response_format: { type: 'json_object' } })
			}, settings, options);
			const text = extractText(json);
			const { translations } = request.plain
				? parsePlainResponse(text, request.blocks[0]!.id)
				: validateResponse(text, request.blocks.map(b => b.id));
			return { translations };
		},

		async complete(prompt: string, settings: ProviderSettings, options: TranslateOptions): Promise<string> {
			const json = await postChat({
				model: settings.model || config.defaultModel,
				messages: [{ role: 'user', content: prompt }]
			}, settings, options);
			return extractText(json);
		}
	};
}
