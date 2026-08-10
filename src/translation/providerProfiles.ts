/**
 * Per-provider configuration profiles (spec 0.9.3 §A).
 *
 * ROOT CAUSE this fixes: Base URL and model used to be single GLOBAL prefs,
 * shared by every provider. So a model typed for OpenAI (gpt-4o) stayed in the
 * field when the user switched to Gemini and got sent to Gemini → 404
 * INVALID_MODEL. Each provider now keeps its OWN Base URL / model in its own
 * profile; the primary provider and every parallel provider read from their own
 * profile, so nothing bleeds across providers.
 *
 * Pure module (no Zotero / DOM): the parse/serialize/migrate logic is shared by
 * the engine (readerSession, startup) and the settings pane, and unit-tested in
 * isolation.
 *
 * Stored as a JSON string in the `providerProfiles` pref:
 *   { "openai": { "apiBaseUrl": "", "model": "gpt-5-mini" },
 *     "gemini": { "apiBaseUrl": "", "model": "gemini-2.5-flash" } }
 */

export interface ProviderProfile {
	/** User Base URL override; empty/undefined = use the provider default. */
	apiBaseUrl?: string;
	/** Effective selected model; empty/undefined = use the provider default. */
	model?: string;
	/** Last custom model the user typed for this provider (restored on switch). */
	customModel?: string;
	// ---- advanced params (all opt-in; unset = request body unchanged) --------
	/** Custom request path (e.g. /v1/chat/completions). */
	apiPath?: string;
	/** Reasoning/thinking effort: '' | minimal | low | medium | high. */
	reasoning?: string;
	/** Max output tokens (0/undefined = provider default). */
	maxOutputTokens?: number;
	/** Sampling temperature (undefined = provider default). */
	temperature?: number;
}

export type ProviderProfiles = Record<string, ProviderProfile>;

export function parseProviderProfiles(raw: string | undefined | null): ProviderProfiles {
	if (!raw) {
		return {};
	}
	try {
		const obj = JSON.parse(raw);
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
			return {};
		}
		const out: ProviderProfiles = {};
		for (const [id, value] of Object.entries(obj as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') {
				continue;
			}
			const v = value as Record<string, unknown>;
			const profile: ProviderProfile = {};
			if (typeof v.apiBaseUrl === 'string') {
				profile.apiBaseUrl = v.apiBaseUrl;
			}
			if (typeof v.model === 'string') {
				profile.model = v.model;
			}
			if (typeof v.customModel === 'string') {
				profile.customModel = v.customModel;
			}
			if (typeof v.apiPath === 'string') {
				profile.apiPath = v.apiPath;
			}
			if (v.reasoning === 'minimal' || v.reasoning === 'low' || v.reasoning === 'medium' || v.reasoning === 'high') {
				profile.reasoning = v.reasoning;
			}
			if (typeof v.maxOutputTokens === 'number' && Number.isFinite(v.maxOutputTokens) && v.maxOutputTokens > 0) {
				profile.maxOutputTokens = Math.floor(v.maxOutputTokens);
			}
			if (typeof v.temperature === 'number' && Number.isFinite(v.temperature)) {
				profile.temperature = v.temperature;
			}
			out[id] = profile;
		}
		return out;
	}
	catch {
		return {};
	}
}

export function serializeProviderProfiles(profiles: ProviderProfiles): string {
	return JSON.stringify(profiles ?? {});
}

export function profileFor(profiles: ProviderProfiles, providerId: string): ProviderProfile {
	return profiles[providerId] ?? {};
}

/** The engine-facing config for one provider: trimmed base URL + model. */
export function effectiveProviderConfig(profiles: ProviderProfiles, providerId: string): { apiBaseURL: string; model: string } {
	const profile = profileFor(profiles, providerId);
	return {
		apiBaseURL: (profile.apiBaseUrl ?? '').trim(),
		model: (profile.model ?? '').trim()
	};
}

export interface LegacyGlobals {
	/** The currently-selected provider — the ONLY one legacy values migrate to. */
	provider: string;
	apiBaseURL: string;
	model: string;
}

/**
 * One-time migration of the old GLOBAL apiBaseURL / model prefs into the
 * CURRENTLY-SELECTED provider's profile only. Never touches any other provider
 * (that is exactly the bleed we are removing). Only fills fields the target
 * profile has not already set, so a profile written by the new pane always
 * wins. Returns whether anything changed.
 */
export function migrateLegacyGlobals(profiles: ProviderProfiles, legacy: LegacyGlobals): { profiles: ProviderProfiles; changed: boolean } {
	const base = (legacy.apiBaseURL ?? '').trim();
	const model = (legacy.model ?? '').trim();
	if (!base && !model) {
		return { profiles, changed: false };
	}
	const id = legacy.provider || 'bing-free';
	const next: ProviderProfiles = { ...profiles };
	const target: ProviderProfile = { ...(next[id] ?? {}) };
	let changed = false;
	if (base && target.apiBaseUrl === undefined) {
		target.apiBaseUrl = base;
		changed = true;
	}
	if (model && target.model === undefined) {
		target.model = model;
		changed = true;
	}
	if (changed) {
		next[id] = target;
	}
	return { profiles: next, changed };
}
