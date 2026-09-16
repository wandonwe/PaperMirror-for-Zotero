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

import type { ProviderSettings, RejectedParam, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { parseUsage } from '../usageMeter';
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

/** Gemini 3 uses thinkingLevel; Gemini 2.5 uses thinkingBudget.
 * Models without an off mode use their documented minimum. */
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
    const model=(settings.model || DEFAULT_MODEL).replace(/^models\//,'');
    if (/^gemini-3/.test(model)) {
        if(r && r !== 'auto') {
            const minimum=/^gemini-3\.[78]-flash/.test(model) || /pro/.test(model) ? 'low' : 'minimal';
            config.thinkingConfig={thinkingLevel:r === 'disabled' || r === 'minimal' ? minimum : r === 'xhigh' ? 'high' : r};
        }
    } else if (r === 'disabled' || r === 'minimal') {
        config.thinkingConfig = { thinkingBudget: /^gemini-2\.5-pro/.test(model) ? 128 : 0 };
    } else if (r === 'auto') {
        config.thinkingConfig = { thinkingBudget: -1 };
    }
	return config;
}

function extractText(json: unknown): string {
	const candidates = (json as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] })?.candidates;
	const parts = candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts)) {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Gemini response shape.');
	}
	return parts.filter(p => !p.thought).map(p => p.text ?? '').join('');
}

/**
 * 「禁用思考」自愈 (2.0.9, 审核 P2-13),与 openaiCompatible 的温度自愈同构。
 * gemini-2.5-pro 不允许 thinkingBudget:0 —— 用户选了「禁用思考」时每个请求
 * 都 400 INVALID_ARGUMENT,此前没有任何自愈,通道永久失败;validate 探针
 * 更是无条件带 budget 0,该模型「测试连接」恒失败。现在: 收到 400 且响应
 * 提及 thinking/budget 时剥掉 thinkingConfig 重试一次,并按 endpoint|model
 * 记住这次拒绝,后续请求直接不带。
 */
const thinkingRejected = new Set<string>();

function thinkingHealKey(settings: ProviderSettings): string {
	return `${geminiGenerateURL(settings)}|${(settings.model || DEFAULT_MODEL).trim()}`;
}

export function isThinkingRejection(e: unknown): boolean {
	return e instanceof PaperMirrorError
		&& e.httpStatus === 400
		&& (e.rejectedParam === 'thinking' || /think|budget/i.test(e.message));
}

/** 测试可重置的自愈记忆。 */
export function resetThinkingHeal(): void {
	thinkingRejected.clear();
}

/**
 * 发送一次 generateContent,带思考自愈: 若该 endpoint|model 已知拒绝思考
 * 参数则先剥再发;首次撞 400 思考拒绝时剥掉 thinkingConfig 重试一次并记住。
 */
async function requestWithThinkingHeal(
	settings: ProviderSettings,
	makeBody: (config: Record<string, unknown>) => unknown,
	config: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
	onAttempt?: () => void,
	onParamHeal?: (param: RejectedParam) => void
): Promise<{ status: number; json: unknown; elapsedMs: number }> {
	const key = thinkingHealKey(settings);
	const strip = (c: Record<string, unknown>): Record<string, unknown> => {
		const { thinkingConfig: _drop, ...rest } = c;
		return rest;
	};
	const effective = thinkingRejected.has(key) && 'thinkingConfig' in config ? strip(config) : config;
	try {
		return await requestJSON(geminiGenerateURL(settings), {
			headers: headers(settings),
			body: makeBody(effective),
			timeoutMs,
			signal,
			onAttempt
		}) as { status: number; json: unknown; elapsedMs: number };
	}
	catch (e) {
		if (!('thinkingConfig' in effective) || !isThinkingRejection(e)) {
			throw e;
		}
		thinkingRejected.add(key);
		onParamHeal?.('thinking');
		return requestJSON(geminiGenerateURL(settings), {
			headers: headers(settings),
			body: makeBody(strip(effective)),
			timeoutMs,
			signal,
			onAttempt
		}) as Promise<{ status: number; json: unknown; elapsedMs: number }>;
	}
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
			// P2-13: 探针经思考自愈 —— gemini-2.5-pro 拒绝 budget 0 时剥掉重试,
			// 「测试连接」不再对该模型恒失败。剥掉后放宽输出上限(思考会吃 token)。
			const { status, json, elapsedMs } = await requestWithThinkingHeal(
				settings,
				config => ({
					contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
					generationConfig: config
				}),
                geminiGenerationConfig({...settings,reasoning:'disabled',maxOutputTokens:256}),
				Math.min(settings.timeoutMs, 30000)
			);
			const text = extractText(json);
			return { ok: true, httpStatus: status, modelAvailable: text.length > 0, elapsedMs };
		}
		catch (e) {
			const err = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			return { ok: false, message: err.code, httpStatus: err.httpStatus };
		}
	},

	async translate(request: TranslationRequest, settings: ProviderSettings, options: TranslateOptions): Promise<TranslationResponse> {
		// P2-13: 经思考自愈 —— 「禁用思考」撞上不许关思考的模型时剥参重试。
		const { json } = await requestWithThinkingHeal(
			settings,
			config => ({
				system_instruction: { parts: [{ text: buildSystemPrompt(request, settings.customPrompt) }] },
				contents: [{ role: 'user', parts: [{ text: buildUserPayload(request) }] }],
				generationConfig: config
			}),
			geminiGenerationConfig(settings, { json: !request.plain }),
			settings.timeoutMs,
			options.signal,
			options.onAttempt,
			options.onParamHeal
		);
		// 用量先于校验 (2.7.7): 校验失败的响应同样花了 token。只读数字。
		const usage = parseUsage(json);
		if (usage) {
			options.onUsage?.(usage);
		}
		const text = extractText(json);
		const { translations } = request.plain
			? parsePlainResponse(text, request.blocks[0]!.id)
			: validateResponse(text, request.blocks.map(b => b.id));
		return usage ? { translations, usage } : { translations };
	},

	async complete(prompt: string, settings: ProviderSettings, options: TranslateOptions): Promise<string> {
		const { json } = await requestWithThinkingHeal(
			settings,
			config => ({
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				generationConfig: config
			}),
			geminiGenerationConfig(settings),
			settings.timeoutMs,
			options.signal
		);
		return extractText(json);
	}
};
