import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalServiceURL, base64ToBytes, bytesToBase64, classifyBridgeReachability } from '../../src/translation/pdfService';

test('only loopback service URLs are accepted', () => {
	assert.ok(assertLocalServiceURL('http://127.0.0.1:11017'));
	assert.ok(assertLocalServiceURL('http://localhost:9999/'));
	assert.ok(assertLocalServiceURL('https://[::1]:8443'));
	// The request carries the API key: any remote host is refused outright.
	assert.throws(() => assertLocalServiceURL('http://192.168.1.5:11017'));
	assert.throws(() => assertLocalServiceURL('https://api.example.com'));
	assert.throws(() => assertLocalServiceURL('ftp://127.0.0.1'));
	assert.throws(() => assertLocalServiceURL('not a url'));
});

test('classifyBridgeReachability separates not-running / legacy / live (2.1.5)', () => {
	// Nothing listening → connection failed (null status).
	assert.equal(classifyBridgeReachability(null), 'down');
	// A pre-2.1.0 bridge is listening but has no /handshake route.
	assert.equal(classifyBridgeReachability(404), 'legacy');
	assert.equal(classifyBridgeReachability(405), 'legacy');
	assert.equal(classifyBridgeReachability(501), 'legacy');
	// A 2.1.0+ bridge answers /handshake → let the HMAC step decide.
	assert.equal(classifyBridgeReachability(200), 'live');
	assert.equal(classifyBridgeReachability(500), 'live'); // a real error, not a missing route
});

test('base64 round-trips arbitrary bytes, including chunk boundaries', () => {
	const sizes = [0, 1, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 100000];
	for (const size of sizes) {
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) {
			bytes[i] = (i * 31 + 7) & 0xff;
		}
		const round = base64ToBytes(bytesToBase64(bytes));
		assert.equal(round.length, size);
		assert.deepEqual(Array.from(round.slice(0, 64)), Array.from(bytes.slice(0, 64)));
		assert.deepEqual(Array.from(round.slice(-64)), Array.from(bytes.slice(-64)));
	}
});
