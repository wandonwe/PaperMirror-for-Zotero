import { test } from 'node:test';
import assert from 'node:assert/strict';
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
