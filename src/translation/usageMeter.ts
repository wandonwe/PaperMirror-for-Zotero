/**
 * API token 用量计数 (2.7.0, 审核 F-2) — pure。
 *
 * 三家服务商的响应都带用量字段,此前一律不读,生产环境 token 效率完全不可
 * 度量。这里把三种形状归一为一组纯数字 —— 只有计数,永远没有文本;用量进
 * 诊断导出与 usage 汇总,不进日志正文。
 *
 *   OpenAI 兼容: usage.prompt_tokens / completion_tokens /
 *                prompt_tokens_details.cached_tokens
 *   Anthropic:   usage.input_tokens / output_tokens /
 *                cache_read_input_tokens / cache_creation_input_tokens
 *                (input_tokens 不含缓存部分 —— 总输入 = 三者之和)
 *   Gemini:      usageMetadata.promptTokenCount / candidatesTokenCount /
 *                cachedContentTokenCount
 */

export interface TokenUsage {
	/** 计费意义上的输入 token 总数(含缓存命中部分)。 */
	inputTokens: number;
	outputTokens: number;
	/** 输入中由服务商提示缓存命中的部分(0 = 未命中或服务商不报)。 */
	cachedInputTokens: number;
}

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** 从服务商原始响应 JSON 里读用量;形状不认识或缺字段时返回 undefined。 */
export function parseUsage(json: unknown): TokenUsage | undefined {
	if (!json || typeof json !== 'object') {
		return undefined;
	}
	const root = json as Record<string, unknown>;
	const usage = root.usage as Record<string, unknown> | undefined;
	if (usage && typeof usage === 'object') {
		// OpenAI 兼容
		const prompt = num(usage.prompt_tokens);
		const completion = num(usage.completion_tokens);
		if (prompt !== undefined || completion !== undefined) {
			const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
			return {
				inputTokens: prompt ?? 0,
				outputTokens: completion ?? 0,
				cachedInputTokens: num(details?.cached_tokens) ?? 0
			};
		}
		// Anthropic
		const input = num(usage.input_tokens);
		const output = num(usage.output_tokens);
		if (input !== undefined || output !== undefined) {
			const cacheRead = num(usage.cache_read_input_tokens) ?? 0;
			const cacheCreate = num(usage.cache_creation_input_tokens) ?? 0;
			return {
				inputTokens: (input ?? 0) + cacheRead + cacheCreate,
				outputTokens: output ?? 0,
				cachedInputTokens: cacheRead
			};
		}
	}
	// Gemini
	const meta = root.usageMetadata as Record<string, unknown> | undefined;
	if (meta && typeof meta === 'object') {
		const prompt = num(meta.promptTokenCount);
		const candidates = num(meta.candidatesTokenCount);
		if (prompt !== undefined || candidates !== undefined) {
			return {
				inputTokens: prompt ?? 0,
				outputTokens: candidates ?? 0,
				cachedInputTokens: num(meta.cachedContentTokenCount) ?? 0
			};
		}
	}
	return undefined;
}

export function addUsage(into: TokenUsage, more: TokenUsage | undefined): TokenUsage {
	if (!more) {
		return into;
	}
	into.inputTokens += more.inputTokens;
	into.outputTokens += more.outputTokens;
	into.cachedInputTokens += more.cachedInputTokens;
	return into;
}

export function emptyUsage(): TokenUsage {
	return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}
