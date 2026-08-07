/**
 * Provider registry: anthropic | openai | openai-compatible | deepl | custom.
 */

import type { ProviderSettings } from '../../types/models';
import { anthropicProvider } from './anthropic';
import { deeplProvider } from './deepl';
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

const providers: TranslationProvider[] = [
	anthropicProvider,
	openaiProvider,
	openaiCompatibleProvider,
	deeplProvider,
	customEndpointProvider
];

export function getProvider(id: string): TranslationProvider {
	return providers.find(p => p.id === id) ?? anthropicProvider;
}

export function listProviders(): TranslationProvider[] {
	return providers.slice();
}
