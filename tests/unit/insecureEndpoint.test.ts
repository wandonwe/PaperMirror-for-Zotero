import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEndpointURL } from '../../src/translation/providers/httpClient';
import { getProvider } from '../../src/translation/providers/registry';
import type { ProviderSettings, TranslationRequest } from '../../src/types/models';

/**
 * P1-4 (2.0.1): ollama 此前是 `allowInsecureHTTP: () => true`,忽略入参,
 * 于是「允许 HTTP 端点」首选项对它完全失效 —— 用户把 Base URL 指向公网
 * VPS 就会明文跨网传输论文(配了密钥则连 Bearer 一起明文发)。
 * 默认的 localhost 用法必须不受影响。
 * 这里走真实请求路径:被拒时不应发出任何请求。
 */

const OK = '{"choices":[{"message":{"content":"{\\"translations\\":[{\\"id\\":\\"b0\\",\\"translatedText\\":\\"你好\\"}]}"}}]}';

function installHTTP() {
	const urls: string[] = [];
	(globalThis as Record<string, any>).Zotero = {
		HTTP: {
			request: async (_m: string, u: string) => {
				urls.push(u);
				return { status: 200, responseText: OK, response: null };
			}
		}
	};
	return { urls, teardown: () => { delete (globalThis as Record<string, any>).Zotero; } };
}

const settings = (over: Partial<ProviderSettings & { allowInsecureHTTP?: boolean }> = {}) => ({
	providerId: 'ollama', apiBaseURL: '', apiKey: '', model: 'qwen3.5', timeoutMs: 1000, ...over
}) as ProviderSettings;

const req: TranslationRequest = {
	pageIndex: 0, sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: '',
	previousContext: '', blocks: [{ id: 'b0', type: 'paragraph', text: 'Hello' }]
};

test('ollama 默认 localhost 仍然放行(不得回归)', async () => {
	const http = installHTTP();
	try {
		const p = getProvider('ollama')!;
		const res = await p.translate(req, settings(), {});
		assert.deepEqual(res.translations, [{ id: 'b0', translatedText: '你好' }]);
		assert.equal(http.urls.length, 1, '本地端点应正常发出请求');
		assert.ok(http.urls[0]!.startsWith('http://localhost:11434'), http.urls[0]);
	}
	finally { http.teardown(); }
});

test('ollama 指向公网明文 HTTP 被拒绝, 且一个字节都没发出去', async () => {
	const http = installHTTP();
	try {
		const p = getProvider('ollama')!;
		await assert.rejects(
			() => p.translate(req, settings({ apiBaseURL: 'http://203.0.113.10:11434' }), {}),
			(e: Error & { code?: string }) => {
				assert.equal(e.code, 'HTTP_INSECURE', '必须以 HTTP_INSECURE 拒绝');
				return true;
			});
		assert.equal(http.urls.length, 0, '被拒时不得发出任何请求(论文不能出网)');
	}
	finally { http.teardown(); }
});

test('显式开启「允许 HTTP 端点」后才放行公网明文', async () => {
	const http = installHTTP();
	try {
		const p = getProvider('ollama')!;
		const s = settings({ apiBaseURL: 'http://203.0.113.10:11434' }) as ProviderSettings & { allowInsecureHTTP?: boolean };
		s.allowInsecureHTTP = true;
		await p.translate(req, s, {});
		assert.equal(http.urls.length, 1, '显式放行后应能发出');
	}
	finally { http.teardown(); }
});

test('checkEndpointURL: 回环无条件放行, 公网明文需开关, HTTPS 始终放行', () => {
	for (const u of ['http://localhost:11434/x', 'http://127.0.0.1:11434/x', 'http://[::1]:11434/x']) {
		assert.doesNotThrow(() => checkEndpointURL(u, false), u);
	}
	assert.throws(() => checkEndpointURL('http://203.0.113.10:11434/x', false));
	assert.doesNotThrow(() => checkEndpointURL('http://203.0.113.10:11434/x', true));
	assert.doesNotThrow(() => checkEndpointURL('https://api.example.com/x', false));
});
