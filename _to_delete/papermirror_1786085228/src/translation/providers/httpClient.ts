/**
 * HTTP layer shared by providers: timeout + cancellation + error mapping.
 *
 * Uses XMLHttpRequest, NOT fetch: the Zotero 9 plugin sandbox whitelists
 * XMLHttpRequest (with native .timeout/.abort()) but does NOT provide
 * AbortController, so fetch would be uncancellable there. Cancellation is
 * cooperative via the (possibly polyfilled) AbortSignal from
 * utils/abortPolyfill.
 *
 * Enforces HTTPS unless the user explicitly allowed HTTP (spec §9).
 */

import { PaperMirrorError } from '../../types/models';
import { mapHTTPError } from '../errors';

export interface HttpJSONOptions {
	method?: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: unknown;
	/** Pre-encoded body (e.g. application/x-www-form-urlencoded). Takes
	 *  precedence over `body`. Set the Content-Type header yourself. */
	rawBody?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	allowInsecureHTTP?: boolean;
}

export function checkEndpointURL(url: string, allowInsecureHTTP: boolean): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	}
	catch {
		throw new PaperMirrorError('UNKNOWN', `Invalid endpoint URL: ${url}`, { retryable: false });
	}
	if (parsed.protocol === 'https:') {
		return parsed;
	}
	if (parsed.protocol === 'http:') {
		const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
		if (!(allowInsecureHTTP || isLocal)) {
			throw new PaperMirrorError('HTTP_INSECURE', 'Refusing to send text over insecure HTTP. Enable "Allow HTTP endpoint" in settings to override.', { retryable: false });
		}
		return parsed;
	}
	throw new PaperMirrorError('UNKNOWN', `Unsupported protocol: ${parsed.protocol}`, { retryable: false });
}

export async function requestJSON(url: string, options: HttpJSONOptions): Promise<{ status: number; json: unknown; elapsedMs: number }> {
	checkEndpointURL(url, options.allowInsecureHTTP ?? false);

	if (options.signal?.aborted) {
		throw new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false });
	}

	const started = Date.now();
	return new Promise((resolve, reject) => {
		let settled = false;
		const xhr = new XMLHttpRequest();
		const signal = options.signal;

		const onAbortSignal = (): void => {
			try {
				xhr.abort();
			}
			catch {
				// ignore
			}
		};

		const finish = (fn: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener('abort', onAbortSignal);
			fn();
		};

		try {
			xhr.open(options.method ?? 'POST', url, true);
		}
		catch (e) {
			reject(new PaperMirrorError('NETWORK', `Failed to open request: ${e instanceof Error ? e.message : e}`, { retryable: false }));
			return;
		}
		for (const [name, value] of Object.entries(options.headers)) {
			try {
				xhr.setRequestHeader(name, value);
			}
			catch {
				// invalid header name/value
			}
		}
		xhr.timeout = options.timeoutMs;
		xhr.responseType = 'text';

		xhr.onload = () => finish(() => {
			const elapsedMs = Date.now() - started;
			const text = xhr.responseText ?? '';
			if (xhr.status < 200 || xhr.status >= 300) {
				reject(mapHTTPError(xhr.status, text));
				return;
			}
			try {
				resolve({ status: xhr.status, json: JSON.parse(text), elapsedMs });
			}
			catch {
				reject(new PaperMirrorError('BAD_RESPONSE', 'The service returned a non-JSON response.', { httpStatus: xhr.status }));
			}
		});
		xhr.onerror = () => finish(() => {
			reject(new PaperMirrorError('NETWORK', 'Network error while contacting the translation service.', { retryable: true }));
		});
		xhr.ontimeout = () => finish(() => {
			reject(new PaperMirrorError('TIMEOUT', `The request timed out after ${options.timeoutMs} ms.`, { retryable: true }));
		});
		xhr.onabort = () => finish(() => {
			reject(new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false }));
		});

		signal?.addEventListener('abort', onAbortSignal);

		try {
			const payload = options.rawBody !== undefined
				? options.rawBody
				: options.body !== undefined ? JSON.stringify(options.body) : null;
			xhr.send(payload);
		}
		catch (e) {
			finish(() => reject(new PaperMirrorError('NETWORK', `Failed to send request: ${e instanceof Error ? e.message : e}`, { retryable: false })));
		}
	});
}

/**
 * Fetch a page as plain text (used by the free Bing engine to obtain its
 * session token from the translator page). GET only, HTTPS only.
 */
export async function requestText(url: string, options: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> }): Promise<string> {
	checkEndpointURL(url, false);
	if (options.signal?.aborted) {
		throw new PaperMirrorError('CANCELLED', 'Cancelled.', { retryable: false });
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const xhr = new XMLHttpRequest();
		const onAbortSignal = (): void => {
			try {
				xhr.abort();
			}
			catch {
				// ignore
			}
		};
		const finish = (fn: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			options.signal?.removeEventListener('abort', onAbortSignal);
			fn();
		};
		xhr.open('GET', url, true);
		for (const [name, value] of Object.entries(options.headers ?? {})) {
			try {
				xhr.setRequestHeader(name, value);
			}
			catch {
				// ignore
			}
		}
		xhr.timeout = options.timeoutMs;
		xhr.responseType = 'text';
		xhr.onload = () => finish(() => {
			if (xhr.status < 200 || xhr.status >= 300) {
				reject(mapHTTPError(xhr.status, xhr.responseText));
				return;
			}
			resolve(xhr.responseText ?? '');
		});
		xhr.onerror = () => finish(() => reject(new PaperMirrorError('NETWORK', 'Network error.', { retryable: true })));
		xhr.ontimeout = () => finish(() => reject(new PaperMirrorError('TIMEOUT', `Timed out after ${options.timeoutMs} ms.`, { retryable: true })));
		xhr.onabort = () => finish(() => reject(new PaperMirrorError('CANCELLED', 'Cancelled.', { retryable: false })));
		options.signal?.addEventListener('abort', onAbortSignal);
		try {
			xhr.send(null);
		}
		catch (e) {
			finish(() => reject(new PaperMirrorError('NETWORK', String(e), { retryable: false })));
		}
	});
}
