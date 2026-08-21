import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJSON } from '../../src/translation/providers/httpClient';
import { PaperMirrorError } from '../../src/types/models';

/**
 * P0-1 (2.0.1): Zotero.HTTP 在 successCodes:false 下对**任何**状态码都 resolve,
 * 包括 XHR 的 status 0(断网/连接被拒/TLS 失败/xhr.abort())。此前这些失败一路
 * 落到 mapHTTPError(0) 的兜底 UNKNOWN{retryable:false},导致:
 *   · 网络错误从不重试,自适应限流收不到反馈;
 *   · 空闲看门狗 abort 后拿到 UNKNOWN 而非 CANCELLED,那句「停滞 150 秒」的
 *     TIMEOUT 转译从未触发。
 * 这里用假 Zotero.HTTP 直接复现 status 0 的两种成因。
 */

function installHTTP(status: number, opts: { onRequest?: (o: any) => void } = {}) {
	(globalThis as Record<string, any>).Zotero = {
		HTTP: {
			request: async (_m: string, _u: string, o: any) => {
				opts.onRequest?.(o);
				return { status, responseText: '', response: null };
			}
		}
	};
	return () => { delete (globalThis as Record<string, any>).Zotero; };
}

test('断网/连接被拒(status 0) → NETWORK 且可重试, 不再是 UNKNOWN', async () => {
	const teardown = installHTTP(0);
	try {
		await assert.rejects(
			() => requestJSON('https://api.example.com/v1/chat', { headers: {}, body: {}, timeoutMs: 1000 }),
			(e: PaperMirrorError) => {
				assert.equal(e.code, 'NETWORK', '必须归为网络错误');
				assert.equal(e.retryable, true, '必须可重试,否则请求级重试完全失效');
				return true;
			});
	}
	finally { teardown(); }
});

test('看门狗 abort 导致的 status 0 → CANCELLED, 而不是 NETWORK/UNKNOWN', async () => {
	// 空闲看门狗调 controller.abort() → xhr.abort() → status 0。
	// 只有映射成 CANCELLED,上层 e.code==='CANCELLED' 的判定才成立,
	// 「停滞 150 秒」的 TIMEOUT 转译才会发生。
	const controller = new AbortController();
	const teardown = installHTTP(0, { onRequest: () => controller.abort() });
	try {
		await assert.rejects(
			() => requestJSON('https://api.example.com/v1/chat',
				{ headers: {}, body: {}, timeoutMs: 1000, signal: controller.signal }),
			(e: PaperMirrorError) => {
				assert.equal(e.code, 'CANCELLED', 'abort 造成的 status 0 必须是 CANCELLED');
				return true;
			});
	}
	finally { teardown(); }
});

test('正常 2xx 与真实 HTTP 错误码不受影响(回归)', async () => {
	let teardown = installHTTP(429);
	try {
		await assert.rejects(
			() => requestJSON('https://api.example.com/v1/chat', { headers: {}, body: {}, timeoutMs: 1000 }),
			(e: PaperMirrorError) => e.code === 'RATE_LIMITED' && e.retryable === true);
	}
	finally { teardown(); }

	teardown = installHTTP(401);
	try {
		await assert.rejects(
			() => requestJSON('https://api.example.com/v1/chat', { headers: {}, body: {}, timeoutMs: 1000 }),
			(e: PaperMirrorError) => e.code === 'INVALID_API_KEY' && e.retryable === false);
	}
	finally { teardown(); }
});
