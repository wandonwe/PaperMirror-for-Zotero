import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReasoning, openaiChatExtras, supportsReasoningControl, isReasoningEffortRejection, reasoningEffortUnsupported, markReasoningEffortUnsupported, isThinkingParamRejection } from '../../src/translation/providers/advancedParams';
import { PaperMirrorError } from '../../src/types/models';
import { resolveChatURL } from '../../src/translation/providers/urls';
import { geminiGenerateURL, geminiGenerationConfig } from '../../src/translation/providers/geminiNative';
import type { ProviderSettings } from '../../src/types/models';

const base = (over: Partial<ProviderSettings>): ProviderSettings => ({
	providerId: 'x', apiBaseURL: '', apiKey: '', model: '', timeoutMs: 1000, ...over
});

test('normalizeReasoning keeps valid levels (incl. xhigh), drops anything else', () => {
	assert.equal(normalizeReasoning('minimal'), 'minimal');
	assert.equal(normalizeReasoning('high'), 'high');
	assert.equal(normalizeReasoning('xhigh'), 'xhigh');
	assert.equal(normalizeReasoning('off'), '');
	assert.equal(normalizeReasoning(undefined), '');
});

test('default temperature 0 for safe providers; openai/openrouter left alone', () => {
	// 温度默认 0(翻译更稳定)— but openai gpt-5.x / openrouter auto-routing only
	// accept the default temperature, so no default is injected there.
	assert.deepEqual(openaiChatExtras(base({}), 'deepseek'), { temperature: 0, thinking: { type: 'disabled' } });
	// 2.12.2: qwen 默认开思考(官方文档明写 qwen3.7-plus 系列),所以它现在还带
	// enable_thinking: false。groq 跑 llama,没有思考,是"只有温度"的干净样本。
	assert.deepEqual(openaiChatExtras(base({}), 'qwen'), { temperature: 0, enable_thinking: false });
	assert.deepEqual(openaiChatExtras(base({}), 'groq'), { temperature: 0 });
	assert.deepEqual(openaiChatExtras(base({}), 'openai'), {});
	assert.deepEqual(openaiChatExtras(base({}), 'openrouter'), {});
});

test('openaiChatExtras: explicit temperature always passes through', () => {
	assert.deepEqual(openaiChatExtras(base({ temperature: 0 }), 'openai'), { temperature: 0 });
	assert.deepEqual(openaiChatExtras(base({ temperature: 0.7 }), 'deepseek'), { temperature: 0.7, thinking: { type: 'disabled' } });
});

test('openaiChatExtras: max tokens key differs for the official OpenAI endpoint', () => {
	assert.deepEqual(openaiChatExtras(base({ maxOutputTokens: 500 }), 'openai'), { max_completion_tokens: 500 });
	assert.deepEqual(
		openaiChatExtras(base({ maxOutputTokens: 500 }), 'deepseek'),
		{ temperature: 0, max_tokens: 500, thinking: { type: 'disabled' } }
	);
	// zero / negative is ignored
	assert.deepEqual(openaiChatExtras(base({ maxOutputTokens: 0 }), 'openai'), {});
});

test('gemini 深度思考 (native adapter): disabled→budget 0, auto→budget -1, default→omitted', () => {
	assert.deepEqual(
		geminiGenerationConfig(base({ reasoning: 'disabled' })),
		{ temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
	);
	assert.deepEqual(
		geminiGenerationConfig(base({ reasoning: 'auto' })),
		{ temperature: 0, thinkingConfig: { thinkingBudget: -1 } }
	);
	assert.deepEqual(geminiGenerationConfig(base({})), { temperature: 0 });
	// json mode + user-set advanced values flow into generationConfig
	assert.deepEqual(
		geminiGenerationConfig(base({ temperature: 0.5, maxOutputTokens: 4096 }), { json: true }),
		{ temperature: 0.5, maxOutputTokens: 4096, responseMimeType: 'application/json' }
	);
	// disabled/auto are Gemini-only vocabulary — OpenAI/OpenRouter never emit them.
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'disabled' }), 'openai'), {});
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'auto' }), 'openrouter'), {});
});

test('gemini native URL: model in the path; custom Base URL / apiPath override', () => {
	assert.equal(
		geminiGenerateURL(base({ model: 'gemini-2.5-flash' })),
		'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
	);
	assert.equal(
		geminiGenerateURL(base({ apiBaseURL: 'https://my-proxy.example', model: 'gemini-2.5-flash-lite' })),
		'https://my-proxy.example/v1beta/models/gemini-2.5-flash-lite:generateContent'
	);
	assert.equal(
		geminiGenerateURL(base({ apiBaseURL: 'https://gw.example', apiPath: '/custom/gemini' })),
		'https://gw.example/custom/gemini'
	);
});

test('reasoning_effort mapping: official levels for OpenAI/OpenRouter only', () => {
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'minimal' }), 'openai'), { reasoning_effort: 'minimal' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'xhigh' }), 'openai'), { reasoning_effort: 'xhigh' });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'low' }), 'openrouter'), { reasoning_effort: 'low' });
	// providers not known to accept it → omitted (never risk a 400)
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'high' }), 'groq'), { temperature: 0 });
	assert.deepEqual(openaiChatExtras(base({ reasoning: 'high' }), 'deepseek'),
		{ temperature: 0, thinking: { type: 'enabled' }, reasoning_effort: 'high' });
});

test('DeepSeek 默认关思考:翻译只要最终译文 (2.12.1)', () => {
	// 真机:同一篇论文里 deepseek 的出 tok/原文字符 = 6.71,而 openai 0.56、
	// gemini 0.44 —— 24661 字原文吐了 165385 个输出 token,约 16 倍于译文本身。
	// 官方文档:「Thinking mode is enabled by default, with the default effort
	// being high」,而我们此前从没发过任何思考参数。
	for (const level of ['', 'disabled', 'auto'] as const) {
		const extras = openaiChatExtras(base(level ? { reasoning: level } : {}), 'deepseek');
		assert.deepEqual(extras.thinking, { type: 'disabled' },
			`reasoning='${level}' 时必须显式关掉 —— 不发等于吃 high 强度的默认思考`);
	}
	// 用户显式要了强度就按他要的来,那是他的决定。
	const ladder: Record<string, string> = {
		minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max'
	};
	for (const [ours, theirs] of Object.entries(ladder)) {
		assert.deepEqual(
			openaiChatExtras(base({ reasoning: ours as never }), 'deepseek'),
			{ temperature: 0, thinking: { type: 'enabled' }, reasoning_effort: theirs },
			`${ours} 应映射到 DeepSeek 的 ${theirs}`);
	}
});

test('supportsReasoningControl: LLM reasoning providers only', () => {
	assert.equal(supportsReasoningControl('openai'), true);
	assert.equal(supportsReasoningControl('gemini'), true);
	assert.equal(supportsReasoningControl('openrouter'), true);
	assert.equal(supportsReasoningControl('anthropic'), true);
	// 2.12.1: DeepSeek 默认开思考,用户必须能在设置里改 —— 改不了就只能吃默认。
	assert.equal(supportsReasoningControl('deepseek'), true);
	assert.equal(supportsReasoningControl('bing-free'), false);
});

test('resolveChatURL: custom apiPath overrides path building', () => {
	assert.equal(
		resolveChatURL('https://api.openai.com', 'https://api.openai.com', false, '/v1/chat/completions'),
		'https://api.openai.com/v1/chat/completions'
	);
	// leading slash added if missing
	assert.equal(resolveChatURL('https://x.example/', 'd', false, 'foo/bar'), 'https://x.example/foo/bar');
	// no apiPath → normal building (adds /v1/chat/completions)
	assert.equal(resolveChatURL('', 'https://api.openai.com', false), 'https://api.openai.com/v1/chat/completions');
});

// ---- 1.1.11: reasoning_effort 拒收自愈 ------------------------------------

test('isReasoningEffortRejection: 只认 400 且 message 带 reasoning_effort', () => {
	const real = new PaperMirrorError('UNKNOWN',
		'Unexpected API response (HTTP 400): {"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}',
		{ httpStatus: 400 });
	assert.equal(isReasoningEffortRejection(real), true);
	// 其它 400 (模型名错) 不算 —— 不该误触发剥参重试
	assert.equal(isReasoningEffortRejection(
		new PaperMirrorError('INVALID_MODEL', 'The API rejected the model name (HTTP 400): no such model', { httpStatus: 400 })), false);
	// 429 / 500 / 非错误都不算
	assert.equal(isReasoningEffortRejection(
		new PaperMirrorError('RATE_LIMITED', 'reasoning_effort mentioned but 429', { httpStatus: 429 })), false);
	assert.equal(isReasoningEffortRejection(new Error('reasoning_effort')), false);
	assert.equal(isReasoningEffortRejection(null), false);
});

test('reasoningEffortUnsupported 注册表: 按 (供应商, 端点, 模型) 记忆, 互不影响', () => {
	const EP = 'https://api.openai.com/v1/chat/completions';
	assert.equal(reasoningEffortUnsupported('openai', EP, 'gpt-4o-unique-a'), false);
	markReasoningEffortUnsupported('openai', EP, 'gpt-4o-unique-a');
	assert.equal(reasoningEffortUnsupported('openai', EP, 'gpt-4o-unique-a'), true);
	// 不牵连同供应商的推理模型, 也不牵连别的供应商
	assert.equal(reasoningEffortUnsupported('openai', EP, 'o3-unique-b'), false);
	assert.equal(reasoningEffortUnsupported('openrouter', EP, 'gpt-4o-unique-a'), false);
	// 端点隔离 (1.3.0): 端点 A 的「不支持」不波及端点 B; 大小写/尾斜杠归一化。
	assert.equal(reasoningEffortUnsupported('openai', 'https://proxy.example.com/v1/chat/completions', 'gpt-4o-unique-a'), false);
	assert.equal(reasoningEffortUnsupported('openai', EP.toUpperCase() + '/', 'gpt-4o-unique-a'), true);
});

// ---- P2-13 (2.0.9): Gemini 禁思考 400 自愈的判定 ----------------------------

test('isThinkingRejection: 只认 400 且提及 thinking/budget 的拒绝', async () => {
	const { isThinkingRejection } = await import('../../src/translation/providers/geminiNative');
	const { PaperMirrorError } = await import('../../src/types/models');
	assert.equal(isThinkingRejection(new PaperMirrorError('UNKNOWN',
		'The API rejected a request parameter (HTTP 400): Budget is not supported for this model.',
		{ httpStatus: 400, retryable: false })), true, 'gemini-2.5-pro 的 budget 拒绝必须命中');
	assert.equal(isThinkingRejection(new PaperMirrorError('UNKNOWN',
		'HTTP 400: thinking is not enabled for this model', { httpStatus: 400 })), true);
	assert.equal(isThinkingRejection(new PaperMirrorError('UNKNOWN',
		'HTTP 400: temperature out of range', { httpStatus: 400 })), false, '别的 400 不得触发剥参');
	assert.equal(isThinkingRejection(new PaperMirrorError('RATE_LIMITED',
		'budget mention but 429', { httpStatus: 429 })), false);
	assert.equal(isThinkingRejection(new Error('budget')), false, '非 PaperMirrorError 不命中');
});

test('gemini 思考自愈也报枚举: onParamHeal("thinking") 一次,成功路径零次 (2.7.9)', async () => {
	const { geminiNativeProvider } = await import('../../src/translation/providers/geminiNative');
	const OK = '{"candidates":[{"content":{"parts":[{"text":"{\\"translations\\":[{\\"id\\":\\"b0\\",\\"translatedText\\":\\"你好\\"}]}"}]}}]}';
	const REJECT = '{"error":{"code":400,"message":"Budget 0 is invalid: thinking is not supported with thinkingBudget for this model","status":"INVALID_ARGUMENT"}}';
	const install = (handler: (body: Record<string, unknown>, n: number) => { status: number; text: string }) => {
		let n = 0;
		const bodies: Record<string, unknown>[] = [];
		(globalThis as Record<string, any>).Zotero = {
			HTTP: {
				request: async (_m: string, _u: string, opts: { body: string }) => {
					const body = JSON.parse(opts.body) as Record<string, unknown>;
					bodies.push(body);
					const { status, text } = handler(body, n++);
					return { status, responseText: text, response: null };
				}
			}
		};
		return { bodies, teardown: () => { delete (globalThis as Record<string, any>).Zotero; } };
	};
	const req = { sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 't', previousContext: '', blocks: [{ id: 'b0', type: 'paragraph' as const, text: 'hello' }], glossary: [] };
	const base = { providerId: 'gemini', apiBaseURL: '', apiKey: 'k', timeoutMs: 1000, reasoning: 'disabled' as const };

	const http = install((body, n) => n === 0 ? { status: 400, text: REJECT } : { status: 200, text: OK });
	try {
		const healed: string[] = [];
		await geminiNativeProvider.translate(req, { ...base, model: 'gemini-heal-enum-test' }, { onParamHeal: p => healed.push(p) });
		assert.deepEqual(healed, ['thinking']);
		assert.equal(http.bodies.length, 2);
	}
	finally { http.teardown(); }

	const http2 = install(() => ({ status: 200, text: OK }));
	try {
		const healed: string[] = [];
		await geminiNativeProvider.translate(req, { ...base, model: 'gemini-no-heal-test' }, { onParamHeal: p => healed.push(p) });
		assert.deepEqual(healed, [], '一次就成的请求不报自愈');
	}
	finally { http2.teardown(); }
});

// ---- 每一家预置 LLM 的思考默认值 (2.12.2) ------------------------------------
//
// 真机第十三轮修好 deepseek 之后(出tok/原字符 6.71 → 0.30,吞吐 65 → 837),
// 照同样的方法把每一家都对着官方文档核了一遍。**四家默认开思考,而我们一个
// 参数都没发过。** 三种关法,发错词汇就是一个 400,所以每家钉死自己的那一种。

test('默认关思考:thinking 对象派 (deepseek / zhipu, 2.12.2)', () => {
	for (const id of ['deepseek', 'zhipu']) {
		assert.deepEqual(openaiChatExtras(base({}), id).thinking, { type: 'disabled' },
			`${id} 默认开思考,不显式关就白烧十几倍的输出 token`);
		assert.ok(!('enable_thinking' in openaiChatExtras(base({}), id)),
			`${id} 用的是 thinking 对象,混进 enable_thinking 就是一个 400`);
	}
});

test('默认关思考:enable_thinking 派 (qwen / siliconflow, 2.12.2)', () => {
	for (const id of ['qwen', 'siliconflow']) {
		const extras = openaiChatExtras(base({}), id);
		assert.equal(extras.enable_thinking, false,
			`${id} 默认开思考(官方文档),必须显式关`);
		assert.ok(!('thinking' in extras), `${id} 用的是顶层布尔,不是 thinking 对象`);
		// 用户要思考就打开。
		assert.equal(openaiChatExtras(base({ reasoning: 'high' }), id).enable_thinking, true);
	}
});

test('关不掉的那家取最低档 (moonshot, 2.12.2)', () => {
	// 官方原话:「You can't — K3 always thinks」,只能调强度,默认是 max。
	assert.equal(openaiChatExtras(base({}), 'moonshot').reasoning_effort, 'low',
		'翻译丢弃思维链,默认 max 是纯浪费');
	assert.equal(openaiChatExtras(base({ reasoning: 'xhigh' }), 'moonshot').reasoning_effort, 'max');
	assert.ok(!('thinking' in openaiChatExtras(base({}), 'moonshot')));
	assert.ok(!('enable_thinking' in openaiChatExtras(base({}), 'moonshot')));
});

test('没中招的几家一个思考字段都不带 (2.12.2)', () => {
	// openai 走 reasoning_effort(本来就是我们这条路);gemini 走原生 thinkingConfig
	// (另一条适配器);anthropic 的扩展思考是 opt-in;groq 跑 llama,没有思考。
	for (const id of ['openai', 'openrouter', 'groq', 'ollama', 'openai-compatible', 'custom']) {
		const extras = openaiChatExtras(base({}), id);
		assert.ok(!('thinking' in extras), `${id} 不该带 thinking`);
		assert.ok(!('enable_thinking' in extras), `${id} 不该带 enable_thinking`);
	}
	// 这几家也不该被塞一个我们自作主张的 reasoning_effort。
	for (const id of ['groq', 'ollama', 'custom']) {
		assert.ok(!('reasoning_effort' in openaiChatExtras(base({}), id)), `${id} 不该带 reasoning_effort`);
	}
});

test('三种关法互斥,每家只发自己的那一种 (2.12.2)', () => {
	const all = ['deepseek', 'zhipu', 'qwen', 'siliconflow', 'moonshot', 'openai', 'groq'];
	for (const id of all) {
		const extras = openaiChatExtras(base({ reasoning: 'high' }), id);
		const used = ['thinking', 'enable_thinking', 'reasoning_effort'].filter(k => k in extras);
		assert.ok(id === 'deepseek' ? used.join(',') === 'thinking,reasoning_effort' : used.length <= 1,
			`${id} 同时发了 ${used.join(' + ')} —— 词汇混用就是一个 400`);
	}
});

test('设置界面给得出思考开关的,正是会思考的那几家 (2.12.2)', () => {
	for (const id of ['deepseek', 'zhipu', 'qwen', 'siliconflow', 'moonshot', 'openai', 'gemini', 'anthropic']) {
		assert.equal(supportsReasoningControl(id), true, `${id} 会思考,用户必须能改`);
	}
	for (const id of ['bing-free', 'google-free', 'deepl']) {
		assert.equal(supportsReasoningControl(id), false, `${id} 没有思考,不该给一个空开关`);
	}
});

test('思考参数被拒能自愈,不把整家打死 (2.12.2)', () => {
	// 按 providerId 放行,但同一个 id 可能指向用户的代理或网关 —— 那些后端见到
	// 不认识的字段会直接 400。与 reasoning_effort 的自愈(1.1.11)同构。
	const rej = (msg: string): unknown =>
		new PaperMirrorError('UNKNOWN', msg, { httpStatus: 400 });
	assert.ok(isThinkingParamRejection(rej('Unrecognized request argument supplied: enable_thinking')));
	assert.ok(isThinkingParamRejection(rej('invalid parameter: thinking')));
	assert.ok(!isThinkingParamRejection(rej('Unrecognized request argument supplied: temperature')));
	assert.ok(!isThinkingParamRejection(new PaperMirrorError('UNKNOWN', 'thinking', { httpStatus: 500 })),
		'只有 400 才是参数被拒 —— 500 是服务端的事,剥字段没用');
});
