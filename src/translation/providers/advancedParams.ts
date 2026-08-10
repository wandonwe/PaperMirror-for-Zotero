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

export type ReasoningLevel = '' | 'minimal' | 'low' | 'medium' | 'high';

/** OpenAI-compatible providers whose chat endpoint accepts `reasoning_effort`. */
const REASONING_EFFORT_PROVIDERS = new Set(['openai', 'gemini', 'openrouter']);

export function normalizeReasoning(v: string | undefined): ReasoningLevel {
	return v === 'minimal' || v === 'low' || v === 'medium' || v === 'high' ? v : '';
}

/**
 * Extra body fields to merge into an OpenAI-compatible chat request for this
 * provider, given the user's advanced settings. Returns {} when nothing is set.
 */
export function openaiChatExtras(settings: ProviderSettings, providerId: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)) {
		out.temperature = settings.temperature;
	}
	if (typeof settings.maxOutputTokens === 'number' && settings.maxOutputTokens > 0) {
		// gpt-5.x rejects max_tokens on the official OpenAI endpoint.
		const key = providerId === 'openai' ? 'max_completion_tokens' : 'max_tokens';
		out[key] = Math.floor(settings.maxOutputTokens);
	}
	const eff = normalizeReasoning(settings.reasoning);
	if (eff && REASONING_EFFORT_PROVIDERS.has(providerId)) {
		// Google's OpenAI-compat uses "none" to disable thinking (no "minimal").
		out.reasoning_effort = providerId === 'gemini' && eff === 'minimal' ? 'none' : eff;
	}
	return out;
}

/** True when this provider's UI should offer reasoning/thinking control. */
export function supportsReasoningControl(providerId: string): boolean {
	return REASONING_EFFORT_PROVIDERS.has(providerId) || providerId === 'anthropic';
}
