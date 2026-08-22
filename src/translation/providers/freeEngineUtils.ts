/**
 * Shared helpers for the free MT engines, ported from
 * immersive-translate/old-immersive-translate (MPL-2.0 heritage via
 * Traduzir-paginas-web), src/background/translationService.js:
 *  - Google "tk" request hash (GoogleHelper.calcHash)
 *  - HTML escaping/unescaping used by both engines
 *  - Google anno=3 response cleanup (<pre>/<b>/<i> stripping)
 *  - sentence-aware splitting for per-request length limits
 *
 * Pure module (unit-tested).
 */

export function escapeHTML(unsafe: string): string {
	return unsafe
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function unescapeHTML(unsafe: string): string {
	return unsafe
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

// ---- Google tk hash ---------------------------------------------------------

const GOOGLE_TKK = '448487.932609646';

function shiftLeftOrRightThenSumOrXor(num: number, optString: string): number {
	for (let i = 0; i < optString.length - 2; i += 3) {
		let acc: number;
		const c = optString.charAt(i + 2);
		if (c >= 'a') {
			acc = c.charCodeAt(0) - 87;
		}
		else {
			acc = Number(c);
		}
		if (optString.charAt(i + 1) === '+') {
			acc = num >>> acc;
		}
		else {
			acc = num << acc;
		}
		if (optString.charAt(i) === '+') {
			num += acc & 4294967295;
		}
		else {
			num ^= acc;
		}
	}
	return num;
}

function transformQuery(query: string): number[] {
	const bytesArray: number[] = [];
	let idx = 0;
	for (let i = 0; i < query.length; i++) {
		let charCode = query.charCodeAt(i);
		if (charCode < 128) {
			bytesArray[idx++] = charCode;
		}
		else {
			if (charCode < 2048) {
				bytesArray[idx++] = (charCode >> 6) | 192;
			}
			else {
				if ((charCode & 64512) === 55296 && i + 1 < query.length && (query.charCodeAt(i + 1) & 64512) === 56320) {
					charCode = 65536 + ((charCode & 1023) << 10) + (query.charCodeAt(++i) & 1023);
					bytesArray[idx++] = (charCode >> 18) | 240;
					bytesArray[idx++] = ((charCode >> 12) & 63) | 128;
				}
				else {
					bytesArray[idx++] = (charCode >> 12) | 224;
				}
				bytesArray[idx++] = ((charCode >> 6) & 63) | 128;
			}
			bytesArray[idx++] = (charCode & 63) | 128;
		}
	}
	return bytesArray;
}

/** Google Translate request hash ("tk" URL parameter). */
export function calcGoogleTk(query: string): string {
	const tkkSplit = GOOGLE_TKK.split('.');
	const tkkIndex = Number(tkkSplit[0]) || 0;
	const tkkKey = Number(tkkSplit[1]) || 0;
	const bytesArray = transformQuery(query);
	let round = tkkIndex;
	for (const item of bytesArray) {
		round += item;
		round = shiftLeftOrRightThenSumOrXor(round, '+-a^+6');
	}
	round = shiftLeftOrRightThenSumOrXor(round, '+-3^+b+-f');
	round ^= tkkKey;
	if (round <= 0) {
		round = (round & 2147483647) + 2147483648;
	}
	const normalized = round % 1000000;
	return normalized.toString() + '.' + (normalized ^ tkkIndex);
}

// ---- Google anno=3 response cleanup ----------------------------------------

/**
 * The anno=3/format=html response wraps each translated sentence in <b> with
 * the original inside <i>. Strip the annotations, keep translations only,
 * remove residual tags, unescape entities.
 */
export function cleanGoogleAnnotatedText(result: string): string {
	let text = result;
	if (text.indexOf('<pre') !== -1) {
		text = text.replace('</pre>', '');
		const index = text.indexOf('>');
		text = text.slice(index + 1);
	}
	const sentences: string[] = [];
	let idx = 0;
	for (;;) {
		const start = text.indexOf('<b>', idx);
		if (start === -1) {
			break;
		}
		const end = text.indexOf('<i>', start);
		if (end === -1) {
			sentences.push(text.slice(start + 3));
			break;
		}
		sentences.push(text.slice(start + 3, end));
		idx = end;
	}
	text = sentences.length > 0 ? sentences.join(' ') : text;
	text = text.replace(/<\/?[bi]>/g, '');
	// Drop the </i>…</b> leftovers and any stray tags the annotator produced
	text = text.replace(/<\/?(?:pre|a)[^>]*>/g, '');
	return unescapeHTML(text).replace(/\s+/g, ' ').trim();
}

// ---- length-limited splitting ----------------------------------------------

/**
 * Split text into chunks of at most maxLen characters, preferring sentence
 * boundaries (., !, ?, 。, !, ?, ;, ;) and falling back to hard cuts.
 */
/**
 * 分片重组连接符 (2.0.10, 审核 P3): 长段被 splitLongText 切开分请求后,译回
 * 的片段此前一律用 ASCII 空格拼回 —— CJK 译文的每个切点都留下一个句中空格。
 * 目标语言是 CJK(中/日/韩,含各引擎的方言代码)时用空串拼接。
 */
export function joinTranslatedParts(parts: string[], targetLang: string): string {
	const t = (targetLang ?? '').toLowerCase();
	const cjk = t.startsWith('zh') || t.startsWith('ja') || t.startsWith('ko')
		|| t.startsWith('jp') || t === 'kor' || t === 'jpn';
	return parts.join(cjk ? '' : ' ');
}

export function splitLongText(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) {
		return [text];
	}
	const sentences = text.match(/[^.!?。!?;;]+[.!?。!?;;]*\s*/g) ?? [text];
	const chunks: string[] = [];
	let current = '';
	for (const sentence of sentences) {
		if (sentence.length > maxLen) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			// 硬切不劈代理对 (2.0.9, 审核 P2-14): 数学正文常含星面字符
			// (U+1D400 起的 𝑥、𝛽 等,占两个 UTF-16 单元)。按单元硬切落在
			// 代理对中间会产生孤立代理 —— encodeURIComponent 对它直接抛
			// URIError(非 PaperMirrorError),整页被包成不可重试的 UNKNOWN
			// 永久失败。切点前一位是高位代理 (0xD800–0xDBFF) 时退一位。
			for (let i = 0; i < sentence.length;) {
				let end = Math.min(i + maxLen, sentence.length);
				const beforeCut = sentence.charCodeAt(end - 1);
				if (end < sentence.length && beforeCut >= 0xd800 && beforeCut <= 0xdbff) {
					end--;
				}
				chunks.push(sentence.slice(i, end));
				i = end;
			}
			continue;
		}
		if (current.length + sentence.length > maxLen && current) {
			chunks.push(current);
			current = '';
		}
		current += sentence;
	}
	if (current) {
		chunks.push(current);
	}
	return chunks.filter(c => c.trim().length > 0);
}

// ---- Bing token page parsing ------------------------------------------------

export interface BingSession {
	ig: string;
	iid: string;
	key: string;
	token: string;
}

/**
 * Parse IG/IID/key/token out of the bing.com/translator page HTML.
 *
 * Bing has shipped the credentials under two different variable names over the
 * years — `params_RichTranslateHelper` (old) and `params_AbusePreventionHelper`
 * (current). Both carry [key, "token", …]; accept either, so a Bing redesign
 * that merely renames the variable does not kill the engine again.
 */
export function parseBingTranslatorPage(html: string): BingSession | null {
	const helper = html.match(/params_(?:RichTranslateHelper|AbusePreventionHelper)\s*=\s*\[[^\]]+/);
	const iidMatch = html.match(/data-iid="([a-zA-Z0-9.]+)/);
	const igMatch = html.match(/IG:"([a-zA-Z0-9.]+)/);
	if (!helper || !helper[0] || helper[0].length <= 30 || !iidMatch?.[1] || !igMatch?.[1]) {
		return null;
	}
	const parts = helper[0].slice(helper[0].indexOf('[') + 1).split(',');
	const key = parts[0]?.trim();
	const rawToken = parts[1]?.trim();
	if (!key || !parseInt(key, 10) || !rawToken || rawToken.length < 3) {
		return null;
	}
	return {
		ig: igMatch[1],
		iid: iidMatch[1],
		key: String(parseInt(key, 10)),
		token: rawToken.replace(/^["']|["']$/g, '')
	};
}

/** Bing language-code mapping (auto → auto-detect, zh-CN → zh-Hans, …). */
export function mapBingLang(code: string): string {
	switch (code) {
		case 'auto': return 'auto-detect';
		case 'zh': case 'zh-CN': return 'zh-Hans';
		case 'zh-TW': return 'zh-Hant';
		case 'tl': return 'fil';
		case 'no': return 'nb';
		default: return code;
	}
}

/** Google language-code mapping (zh → zh-CN). */
export function mapGoogleLang(code: string): string {
	switch (code) {
		case 'zh': return 'zh-CN';
		default: return code;
	}
}


/**
 * Which origin the Bing ttranslatev3 call must target.
 *
 * The session token is only valid against the host that ISSUED it — and in
 * mainland networks www.bing.com 302s the session page to cn.bing.com. The
 * subtle failure: the settings pane auto-fills the provider's default Base
 * URL (https://www.bing.com) into the preference, so "use apiBaseURL when
 * set" silently overrode the learned cn origin on every install, and the
 * token was posted to the wrong host by construction.
 *
 * Rule: any bing.com host in the user's Base URL means "no real override" —
 * follow the session origin. Only a NON-bing host (a private mirror) is an
 * actual override and wins.
 */
export function resolveBingApiBase(userBaseURL: string | undefined, sessionOrigin: string): string {
	const cleaned = (userBaseURL ?? '').trim().replace(/\/+$/, '');
	if (!cleaned) {
		return sessionOrigin.replace(/\/+$/, '');
	}
	try {
		const host = new URL(cleaned).hostname.toLowerCase();
		if (host === 'bing.com' || host.endsWith('.bing.com')) {
			return sessionOrigin.replace(/\/+$/, '');
		}
	}
	catch {
		// fail-closed (2.0.10, 审核 P3): 非空但解析失败的 base(常见: 漏写
		// scheme 的 `myproxy.internal/bing`)此前被静默当「未覆盖」—— 流量
		// 照旧出网微软,正是 2.0.1「宁可报错也不静默出网」要堵的路径换了个
		// 入口。按用户意图保留原样返回: 随后的 checkEndpointURL 会给出明确
		// 报错,用户看得见配置错了,而不是论文被静默发去官方端点。
		return cleaned;
	}
	return cleaned;
}


/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving
 * result order. The free engines' big latency cost is REQUEST COUNT × round
 * trip, fully serialised — a region split into parts used to await each part
 * before sending the next. A small pool (the same order of parallelism the
 * bing.com page itself uses) collapses a page from ~20 sequential round trips
 * into ~5 waves. The first rejection aborts the pool.
 */
export async function runPool<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed: unknown = null;
	const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		for (;;) {
			if (failed) {
				return;
			}
			const index = next++;
			if (index >= items.length) {
				return;
			}
			try {
				results[index] = await worker(items[index]!, index);
			}
			catch (e) {
				failed = failed ?? e;
				return;
			}
		}
	});
	await Promise.all(lanes);
	if (failed) {
		throw failed;
	}
	return results;
}
