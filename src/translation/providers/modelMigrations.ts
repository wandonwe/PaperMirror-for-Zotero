/** Verified official-service retirements/aliases, checked 2026-09-16.
 * Never apply a vendor's retirement to a proxy, local server or aggregator. */
const OFFICIAL_HOSTS: Record<string, string[]> = {
	deepseek: ['api.deepseek.com'], moonshot: ['api.moonshot.ai', 'api.moonshot.cn'],
	gemini: ['generativelanguage.googleapis.com'], anthropic: ['api.anthropic.com'],
	openai: ['api.openai.com']
};
const REPLACEMENTS: Record<string, Record<string, string>> = {
	deepseek: { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' },
	moonshot: { 'kimi-k2.5': 'kimi-k3', 'kimi-k2': 'kimi-k3', 'kimi-k2-0711-preview': 'kimi-k3', 'kimi-k2-0905-preview': 'kimi-k3', 'kimi-k2-thinking': 'kimi-k3', 'kimi-k2-thinking-turbo': 'kimi-k3' },
	gemini: { 'gemini-2.0-flash': 'gemini-3.6-flash', 'gemini-2.0-flash-001': 'gemini-3.6-flash', 'gemini-2.0-flash-lite': 'gemini-3.1-flash-lite', 'gemini-2.0-flash-lite-001': 'gemini-3.1-flash-lite', 'gemini-3-pro-preview': 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite' },
	anthropic: { 'claude-opus-4-1-20250805': 'claude-opus-4-8', 'claude-opus-4-20250514': 'claude-opus-4-8', 'claude-sonnet-4-20250514': 'claude-sonnet-4-6', 'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6', 'claude-3-5-haiku-20241022': 'claude-haiku-4-5', 'claude-3-haiku-20240307': 'claude-haiku-4-5' },
	openai: { 'gpt-5.2-chat-latest': 'gpt-5.6-sol', 'gpt-5.3-chat-latest': 'gpt-5.6-sol', 'gpt-5-chat-latest': 'gpt-5.6-sol', 'gpt-5.1-chat-latest': 'gpt-5.6-sol' }
};
export function currentOfficialModel(provider: string, model: string, baseURL = '', apiPath = ''): string {
	if (apiPath.trim() || !OFFICIAL_HOSTS[provider]) return model;
	if (baseURL.trim()) {
		// Match only origin plus official version suffix; do not rewrite gateway paths.
		const match = /^https:\/\/([^/:?#]+)(\/v1(?:beta)?\/?)?\/?$/i.exec(baseURL.trim());
		if (!match || !OFFICIAL_HOSTS[provider]!.includes(match[1]!.toLowerCase())) return model;
	}
	const id = model.trim();
	if (provider === 'moonshot' && /^moonshot-v1-(?:auto|8k|32k|128k)(?:-vision-preview)?$/.test(id)) return 'kimi-k3';
	return REPLACEMENTS[provider]?.[id] ?? model;
}
