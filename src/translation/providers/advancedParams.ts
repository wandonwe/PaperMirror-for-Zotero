/**
 * Per-provider advanced request parameters (Bob-style), all opt-in.
 *
 * Every field is only emitted when the user has explicitly set it, so a profile
 * that touches none of them produces a request body identical to before — zero
 * regression. Each vendor names these differently, so the mapping lives here in
 * one pure, unit-tested place.
 *
 * Reasoning/thinking: for TRANSLATION you usually want it MINIMAL/OFF (faster,
 * cheaper, avoids reasoning eating the output). Support differs by vendor, so
 * `reasoning_effort` is only emitted for providers known to accept it; on others
 * the setting is ignored rather than risking a 400.
 */

import type { ProviderSettings } from '../../types/models';
import { PaperMirrorError } from '../../types/models';

/**
 * 'minimal'…'xhigh' are OpenAI-style effort levels; 'disabled'/'auto' are the
 * Gemini-style 深度思考 switch (禁用思考 / 自动思考) — Gemini's control is a
 * toggle, not an effort ladder, so it gets its own values and its own UI.
 */
export type ReasoningLevel = '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'disabled' | 'auto';

/** OpenAI-compatible providers whose chat endpoint accepts `reasoning_effort`.
 *  Values follow OpenAI's official levels (minimal/low/medium/high/xhigh —
 *  xhigh exists on gpt-5.4+; unsupported levels are the model's own 400).
 *  Gemini is NOT here anymore: it runs on the native generateContent API and
 *  handles 深度思考 via thinkingConfig in its own adapter (geminiNative). */
const REASONING_EFFORT_PROVIDERS = new Set(['openai', 'openrouter']);

/**
 * DeepSeek 的思考模式 (2.12.1, 真机第十三轮)。
 *
 * ## 证据
 *
 * 同一篇论文、同一个翻译任务,按服务商拆开算输出 token:
 *
 *   | 服务商   | 出 tok / 原文字符 | 出 tok / 入 tok |
 *   |----------|-------------------|-----------------|
 *   | deepseek | **6.71**          | **5.92**        |
 *   | openai   | 0.56              | 0.40            |
 *   | gemini   | 0.44              | 0.60            |
 *
 * 24661 字原文吐了 **165385 个输出 token** —— 中文译文本身大约只值 10000。
 * 它在生成约 16 倍于译文的内容,而那些内容全部被丢弃(我们只取最终答案)。
 * 实测吞吐因此只有 65 字符/秒,是 openai 的 1/5、google-free 的 1/100;
 * 单个请求中位 22 秒、最长 73 秒。**不是网络慢,是在思考。**
 *
 * ## 根因
 *
 * DeepSeek 官方文档:「Thinking mode is enabled by default, with the default
 * effort being `high`」。而 `REASONING_EFFORT_PROVIDERS` 只含 openai /
 * openrouter —— 我们**从来没给 deepseek 发过任何思考相关的参数**,于是一直
 * 吃着 high 强度的默认思考。
 *
 * 同一份文档还说明:thinking 模式下 `temperature` **无效**。也就是我们给
 * deepseek 发的 `temperature: 0`(翻译要确定性)一直被忽略 —— 关掉思考之后
 * 它才真的生效。
 *
 * ## 取舍
 *
 * 翻译不需要思维链:我们只要最终译文,推理过程读都不读。默认关掉。
 * 用户在高级设置里显式要了思考强度,就按他要的发 —— 那是他的决定。
 */
/* 真机第十三轮之后,照 deepseek 的做法把每一家预置 LLM 都对着官方文档核了一遍。
 * 结论:**四家默认开思考,而我们一个参数都没发过。** 三种关法,不能混用 ——
 * 发错词汇就是一个 400。
 *
 *   thinking 对象      deepseek (thinking.type=enabled|disabled + reasoning_effort)
 *                      zhipu    (GLM-5 默认"自适应思考",官方:必须跳过就显式
 *                                设 thinking.type=disabled)
 *   enable_thinking    qwen     (官方明写 qwen3.7-plus 系列"thinking enabled
 *                                by default";我们的默认型号正是它)
 *                      siliconflow (默认型号就是 DeepSeek-V4-Flash,同一个模型)
 *   关不掉,只能调低    moonshot (官方原话:「You can't — K3 always thinks」,
 *                                只能把 reasoning_effort 从默认的 max 降下来)
 *
 * 没有中招的:openai(reasoning_effort 本来就走我们这条路)、gemini(原生
 * thinkingConfig,另一条适配器)、anthropic(扩展思考是 opt-in,不发就不思考)、
 * groq(llama,无思考)、openrouter(按路由决定,不替它猜)。
 */
const THINKING_OBJECT_PROVIDERS = new Set(['deepseek', 'zhipu']);

/** 顶层布尔 `enable_thinking`(阿里 DashScope / SiliconFlow 的词汇)。 */
const ENABLE_THINKING_PROVIDERS = new Set(['qwen', 'siliconflow']);

/** 思考关不掉,只能调强度 —— 翻译一律取最低档。 */
const ALWAYS_THINKS_PROVIDERS = new Set(['moonshot']);

/** 我们的强度阶梯 → DeepSeek 的 none/low/high/max。 */
function deepseekEffort(level: ReasoningLevel): string | null {
	switch (level) {
		case 'minimal': case 'low': return 'low';
		case 'medium': case 'high': return 'high';
		case 'xhigh': return 'max';
		default: return null; // '' / disabled / auto → 不开思考
	}
}

/** Providers where a DEFAULT temperature 0 is safe (translation-stable).
 *  Excluded: 'openai' (gpt-5.x reasoning models accept only the default
 *  temperature) and 'openrouter' (auto-routing may land on such a model).
 *  An EXPLICIT user-set temperature is always sent regardless. */
const DEFAULT_TEMP_PROVIDERS = new Set([
	'deepseek', 'moonshot', 'qwen', 'zhipu', 'siliconflow', 'groq',
	'ollama', 'openai-compatible', 'custom'
]);

export function normalizeReasoning(v: string | undefined): ReasoningLevel {
	return v === 'minimal' || v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh'
		|| v === 'disabled' || v === 'auto' ? v : '';
}

/**
 * Extra body fields to merge into an OpenAI-compatible chat request for this
 * provider, given the user's advanced settings.
 */
export function openaiChatExtras(settings: ProviderSettings, providerId: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)) {
		out.temperature = settings.temperature;
	}
	else if (DEFAULT_TEMP_PROVIDERS.has(providerId)) {
		// 温度默认 0: deterministic output suits translation best.
		out.temperature = 0;
	}
	if (typeof settings.maxOutputTokens === 'number' && settings.maxOutputTokens > 0) {
		// gpt-5.x rejects max_tokens on the official OpenAI endpoint.
		const key = providerId === 'openai' ? 'max_completion_tokens' : 'max_tokens';
		out[key] = Math.floor(settings.maxOutputTokens);
	}
	const eff = normalizeReasoning(settings.reasoning);
	if (eff && eff !== 'disabled' && eff !== 'auto' && REASONING_EFFORT_PROVIDERS.has(providerId)) {
		// OpenAI/OpenRouter take the official effort ladder only; the Gemini
		// 深度思考 vocabulary (disabled/auto) never leaves the native adapter.
		out.reasoning_effort = eff;
	}
	const level = deepseekEffort(eff);
	if (THINKING_OBJECT_PROVIDERS.has(providerId)) {
		// 默认关闭(见上方证据):翻译只要最终译文,而它们默认就思考,
		// 输出 token 是译文的十几倍 —— 时间和钱都白烧。
		out.thinking = level ? { type: 'enabled', reasoning_effort: level } : { type: 'disabled' };
	}
	else if (ENABLE_THINKING_PROVIDERS.has(providerId)) {
		out.enable_thinking = level !== null;
	}
	else if (ALWAYS_THINKS_PROVIDERS.has(providerId)) {
		// 关不掉就取最低档。默认是 max —— 对翻译是纯浪费。
		out.reasoning_effort = level ?? 'low';
	}
	return out;
}

/** True when this provider's UI should offer reasoning/thinking control.
 *  (Gemini qualifies via its native thinkingConfig, not reasoning_effort.) */
export function supportsReasoningControl(providerId: string): boolean {
	return REASONING_EFFORT_PROVIDERS.has(providerId) || THINKING_OBJECT_PROVIDERS.has(providerId)
		|| ENABLE_THINKING_PROVIDERS.has(providerId) || ALWAYS_THINKS_PROVIDERS.has(providerId)
		|| providerId === 'anthropic' || providerId === 'gemini';
}

/**
 * 非推理模型拒收 reasoning_effort 的自愈 (1.1.11):
 *
 * REASONING_EFFORT_PROVIDERS 是按「供应商」放行的,但同一供应商下有推理模型
 * (o 系列 / gpt-5.x) 也有非推理模型 (gpt-4o / gpt-4.1),以及大量只是「OpenAI
 * 兼容」的自建端点 —— 后两类会对 reasoning_effort 直接回
 * HTTP 400「Unrecognized request argument supplied: reasoning_effort」。用户在
 * 「深度解析」上撞见的正是它(翻译走同一条 openaiChatExtras,同样会中招)。
 *
 * 判据在 mapHTTPError 之后仍然可用: 400 且未命中 model 分支时落到 UNKNOWN,
 * 错误 message 里带着响应体前 200 字符,reasoning_effort 就在其中。识别出来后
 * 调用方剥掉该参数重试一次,并把「这个模型不支持」记下来,后续请求直接不发,
 * 避免每次都先 400 再重试。仅按模型标记,不影响同供应商下真正的推理模型。
 */
export function isReasoningEffortRejection(e: unknown): boolean {
	return e instanceof PaperMirrorError
		&& e.httpStatus === 400
		&& (e.rejectedParam === 'reasoning_effort' || /reasoning_effort/i.test(e.message ?? ''));
}

/**
 * 思考参数被拒的自愈 (2.12.2)。
 *
 * `thinking` / `enable_thinking` 都是各家自己的非标准字段。我们按 providerId
 * 放行,但同一个 id 可能指向用户的代理或网关 —— 那些后端见到不认识的字段会
 * 直接 400。`reasoning_effort` 早就有这条自愈路径(1.1.11),这两个字段同理:
 * 认出来 → 剥掉重试一次 → 记下,后续不再发。
 */
export function isThinkingParamRejection(e: unknown): boolean {
	return e instanceof PaperMirrorError
		&& e.httpStatus === 400
		// `rejectedParam` 是一个受限联合(temperature / reasoning_effort / model /
		// other),没有这两个字段的取值 —— 按 message 识别,与 reasoning_effort
		// 那条自愈的兜底判据同构(错误消息里带着响应体前 200 字符)。
		&& /\b(thinking|enable_thinking)\b/i.test(e.message ?? '');
}

const thinkingParamUnsupportedModels = new Set<string>();

export function markThinkingParamUnsupported(providerId: string, endpoint: string, model: string): void {
	thinkingParamUnsupportedModels.add(modelKey(providerId, endpoint, model));
}

export function thinkingParamUnsupported(providerId: string, endpoint: string, model: string): boolean {
	return thinkingParamUnsupportedModels.has(modelKey(providerId, endpoint, model));
}

const reasoningEffortUnsupportedModels = new Set<string>();

/**
 * 记忆键按端点隔离 (1.3.0, 审核 P2): 同一 providerId + 模型名可能连接官方 API、
 * 用户代理、本地兼容端点等完全不同的后端 —— 端点 A 不支持某参数,不能让端点 B
 * 在本会话里也不再发送。endpoint 传归一化后的请求 URL(小写、去尾斜杠),
 * 自然覆盖 baseURL 与 API path 的差异。
 */
export function normalizeEndpoint(url: string): string {
	return (url || '').trim().toLowerCase().replace(/\/+$/, '');
}

const modelKey = (providerId: string, endpoint: string, model: string): string =>
	JSON.stringify([providerId, normalizeEndpoint(endpoint), model]);

/** Has this (provider, endpoint, model) already 400'd on reasoning_effort this session? */
export function reasoningEffortUnsupported(providerId: string, endpoint: string, model: string): boolean {
	return reasoningEffortUnsupportedModels.has(modelKey(providerId, endpoint, model));
}

/** Remember that this (provider, endpoint, model) rejects reasoning_effort, so
 *  future requests omit it up front instead of eating a 400 + retry every time. */
export function markReasoningEffortUnsupported(providerId: string, endpoint: string, model: string): void {
	reasoningEffortUnsupportedModels.add(modelKey(providerId, endpoint, model));
}

/**
 * temperature 的同款自愈 (1.2.6, 与 1.1.11 的 reasoning_effort 完全同构):
 *
 * DEFAULT_TEMP_PROVIDERS 会默认发 temperature: 0(翻译求确定性),显式设置的
 * 温度也走同一字段。但推理模型(gpt-5.x / o 系列,以及各家「OpenAI 兼容」
 * 端点背后路由到的推理模型)只接受默认温度,直接回 HTTP 400「Unsupported
 * value: 'temperature' does not support 0 with this model. Only the default
 * (1) value is supported.」——用户在「深度解析」上撞见的正是它(翻译走同一条
 * openaiChatExtras,同样会中招)。识别后剥掉 temperature 重试一次,并按
 * (provider, model) 记住,后续请求直接不发,避免每次先 400 再重试。
 */
export function isTemperatureRejection(e: unknown): boolean {
	if (!(e instanceof PaperMirrorError) || e.httpStatus !== 400) {
		return false;
	}
	if (e.rejectedParam === 'temperature') {
		return true; // 2.7.5: mapHTTPError 已归类,message 不再带片段
	}
	const msg = e.message ?? '';
	// 只匹配明确的「不支持该参数 / 只允许默认值」形态 (审核 P2) —— 单纯
	// /temperature/ 会把用户输入越界值、类型错误等配置问题也静默吞掉。
	return /temperature/i.test(msg)
		&& /unsupported\s+value|only\s+the\s+default|does\s+not\s+support|unrecognized\s+request\s+argument|unknown\s+parameter|not\s+supported\s+with\s+this\s+model/i.test(msg);
}

const temperatureUnsupportedModels = new Set<string>();

/** Has this (provider, endpoint, model) already 400'd on temperature this session? */
export function temperatureUnsupported(providerId: string, endpoint: string, model: string): boolean {
	return temperatureUnsupportedModels.has(modelKey(providerId, endpoint, model));
}

/** Remember that this (provider, endpoint, model) rejects a non-default temperature. */
export function markTemperatureUnsupported(providerId: string, endpoint: string, model: string): void {
	temperatureUnsupportedModels.add(modelKey(providerId, endpoint, model));
}
