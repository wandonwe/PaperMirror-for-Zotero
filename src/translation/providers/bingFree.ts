/**
 * Free Bing (Microsoft) Translator engine (no API key), ported from
 * old-immersive-translate's bingService:
 *   1. GET https://www.bing.com/translator → parse IG / data-iid /
 *      params_RichTranslateHelper = [key, "token", …]  (session, cached ~8 h)
 *   2. POST https://www.bing.com/ttranslatev3?isVertical=1&IG=<IG>&IID=<IID>
 *      body: &fromLang=<sl>&text=<text>&to=<tl>&token=<token>&key=<key>
 *      → [ { translations: [{ text }], detectedLanguage: { language } } ]
 *
 * One text per request (the endpoint caps around 1000 chars); long blocks are
 * split at sentence boundaries and re-joined. Reachable from mainland China.
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import * as logger from '../../utils/logger';
import {
	escapeHTML,
	mapBingLang,
	parseBingTranslatorPage,
	splitLongText,
	unescapeHTML,
	type BingSession
} from './freeEngineUtils';
import { requestJSON, requestText, requestTextWithURL } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';

const MODULE = 'bingFree';
const PAGE_URL = 'https://www.bing.com/translator';
const API_BASE = 'https://www.bing.com';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const REQUEST_CHAR_LIMIT = 900;

/**
 * Primary flow since the bing.com page scrape broke: the Edge browser's own
 * translator auth. GET /translate/auth hands back a JWT (plain text, ~10 min
 * validity, no key, reachable from mainland China), which authorises the
 * standard Cognitive Services translate API. This is the flow current
 * immersive-translate uses; the page-scrape below stays as the fallback.
 */
const EDGE_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const EDGE_API_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&includeSentenceLength=true';
const EDGE_TOKEN_TTL_MS = 8 * 60 * 1000;

let edgeToken: string | null = null;
let edgeTokenAt = 0;
let edgeTokenPromise: Promise<string> | null = null;
/** Set after the edge flow fails hard, so we stop paying its latency. */
let edgeDisabledUntil = 0;

async function getEdgeToken(timeoutMs: number, signal?: AbortSignal, force = false): Promise<string> {
	if (!force && edgeToken && Date.now() - edgeTokenAt < EDGE_TOKEN_TTL_MS) {
		return edgeToken;
	}
	if (!edgeTokenPromise) {
		edgeTokenPromise = requestText(EDGE_AUTH_URL, { timeoutMs, signal })
			.then((text) => {
				const token = text.trim();
				if (token.split('.').length !== 3) {
					throw new PaperMirrorError('BAD_RESPONSE', 'Edge auth did not return a JWT.', { retryable: true });
				}
				edgeToken = token;
				edgeTokenAt = Date.now();
				return token;
			})
			.finally(() => {
				edgeTokenPromise = null;
			});
	}
	return edgeTokenPromise;
}

async function translateViaEdge(
	texts: string[],
	sl: string,
	tl: string,
	settings: ProviderSettings,
	signal: AbortSignal | undefined,
	allowRetry = true
): Promise<string[]> {
	const token = await getEdgeToken(settings.timeoutMs, signal);
	const from = sl === 'auto-detect' ? '' : `&from=${encodeURIComponent(sl)}`;
	const url = `${EDGE_API_URL}${from}&to=${encodeURIComponent(tl)}`;
	let json: unknown;
	try {
		({ json } = await requestJSON(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`
			},
			body: texts.map(text => ({ Text: text })),
			timeoutMs: settings.timeoutMs,
			signal
		}));
	}
	catch (e) {
		if (allowRetry && e instanceof PaperMirrorError && (e.httpStatus === 401 || e.httpStatus === 403)) {
			await getEdgeToken(settings.timeoutMs, signal, true);
			return translateViaEdge(texts, sl, tl, settings, signal, false);
		}
		throw e;
	}
	if (!Array.isArray(json)) {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Edge translator response shape.', { retryable: true });
	}
	return json.map((entry) => {
		const text = (entry as BingApiResult)?.translations?.[0]?.text;
		if (typeof text !== 'string') {
			throw new PaperMirrorError('BAD_RESPONSE', 'Edge translator entry missing text.', { retryable: true });
		}
		return text;
	});
}

let cachedSession: BingSession | null = null;
/** Origin the session page ACTUALLY came from after redirects. In mainland
 *  China www.bing.com 302s to cn.bing.com, and the scraped IG/IID/token are
 *  only valid against that same host — posting them back to www.bing.com is
 *  a guaranteed 400, which is exactly how the engine looked "broken". */
let cachedOrigin = API_BASE;
let cachedAt = 0;
let sessionPromise: Promise<BingSession> | null = null;

async function fetchSession(timeoutMs: number, signal?: AbortSignal): Promise<BingSession> {
	const { text: html, finalURL } = await requestTextWithURL(PAGE_URL, { timeoutMs, signal });
	const session = parseBingTranslatorPage(html);
	if (!session) {
		throw new PaperMirrorError('BAD_RESPONSE', 'Could not obtain a Bing Translator session (page layout changed?).', { retryable: true });
	}
	try {
		cachedOrigin = new URL(finalURL).origin;
	}
	catch {
		cachedOrigin = API_BASE;
	}
	return session;
}

async function getSession(timeoutMs: number, signal?: AbortSignal, forceRefresh = false): Promise<BingSession> {
	if (!forceRefresh && cachedSession && Date.now() - cachedAt < SESSION_TTL_MS) {
		return cachedSession;
	}
	if (!sessionPromise) {
		sessionPromise = fetchSession(timeoutMs, signal)
			.then((session) => {
				cachedSession = session;
				cachedAt = Date.now();
				return session;
			})
			.finally(() => {
				sessionPromise = null;
			});
	}
	return sessionPromise;
}

/** Exposed for tests/shutdown hygiene. */
export function resetBingSession(): void {
	cachedSession = null;
	cachedOrigin = API_BASE;
	cachedAt = 0;
	sessionPromise = null;
	edgeToken = null;
	edgeTokenAt = 0;
	edgeTokenPromise = null;
	edgeDisabledUntil = 0;
}

interface BingApiResult {
	translations?: { text?: string }[];
	detectedLanguage?: { language?: string };
}

async function translateOne(
	text: string,
	sl: string,
	tl: string,
	settings: ProviderSettings,
	signal: AbortSignal | undefined,
	allowRetry = true
): Promise<string> {
	// Edge auth first; the page scrape only when Edge is down or blocked.
	if (Date.now() >= edgeDisabledUntil) {
		try {
			const [translated] = await translateViaEdge([text], sl, tl, settings, signal);
			return translated!;
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
				throw e;
			}
			logger.debug(MODULE, 'Edge translator failed; falling back to bing.com scrape', e);
			edgeDisabledUntil = Date.now() + 5 * 60 * 1000;
		}
	}
	const session = await getSession(settings.timeoutMs, signal);
	// Same-origin with the session page, or the token is rejected.
	const base = (settings.apiBaseURL || cachedOrigin).replace(/\/+$/, '');
	const url = `${base}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(session.ig)}&IID=${encodeURIComponent(session.iid)}`;
	const rawBody = `&fromLang=${encodeURIComponent(sl)}`
		+ `&text=${encodeURIComponent(escapeHTML(text))}`
		+ `&to=${encodeURIComponent(tl)}`
		+ `&token=${encodeURIComponent(session.token)}`
		+ `&key=${encodeURIComponent(session.key)}`;
	let json: unknown;
	try {
		({ json } = await requestJSON(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			rawBody,
			timeoutMs: settings.timeoutMs,
			signal
		}));
	}
	catch (e) {
		// Expired session → refresh once and retry
		if (allowRetry && e instanceof PaperMirrorError && (e.httpStatus === 400 || e.httpStatus === 401 || e.httpStatus === 403 || e.code === 'BAD_RESPONSE')) {
			logger.debug(MODULE, 'Bing session may have expired; refreshing');
			await getSession(settings.timeoutMs, signal, true);
			return translateOne(text, sl, tl, settings, signal, false);
		}
		throw e;
	}
	// A token failure returns { statusCode: 400 } instead of an array
	const statusCode = (json as { statusCode?: number })?.statusCode;
	if (typeof statusCode === 'number' && statusCode >= 400) {
		if (allowRetry) {
			await getSession(settings.timeoutMs, signal, true);
			return translateOne(text, sl, tl, settings, signal, false);
		}
		throw new PaperMirrorError('BAD_RESPONSE', `Bing returned status ${statusCode}.`, { retryable: true });
	}
	const first = Array.isArray(json) ? (json[0] as BingApiResult | undefined) : undefined;
	const translated = first?.translations?.[0]?.text;
	if (typeof translated !== 'string') {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Bing response shape.');
	}
	return unescapeHTML(translated);
}

export const bingFreeProvider: TranslationProvider = {
	id: 'bing-free',
	displayName: 'Microsoft 微软翻译',
	defaultBaseURL: API_BASE,
	defaultModel: '',
	requiresApiKey: false,

	async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
		try {
			const started = Date.now();
			const text = await translateOne('Hello world', 'en', 'zh-Hans', settings, undefined);
			return { ok: text.length > 0, httpStatus: 200, modelAvailable: true, elapsedMs: Date.now() - started };
		}
		catch (e) {
			const err = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			return { ok: false, message: `${err.code}: ${err.message}`, httpStatus: err.httpStatus };
		}
	},

	async translate(request: TranslationRequest, settings: ProviderSettings, options: TranslateOptions): Promise<TranslationResponse> {
		const sl = mapBingLang(request.sourceLanguage || 'auto');
		const tl = mapBingLang(request.targetLanguage);
		const translations: { id: string; translatedText: string }[] = [];
		for (const block of request.blocks) {
			if (options.signal?.aborted) {
				throw new PaperMirrorError('CANCELLED', 'Cancelled.');
			}
			const parts = splitLongText(block.text, REQUEST_CHAR_LIMIT);
			const translatedParts: string[] = [];
			for (const part of parts) {
				translatedParts.push(await translateOne(part, sl, tl, settings, options.signal));
			}
			translations.push({ id: block.id, translatedText: translatedParts.join(' ').trim() });
		}
		return { translations };
	}
};
