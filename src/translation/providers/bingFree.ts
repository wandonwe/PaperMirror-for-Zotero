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
import { requestJSON, requestText } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';

const MODULE = 'bingFree';
const PAGE_URL = 'https://www.bing.com/translator';
const API_BASE = 'https://www.bing.com';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const REQUEST_CHAR_LIMIT = 900;

let cachedSession: BingSession | null = null;
let cachedAt = 0;
let sessionPromise: Promise<BingSession> | null = null;

async function fetchSession(timeoutMs: number, signal?: AbortSignal): Promise<BingSession> {
	const html = await requestText(PAGE_URL, { timeoutMs, signal });
	const session = parseBingTranslatorPage(html);
	if (!session) {
		throw new PaperMirrorError('BAD_RESPONSE', 'Could not obtain a Bing Translator session (page layout changed?).', { retryable: true });
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
	cachedAt = 0;
	sessionPromise = null;
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
	const session = await getSession(settings.timeoutMs, signal);
	const base = (settings.apiBaseURL || API_BASE).replace(/\/+$/, '');
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
	displayName: 'Bing / Microsoft Translator (free, no key)',
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
			return { ok: false, message: err.code, httpStatus: err.httpStatus };
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
