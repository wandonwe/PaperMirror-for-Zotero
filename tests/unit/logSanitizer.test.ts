import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, sanitizeHeaders, registerSecret, clearSecrets } from '../../src/security/logSanitizer';

test('redacts Anthropic-style keys', () => {
	const out = sanitize('using key sk-ant-abcdef0123456789 now');
	assert.ok(!out.includes('sk-ant-abcdef0123456789'));
	assert.ok(out.includes('[REDACTED]'));
});

test('redacts OpenAI-style bearer tokens', () => {
	const out = sanitize('Authorization: Bearer sk-abcdef0123456789ABCDEF');
	assert.ok(!out.includes('sk-abcdef0123456789ABCDEF'));
});

test('redacts x-api-key header value but keeps the name', () => {
	const out = sanitize('x-api-key: verysecretvalue12345');
	assert.ok(!out.includes('verysecretvalue12345'));
});

test('redacts a registered runtime secret and DeepL uuid', () => {
	clearSecrets();
	registerSecret('MY-CUSTOM-SECRET-TOKEN');
	const out = sanitize('key=MY-CUSTOM-SECRET-TOKEN and 12345678-1234-1234-1234-123456789abc:fx');
	assert.ok(!out.includes('MY-CUSTOM-SECRET-TOKEN'));
	assert.ok(!out.includes('123456789abc'));
	clearSecrets();
});

test('sanitizeHeaders drops every value', () => {
	const out = sanitizeHeaders({ Authorization: 'Bearer x', 'Content-Type': 'application/json' });
	assert.equal(out.Authorization, '[REDACTED]');
	assert.equal(out['Content-Type'], '[REDACTED]');
});

test('sanitize handles Error objects', () => {
	const out = sanitize(new Error('boom sk-ant-secret000000000'));
	assert.ok(!out.includes('sk-ant-secret000000000'));
});
