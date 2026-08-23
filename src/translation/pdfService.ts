/**
 * Client for the LOCAL full-document translation service (BabelDOC bridge).
 *
 * Architecture (per the project decision): the plugin does not attempt full
 * PDF re-layout itself. It submits the PDF to a local service that runs
 * BabelDOC / pdf2zh — layout analysis, paragraph translation, adaptive
 * reflow — and gets back a mono (纯译文) and/or dual (双语对照) PDF, which
 * the caller attaches to the Zotero item. The in-reader compare view stays
 * as the instant preview.
 *
 * Privacy hard line: the service URL MUST be loopback. The request carries
 * the user's provider API key (so the bridge can call the configured LLM on
 * their behalf); that key never leaves the machine — a non-localhost URL is
 * rejected outright, no override.
 *
 * Wire contract (implemented by tools/babeldoc_server.py):
 *   POST {base}/translate   JSON TranslateSubmission        -> { task_id }
 *   GET  {base}/status?id=X                                 -> TaskStatus
 *   GET  {base}/result?id=X&kind=mono|dual                  -> { pdf_base64 }
 */

import { PaperMirrorError } from '../types/models';
import { sanitize } from '../security/logSanitizer';
import * as logger from '../utils/logger';

const MODULE = 'pdfService';

export interface PdfServiceProvider {
	kind: 'openai-compatible';
	baseURL: string;
	model: string;
	apiKey: string;
}

export interface TranslateSubmission {
	filename: string;
	pdf_base64: string;
	lang_in: string;
	lang_out: string;
	mono: boolean;
	dual: boolean;
	glossary?: { source: string; target: string }[];
	provider?: PdfServiceProvider;
}

export interface TaskStatus {
	state: 'queued' | 'running' | 'done' | 'error';
	progress?: number;
	message?: string;
}

/** Loopback-only. Anything else is refused — the request carries the API key. */
export function assertLocalServiceURL(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	}
	catch {
		throw new PaperMirrorError('UNKNOWN', `无效的服务地址: ${url}`, { retryable: false });
	}
	const host = parsed.hostname;
	const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
	if (!isLoopback || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		throw new PaperMirrorError(
			'HTTP_INSECURE',
			'完整 PDF 翻译服务必须运行在本机 (localhost)。请求中包含 API 密钥，不允许发往其他主机。',
			{ retryable: false }
		);
	}
	return parsed;
}

/** Uint8Array -> base64, chunked so a 50 MB PDF does not blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

/**
 * 桥接会话令牌与服务端鉴权 (2.1.0, 审核 S2/S3/S4)。
 *
 * 桥接每次启动把随机令牌写进 `<系统临时目录>/papermirror-bridge.token`
 * (0600,仅本用户可读)。插件在**发送密钥之前**必须:
 *  1. 读令牌(读不到 = 桥接没在跑,或不是本用户 → 直接失败,绝不裸发);
 *  2. 用一次性 nonce 向 /handshake 要 HMAC(token, nonce),本地校验 ——
 *     抢占了端口的其他用户进程不知道 token,产不出正确 HMAC,插件据此
 *     判定「对面不是本尊」并中止,密钥永不出手;
 *  3. 之后每个请求都带 X-PaperMirror-Token 头,桥接逐一核验。
 */
const TOKEN_HEADER = 'X-PaperMirror-Token';

/**
 * 旧桥接的可执行提示 (2.1.5): 2.1.0 起插件在发密钥前要求 /handshake 握手鉴权;
 * 升级前的 babeldoc_server.py 既不写令牌文件、也没有 /handshake,于是旧流程
 * 会先撞上「令牌缺失 → 请确认服务正在运行」——而服务其实**正在**运行,只是旧。
 * 这条文案把「在跑但旧」和「没在跑」区分开,直接指向升级动作。
 */
const LEGACY_BRIDGE_MSG =
	'检测到本机有服务在监听该端口,但它缺少 PaperMirror 2.1.0 起的握手鉴权 —— '
	+ '几乎可以确定是**旧版 babeldoc_server.py**。请把它升级到随插件附带的新版'
	+ '(源码包里的 tools/babeldoc_server.py)并重启该服务后重试。'
	+ '(为保护你的 API 密钥,插件不会向未通过握手的服务发送任何请求。)';

/**
 * Map a /handshake probe's HTTP status to a bridge state. Pure (unit-tested):
 *  - null      连接被拒/超时 → 端口上没有服务在听 ('down')
 *  - 404/405/501 端口有服务在应答,但没有 /handshake 接口 → 旧版桥接 ('legacy')
 *  - 其他      有 /handshake(或别的服务占了端口)→ 交由 HMAC 环节判定 ('live')
 */
export function classifyBridgeReachability(status: number | null): 'down' | 'legacy' | 'live' {
	if (status === null) {
		return 'down';
	}
	if (status === 404 || status === 405 || status === 501) {
		return 'legacy';
	}
	return 'live';
}

/** Raw GET that returns the HTTP status (any code) or null on connection failure. */
async function rawGet(url: string, timeoutMs: number): Promise<{ status: number; text: string } | null> {
	const http = (globalThis as Record<string, any>).Zotero?.HTTP;
	if (!http?.request) {
		return null;
	}
	try {
		const response = await http.request('GET', url, {
			responseType: 'text', timeout: timeoutMs, successCodes: false, logBodyLength: 0, noCache: true
		});
		return { status: Number(response?.status ?? 0), text: String(response?.responseText ?? '') };
	}
	catch {
		return null; // connection refused / DNS / timeout → nothing listening
	}
}

async function readBridgeToken(): Promise<string> {
	const tempDir = (PathUtils as unknown as { tempDir: string }).tempDir;
	const path = PathUtils.join(tempDir, 'papermirror-bridge.token');
	try {
		const token = (await IOUtils.readUTF8(path)).trim();
		if (!token) {
			throw new Error('empty token file');
		}
		return token;
	}
	catch {
		throw new PaperMirrorError(
			'UNKNOWN',
			'未找到本地翻译服务的会话令牌。请确认 babeldoc_server.py 正在运行(它会在启动时生成令牌文件)。',
			{ retryable: false }
		);
	}
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const subtle = (globalThis as Record<string, any>).crypto?.subtle;
	if (!subtle) {
		throw new PaperMirrorError('UNKNOWN', 'Web Crypto 不可用,无法验证本地服务身份。', { retryable: false });
	}
	const cryptoKey = await subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await subtle.sign('HMAC', cryptoKey, enc.encode(message));
	return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 常量时间比较十六进制字符串,防时序侧信道。 */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * 发送密钥前验证服务端确实是本尊。冒名者返回错误 HMAC(或 /handshake 缺失)
 * → 抛错,调用方绝不继续提交带密钥的 /translate。
 */
async function verifyBridge(base: string, token: string): Promise<void> {
	const nonceBytes = (globalThis as Record<string, any>).crypto.getRandomValues(new Uint8Array(16)) as Uint8Array;
	const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');
	const probe = await rawGet(`${base}/handshake?nonce=${nonce}`, 15000);
	const verdict = classifyBridgeReachability(probe ? probe.status : null);
	if (verdict === 'down') {
		throw new PaperMirrorError(
			'NETWORK',
			`无法连接本地翻译服务 (${base})。请确认已启动 babeldoc_server.py — 见设置页说明。`,
			{ retryable: true }
		);
	}
	if (verdict === 'legacy') {
		// 端口有服务在应答,但没有 /handshake → 旧版桥接。给可执行的升级提示。
		throw new PaperMirrorError('UNKNOWN', LEGACY_BRIDGE_MSG, { retryable: false });
	}
	if (!probe || probe.status < 200 || probe.status >= 300) {
		throw new PaperMirrorError(
			'NETWORK',
			`本地翻译服务握手返回 HTTP ${probe?.status ?? 0}: ${sanitize(probe?.text ?? '').slice(0, 200)}`,
			{ retryable: false }
		);
	}
	let got = '';
	try {
		got = String((JSON.parse(probe.text || '{}') as { mac?: unknown })?.mac ?? '');
	}
	catch {
		got = '';
	}
	const expected = await hmacSha256Hex(token, nonce);
	if (!got || !timingSafeEqualHex(got, expected)) {
		throw new PaperMirrorError(
			'UNKNOWN',
			'本地翻译服务身份验证失败:握手响应不匹配。可能有其他进程占用了该端口 —— 已中止,未发送任何密钥。',
			{ retryable: false }
		);
	}
}

async function requestJSON(url: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number, token?: string): Promise<any> {
	const http = (globalThis as Record<string, any>).Zotero?.HTTP;
	if (!http?.request) {
		throw new PaperMirrorError('UNKNOWN', 'Zotero.HTTP unavailable.', { retryable: false });
	}
	try {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token) {
			headers[TOKEN_HEADER] = token;
		}
		const response = await http.request(method, url, {
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			responseType: 'text',
			timeout: timeoutMs,
			successCodes: false,
			// PRIVACY: bodies carry the PDF and the API key — never log them.
			logBodyLength: 0,
			noCache: true
		});
		if (response.status < 200 || response.status >= 300) {
			// 先脱敏后截断 (2.0.10, 审核 P3): 端口被非预期服务占用/回显时,片段
			// 会进 UI 胶囊与日志 —— 与 errors.ts P1-5 同一条纪律。
			throw new PaperMirrorError('NETWORK', `本地翻译服务返回 HTTP ${response.status}: ${sanitize(String(response.responseText ?? '')).slice(0, 200)}`, { retryable: false });
		}
		return JSON.parse(String(response.responseText ?? '{}'));
	}
	catch (e) {
		if (e instanceof PaperMirrorError) {
			throw e;
		}
		const message = e instanceof Error ? e.message : String(e);
		throw new PaperMirrorError(
			'NETWORK',
			`无法连接本地翻译服务 (${url})。请确认已启动 babeldoc_server.py — 见设置页说明。原始错误: ${message}`,
			{ retryable: true }
		);
	}
}

export interface FullPdfResult {
	monoBytes: Uint8Array | null;
	dualBytes: Uint8Array | null;
}

export interface ProgressReporter {
	(state: TaskStatus): void;
}

/** Submit, poll to completion, download the result PDFs. */
export async function translateFullPdf(
	serviceURL: string,
	submission: TranslateSubmission,
	onProgress: ProgressReporter,
	options?: { pollMs?: number; overallTimeoutMs?: number }
): Promise<FullPdfResult> {
	const base = assertLocalServiceURL(serviceURL).toString().replace(/\/$/, '');
	const pollMs = options?.pollMs ?? 2000;
	const deadline = Date.now() + (options?.overallTimeoutMs ?? 45 * 60 * 1000);

	// S2/S3/S4 (2.1.0): 读令牌 → 握手验证服务端身份 → 之后才带密钥提交。
	// 旧版桥接不写令牌文件,读取会先失败(2.1.5): 此时探一下端口 —— 有服务在应答
	// 就是「在跑但旧」,给升级提示;真的没在跑才保留「请确认已启动」的原文案。
	let token: string;
	try {
		token = await readBridgeToken();
	}
	catch (tokenErr) {
		const probe = await rawGet(`${base}/handshake?nonce=probe`, 8000);
		if (classifyBridgeReachability(probe ? probe.status : null) !== 'down') {
			throw new PaperMirrorError('UNKNOWN', LEGACY_BRIDGE_MSG, { retryable: false });
		}
		throw tokenErr; // 端口无人应答 → 确实没启动,保留原提示
	}
	await verifyBridge(base, token);

	const submitted = await requestJSON(`${base}/translate`, 'POST', submission, 120000, token);
	const taskId = String(submitted?.task_id ?? '');
	if (!taskId) {
		throw new PaperMirrorError('BAD_RESPONSE', '本地翻译服务未返回任务 ID。', { retryable: false });
	}
	logger.info(MODULE, `Full-PDF task submitted: ${taskId}`);

	for (;;) {
		if (Date.now() > deadline) {
			throw new PaperMirrorError('TIMEOUT', '完整 PDF 翻译超时。长文档可提高超时或检查服务日志。', { retryable: true });
		}
		await new Promise(resolve => setTimeout(resolve, pollMs));
		const status = await requestJSON(`${base}/status?id=${encodeURIComponent(taskId)}`, 'GET', undefined, 30000, token) as TaskStatus;
		onProgress(status);
		if (status.state === 'error') {
			// 桥接侧 message 可能带引擎回显 (2.0.10, 审核 P3): 先脱敏再截断,
			// 桥接自身也已只回传退出码+末行,双保险。
			throw new PaperMirrorError('UNKNOWN', `翻译服务出错: ${sanitize(String(status.message ?? '未知错误')).slice(0, 300)}`, { retryable: true });
		}
		if (status.state === 'done') {
			break;
		}
	}

	const fetchKind = async (kind: 'mono' | 'dual'): Promise<Uint8Array | null> => {
		try {
			const result = await requestJSON(`${base}/result?id=${encodeURIComponent(taskId)}&kind=${kind}`, 'GET', undefined, 300000, token);
			const b64 = String(result?.pdf_base64 ?? '');
			return b64 ? base64ToBytes(b64) : null;
		}
		catch (e) {
			logger.warn(MODULE, `Fetching ${kind} PDF failed`, e);
			return null;
		}
	};
	const monoBytes = submission.mono ? await fetchKind('mono') : null;
	const dualBytes = submission.dual ? await fetchKind('dual') : null;
	if (!monoBytes && !dualBytes) {
		throw new PaperMirrorError('BAD_RESPONSE', '翻译完成但未取到任何 PDF 结果。', { retryable: true });
	}
	return { monoBytes, dualBytes };
}
