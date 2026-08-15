import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatibleProvider } from '../../src/translation/providers/openaiCompatible';
import type { ProviderSettings, TranslationRequest } from '../../src/types/models';

/**
 * 1.1.11: a non-reasoning model 400s on reasoning_effort. The adapter must strip
 * that one param, retry once, succeed — and remember the model so the next call
 * omits it up front (no second 400). Uses a fake Zotero.HTTP that records every
 * request body.
 */

function installHTTP(handler: (body: any, count: number) => { status: number; text: string }) {
	const bodies: any[] = [];
	let count = 0;
	(globalThis as Record<string, any>).Zotero = {
		HTTP: {
			request: async (_m: string, _u: string, opts: any) => {
				const body = JSON.parse(opts.body);
				bodies.push(body);
				const { status, text } = handler(body, count++);
				return { status, responseText: text, response: null };
			}
		}
	};
	return { bodies, teardown: () => { delete (globalThis as Record<string, any>).Zotero; } };
}

const REJECT = '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort","type":"invalid_request_error"}}';
const OK_TEXT = '{"choices":[{"message":{"content":"深度解析内容"}}]}';
const OK_JSON = '{"choices":[{"message":{"content":"{\\"translations\\":[{\\"id\\":\\"b0\\",\\"translatedText\\":\\"你好\\"}]}"}}]}';

const settings = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
	providerId: 'openai', apiBaseURL: '', apiKey: 'k', model: 'gpt-4o-retry-test',
	timeoutMs: 1000, reasoning: 'minimal', ...over
});

test('complete (深度解析): 400 on reasoning_effort → strip + retry → success', async () => {
	// First call carries reasoning_effort and is rejected; the retry has it stripped.
	const http = installHTTP((body, n) => body.reasoning_effort !== undefined
		? { status: 400, text: REJECT }
		: { status: 200, text: OK_TEXT });
	try {
		const p = createOpenAICompatibleProvider({ id: 'openai', displayName: 'OpenAI', defaultBaseURL: 'https://api.openai.com', defaultModel: 'gpt-4o' });
		const out = await p.complete!('explain this', settings(), {});
		assert.equal(out, '深度解析内容');
		assert.equal(http.bodies.length, 2, '一次被拒 + 一次重试');
		assert.equal(http.bodies[0].reasoning_effort, 'minimal', '首发带了 reasoning_effort');
		assert.equal(http.bodies[1].reasoning_effort, undefined, '重试剥掉了 reasoning_effort');
	}
	finally { http.teardown(); }
});

test('记忆生效: 同模型的后续请求直接不带 reasoning_effort (不再先 400)', async () => {
	// This model was marked unsupported by the previous test (module-level memory).
	// A fresh request must omit reasoning_effort from the very first call.
	const http = installHTTP((body) => body.reasoning_effort !== undefined
		? { status: 400, text: REJECT }
		: { status: 200, text: OK_TEXT });
	try {
		const p = createOpenAICompatibleProvider({ id: 'openai', displayName: 'OpenAI', defaultBaseURL: 'https://api.openai.com', defaultModel: 'gpt-4o' });
		const out = await p.complete!('again', settings(), {});
		assert.equal(out, '深度解析内容');
		assert.equal(http.bodies.length, 1, '记忆命中 → 只发一次, 无 400 重试');
		assert.equal(http.bodies[0].reasoning_effort, undefined);
	}
	finally { http.teardown(); }
});

test('translate 同样自愈, 且译文正常解析', async () => {
	const http = installHTTP((body) => body.reasoning_effort !== undefined
		? { status: 400, text: REJECT }
		: { status: 200, text: OK_JSON });
	try {
		const p = createOpenAICompatibleProvider({ id: 'openai', displayName: 'OpenAI', defaultBaseURL: 'https://api.openai.com', defaultModel: 'gpt-4o' });
		const req: TranslationRequest = {
			pageIndex: 0, sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: '',
			previousContext: '', blocks: [{ id: 'b0', type: 'paragraph', text: 'Hello' }]
		};
		const res = await p.translate(req, settings({ model: 'gpt-4o-translate-test' }), {});
		assert.deepEqual(res.translations, [{ id: 'b0', translatedText: '你好' }]);
		assert.equal(http.bodies.length, 2);
		assert.equal(http.bodies[1].reasoning_effort, undefined);
	}
	finally { http.teardown(); }
});

test('无 reasoning 设置时该路径完全静默 (不重试, 一次成功)', async () => {
	const http = installHTTP(() => ({ status: 200, text: OK_TEXT }));
	try {
		const p = createOpenAICompatibleProvider({ id: 'openai', displayName: 'OpenAI', defaultBaseURL: 'https://api.openai.com', defaultModel: 'gpt-4o' });
		const out = await p.complete!('x', settings({ reasoning: undefined, model: 'gpt-4o-noreason' }), {});
		assert.equal(out, '深度解析内容');
		assert.equal(http.bodies.length, 1);
		assert.equal(http.bodies[0].reasoning_effort, undefined, '本来就没有 reasoning_effort');
	}
	finally { http.teardown(); }
});

test('非 reasoning_effort 的 400 (模型名错) 照旧抛出, 不吞不重试', async () => {
	const http = installHTTP(() => ({ status: 400, text: '{"error":{"message":"The model `bogus` does not exist"}}' }));
	try {
		const p = createOpenAICompatibleProvider({ id: 'openai', displayName: 'OpenAI', defaultBaseURL: 'https://api.openai.com', defaultModel: 'gpt-4o' });
		await assert.rejects(() => p.complete!('x', settings({ model: 'bogus-model-xyz' }), {}));
		assert.equal(http.bodies.length, 1, '不该重试');
	}
	finally { http.teardown(); }
});

// ---- temperature 的同款自愈 (1.2.6) ------------------------------------------
// 推理模型只接受默认温度: "Unsupported value: 'temperature' does not support 0
// with this model. Only the default (1) value is supported."(用户在深度解析上
// 撞见的原文)。剥掉 temperature 重试一次并记住模型。

const TEMP_REJECT = '{"error":{"message":"Unsupported value: \'temperature\' does not support 0 with this model. Only the default (1) value is supported.","type":"invalid_request_error","param":"temperature"}}';

test('complete (深度解析): 400 on temperature → strip + retry → success', async () => {
	const http = installHTTP((body) => body.temperature !== undefined
		? { status: 400, text: TEMP_REJECT }
		: { status: 200, text: OK_TEXT });
	try {
		// deepseek is in DEFAULT_TEMP_PROVIDERS → temperature 0 by default.
		const p = createOpenAICompatibleProvider({ id: 'deepseek', displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' });
		const out = await p.complete!('explain this', settings({ providerId: 'deepseek', reasoning: undefined, model: 'deepseek-reasoner-temp-test' }), {});
		assert.equal(out, '深度解析内容');
		assert.equal(http.bodies.length, 2, '一次被拒 + 一次重试');
		assert.equal(http.bodies[0].temperature, 0, '首发带了默认 temperature 0');
		assert.equal(http.bodies[1].temperature, undefined, '重试剥掉了 temperature');
	}
	finally { http.teardown(); }
});

test('temperature 记忆生效: 同模型后续请求直接不带 temperature', async () => {
	const http = installHTTP((body) => body.temperature !== undefined
		? { status: 400, text: TEMP_REJECT }
		: { status: 200, text: OK_TEXT });
	try {
		const p = createOpenAICompatibleProvider({ id: 'deepseek', displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' });
		const out = await p.complete!('again', settings({ providerId: 'deepseek', reasoning: undefined, model: 'deepseek-reasoner-temp-test' }), {});
		assert.equal(out, '深度解析内容');
		assert.equal(http.bodies.length, 1, '记忆命中 → 只发一次');
		assert.equal(http.bodies[0].temperature, undefined);
	}
	finally { http.teardown(); }
});

test('双雷区: 先 400 temperature 再 400 reasoning_effort, 各剥一次后成功', async () => {
	const http = installHTTP((body) => {
		if (body.temperature !== undefined) {
			return { status: 400, text: TEMP_REJECT };
		}
		if (body.reasoning_effort !== undefined) {
			return { status: 400, text: REJECT };
		}
		return { status: 200, text: OK_TEXT };
	});
	try {
		// openai-compatible is in DEFAULT_TEMP_PROVIDERS AND we set reasoning —
		// but openai-compatible is NOT a reasoning-effort provider, so use
		// openrouter? openrouter is NOT in DEFAULT_TEMP_PROVIDERS. Force both
		// params via an explicit temperature on openrouter + reasoning.
		const p = createOpenAICompatibleProvider({ id: 'openrouter', displayName: 'OpenRouter', defaultBaseURL: 'https://openrouter.ai/api', defaultModel: 'auto' });
		const out = await p.complete!('x', settings({ providerId: 'openrouter', temperature: 0, reasoning: 'minimal', model: 'or-double-400-test' }), {});
		assert.equal(out, '深度解析内容');
		assert.equal(http.bodies.length, 3, '两次 400 + 一次成功');
		assert.equal(http.bodies[2].temperature, undefined);
		assert.equal(http.bodies[2].reasoning_effort, undefined);
	}
	finally { http.teardown(); }
});
