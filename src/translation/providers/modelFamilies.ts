/**
 * 型号家族识别 (5.0 梳理): 各服务商的参数契约按型号家族区分,判定集中在这里,
 * 请求构造(advancedParams / openaiCompatible / anthropic / geminiNative)
 * 不再各自写一份正则。全部为纯函数,单测覆盖。
 */

/** Kimi K3 / K3.1(含 -pro、-highspeed 等后缀): 总是思考、温度固定、用 max_completion_tokens。 */
export function isKimiK3(model: string): boolean {
	return /^kimi-k3(?:\.\d+)?(?:$|-)/i.test(model.trim());
}

/** Kimi K2.6: 可关闭思考;温度在思考时 1.0、不思考时 0.6。 */
export function isKimiK26(model: string): boolean {
	return /^kimi-k2\.6(?:$|-)/i.test(model.trim());
}

/** 智谱 GLM-5.3 系列(含 -flash / -flashx): 总是思考。 */
export function isGlm53(model: string): boolean {
	return /^glm-5\.3(?:$|-)/i.test(model.trim());
}

export type Gpt6Tier = 'astra' | 'sol' | 'terra' | 'luna';

/** GPT-6 档位(OpenRouter 的 openai/ 前缀同样识别);不是 GPT-6 返回 null。 */
export function gpt6Tier(model: string): Gpt6Tier | null {
	const m = /^(?:openai\/)?gpt-6(?:\.\d+)?-(astra|sol|terra|luna)(?:$|-)/.exec(model.trim());
	return m ? m[1] as Gpt6Tier : null;
}

/** GPT-6 能用的最低推理强度: Luna/Terra 可以 none,Astra/Sol 最低 low。 */
export function gpt6MinimumEffort(tier: Gpt6Tier): 'none' | 'low' {
	return tier === 'terra' || tier === 'luna' ? 'none' : 'low';
}

/** Groq 上的 GPT-OSS(只接受 low/medium/high)。 */
export function isGptOss(model: string): boolean {
	return /^openai\/gpt-oss-/.test(model.trim());
}

/**
 * OpenAI reasoning models that THINK BY DEFAULT (5.0): the original GPT-5 /
 * mini / nano (default medium, lowest minimal) and the o-series (default
 * medium, lowest low). GPT-5.1 and later default to none and need nothing.
 */
export function openaiDefaultThinkingFloor(model: string): 'minimal' | 'low' | null {
	const m = model.trim().replace(/^openai\//, '');
	if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return 'minimal';
	if (/^o[134](?:-mini|-pro)?(?:$|-)/.test(m)) return 'low';
	return null;
}
