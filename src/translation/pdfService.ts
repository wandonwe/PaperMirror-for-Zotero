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

async function requestJSON(url: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number): Promise<any> {
	const http = (globalThis as Record<string, any>).Zotero?.HTTP;
	if (!http?.request) {
		throw new PaperMirrorError('UNKNOWN', 'Zotero.HTTP unavailable.', { retryable: false });
	}
	try {
		const response = await http.request(method, url, {
			headers: { 'Content-Type': 'application/json' },
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

	const submitted = await requestJSON(`${base}/translate`, 'POST', submission, 120000);
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
		const status = await requestJSON(`${base}/status?id=${encodeURIComponent(taskId)}`, 'GET', undefined, 30000) as TaskStatus;
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
			const result = await requestJSON(`${base}/result?id=${encodeURIComponent(taskId)}&kind=${kind}`, 'GET', undefined, 300000);
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
