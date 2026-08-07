/**
 * Log sanitizer: strips API keys, Authorization headers, and other secrets
 * from anything that is about to be logged. Pure module (unit-tested).
 */

const SECRET_PATTERNS: RegExp[] = [
	// Authorization / api-key style headers, JSON fields, query params
	/(authorization\s*[:=]\s*)("?)(bearer\s+)?[a-z0-9._~+/-]{8,}={0,2}("?)/gi,
	/(x-api-key\s*[:=]\s*)("?)[a-z0-9._~+/-]{8,}("?)/gi,
	/("?api[_-]?key"?\s*[:=]\s*)("?)[a-z0-9._~+/-]{8,}("?)/gi,
	// Anthropic keys
	/sk-ant-[a-zA-Z0-9_-]{10,}/g,
	// OpenAI-style keys
	/sk-[a-zA-Z0-9_-]{16,}/g,
	// DeepL keys (uuid:fx style)
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:fx)?\b/gi,
	// Bearer tokens anywhere
	/(bearer\s+)[a-z0-9._~+/-]{8,}={0,2}/gi
];

const REDACTED = '[REDACTED]';

/** Known secrets registered at runtime (e.g. the configured API key). */
const knownSecrets = new Set<string>();

export function registerSecret(secret: string | undefined | null): void {
	if (secret && secret.length >= 4) {
		knownSecrets.add(secret);
	}
}

export function clearSecrets(): void {
	knownSecrets.clear();
}

export function sanitize(input: unknown): string {
	let text: string;
	if (typeof input === 'string') {
		text = input;
	}
	else if (input instanceof Error) {
		text = `${input.name}: ${input.message}`;
	}
	else {
		try {
			text = JSON.stringify(input);
		}
		catch {
			text = String(input);
		}
	}
	if (!text) {
		return text;
	}
	for (const secret of knownSecrets) {
		// split/join avoids regex-escaping issues
		text = text.split(secret).join(REDACTED);
	}
	for (const pattern of SECRET_PATTERNS) {
		text = text.replace(pattern, (match, ...groups) => {
			// Keep a recognizable prefix (header name) when captured
			const prefix = typeof groups[0] === 'string' && /[:=]/.test(groups[0]) ? groups[0] : '';
			return prefix + REDACTED;
		});
	}
	return text;
}

/**
 * Sanitize headers object for logging: drop every value, keep names.
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of Object.keys(headers)) {
		out[name] = REDACTED;
	}
	return out;
}
