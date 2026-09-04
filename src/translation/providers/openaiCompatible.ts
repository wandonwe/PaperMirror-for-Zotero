/**
 * OpenAI-compatible chat-completions provider. Used directly for
 * "OpenAI-compatible" endpoints and subclassed (parameterized) for OpenAI
 * itself and for custom endpoints.
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { parseUsage } from '../usageMeter';
import { parsePlainResponse, validateResponse } from '../responseValidator';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';
import { openaiChatURL, resolveChatURL } from './urls';
import {
	openaiChatExtras,
	isReasoningEffortRejection,
	markReasoningEffortUnsupported,
	reasoningEffortUnsupported,
	isTemperatureRejection,
	markTemperatureUnsupported,
	temperatureUnsupported
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
	 * (reasoning_effort / temperature / max tokens), with per-param
	 * self-healing: non-reasoning models on openai/openrouter (and many
	 * OpenAI-compatible servers) 400 on reasoning_effort (1.1.11), and
	 * reasoning models 400 on a non-default temperature (1.2.6 — "Unsupported
	 * value: 'temperature' does not support 0 with this model"). When the
	 * server names one of these params, strip that one param, retry, and
	 * remember the model rejects it so the next request omits it up front.
	 * At most one retry per param; every other error propagates unchanged. A
	 * profile that emits neither param makes this path fully inert.
	 */
	const postChat = async (
		baseBody: Record<string, unknown>,
		settings: ProviderSettings,
		options: TranslateOptions
	): Promise<unknown> => {
		const url = chatURL(settings, config.defaultBaseURL, config.noV1Suffix);
		const model = settings.model || config.defaultModel;
		// 记忆按 (provider, endpoint, model) 隔离 (1.3.0): 同名模型接不同后端时,
		// 端点 A 的「不支持」不再波及端点 B。url 即含 baseURL 与 API path。
		const drop = {
			reasoning: reasoningEffortUnsupported(config.id, url, model),
			temperature: temperatureUnsupported(config.id, url, model)
		};
		// 只有插件自动加的默认温度可以静默剥离 (审核 P2): 用户显式设置的温度被
		// 拒时,这是一个该浮出的配置错误,不是该吞的兼容性问题。
		const temperatureIsExplicit = typeof settings.temperature === 'number'
			&& Number.isFinite(settings.temperature);
		const bodyNow = (): Record<string, unknown> => {
			const extras = openaiChatExtras(settings, config.id);
			if (drop.reasoning) {
				delete extras.reasoning_effort;
			}
			if (drop.temperature) {
				delete extras.temperature;
			}
			return { ...baseBody, ...extras };
		};
		const post = (): Promise<{ json: unknown }> => requestJSON(url, {
			headers: headers(settings),
			body: bodyNow(),
			timeoutMs: settings.timeoutMs,
			signal: options.signal,
			allowInsecureHTTP: config.allowInsecureHTTP?.(settings) ?? false
		});
		for (;;) {
			try {
				return (await post()).json;
			}
			catch (e) {
				// Retry only if the named param was actually in THIS request
				// (i.e. we hadn't already learned to drop it).
				if (!drop.reasoning && isReasoningEffortRejection(e)) {
					drop.reasoning = true;
					markReasoningEffortUnsupported(config.id, url, model);
					continue;
				}
				if (!drop.temperature && isTemperatureRejection(e)) {
					if (temperatureIsExplicit) {
						// 显式设置的温度被模型拒绝: 这是该浮出的配置错误 (1.3.0),
						// 但必须可操作 —— 告诉用户清空哪个设置,而不是甩一段
						// 被误标成"模型名被拒"的原始 JSON (1.3.1)。
						throw new PaperMirrorError('UNKNOWN',
							`当前模型不接受你在高级设置中显式设置的温度 (temperature)。`
							+ `请在 PaperMirror 设置 → 高级 中清空温度(使用模型默认值)后重试。`
							+ ` 原始错误: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
							{ httpStatus: 400, retryable: false, cause: e });
					}
					drop.temperature = true;
					markTemperatureUnsupported(config.id, url, model);
					continue;
				}
				throw e;
			}
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
			// 用量计数 (2.7.0): 只读数字,响应正文不进任何日志。
			const usage = parseUsage(json);
			return usage ? { translations, usage } : { translations };
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
