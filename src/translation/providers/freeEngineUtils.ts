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
			for (let i = 0; i < sentence.length; i += maxLen) {
				chunks.push(sentence.slice(i, i + maxLen));
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
