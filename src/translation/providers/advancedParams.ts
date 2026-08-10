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

/**
 * 'minimal'…'xhigh' are OpenAI-style effort levels; 'disabled'/'auto' are the
 * Gemini-style 深度思考 switch (禁用思考 / 自动思考) — Gemini's control is a
 * toggle, not an effort ladder, so it gets its own values and its own UI.
 */
export type ReasoningLevel = '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'disabled' | 'auto';

/** OpenAI-compatible providers whose chat endpoint accepts `reasoning_effort`.
 *  Values follow OpenAI's official levels (minimal/low/medium/high/xhigh —
 *  xhigh exists on gpt-5.4+; unsupported levels are the model's own 400). */
const REASONING_EFFORT_PROVIDERS = new Set(['openai', 'gemini', 'openrouter']);

/** Providers where a DEFAULT temperature 0 is safe (translation-stable).
 *  Excluded: 'openai' (gpt-5.x reasoning models accept only the default
 *  temperature) and 'openrouter' (auto-routing may land on such a model).
 *  An EXPLICIT user-set temperature is always sent regardless. */
const DEFAULT_TEMP_PROVIDERS = new Set([
	'deepseek', 'moonshot', 'qwen', 'zhipu', 'siliconflow', 'groq',
	'gemini', 'ollama', 'openai-compatible', 'custom'
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
	if (eff && REASONING_EFFORT_PROVIDERS.has(providerId)) {
		if (providerId === 'gemini') {
			// Gemini 深度思考 (Bob-style): 禁用思考 → reasoning_effort "none";
			// 自动思考 → dynamic thinking budget (-1) via Google's extra_body;
			// legacy effort levels still map (minimal→none, xhigh→high).
			if (eff === 'disabled' || eff === 'minimal') {
				out.reasoning_effort = 'none';
			}
			else if (eff === 'auto') {
				out.extra_body = { google: { thinking_config: { thinking_budget: -1 } } };
			}
			else {
				out.reasoning_effort = eff === 'xhigh' ? 'high' : eff;
			}
		}
		else if (eff !== 'disabled' && eff !== 'auto') {
			// OpenAI/OpenRouter take the official effort ladder only.
			out.reasoning_effort = eff;
		}
	}
	return out;
}

/** True when this provider's UI should offer reasoning/thinking control. */
export function supportsReasoningControl(providerId: string): boolean {
	return REASONING_EFFORT_PROVIDERS.has(providerId) || providerId === 'anthropic';
}
