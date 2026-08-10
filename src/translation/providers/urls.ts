/**
 * Pure endpoint-URL builders, shared by the provider adapters AND the settings
 * pane's "实际请求地址" preview. Keeping them here (with no Zotero / HTTP
 * imports) is what lets the preview show EXACTLY the URL a request will hit,
 * with no risk of the display drifting from the transport.
 *
 * Normalization rules (spec 0.9.3 §C):
 *   - never produce /v1/v1 (a base already ending in a version segment is left
 *     alone before /v1 is appended)
 *   - never produce /chat/completions/chat/completions
 *   - Anthropic native path is /v1/messages — a base ending in /v1 must not
 *     become /v1/v1/messages
 *   - DeepL native path is /v2/translate — same guard for /v2
 */

/** OpenAI-compatible base, normalized (adds /v1 when the base has no version). */
export function normalizeOpenAIBase(base: string, defaultBase: string, noV1Suffix = false): string {
	let b = (base || defaultBase).replace(/\/+$/, '');
	if (!noV1Suffix && !/\/v\d+[a-z]*$/.test(b) && !b.includes('/chat/completions')) {
		b += '/v1';
	}
	return b;
}

/** Full OpenAI-compatible chat-completions URL. */
export function openaiChatURL(base: string, defaultBase: string, noV1Suffix = false): string {
	const b = normalizeOpenAIBase(base, defaultBase, noV1Suffix);
	return b.includes('/chat/completions') ? b : `${b}/chat/completions`;
}

/** Full Anthropic native messages URL, guarding against a doubled /v1. */
export function anthropicMessagesURL(base: string, defaultBase: string): string {
	let b = (base || defaultBase).replace(/\/+$/, '');
	if (/\/v1\/messages$/.test(b)) {
		return b;
	}
	b = b.replace(/\/v1$/, '');
	return `${b}/v1/messages`;
}

/** Full DeepL native translate URL, guarding against a doubled /v2. */
export function deeplTranslateURL(base: string): string {
	let b = base.replace(/\/+$/, '');
	if (/\/v2\/translate$/.test(b)) {
		return b;
	}
	b = b.replace(/\/v2$/, '');
	return `${b}/v2/translate`;
}
