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
		// deepseek-chat/deepseek-reasoner were discontinued 2026-07-24; V4-Flash
		// is the current default (verified 2026-08-10, api-docs.deepseek.com).
		defaultModel: 'deepseek-v4-flash'
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
		// glm-5 is the current flagship; the dated glm-4-* ids move to the legacy
		// group (2026-08-10, docs.bigmodel.cn). Kept in sync w/ modelCatalog.
		defaultModel: 'glm-5'
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
		defaultModel: 'llama-3.3-70b-versatile',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'ollama',
		displayName: 'Ollama (本地)',
		defaultBaseURL: 'http://localhost:11434',
		defaultModel: 'qwen3.5',
		requiresApiKey: false,
		allowInsecureHTTP: () => true // localhost only by default URL
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
