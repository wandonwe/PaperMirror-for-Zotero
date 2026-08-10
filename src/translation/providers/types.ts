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

	/**
	 * Whether this provider honours a per-block character budget in the request
	 * (i.e. it is prompt-driven and will actually try to shorten a translation
	 * when asked). LLM engines do; fixed MT services (Bing/Google/DeepL) ignore
	 * it, so the strict renderer must not waste compress rounds on them and
	 * should go straight to the shrink stage. Explicit capability — NOT inferred
	 * from whether the provider can also power the explain feature.
	 */
	supportsCharBudget?: boolean;

	/**
	 * The exact URL a request will be sent to for these settings. Used by the
	 * settings pane's "实际请求地址" preview so it can never drift from the
	 * transport. Providers with no configurable endpoint (free scrapers) leave
	 * it undefined.
	 */
	endpointFor?(settings: ProviderSettings): string;

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

/** True if this provider will act on a per-block character budget. */
export function supportsCharBudget(provider: TranslationProvider): boolean {
	return provider.supportsCharBudget === true;
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
