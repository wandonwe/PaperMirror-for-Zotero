/**
 * Maps HTTP/network failures to user-comprehensible PaperMirrorError codes.
 * Pure module (unit-tested).
 */

import { PaperMirrorError } from '../types/models';

export function mapHTTPError(status: number, bodySnippet?: string): PaperMirrorError {
	const snippet = (bodySnippet ?? '').slice(0, 200);
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
