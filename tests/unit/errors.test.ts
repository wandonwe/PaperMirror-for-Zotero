import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret } from '../../src/security/logSanitizer';
import { mapHTTPError, mapFetchFailure } from '../../src/translation/errors';
import { PaperMirrorError } from '../../src/types/models';

test('401/403 -> INVALID_API_KEY, not retryable', () => {
	assert.equal(mapHTTPError(401).code, 'INVALID_API_KEY');
	assert.equal(mapHTTPError(403).retryable, false);
});

test('404 -> INVALID_MODEL', () => {
	assert.equal(mapHTTPError(404).code, 'INVALID_MODEL');
});

test('429 -> RATE_LIMITED and retryable, unless quota text present', () => {
	assert.equal(mapHTTPError(429).code, 'RATE_LIMITED');
	assert.equal(mapHTTPError(429).retryable, true);
	assert.equal(mapHTTPError(429, 'insufficient_quota billing').code, 'QUOTA_EXCEEDED');
	assert.equal(mapHTTPError(429, 'insufficient_quota').retryable, false);
});

test('402 -> QUOTA_EXCEEDED', () => {
	assert.equal(mapHTTPError(402).code, 'QUOTA_EXCEEDED');
});

test('5xx -> NETWORK and retryable', () => {
	assert.equal(mapHTTPError(503).code, 'NETWORK');
	assert.equal(mapHTTPError(503).retryable, true);
});

test('abort -> CANCELLED', () => {
	const e = mapFetchFailure(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
	assert.equal(e.code, 'CANCELLED');
});

test('timeout -> TIMEOUT retryable', () => {
	const e = mapFetchFailure(new Error('request timed out'));
	assert.equal(e.code, 'TIMEOUT');
	assert.equal(e.retryable, true);
});

test('passes through existing PaperMirrorError', () => {
	const original = new PaperMirrorError('QUOTA_EXCEEDED', 'x');
	assert.equal(mapFetchFailure(original), original);
});

// ---- HTTP transport selection & privacy -------------------------------------

test('httpClient prefers Zotero.HTTP and never logs request bodies', async () => {
	const { requestJSON } = await import('../../src/translation/providers/httpClient');
	const calls: { method: string; url: string; options: Record<string, unknown> }[] = [];
	(globalThis as Record<string, any>).Zotero = {
		HTTP: {
			request: async (method: string, url: string, options: Record<string, unknown>) => {
				calls.push({ method, url, options });
				return { status: 200, responseText: '{"ok":true}', response: null };
			}
		}
	};
	try {
		const result = await requestJSON('https://api.example.com/v1/chat/completions', {
			headers: { 'Content-Type': 'application/json' },
			body: { secret: 'paper text' },
			timeoutMs: 1234
		});
		assert.deepEqual(result.json, { ok: true });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.method, 'POST');
		// PRIVACY: request bodies must never reach Zotero's debug log
		assert.equal(calls[0]!.options.logBodyLength, 0);
		// We map status codes ourselves
		assert.equal(calls[0]!.options.successCodes, false);
		assert.equal(calls[0]!.options.timeout, 1234);
	}
	finally {
		delete (globalThis as Record<string, any>).Zotero;
	}
});

test('httpClient maps non-2xx from Zotero.HTTP to typed errors', async () => {
	const { requestJSON } = await import('../../src/translation/providers/httpClient');
	(globalThis as Record<string, any>).Zotero = {
		HTTP: { request: async () => ({ status: 401, responseText: 'bad key', response: null }) }
	};
	try {
		await assert.rejects(
			requestJSON('https://api.example.com/v1/x', { headers: {}, body: {}, timeoutMs: 100 }),
			(e: unknown) => e instanceof PaperMirrorError && e.code === 'INVALID_API_KEY'
		);
	}
	finally {
		delete (globalThis as Record<string, any>).Zotero;
	}
});

test('httpClient still refuses insecure HTTP endpoints', async () => {
	const { requestJSON } = await import('../../src/translation/providers/httpClient');
	await assert.rejects(
		requestJSON('http://example.com/v1/x', { headers: {}, body: {}, timeoutMs: 100 }),
		(e: unknown) => e instanceof PaperMirrorError && e.code === 'HTTP_INSECURE'
	);
});

// ---- 参数被拒的 400 不再被误标为「模型名被拒」 (1.3.1) -------------------------

test('temperature 拒绝语含 "with this model" 也不再归为 INVALID_MODEL', () => {
	const e = mapHTTPError(400, `{"error":{"message":"Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.","param":"temperature"}}`);
	assert.notEqual(e.code, 'INVALID_MODEL');
	assert.ok(/request parameter/i.test(e.message), '按参数被拒描述');
	assert.ok(/temperature/i.test(e.message), '原始片段保留 (自愈匹配依赖它)');
	assert.equal(e.httpStatus, 400);
});

test('reasoning_effort 的 Unrecognized argument 同样归为参数被拒', () => {
	const e = mapHTTPError(400, '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}');
	assert.notEqual(e.code, 'INVALID_MODEL');
	assert.ok(/reasoning_effort/i.test(e.message));
});

test('真正的模型名 400 仍归 INVALID_MODEL', () => {
	const e = mapHTTPError(400, '{"error":{"message":"The model `bogus-x` does not exist or you do not have access to it."}}');
	assert.equal(e.code, 'INVALID_MODEL');
});

// ---- P0-1: 传输层失败(status 0)不是"不可重试的 UNKNOWN" (2.0.1) --------------

test('status 0 / 负数 → NETWORK 且可重试(二道防线)', () => {
	for (const s of [0, -1]) {
		const e = mapHTTPError(s, '');
		assert.equal(e.code, 'NETWORK', `status ${s} 必须是 NETWORK`);
		assert.equal(e.retryable, true, `status ${s} 必须可重试`);
	}
});

test('正常 HTTP 状态码分类不受 status-0 分支影响(回归)', () => {
	assert.equal(mapHTTPError(401, '').code, 'INVALID_API_KEY');
	assert.equal(mapHTTPError(404, '').code, 'INVALID_MODEL');
	assert.equal(mapHTTPError(429, '').code, 'RATE_LIMITED');
	assert.equal(mapHTTPError(402, '').code, 'QUOTA_EXCEEDED');
	assert.equal(mapHTTPError(500, '').code, 'NETWORK');
	assert.equal(mapHTTPError(400, 'The model `x` does not exist').code, 'INVALID_MODEL');
});

// ---- P1-5: 响应体片段脱敏后才进 error.message (2.0.1) ------------------------

test('网关回显的密钥不会进入 error.message(UI 会直接显示它)', () => {
	// 自建中转网关令牌过期常返回 400 且回显密钥
	const e1 = mapHTTPError(400, '{"error":{"message":"invalid token: sk-abcdefghijklmnopqrstuvwxyz123456"}}');
	assert.ok(!/abcdefghijklmnop/.test(e1.message), 'sk- 模式必须被脱敏');
	const e2 = mapHTTPError(400, '{"error":{"message":"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9payload"}}');
	assert.ok(!/eyJhbGciOiJIUzI1NiJ9payload/.test(e2.message), 'Bearer 令牌必须被脱敏');
	const e3 = mapHTTPError(400, '{"api_key":"abcd1234efgh5678ijkl"}');
	assert.ok(!/abcd1234efgh5678ijkl/.test(e3.message), 'api_key 字段必须被脱敏');
});

test('运行时注册的真实密钥也被脱敏', () => {
	registerSecret('sk-proj-UNIQUEKEYFORTEST0987654321');
	const e = mapHTTPError(400, 'rejected: sk-proj-UNIQUEKEYFORTEST0987654321 is expired');
	assert.ok(!/UNIQUEKEYFORTEST/.test(e.message));
	assert.ok(/REDACTED/.test(e.message), '应留下 [REDACTED] 痕迹便于排查');
});

test('脱敏不影响无密钥的诊断信息可读性', () => {
	const e = mapHTTPError(400, 'Unsupported value: temperature does not support 0 with this model');
	assert.ok(/temperature/.test(e.message), '参数名必须保留,自愈匹配依赖它');
});
