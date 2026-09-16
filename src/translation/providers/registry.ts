/**
 * Provider registry: anthropic | openai | openai-compatible | deepl | custom.
 */

import type { ProviderSettings } from '../../types/models';
import { anthropicProvider } from './anthropic';
import { geminiNativeProvider } from './geminiNative';
import { bingFreeProvider } from './bingFree';
import { deeplProvider } from './deepl';
import { googleFreeProvider } from './googleFree';
import { createOpenAICompatibleProvider } from './openaiCompatible';
import type { TranslationProvider } from './types';

const openaiProvider = createOpenAICompatibleProvider({
	id: 'openai',
	displayName: 'OpenAI',
	defaultBaseURL: 'https://api.openai.com',
	// GPT-5.6 family is current; Luna is the cost-optimized tier (verified
	// 2026-08-10, developers.openai.com). Kept in sync w/ modelCatalog.
	defaultModel: 'gpt-5.6-luna'
});

const openaiCompatibleProvider = createOpenAICompatibleProvider({
	id: 'openai-compatible',
	displayName: 'OpenAI-compatible API',
	defaultBaseURL: '',
	defaultModel: ''
});

const customEndpointProvider = createOpenAICompatibleProvider({
	id: 'custom',
	displayName: 'Custom HTTP endpoint',
	defaultBaseURL: '',
	defaultModel: '',
	allowInsecureHTTP: settings => (settings as ProviderSettings & { allowInsecureHTTP?: boolean }).allowInsecureHTTP === true
});

/**
 * Preset roster inspired by Read Frog (mengxi-ream/read-frog): popular
 * OpenAI-compatible services selectable with one click — the default Base URL
 * and model are filled in automatically; only the API key is needed.
 */
const presetProviders: TranslationProvider[] = [
	createOpenAICompatibleProvider({
		id: 'deepseek',
		displayName: 'DeepSeek 深度求索',
		defaultBaseURL: 'https://api.deepseek.com',
		// deepseek-chat/deepseek-reasoner were discontinued 2026-07-24.
		// 2.12.1 (核对 api-docs.deepseek.com/updates, 2026-09-10): 当前名是
		// `deepseek-flash`(V4.1 Flash);`deepseek-v4-flash` 只是**暂时**路由
		// 过去的过渡名 —— 默认值留在过渡名上迟早会断,改到当前名。
		// 已显式选过型号的用户不受影响(这里只是没选时的默认)。
		defaultModel: 'deepseek-flash'
	}),
	createOpenAICompatibleProvider({
		id: 'moonshot',
		displayName: 'Kimi (Moonshot AI)',
		// Base moved to api.moonshot.ai; moonshot-v1-* sunsetting, kimi-k3 current
		// (verified 2026-08-10, platform.kimi.ai). Kept in sync w/ modelCatalog.
		defaultBaseURL: 'https://api.moonshot.ai',
		defaultModel: 'kimi-k3'
	}),
	createOpenAICompatibleProvider({
		id: 'qwen',
		displayName: '通义千问 Qwen (阿里云百炼)',
		defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		// qwen-plus/max/turbo aliases are retiring; qwen3.7-plus is the current
		// recommended for document translation (2026-08-10, help.aliyun.com).
		defaultModel: 'qwen3.7-plus',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'zhipu',
		displayName: '智谱 GLM',
		defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
		// GLM-5.3 requires thinking enabled; handled by advancedParams.
		defaultModel: 'glm-5.3'
	}),
	// Gemini runs on the NATIVE generateContent API (Bob-plugin style):
	// first-class thinkingConfig / JSON mode, proxy-friendly Base URL.
	geminiNativeProvider,
	createOpenAICompatibleProvider({
		id: 'openrouter',
		displayName: 'OpenRouter',
		defaultBaseURL: 'https://openrouter.ai/api/v1',
		// Meta-router: default to auto-routing; users pick a specific slug or type one.
		defaultModel: 'openrouter/auto',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'siliconflow',
		displayName: '硅基流动 SiliconFlow',
		defaultBaseURL: 'https://api.siliconflow.cn',
		// Aggregator; DeepSeek-V4-Flash is a current high-value default (ids per
		// the SiliconFlow console, 2026-08-10). Kept in sync w/ modelCatalog.
		defaultModel: 'deepseek-ai/DeepSeek-V4-Flash'
	}),
	createOpenAICompatibleProvider({
		id: 'groq',
		displayName: 'Groq',
		defaultBaseURL: 'https://api.groq.com/openai/v1',
		defaultModel: 'openai/gpt-oss-120b',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'ollama',
		displayName: 'Ollama (本地)',
		defaultBaseURL: 'http://localhost:11434',
		defaultModel: 'qwen3.5',
		requiresApiKey: false,
		// 与 custom 一致 (审核 P1-4): 此前是 `() => true` —— 闭包忽略入参,而
		// 注释写的前提「默认 URL 是 localhost」并不成立,因为 Base URL 是用户
		// 可编辑字段。于是 checkEndpointURL 的 isLocal 判断与「允许 HTTP 端点」
		// 首选项对 ollama 完全失效:填一个公网地址就明文跨网传输整篇论文;
		// 若该端点还配了密钥,Authorization: Bearer 也会一并明文发出。
		// 默认的 localhost 用法不受影响 —— checkEndpointURL 对回环地址
		// (localhost / 127.0.0.1 / [::1]) 本来就无条件放行。
		allowInsecureHTTP: settings => (settings as ProviderSettings & { allowInsecureHTTP?: boolean }).allowInsecureHTTP === true
	})
];

const providers: TranslationProvider[] = [
	bingFreeProvider,
	googleFreeProvider,
	anthropicProvider,
	openaiProvider,
	...presetProviders,
	openaiCompatibleProvider,
	deeplProvider,
	customEndpointProvider
];

export function getProvider(id: string): TranslationProvider {
	return providers.find(p => p.id === id) ?? bingFreeProvider;
}

export function listProviders(): TranslationProvider[] {
	return providers.slice();
}
