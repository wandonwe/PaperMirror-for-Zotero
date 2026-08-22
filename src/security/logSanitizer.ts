/**
 * Log sanitizer: strips API keys, Authorization headers, and other secrets
 * from anything that is about to be logged. Pure module (unit-tested).
 */

const SECRET_PATTERNS: RegExp[] = [
	// Authorization headers — consume the WHOLE value after ANY scheme (2.1.0,
	// 审核 S6): the old form only ate a bare/Bearer value, so custom schemes
	// (DeepL-Auth-Key <key>, Api-Key <key>) kept the key body in the log.
	// Match an optional scheme word (letters+dashes, ≤32) then the credential.
	/(authorization\s*[:=]\s*)("?)([a-z][a-z0-9-]{0,31}\s+)?[a-z0-9._~+/-]{8,}={0,2}("?)/gi,
	/(x-api-key\s*[:=]\s*)("?)[a-z0-9._~+/-]{8,}("?)/gi,
	/(x-goog-api-key\s*[:=]\s*)("?)[a-z0-9._~+/-]{8,}("?)/gi,
	/("?api[_-]?key"?\s*[:=]\s*)("?)[a-z0-9._~+/-]{8,}("?)/gi,
	// URL / query-string credentials (2.1.0, 审核 S1): Gemini's documented
	// REST usage is ?key=AIza… — such keys live ONLY in the Base URL string and
	// never pass through registerSecret, so precise replacement can't help them.
	// Keep the param name, redact the value. Covers key / api_key / token /
	// access_token / secret in either ? & separator.
	/([?&](?:api[_-]?key|key|token|access_token|secret)=)[^&\s"'#]{6,}/gi,
	// Provider key SHAPES (redact even when they appear bare, e.g. echoed in a
	// gateway's error body or embedded in a URL):
	//   Anthropic
	/sk-ant-[a-zA-Z0-9_-]{10,}/g,
	//   OpenAI-style (sk- / sk-proj-)
	/sk-[a-zA-Z0-9_-]{16,}/g,
	//   Google (AIza…) (2.1.0, 审核 S1)
	/AIza[0-9A-Za-z_-]{30,}/g,
	//   Groq (gsk_…) (2.1.0, 审核 S1)
	/gsk_[A-Za-z0-9_-]{20,}/g,
	//   Zhipu GLM (32-hex "." suffix) (2.1.0, 审核 S1)
	/\b[0-9a-f]{32}\.[A-Za-z0-9]{8,}\b/g,
	// DeepL keys (uuid:fx style)
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:fx)?\b/gi,
	// Bearer tokens anywhere
	/(bearer\s+)[a-z0-9._~+/-]{8,}={0,2}/gi
];

const REDACTED = '[REDACTED]';

/** Known secrets registered at runtime (e.g. the configured API key). */
const knownSecrets = new Set<string>();

export function registerSecret(secret: string | undefined | null): void {
	// 下限 8 (2.1.0, 审核 S1 附带): 下限 4 会把 "test" 之类短串当密钥,
	// 使所有含该子串的日志被打成碎片(诊断自毁);真实密钥远长于 8。
	if (secret && secret.length >= 8) {
		knownSecrets.add(secret);
	}
}

export function clearSecrets(): void {
	knownSecrets.clear();
}

/**
 * 结构性兜底 (2.1.0, 审核 S1): 从一个 URL / 端点字符串里提取查询参数形式的
 * 凭据(?key=…、?token=… 等)并注册为已知密钥 —— 这样即使它后续以**不带
 * 参数名**的裸形态出现(如网关把 key 回显进错误体),也能被精确替换命中。
 * URL 内密钥不经 getApiKey,是唯一会绕过 registerSecret 的凭据来源。
 */
export function registerUrlCredentials(url: string | undefined | null): void {
	if (!url) {
		return;
	}
	const re = /[?&](?:api[_-]?key|key|token|access_token|secret)=([^&\s"'#]{8,})/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(url)) !== null) {
		try {
			registerSecret(decodeURIComponent(m[1]!));
		}
		catch {
			registerSecret(m[1]!); // 非法 % 序列: 注册原样
		}
	}
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
	// 按长度降序替换 (2.1.0, 审核 S5): 若先注册短密钥再注册长密钥(用户先粘
	// 错/截断再存完整),按插入序会先命中短的,把长密钥替换成
	// `[REDACTED]+残余后缀` —— 后半段裸露。先替换最长的杜绝这种部分泄露。
	for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
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
