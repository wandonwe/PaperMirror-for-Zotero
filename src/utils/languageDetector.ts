/**
 * Lightweight language detection for deciding the default translation
 * direction. Pure module (unit-tested).
 *
 * Chinese text -> translate to English; everything else -> zh-CN.
 */

export type DetectedLanguage = 'zh' | 'en' | 'other';

const CJK_RANGES: [number, number][] = [
	[0x4e00, 0x9fff], // CJK Unified Ideographs
	[0x3400, 0x4dbf], // Extension A
	[0xf900, 0xfaff], // Compatibility Ideographs
	[0x20000, 0x2a6df] // Extension B
];

function isCJK(codePoint: number): boolean {
	for (const [lo, hi] of CJK_RANGES) {
		if (codePoint >= lo && codePoint <= hi) {
			return true;
		}
	}
	return false;
}

export interface LanguageStats {
	cjk: number;
	latin: number;
	total: number;
	cjkRatio: number;
}

export function analyze(text: string): LanguageStats {
	let cjk = 0;
	let latin = 0;
	let total = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) {
			continue;
		}
		// Skip whitespace, digits and common punctuation — they carry no signal
		if (/\s|\d|[\p{P}\p{S}]/u.test(ch)) {
			continue;
		}
		total++;
		if (isCJK(cp)) {
			cjk++;
		}
		else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) {
			latin++;
		}
	}
	return { cjk, latin, total, cjkRatio: total > 0 ? cjk / total : 0 };
}

export function detectLanguage(text: string): DetectedLanguage {
	const stats = analyze(text);
	if (stats.total < 4) {
		return 'other';
	}
	// Chinese chars are information-dense; even 25% CJK means a Chinese document
	if (stats.cjkRatio >= 0.25) {
		return 'zh';
	}
	if (stats.latin / Math.max(1, stats.total) >= 0.5) {
		return 'en';
	}
	return 'other';
}

/**
 * Default direction rule from the spec:
 * - Chinese source  -> English
 * - everything else -> Simplified Chinese
 */
export function defaultTargetFor(source: DetectedLanguage): 'en' | 'zh-CN' {
	return source === 'zh' ? 'en' : 'zh-CN';
}

export function sourceCodeFor(source: DetectedLanguage): string {
	switch (source) {
		case 'zh': return 'zh';
		case 'en': return 'en';
		default: return 'auto';
	}
}
