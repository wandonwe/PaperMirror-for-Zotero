/**
 * Provider registry: anthropic | openai | openai-compatible | deepl | custom.
 */

import type { ProviderSettings } from '../../types/models';
import { anthropicProvider } from './anthropic';
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
		defaultModel: 'qwen-plus',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'zhipu',
		displayName: '智谱 GLM',
		defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
		// The bare glm-4-flash alias is retired; the free model is now dated
		// (verified 2026-08-10, docs.bigmodel.cn). Kept in sync w/ modelCatalog.
		defaultModel: 'glm-4-flash-250414'
	}),
	createOpenAICompatibleProvider({
		id: 'gemini',
		displayName: 'Google Gemini',
		defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
		// gemini-2.0-flash was retired (the API answers 404 model-not-found);
		// 2.5-flash is the current fast tier.
		defaultModel: 'gemini-2.5-flash',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'openrouter',
		displayName: 'OpenRouter',
		defaultBaseURL: 'https://openrouter.ai/api/v1',
		// openai/gpt-4o-mini slug retired; use a current, confirmed slug.
		defaultModel: 'deepseek/deepseek-v4-flash-latest',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'siliconflow',
		displayName: '硅基流动 SiliconFlow',
		defaultBaseURL: 'https://api.siliconflow.cn',
		defaultModel: 'Qwen/Qwen2.5-7B-Instruct'
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
		defaultModel: 'qwen3',
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
