/**
 * Per-provider advanced request parameters (Bob-style), all opt-in.
 *
 * Every field is only emitted when the user has explicitly set it, so a profile
 * that touches none of them produces a request body identical to before — zero
 * regression. Each vendor names these differently, so the mapping lives here in
 * one pure, unit-tested place.
 *
 * Reasoning/thinking: for TRANSLATION you usually want it MINIMAL/OFF (faster,
 * cheaper, avoids reasoning eating the output). Support differs by vendor, so
 * `reasoning_effort` is only emitted for providers known to accept it; on others
 * the setting is ignored rather than risking a 400.
 */

import type { ProviderSettings } from '../../types/models';
import { PaperMirrorError } from '../../types/models';

/**
 * 'minimal'…'xhigh' are OpenAI-style effort levels; 'disabled'/'auto' are the
 * Gemini-style 深度思考 switch (禁用思考 / 自动思考) — Gemini's control is a
 * toggle, not an effort ladder, so it gets its own values and its own UI.
 */
export type ReasoningLevel = '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'disabled' | 'auto';

/** OpenAI-compatible providers whose chat endpoint accepts `reasoning_effort`.
 *  Values follow OpenAI's official levels (minimal/low/medium/high/xhigh —
 *  xhigh exists on gpt-5.4+; unsupported levels are the model's own 400).
 *  Gemini is NOT here anymore: it runs on the native generateContent API and
 *  handles 深度思考 via thinkingConfig in its own adapter (geminiNative). */
const REASONING_EFFORT_PROVIDERS = new Set(['openai', 'openrouter']);

/** Providers where a DEFAULT temperature 0 is safe (translation-stable).
 *  Excluded: 'openai' (gpt-5.x reasoning models accept only the default
 *  temperature) and 'openrouter' (auto-routing may land on such a model).
 *  An EXPLICIT user-set temperature is always sent regardless. */
const DEFAULT_TEMP_PROVIDERS = new Set([
	'deepseek', 'moonshot', 'qwen', 'zhipu', 'siliconflow', 'groq',
	'ollama', 'openai-compatible', 'custom'
]);

export function normalizeReasoning(v: string | undefined): ReasoningLevel {
	return v === 'minimal' || v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh'
		|| v === 'disabled' || v === 'auto' ? v : '';
}

/**
 * Extra body fields to merge into an OpenAI-compatible chat request for this
 * provider, given the user's advanced settings.
 */
export function openaiChatExtras(settings: ProviderSettings, providerId: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)) {
		out.temperature = settings.temperature;
	}
	else if (DEFAULT_TEMP_PROVIDERS.has(providerId)) {
		// 温度默认 0: deterministic output suits translation best.
		out.temperature = 0;
	}
	if (typeof settings.maxOutputTokens === 'number' && settings.maxOutputTokens > 0) {
		// gpt-5.x rejects max_tokens on the official OpenAI endpoint.
		const key = providerId === 'openai' ? 'max_completion_tokens' : 'max_tokens';
		out[key] = Math.floor(settings.maxOutputTokens);
	}
	const eff = normalizeReasoning(settings.reasoning);
	if (eff && eff !== 'disabled' && eff !== 'auto' && REASONING_EFFORT_PROVIDERS.has(providerId)) {
		// OpenAI/OpenRouter take the official effort ladder only; the Gemini
		// 深度思考 vocabulary (disabled/auto) never leaves the native adapter.
		out.reasoning_effort = eff;
	}
	return out;
}

/** True when this provider's UI should offer reasoning/thinking control.
 *  (Gemini qualifies via its native thinkingConfig, not reasoning_effort.) */
export function supportsReasoningControl(providerId: string): boolean {
	return REASONING_EFFORT_PROVIDERS.has(providerId) || providerId === 'anthropic' || providerId === 'gemini';
}

/**
 * 非推理模型拒收 reasoning_effort 的自愈 (1.1.11):
 *
 * REASONING_EFFORT_PROVIDERS 是按「供应商」放行的,但同一供应商下有推理模型
 * (o 系列 / gpt-5.x) 也有非推理模型 (gpt-4o / gpt-4.1),以及大量只是「OpenAI
 * 兼容」的自建端点 —— 后两类会对 reasoning_effort 直接回
 * HTTP 400「Unrecognized request argument supplied: reasoning_effort」。用户在
 * 「深度解析」上撞见的正是它(翻译走同一条 openaiChatExtras,同样会中招)。
 *
 * 判据在 mapHTTPError 之后仍然可用: 400 且未命中 model 分支时落到 UNKNOWN,
 * 错误 message 里带着响应体前 200 字符,reasoning_effort 就在其中。识别出来后
 * 调用方剥掉该参数重试一次,并把「这个模型不支持」记下来,后续请求直接不发,
 * 避免每次都先 400 再重试。仅按模型标记,不影响同供应商下真正的推理模型。
 */
export function isReasoningEffortRejection(e: unknown): boolean {
	return e instanceof PaperMirrorError
		&& e.httpStatus === 400
		&& /reasoning_effort/i.test(e.message ?? '');
}

const reasoningEffortUnsupportedModels = new Set<string>();
const modelKey = (providerId: string, model: string): string => JSON.stringify([providerId, model]);

/** Has this (provider, model) already 400'd on reasoning_effort this session? */
export function reasoningEffortUnsupported(providerId: string, model: string): boolean {
	return reasoningEffortUnsupportedModels.has(modelKey(providerId, model));
}

/** Remember that this (provider, model) rejects reasoning_effort, so future
 *  requests omit it up front instead of eating a 400 + retry every time. */
export function markReasoningEffortUnsupported(providerId: string, model: string): void {
	reasoningEffortUnsupportedModels.add(modelKey(providerId, model));
}

/**
 * temperature 的同款自愈 (1.2.6, 与 1.1.11 的 reasoning_effort 完全同构):
 *
 * DEFAULT_TEMP_PROVIDERS 会默认发 temperature: 0(翻译求确定性),显式设置的
 * 温度也走同一字段。但推理模型(gpt-5.x / o 系列,以及各家「OpenAI 兼容」
 * 端点背后路由到的推理模型)只接受默认温度,直接回 HTTP 400「Unsupported
 * value: 'temperature' does not support 0 with this model. Only the default
 * (1) value is supported.」——用户在「深度解析」上撞见的正是它(翻译走同一条
 * openaiChatExtras,同样会中招)。识别后剥掉 temperature 重试一次,并按
 * (provider, model) 记住,后续请求直接不发,避免每次先 400 再重试。
 */
export function isTemperatureRejection(e: unknown): boolean {
	return e instanceof PaperMirrorError
		&& e.httpStatus === 400
		&& /temperature/i.test(e.message ?? '');
}

const temperatureUnsupportedModels = new Set<string>();

/** Has this (provider, model) already 400'd on temperature this session? */
export function temperatureUnsupported(providerId: string, model: string): boolean {
	return temperatureUnsupportedModels.has(modelKey(providerId, model));
}

/** Remember that this (provider, model) rejects a non-default temperature. */
export function markTemperatureUnsupported(providerId: string, model: string): void {
	temperatureUnsupportedModels.add(modelKey(providerId, model));
}
