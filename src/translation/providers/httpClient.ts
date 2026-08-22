/**
 * HTTP layer shared by providers.
 *
 * Transport priority:
 *   1. Zotero.HTTP.request — the canonical Zotero path. It is proven inside
 *      the plugin sandbox, handles timeouts/headers/redirects, and exposes the
 *      underlying XHR through requestObserver so we can abort.
 *      IMPORTANT: logBodyLength: 0 keeps paper text and credentials out of
 *      Zotero's debug log.
 *   2. Raw XMLHttpRequest — fallback for environments without Zotero.HTTP
 *      (unit tests, future refactors).
 *
 * fetch() is deliberately NOT used: the plugin sandbox has no native
 * AbortController (see utils/abortPolyfill), so fetch would be uncancellable.
 *
 * HTTPS is enforced unless the user explicitly allowed HTTP (spec §9).
 */

import { PaperMirrorError } from '../../types/models';
import { mapHTTPError } from '../errors';

export interface HttpJSONOptions {
	method?: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: unknown;
	/** Pre-encoded body (e.g. application/x-www-form-urlencoded). */
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

interface RawResponse {
	status: number;
	text: string;
	elapsedMs: number;
	/** URL after redirects — a mainland bing.com 302s to cn.bing.com, and the
	 *  session scraped there is only valid against that same host. */
	finalURL?: string;
	/** Parsed Retry-After header (429/503), in ms — for honest backoff. */
	retryAfterMs?: number;
}

/** Parse a Retry-After header value (delta-seconds or HTTP-date) to ms. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const secs = Number(value);
	if (Number.isFinite(secs) && secs >= 0) {
		return Math.min(120000, Math.round(secs * 1000));
	}
	const date = Date.parse(value);
	if (Number.isFinite(date)) {
		const ms = date - Date.now();
		return ms > 0 ? Math.min(120000, ms) : undefined;
	}
	return undefined;
}

function zoteroHTTP(): ZoteroHTTPAPI | null {
	try {
		const http = (globalThis as Record<string, any>).Zotero?.HTTP;
		if (http && typeof http.request === 'function') {
			return http as ZoteroHTTPAPI;
		}
	}
	catch {
		// not running inside Zotero
	}
	return null;
}

/** Core transport. Returns the raw status + body; never throws on non-2xx. */
async function send(
	method: 'GET' | 'POST',
	url: string,
	headers: Record<string, string>,
	body: string | null,
	timeoutMs: number,
	signal: AbortSignal | undefined
): Promise<RawResponse> {
	if (signal?.aborted) {
		throw new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false });
	}
	const started = Date.now();
	const http = zoteroHTTP();

	if (http) {
		let xhrRef: { abort?: () => void } | null = null;
		const onAbortSignal = (): void => {
			try {
				xhrRef?.abort?.();
			}
			catch {
				// ignore
			}
		};
		signal?.addEventListener('abort', onAbortSignal, { once: true } as AddEventListenerOptions);
		try {
			const response = await http.request(method, url, {
				headers,
				body: body ?? undefined,
				timeout: timeoutMs,
				responseType: 'text',
				// Map status codes ourselves instead of letting Zotero throw
				successCodes: false,
				// PRIVACY: never write request bodies (paper text / keys) to the log
				logBodyLength: 0,
				noCache: true,
				requestObserver: (xhr: { abort?: () => void }) => {
					xhrRef = xhr;
					if (signal?.aborted) {
						onAbortSignal();
					}
				}
			});
			let retryAfterMs: number | undefined;
			try {
				const header = (response as { getResponseHeader?: (n: string) => string | null }).getResponseHeader?.('Retry-After');
				retryAfterMs = parseRetryAfter(header);
			}
			catch {
				// header access can throw across compartments — best-effort
			}
			// status 0 是「传输层根本没完成」,不是一个 HTTP 状态码 (审核 P0-1)。
			// successCodes:false 让 Zotero.HTTP 对任何状态码都 resolve —— 包括 XHR
			// 的 status 0(DNS 失败、连接被拒、TLS/代理失败、离线、xhr.abort())。
			// 于是下面那个把网络错误映射成 NETWORK{retryable:true}、把 abort 映射成
			// CANCELLED 的 catch 分支永远不会执行,这些失败一路落到
			// mapHTTPError(0) 的兜底 UNKNOWN{retryable:false}:
			//   · 网络错误从不重试,自适应限流收不到任何反馈;
			//   · 更糟的是空闲看门狗 —— 它 abort 后拿到 UNKNOWN 而非 CANCELLED,
			//     那句「Page N 停滞 150 秒」的 TIMEOUT 转译从来没有触发过。
			// 这里在返回前把 status 0 还原成它真正的语义。XHR 回退路径
			// (下面的 onerror)一直是这么做的,两条路径现在一致了。
			if (!response.status) {
				if (signal?.aborted) {
					throw new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false });
				}
				throw new PaperMirrorError('NETWORK',
					'Network error: the request did not complete (no response from the server).',
					{ retryable: true });
			}
			return {
				status: response.status,
				text: typeof response.responseText === 'string' ? response.responseText : String(response.response ?? ''),
				finalURL: typeof (response as { responseURL?: string }).responseURL === 'string'
					? (response as { responseURL?: string }).responseURL
					: undefined,
				retryAfterMs,
				elapsedMs: Date.now() - started
			};
		}
		catch (e) {
			// 已经分类好的错误原样上抛,不要二次包装(status 0 分支就走这里)。
			if (e instanceof PaperMirrorError) {
				throw e;
			}
			if (signal?.aborted) {
				throw new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false });
			}
			const message = e instanceof Error ? e.message : String(e);
			const name = (e as { name?: string })?.name ?? '';
			if (/timed? ?out/i.test(message) || name === 'TimeoutError') {
				throw new PaperMirrorError('TIMEOUT', `The request timed out after ${timeoutMs} ms.`, { retryable: true });
			}
			throw new PaperMirrorError('NETWORK', `Network error while contacting the translation service: ${message}`, { retryable: true });
		}
		finally {
			signal?.removeEventListener('abort', onAbortSignal);
		}
	}

	// ---- fallback: raw XMLHttpRequest -------------------------------------
	return new Promise<RawResponse>((resolve, reject) => {
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
			signal?.removeEventListener('abort', onAbortSignal);
			fn();
		};
		try {
			xhr.open(method, url, true);
		}
		catch (e) {
			reject(new PaperMirrorError('NETWORK', `Failed to open request: ${e instanceof Error ? e.message : e}`, { retryable: false }));
			return;
		}
		for (const [name, value] of Object.entries(headers)) {
			try {
				xhr.setRequestHeader(name, value);
			}
			catch {
				// invalid header name/value
			}
		}
		xhr.timeout = timeoutMs;
		xhr.onload = () => finish(() => resolve({
			status: xhr.status,
			text: xhr.responseText ?? '',
			retryAfterMs: parseRetryAfter(xhr.getResponseHeader?.('Retry-After')),
			// P3 (2.0.10): 与 Zotero.HTTP 路径一致,报告重定向落点 —— bing 会话
			// 页在 XHR 回退下也学得到 cn/www 源。
			finalURL: typeof (xhr as XMLHttpRequest & { responseURL?: string }).responseURL === 'string'
				? (xhr as XMLHttpRequest & { responseURL?: string }).responseURL
				: undefined,
			elapsedMs: Date.now() - started
		}));
		xhr.onerror = () => finish(() => reject(new PaperMirrorError('NETWORK', 'Network error while contacting the translation service.', { retryable: true })));
		xhr.ontimeout = () => finish(() => reject(new PaperMirrorError('TIMEOUT', `The request timed out after ${timeoutMs} ms.`, { retryable: true })));
		xhr.onabort = () => finish(() => reject(new PaperMirrorError('CANCELLED', 'Translation was cancelled.', { retryable: false })));
		signal?.addEventListener('abort', onAbortSignal);
		try {
			xhr.send(body);
		}
		catch (e) {
			finish(() => reject(new PaperMirrorError('NETWORK', String(e), { retryable: false })));
		}
	});
}

export async function requestJSON(url: string, options: HttpJSONOptions): Promise<{ status: number; json: unknown; elapsedMs: number }> {
	checkEndpointURL(url, options.allowInsecureHTTP ?? false);
	const payload = options.rawBody !== undefined
		? options.rawBody
		: options.body !== undefined ? JSON.stringify(options.body) : null;

	const { status, text, elapsedMs, retryAfterMs } = await send(
		options.method ?? 'POST',
		url,
		options.headers,
		payload,
		options.timeoutMs,
		options.signal
	);
	if (status < 200 || status >= 300) {
		const error = mapHTTPError(status, text);
		// Honest backoff: surface the server's Retry-After so the scheduler and
		// the request-level retry wait what the SERVER asked, not a blind 400ms.
		if (retryAfterMs !== undefined) {
			(error as PaperMirrorError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
		}
		throw error;
	}
	try {
		return { status, json: JSON.parse(text), elapsedMs };
	}
	catch {
		// Say WHAT came back instead — an HTML bot-check page and an empty
		// body need entirely different fixes, and "non-JSON" hides both.
		const head = text.trim().slice(0, 40).toLowerCase();
		const kind = !text.trim()
			? 'an empty body'
			: head.startsWith('<!doctype') || head.startsWith('<html')
				? 'an HTML page (likely a bot check or a redirect)'
				: 'a non-JSON body';
		throw new PaperMirrorError('BAD_RESPONSE', `The service returned ${kind}.`, { httpStatus: status });
	}
}

/**
 * Fetch a page as plain text (used by the free Bing engine to obtain its
 * session token from the translator page). GET only, HTTPS only.
 */
export async function requestText(url: string, options: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> }): Promise<string> {
	return (await requestTextWithURL(url, options)).text;
}

/** Like requestText, but also reports where redirects actually landed. */
export async function requestTextWithURL(url: string, options: { timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string> }): Promise<{ text: string; finalURL: string }> {
	checkEndpointURL(url, false);
	const { status, text, finalURL, retryAfterMs } = await send('GET', url, options.headers ?? {}, null, options.timeoutMs, options.signal);
	if (status < 200 || status >= 300) {
		const error = mapHTTPError(status, text);
		// P3 (2.0.10): 与 requestJSON 一致地携带 Retry-After —— bing 会话页
		// 429 时的 RATE_LIMITED 此前不带 retryAfterMs,退避回到盲猜。
		if (retryAfterMs !== undefined) {
			(error as PaperMirrorError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
		}
		throw error;
	}
	return { text, finalURL: finalURL || url };
}
