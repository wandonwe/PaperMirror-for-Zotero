/**
 * Cache key/entry schema. Pure module (unit-tested).
 *
 * Key components (spec 4.7): attachmentKey, PDF file hash, page index,
 * source language, target language, provider, model, prompt version,
 * custom prompt hash, source text hash.
 *
 * SCHEMA v2 (1.3.0, 缓存一致性审核):
 * - customPromptHash 进入页面键与段落 context —— 用户改自定义提示词后,旧译文
 *   不再命中(此前改了提示词仍读出改前译文)。
 * - promptVersion 由调用方直接传代码常量 PROMPT_VERSION,不再读可持久化的
 *   promptVersion 首选项(prefs.js 固定 1 曾把代码里的 v2 永远压回 v1,提示词
 *   升级从未真正让缓存失效)。
 * - v1 旧条目 schemaVersion 不匹配,读到即删;文件名布局也变了,残留旧文件由
 *   cacheManager 的 sweepStaleCacheFiles 清理。
 *
 * SCHEMA v3 (2.0.2, 审核 P1-10):
 * - glossaryHash 与 noTranslateHash 进入**页面键**。此前只有段落 context 带
 *   glossaryHash —— 而页面缓存是先命中的一层,它的键里没有,于是「改了术语表
 *   要让旧译文失效」这个意图对所有已翻译过的页面完全落空(用户会以为术语表
 *   功能坏了)。不译词列表更彻底: 它改变占位符掩蔽从而改变译文,却两层都不在。
 *
 * SCHEMA v4 (2.0.4, 审核 P2-12):
 * - fnv1a64 第二条 lane 修正。旧公式只混 `(c>>8) ^ (i&0xff)`,ASCII 下
 *   `c>>8 === 0`,h2 完全由字符串**长度**决定 —— 任意两段等长 ASCII 文本
 *   h2 相同,64 位哈希退化为 32 位(实测 40 万等长串中已出现全 64 位碰撞)。
 *   新公式把字符本身与位置一起混入第二条 lane。所有旧哈希值随之改变,
 *   文件名布局不同,故必须提升 schemaVersion 让 sweepStaleCacheFiles
 *   清走旧文件(代价: 每个文档一次全量重译)。
 *
 * SCHEMA v5 (2.0.6, 审核 P3):
 * - settingsHash 进入页面键与段落 context: apiBaseURL / apiPath / reasoning /
 *   maxOutputTokens / temperature / useContext 折叠为一个哈希。这些配置都会
 *   改变译文(不同端点/代理后面可能是不同模型,温度与推理强度直接改变输出,
 *   useContext 改变请求携带的上文),却都不在缓存身份里 —— 改了配置仍命中
 *   改前的译文。文件名布局随之改变,schemaVersion 提升让旧文件被清理
 *   (代价: 每个文档一次全量重译)。
 */

export const CACHE_SCHEMA_VERSION = 5;

export interface CacheKeyParts {
	attachmentKey: string;
	fileHash: string;
	pageIndex: number;
	sourceLanguage: string;
	targetLanguage: string;
	provider: string;
	model: string;
	promptVersion: number;
	/** Hash of the user's custom prompt text ('' hashes too) — part of the
	 *  translation's identity: a different prompt is a different translation. */
	customPromptHash: string;
	/** 术语表与不译词列表的哈希 (v3): 两者都会改变译文,因此都是译文身份的
	 *  一部分。段落 context 早就带 glossaryHash,页面键此前漏了。 */
	glossaryHash: string;
	noTranslateHash: string;
	/** apiBaseURL/apiPath/reasoning/maxOutputTokens/temperature/useContext 的
	 *  折叠哈希 (v5): 这些配置都会改变译文,同为译文身份的一部分。 */
	settingsHash: string;
	sourceTextHash: string;
}

export interface CachedPage {
	schemaVersion: number;
	key: CacheKeyParts;
	createdAt: string;
	translations: { id: string; translatedText: string }[];
}

/** FNV-1a 64-bit — stable, dependency-free content hash for cache keys. */
export function fnv1a64(input: string): string {
	let h1 = 0x811c9dc5 >>> 0; // two 32-bit lanes approximating a 64-bit hash
	let h2 = 0xcbf29ce4 >>> 0;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		// 第二条 lane 必须混入字符本身 (v4, 审核 P2-12): 旧公式只混
		// `(c>>8) ^ (i&0xff)`,ASCII 下 `c>>8 === 0`,h2 只依赖长度。
		// `c*31+i` 让不同字符/不同位置都改变 lane;质数换成 0x01000197
		// 使两条 lane 的乘法常数不同,避免相关性。
		h2 = Math.imul(h2 ^ (((c * 31 + i) & 0xffff) ^ (c >> 8)), 0x01000197) >>> 0;
	}
	return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function hashSourceTexts(texts: string[]): string {
	// '\u0000' as the ESCAPE SEQUENCE, never a literal NUL byte: a raw NUL here
	// made this file binary to Git/grep/formatters (the same defect 1.2.2 fixed
	// in advancedParams.ts). Identical runtime string, normal source file.
	return fnv1a64(texts.join('\u0000'));
}

function sanitizeComponent(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

/**
 * Stable directory name for one attachment+file version.
 * Old file version -> different hash -> different directory, so stale cache
 * is never served (spec: cache invalidated when the file changes).
 */
export function attachmentDirName(attachmentKey: string, fileHash: string): string {
	return `${sanitizeComponent(attachmentKey)}-${sanitizeComponent(fileHash)}`;
}

/**
 * File name for one page's translations under one config.
 * Model/language/provider/prompt (version OR custom text) changes produce a
 * new file.
 */
export function pageFileName(parts: CacheKeyParts): string {
	const config = [
		parts.sourceLanguage,
		parts.targetLanguage,
		parts.provider,
		parts.model || 'default',
		`v${parts.promptVersion}`,
		`p${parts.customPromptHash}`,
		`g${parts.glossaryHash}`,
		`n${parts.noTranslateHash}`,
		`s${parts.settingsHash}`
	].map(sanitizeComponent).join('_');
	return `page-${parts.pageIndex}_${config}_${sanitizeComponent(parts.sourceTextHash)}.json`;
}

export function isValidCachedPage(data: unknown, expected: CacheKeyParts): data is CachedPage {
	if (!data || typeof data !== 'object') {
		return false;
	}
	const page = data as CachedPage;
	if (page.schemaVersion !== CACHE_SCHEMA_VERSION || !page.key || !Array.isArray(page.translations)) {
		return false;
	}
	const k = page.key;
	if (
		k.attachmentKey !== expected.attachmentKey
		|| k.fileHash !== expected.fileHash
		|| k.pageIndex !== expected.pageIndex
		|| k.sourceLanguage !== expected.sourceLanguage
		|| k.targetLanguage !== expected.targetLanguage
		|| k.provider !== expected.provider
		|| k.model !== expected.model
		|| k.promptVersion !== expected.promptVersion
		|| k.customPromptHash !== expected.customPromptHash
		|| k.glossaryHash !== expected.glossaryHash
		|| k.noTranslateHash !== expected.noTranslateHash
		|| k.settingsHash !== expected.settingsHash
		|| k.sourceTextHash !== expected.sourceTextHash
	) {
		return false;
	}
	return page.translations.every(t => t && typeof t.id === 'string' && typeof t.translatedText === 'string');
}

/**
 * 段落级缓存 context: everything that scopes a segment translation EXCEPT the
 * segment content itself (content + languages live in the per-segment hash the
 * manager computes). A provider/model/prompt/custom-prompt/glossary change
 * produces a new context file, so stale segments are never served across
 * config changes.
 */
export interface SegmentContextParts {
	attachmentKey: string;
	fileHash: string;
	provider: string;
	model: string;
	promptVersion: number;
	customPromptHash: string;
	glossaryHash: string;
	/** 不译词列表改变占位符掩蔽,从而改变译文 (v3)。 */
	noTranslateHash: string;
	/** 端点/温度/推理强度/输出上限/useContext 折叠哈希 (v5)。 */
	settingsHash: string;
}

export interface CachedSegments {
	schemaVersion: number;
	context: string;
	segments: Record<string, string>;
}

export function segmentContextHash(parts: SegmentContextParts): string {
	return fnv1a64([
		parts.provider,
		parts.model || 'default',
		`v${parts.promptVersion}`,
		parts.customPromptHash,
		parts.glossaryHash,
		parts.noTranslateHash,
		parts.settingsHash
	].join('\u0000'));
}

export function segmentsFileName(parts: SegmentContextParts): string {
	return `segments-${segmentContextHash(parts)}.json`;
}

export function isValidCachedSegments(data: unknown, expectedContext: string): data is CachedSegments {
	if (!data || typeof data !== 'object') {
		return false;
	}
	const d = data as CachedSegments;
	return d.schemaVersion === CACHE_SCHEMA_VERSION
		&& d.context === expectedContext
		&& !!d.segments && typeof d.segments === 'object';
}
