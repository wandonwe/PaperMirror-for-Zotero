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
