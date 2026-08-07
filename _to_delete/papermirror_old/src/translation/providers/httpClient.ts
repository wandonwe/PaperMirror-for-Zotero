/**
 * Small fetch wrapper shared by providers: timeout + abort + error mapping.
 * Enforces HTTPS unless the user explicitly allowed HTTP (spec §9).
 */

import { PaperMirrorError } from '../../types/models';
import { mapFetchFailure, mapHTTPError } from '../errors';

export interface HttpJSONOptions {
	method?: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: unknown;
	timeoutMs: number;
	signal?: AbortSignal;
	allowInsecureHTTP?: boolean;
}

export async function requestJSON(url: string, options: HttpJSONOptions): Promise<{ status: number; json: unknown; elapsedMs: number }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	}
	catch {
		throw new PaperMirrorError('UNKNOWN', `Invalid endpoint URL: ${url}`, { retryable: false });
	}
	if (parsed.protocol !== 'https:') {
		const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
		if (parsed.protocol === 'http:' && !(options.allowInsecureHTTP || isLocal)) {
			throw new PaperMirrorError('HTTP_INSECURE', 'Refusing to send text over insecure HTTP. Enable "Allow HTTP endpoint" in settings to override.', { retryable: false });
		}
		if (parsed.protocol !== 'http:') {
			throw new PaperMirrorError('UNKNOWN', `Unsupported protocol: ${parsed.protocol}`, { retryable: false });
		}
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
	const onOuterAbort = (): void => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) {
			clearTimeout(timeout);
			throw new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false });
		}
		options.signal.addEventListener('abort', onOuterAbort, { once: true });
	}

	const started = Date.now();
	try {
		const response = await fetch(url, {
			method: options.method ?? 'POST',
			headers: options.headers,
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: controller.signal
		});
		const elapsedMs = Date.now() - started;
		const text = await response.text();
		if (!response.ok) {
			throw mapHTTPError(response.status, text);
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		}
		catch {
			throw new PaperMirrorError('BAD_RESPONSE', 'The service returned a non-JSON response.', { httpStatus: response.status });
		}
		return { status: response.status, json, elapsedMs };
	}
	catch (e) {
		if (options.signal?.aborted) {
			throw new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false });
		}
		if (controller.signal.aborted && !options.signal?.aborted) {
			throw new PaperMirrorError('TIMEOUT', `The request timed out after ${options.timeoutMs} ms.`, { retryable: true });
		}
		throw mapFetchFailure(e);
	}
	finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener('abort', onOuterAbort);
	}
}
