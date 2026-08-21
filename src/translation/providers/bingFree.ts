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
	resolveBingApiBase,
	runPool,
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
/**
 * Microsoft's endpoints bot-check unfamiliar clients: the Zotero user agent
 * gets an HTML challenge page with HTTP 200 where a browser gets JSON.
 * Privileged XHR is allowed to set User-Agent, so every request to a
 * Microsoft host introduces itself as Edge.
 */
const EDGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const EDGE_API_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&includeSentenceLength=true';
const EDGE_TOKEN_TTL_MS = 8 * 60 * 1000;

/**
 * 用户是否配置了「真正的」自定义 Base URL (审核 P1-3)。
 *
 * 判据必须与 resolveBingApiBase 完全一致,否则两处会漂移:空串、解析失败、
 * 以及 bing.com/*.bing.com 都不算覆盖(那只是把默认值写了出来,仍走官方通道)。
 * 只有指向第三方主机时才算 —— 那种情况下回退到硬编码的微软端点会违背用户
 * 把流量收进自有代理的意图。
 */
export function hasCustomBingBase(userBaseURL: string | undefined): boolean {
	const cleaned = (userBaseURL ?? '').trim().replace(/\/+$/, '');
	if (!cleaned) {
		return false;
	}
	try {
		const host = new URL(cleaned).hostname.toLowerCase();
		return !(host === 'bing.com' || host.endsWith('.bing.com'));
	}
	catch {
		return false;
	}
}

let edgeToken: string | null = null;
let edgeTokenAt = 0;
let edgeTokenPromise: Promise<string> | null = null;
/** Set after the edge flow fails hard, so we stop paying its latency. */
let edgeDisabledUntil = 0;
/** The last Edge failure — reported even while the channel is skipped, so a
 *  single test-connection screenshot always tells the whole story. */
let lastEdgeError: string | null = null;

/**
 * 共享 in-flight promise 与调用方信号解耦 (2.0.6, 审核 P3): 认证/会话这类
 * 共享请求此前把**第一个到达者**的 AbortSignal 绑进了底层请求 —— 第一个
 * 标签页取消(关页/翻页)会把同刻等待的所有其他标签页一起打断
 * (CANCELLED 串扰)。现在共享请求自身只受 timeoutMs 约束;每个调用者用
 * 自己的 signal 与共享 promise 赛跑: 自己取消只影响自己,共享结果继续
 * 供别人使用。
 */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(new PaperMirrorError('CANCELLED', 'Cancelled.'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new PaperMirrorError('CANCELLED', 'Cancelled.'));
		signal.addEventListener('abort', onAbort, { once: true } as AddEventListenerOptions);
		promise.then(
			(v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
			(e) => { signal.removeEventListener('abort', onAbort); reject(e); }
		);
	});
}

async function getEdgeToken(timeoutMs: number, signal?: AbortSignal, force = false): Promise<string> {
	if (!force && edgeToken && Date.now() - edgeTokenAt < EDGE_TOKEN_TTL_MS) {
		return edgeToken;
	}
	if (!edgeTokenPromise) {
		// 不带调用方 signal (P3): 见 raceSignal 注释。
		edgeTokenPromise = requestText(EDGE_AUTH_URL, {
			timeoutMs,
			headers: { 'User-Agent': EDGE_UA, Accept: '*/*' }
		})
			.catch((e) => {
				// 404 here means the ANONYMOUS AUTH ENDPOINT is gone, not that
				// some model does not exist — mapHTTPError's generic 404 text
				// ("model not found") was actively misleading in this spot.
				if (e instanceof PaperMirrorError && e.httpStatus === 404) {
					throw new PaperMirrorError('BAD_RESPONSE', 'Edge 匿名认证端点不可用 (HTTP 404)', { httpStatus: 404, retryable: true });
				}
				throw e;
			})
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
	return raceSignal(edgeTokenPromise, signal);
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
				'User-Agent': EDGE_UA,
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
/** Bing's own client suffixes the IID with a per-session request counter. */
let iidCounter = 0;

/** Preferred page host; rotated when one host answers with silent-empty 200s. */
let pageHost = PAGE_URL;

function rotateHost(): void {
	pageHost = pageHost.includes('cn.bing.com')
		? 'https://www.bing.com/translator'
		: 'https://cn.bing.com/translator';
	iidCounter = 0;
}

async function fetchSession(timeoutMs: number, signal?: AbortSignal): Promise<BingSession> {
	const { text: html, finalURL } = await requestTextWithURL(pageHost, {
		timeoutMs,
		signal,
		headers: { 'User-Agent': EDGE_UA, Accept: 'text/html,application/xhtml+xml' }
	});
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
		// 不带调用方 signal (P3): 共享请求只受 timeoutMs 约束,见 raceSignal。
		sessionPromise = fetchSession(timeoutMs, undefined)
			.then((session) => {
				cachedSession = session;
				cachedAt = Date.now();
				return session;
			})
			.finally(() => {
				sessionPromise = null;
			});
	}
	return raceSignal(sessionPromise, signal);
}

/** Exposed for tests/shutdown hygiene. */
export function resetBingSession(): void {
	cachedSession = null;
	cachedOrigin = API_BASE;
	cachedAt = 0;
	iidCounter = 0;
	pageHost = PAGE_URL;
	lastEdgeError = null;
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
	// The Bing web channel is the one that currently works — it goes FIRST.
	// Edge anonymous auth (observed returning 404) is the fallback, behind a
	// 5-minute breaker so a dead endpoint costs one probe, not one per block.
	let scrapeError: string | null = null;
	try {
		return await translateViaScrape(text, sl, tl, settings, signal, allowRetry);
	}
	catch (e) {
		if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
			throw e;
		}
		scrapeError = e instanceof Error ? e.message : String(e);
		logger.debug(MODULE, 'Bing web channel failed; trying Edge auth fallback', e);
	}
	let edgeNote: string;
	// 用户自定义了 Base URL 时,禁用 Edge 兜底 (审核 P1-3)。
	// translateViaScrape 尊重 settings.apiBaseURL,但 translateViaEdge 的两个
	// 端点是硬编码常量(edge.microsoft.com / api-edge.cognitive.microsofttranslator.com),
	// 完全不读 apiBaseURL。bing-free 又是默认引擎 —— 机构用户把 Base URL 指向
	// 内网代理正是为了让论文不出网,代理返回一次 502 就会让同一段原文被 POST
	// 到微软端点,且 UI 上毫无提示。宁可报错让用户看见,也不能静默出网。
	if (hasCustomBingBase(settings.apiBaseURL)) {
		throw new PaperMirrorError('BAD_RESPONSE',
			`Bing通道: ${scrapeError} ｜ Edge通道: 已跳过(你配置了自定义 Base URL,`
			+ `不会回退到微软官方端点;如需回退请清空该设置)`,
			{ retryable: true });
	}
	if (Date.now() >= edgeDisabledUntil) {
		try {
			const [translated] = await translateViaEdge([text], sl, tl, settings, signal);
			lastEdgeError = null;
			return translated!;
		}
		catch (e) {
			if (e instanceof PaperMirrorError && e.code === 'CANCELLED') {
				throw e;
			}
			lastEdgeError = e instanceof Error ? e.message : String(e);
			edgeNote = lastEdgeError;
			edgeDisabledUntil = Date.now() + 5 * 60 * 1000;
		}
	}
	else {
		edgeNote = lastEdgeError ? `熔断中, 上次: ${lastEdgeError}` : '熔断中';
	}
	throw new PaperMirrorError('BAD_RESPONSE', `Bing通道: ${scrapeError} ｜ Edge通道: ${edgeNote}`, { retryable: true });
}

async function translateViaScrape(
	text: string,
	sl: string,
	tl: string,
	settings: ProviderSettings,
	signal: AbortSignal | undefined,
	allowRetry = true
): Promise<string> {
	const session = await getSession(settings.timeoutMs, signal);
	// Same-origin with wherever the session was ISSUED (www vs cn), or the
	// token is rejected. A bing.com Base URL in settings is the auto-filled
	// default, not a real override — resolveBingApiBase ignores it.
	const base = resolveBingApiBase(settings.apiBaseURL, cachedOrigin);
	const iid = `${session.iid}.${++iidCounter}`;
	const url = `${base}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(session.ig)}&IID=${encodeURIComponent(iid)}`;
	const rawBody = `&fromLang=${encodeURIComponent(sl)}`
		+ `&text=${encodeURIComponent(escapeHTML(text))}`
		+ `&to=${encodeURIComponent(tl)}`
		+ `&token=${encodeURIComponent(session.token)}`
		+ `&key=${encodeURIComponent(session.key)}`;
	let json: unknown;
	try {
		({ json } = await requestJSON(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': EDGE_UA,
				Accept: '*/*',
				Referer: `${base}/translator`
			},
			rawBody,
			timeoutMs: settings.timeoutMs,
			signal
		}));
	}
	catch (e) {
		// Expired session → refresh once and retry
		if (allowRetry && e instanceof PaperMirrorError && (e.httpStatus === 400 || e.httpStatus === 401 || e.httpStatus === 403 || e.code === 'BAD_RESPONSE')) {
			// A silent-empty 200 is Bing rate-limiting/flagging THIS host for
			// this client; the sibling host (www ↔ cn) often still answers.
			if (/empty body/i.test(e.message)) {
				logger.debug(MODULE, 'Bing answered empty; rotating host and retrying');
				rotateHost();
			}
			else {
				logger.debug(MODULE, 'Bing session may have expired; refreshing');
			}
			await getSession(settings.timeoutMs, signal, true);
			return translateViaScrape(text, sl, tl, settings, signal, false);
		}
		throw e;
	}
	// A token failure returns { statusCode: 400 } instead of an array
	const statusCode = (json as { statusCode?: number })?.statusCode;
	if (typeof statusCode === 'number' && statusCode >= 400) {
		if (allowRetry) {
			await getSession(settings.timeoutMs, signal, true);
			return translateViaScrape(text, sl, tl, settings, signal, false);
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
		// Flatten every block's paragraphs and length-capped parts into one
		// task list, run it through a small parallel pool, then reassemble.
		// Serial awaiting was the whole slowness: ~20 round trips per page,
		// one after another.
		interface Task { block: number; paragraph: number; part: number; text: string }
		const tasks: Task[] = [];
		const shape: number[][] = [];
		request.blocks.forEach((block, blockIndex) => {
			const paragraphs = block.text.split(/\n{2,}/);
			shape.push(paragraphs.map(() => 0));
			paragraphs.forEach((paragraph, paragraphIndex) => {
				const parts = splitLongText(paragraph, REQUEST_CHAR_LIMIT);
				shape[blockIndex]![paragraphIndex] = parts.length;
				parts.forEach((part, partIndex) => {
					tasks.push({ block: blockIndex, paragraph: paragraphIndex, part: partIndex, text: part });
				});
			});
		});
		const translated = await runPool(tasks, 3, async (task) => {
			if (options.signal?.aborted) {
				throw new PaperMirrorError('CANCELLED', 'Cancelled.');
			}
			return translateOne(task.text, sl, tl, settings, options.signal);
		});
		request.blocks.forEach((block, blockIndex) => {
			const paragraphs: string[][] = shape[blockIndex]!.map(count => new Array<string>(count));
			tasks.forEach((task, taskIndex) => {
				if (task.block === blockIndex) {
					paragraphs[task.paragraph]![task.part] = translated[taskIndex]!;
				}
			});
			translations.push({
				id: block.id,
				translatedText: paragraphs.map(parts => parts.join(' ').trim()).filter(Boolean).join('\n\n').trim()
			});
		});
		return { translations };
	}
};
