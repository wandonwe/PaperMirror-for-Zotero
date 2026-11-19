/** Verified official-service retirements/aliases, checked 2026-11-19 (5.0).
 * Never apply a vendor's retirement to a proxy, local server or aggregator.
 * Sources: docs/LLM-PROVIDERS-2026-11-19.md. */
const OFFICIAL_HOSTS: Record<string, string[]> = {
	deepseek: ['api.deepseek.com'], moonshot: ['api.moonshot.ai', 'api.moonshot.cn'],
	gemini: ['generativelanguage.googleapis.com'], anthropic: ['api.anthropic.com'],
	openai: ['api.openai.com']
};

/** Already retired or alias-routed: rewrite immediately. */
const REPLACEMENTS: Record<string, Record<string, string>> = {
	deepseek: { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' },
	moonshot: { 'kimi-k2.5': 'kimi-k3', 'kimi-k2': 'kimi-k3', 'kimi-k2-0711-preview': 'kimi-k3', 'kimi-k2-0905-preview': 'kimi-k3', 'kimi-k2-thinking': 'kimi-k3', 'kimi-k2-thinking-turbo': 'kimi-k3', 'kimi-k2-turbo-preview': 'kimi-k3', 'kimi-latest': 'kimi-k3' },
	gemini: {
		'gemini-2.0-flash': 'gemini-3.6-flash', 'gemini-2.0-flash-001': 'gemini-3.6-flash', 'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite', 'gemini-2.0-flash-lite-001': 'gemini-3.5-flash-lite',
		'gemini-3-pro-preview': 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite',
		// Google auto-routes these to their successors (2026-10-28 changelog).
		'gemini-3.7-flash': 'gemini-3.8-flash', 'gemini-3.5-flash': 'gemini-3.6-flash'
	},
	anthropic: {
		'claude-opus-4-1-20250805': 'claude-opus-4-8', 'claude-opus-4-1': 'claude-opus-4-8', 'claude-opus-4-20250514': 'claude-opus-4-8', 'claude-opus-4-0': 'claude-opus-4-8',
		'claude-sonnet-4-20250514': 'claude-sonnet-5-5', 'claude-sonnet-4-0': 'claude-sonnet-5-5', 'claude-3-7-sonnet-20250219': 'claude-sonnet-5-5',
		'claude-3-5-haiku-20241022': 'claude-haiku-4-5', 'claude-3-haiku-20240307': 'claude-haiku-4-5'
	},
	openai: {
		'gpt-5.2-chat-latest': 'gpt-5.6-sol', 'gpt-5.3-chat-latest': 'gpt-5.6-sol', 'gpt-5-chat-latest': 'gpt-5.6-sol', 'gpt-5.1-chat-latest': 'gpt-5.6-sol',
		'gpt-4.1-nano': 'gpt-6-luna'
	}
};

/** Announced shutdowns: rewrite only once the vendor's shutdown date has arrived,
 * so a model that still works is never swapped out early. ISO dates (UTC). */
const SCHEDULED: Record<string, Record<string, { on: string; to: string }>> = {
	openai: {
		'gpt-5': { on: '2026-12-11', to: 'gpt-6.1-sol' },
		'gpt-5-mini': { on: '2026-12-11', to: 'gpt-6.1-terra' },
		'gpt-5-nano': { on: '2026-12-11', to: 'gpt-6-luna' },
		'gpt-4.1': { on: '2027-01-14', to: 'gpt-6-luna' },
		'gpt-4.1-mini': { on: '2027-01-14', to: 'gpt-6-luna' },
		'gpt-5.4-nano': { on: '2027-04-01', to: 'gpt-6-luna' },
		'gpt-5.1': { on: '2027-04-01', to: 'gpt-6-sol' }
	},
	anthropic: {
		'claude-sonnet-4-5': { on: '2026-11-30', to: 'claude-sonnet-5-5' },
		'claude-sonnet-4-5-20250929': { on: '2026-11-30', to: 'claude-sonnet-5-5' }
	},
	gemini: {
		'gemini-3.1-flash-lite': { on: '2027-05-07', to: 'gemini-3.5-flash-lite' }
	}
};

export function currentOfficialModel(provider: string, model: string, baseURL = '', apiPath = '', now: Date = new Date()): string {
	if (apiPath.trim() || !OFFICIAL_HOSTS[provider]) return model;
	if (baseURL.trim()) {
		// Match only origin plus official version suffix; do not rewrite gateway paths.
		const match = /^https:\/\/([^/:?#]+)(\/v1(?:beta)?\/?)?\/?$/i.exec(baseURL.trim());
		if (!match || !OFFICIAL_HOSTS[provider]!.includes(match[1]!.toLowerCase())) return model;
	}
	const id = model.trim();
	if (provider === 'moonshot' && /^moonshot-v1-(?:auto|8k|32k|128k)(?:-vision-preview)?$/.test(id)) return 'kimi-k3';
	const direct = REPLACEMENTS[provider]?.[id];
	if (direct) return direct;
	const scheduled = SCHEDULED[provider]?.[id];
	if (scheduled && now.toISOString().slice(0, 10) >= scheduled.on) return scheduled.to;
	return model;
}
