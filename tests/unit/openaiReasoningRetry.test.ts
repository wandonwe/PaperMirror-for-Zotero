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

test('显式用户温度被拒 → 配置错误浮出, 不静默吞 (1.3.0)', async () => {
	// 用户显式设置的温度被模型拒绝时,这是该浮出的配置错误 —— 只有插件自动加的
	// 默认温度可以静默剥离重试。
	const http = installHTTP((body) => body.temperature !== undefined
		? { status: 400, text: TEMP_REJECT }
		: { status: 200, text: OK_TEXT });
	try {
		const p = createOpenAICompatibleProvider({ id: 'openrouter', displayName: 'OpenRouter', defaultBaseURL: 'https://openrouter.ai/api', defaultModel: 'auto' });
		await assert.rejects(
			() => p.complete!('x', settings({ providerId: 'openrouter', temperature: 0, reasoning: undefined, model: 'or-explicit-temp-test' }), {}),
			(err: Error) => /高级.*温度|温度.*高级/s.test(err.message), '报错必须可操作: 指向高级设置里的温度');
		assert.equal(http.bodies.length, 1, '显式温度不重试');
		assert.equal(http.bodies[0].temperature, 0);
	}
	finally { http.teardown(); }
});

test('温度自愈记忆按端点隔离: 换 baseURL 后重新携带默认温度 (1.3.0)', async () => {
	// deepseek-reasoner-temp-test 已在官方端点上被标记不支持;换一个代理端点,
	// 首发必须重新带上默认 temperature(即会再吃一次 400 → 自愈)。
	const http = installHTTP((body) => body.temperature !== undefined
		? { status: 400, text: TEMP_REJECT }
		: { status: 200, text: OK_TEXT });
	try {
		const p = createOpenAICompatibleProvider({ id: 'deepseek', displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' });
		const out = await p.complete!('x', settings({ providerId: 'deepseek', reasoning: undefined, model: 'deepseek-reasoner-temp-test', apiBaseURL: 'https://proxy.example.com/v1' }), {});
		assert.equal(out, '深度解析内容');
		assert.equal(http.bodies.length, 2, '新端点重新试探 → 一次 400 + 一次重试');
		assert.equal(http.bodies[0].temperature, 0, '新端点首发仍带默认温度');
	}
	finally { http.teardown(); }
});

test('非「不支持参数」形态的 temperature 400 (类型/越界) 照旧抛出 (1.3.0)', async () => {
	const http = installHTTP(() => ({ status: 400, text: '{"error":{"message":"Invalid type for temperature: expected number, got string","type":"invalid_request_error"}}' }));
	try {
		const p = createOpenAICompatibleProvider({ id: 'deepseek', displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' });
		await assert.rejects(() => p.complete!('x', settings({ providerId: 'deepseek', reasoning: undefined, model: 'deepseek-badtemp-test' }), {}));
		assert.equal(http.bodies.length, 1, '配置错误不重试不吞');
	}
	finally { http.teardown(); }
});
