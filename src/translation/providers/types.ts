/**
 * Provider adapter interface (spec 4.4).
 */

import type {
	ProviderSettings,
	TranslationProgress,
	TranslationRequest,
	TranslationResponse,
	ValidationResult
} from '../../types/models';

export interface TranslateOptions {
	signal?: AbortSignal;
	onProgress?: (event: TranslationProgress) => void;
}

export interface TranslationProvider {
	id: string;
	displayName: string;
	/** Default base URL; shown in settings when field is empty. */
	defaultBaseURL: string;
	/**
	 * Base URL as the user would recognise it, including any version segment
	 * the adapter appends internally (e.g. https://api.openai.com/v1).
	 * Displayed as the Base URL placeholder in settings.
	 */
	displayBaseURL?: string;
	/** Default model name suggestion. */
	defaultModel: string;
	/** Whether this provider needs an API key. */
	requiresApiKey: boolean;

	validateConfiguration(settings: ProviderSettings): Promise<ValidationResult>;

	translate(
		request: TranslationRequest,
		settings: ProviderSettings,
		options: TranslateOptions
	): Promise<TranslationResponse>;

	/**
	 * Free-form single-prompt completion (used by the sentence-explain
	 * feature). Only LLM providers implement this; MT engines leave it
	 * undefined.
	 */
	complete?(
		prompt: string,
		settings: ProviderSettings,
		options: TranslateOptions
	): Promise<string>;
}

/** The single host every request for a settings object will go to (privacy UI). */
export function endpointHost(settings: ProviderSettings, defaultBaseURL: string): string {
	try {
		return new URL(settings.apiBaseURL || defaultBaseURL).host;
	}
	catch {
		return settings.apiBaseURL || defaultBaseURL;
	}
}
