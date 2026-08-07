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
	defaultModel: 'gpt-4o-mini'
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
		defaultModel: 'deepseek-chat'
	}),
	createOpenAICompatibleProvider({
		id: 'moonshot',
		displayName: 'Kimi (Moonshot AI)',
		defaultBaseURL: 'https://api.moonshot.cn',
		defaultModel: 'moonshot-v1-8k'
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
		defaultModel: 'glm-4-flash'
	}),
	createOpenAICompatibleProvider({
		id: 'gemini',
		displayName: 'Google Gemini',
		defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
		defaultModel: 'gemini-2.0-flash',
		noV1Suffix: true
	}),
	createOpenAICompatibleProvider({
		id: 'openrouter',
		displayName: 'OpenRouter',
		defaultBaseURL: 'https://openrouter.ai/api/v1',
		defaultModel: 'openai/gpt-4o-mini',
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
		defaultModel: 'qwen2.5',
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
