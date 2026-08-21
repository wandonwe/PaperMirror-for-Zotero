/**
 * Maps HTTP/network failures to user-comprehensible PaperMirrorError codes.
 * Pure module (unit-tested).
 */

import { PaperMirrorError } from '../types/models';
import { sanitize } from '../security/logSanitizer';

export function mapHTTPError(status: number, bodySnippet?: string): PaperMirrorError {
	// 响应体片段先脱敏再截断 (审核 P1-5): 这段片段会原样拼进 error.message,
	// 而 UI 的错误行是直接 textContent 显示 message 的 —— 只有 logger 过
	// sanitize,UI 路径不过。自建中转网关(one-api 之类)在令牌过期时常返回
	// HTTP 400 且响应体回显密钥,那样密钥就会显示在面板上、进到用户截图里。
	// 先脱敏再切片:密钥被 200 字截断成两半时同样能被模式命中。
	const snippet = sanitize(bodySnippet ?? '').slice(0, 200);
	// status 0/负数不是 HTTP 状态码,而是「传输层没完成」(见 httpClient 的
	// status 0 分支)。主路径已在 httpClient 里还原语义,这里是二道防线:
	// 任何其他调用方拿到 0 时也不该得到「不可重试的 UNKNOWN」。
	if (!(status > 0)) {
		return new PaperMirrorError('NETWORK',
			'Network error: the request did not complete (no response from the server).',
			{ httpStatus: status, retryable: true });
	}
	if (status === 401 || status === 403) {
		return new PaperMirrorError('INVALID_API_KEY', `Authentication failed (HTTP ${status}). Check your API key.`, { httpStatus: status, retryable: false });
	}
	if (status === 404) {
		return new PaperMirrorError('INVALID_MODEL', `Endpoint or model not found (HTTP 404). Check the Base URL and model name.`, { httpStatus: status, retryable: false });
	}
	if (status === 429) {
		if (/quota|billing|insufficient|credit/i.test(snippet)) {
			return new PaperMirrorError('QUOTA_EXCEEDED', 'The API reports insufficient quota/credits (HTTP 429).', { httpStatus: status, retryable: false });
		}
		return new PaperMirrorError('RATE_LIMITED', 'The API is rate-limiting requests (HTTP 429). PaperMirror will retry with backoff.', { httpStatus: status, retryable: true });
	}
	// 参数被拒的 400 必须先于「模型名」判定 (1.3.1): temperature/reasoning_effort
	// 的拒绝语里常带 "with this model" 字样,曾被下面的 /model/ 分支包装成
	// "The API rejected the model name" —— 完全误导。消息保留原始片段,
	// postChat 的自愈匹配 (isTemperatureRejection 等) 依赖它。
	if (status === 400
		&& /unsupported\s+value|unrecognized\s+request\s+argument|unknown\s+parameter|not\s+supported\s+with\s+this\s+model|only\s+the\s+default/i.test(snippet)) {
		return new PaperMirrorError('UNKNOWN', `The API rejected a request parameter (HTTP 400): ${snippet}`, { httpStatus: status, retryable: false });
	}
	if (status === 400 && /model/i.test(snippet)) {
		return new PaperMirrorError('INVALID_MODEL', `The API rejected the model name (HTTP 400): ${snippet}`, { httpStatus: status, retryable: false });
	}
	if (status === 402) {
		return new PaperMirrorError('QUOTA_EXCEEDED', 'The API reports insufficient balance (HTTP 402).', { httpStatus: status, retryable: false });
	}
	if (status >= 500) {
		return new PaperMirrorError('NETWORK', `The API server returned an error (HTTP ${status}).`, { httpStatus: status, retryable: true });
	}
	return new PaperMirrorError('UNKNOWN', `Unexpected API response (HTTP ${status}): ${snippet}`, { httpStatus: status, retryable: false });
}

export function mapFetchFailure(e: unknown): PaperMirrorError {
	if (e instanceof PaperMirrorError) {
		return e;
	}
	const message = e instanceof Error ? e.message : String(e);
	const name = e instanceof Error ? e.name : '';
	if (name === 'AbortError' || /abort/i.test(message)) {
		return new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false });
	}
	if (/timeout|timed out/i.test(message)) {
		return new PaperMirrorError('TIMEOUT', 'The translation request timed out.', { retryable: true });
	}
	if (/network|fetch|dns|connect|refused|NS_ERROR/i.test(message + name)) {
		return new PaperMirrorError('NETWORK', `Network error: ${message}`, { retryable: true });
	}
	return new PaperMirrorError('UNKNOWN', message, { retryable: false });
}

/** Localizable, user-facing message key for an error code. */
export function fluentKeyForError(code: PaperMirrorError['code']): string {
	return `papermirror-error-${code.toLowerCase().replace(/_/g, '-')}`;
}
