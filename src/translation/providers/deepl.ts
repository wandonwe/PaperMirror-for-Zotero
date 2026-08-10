/**
 * DeepL API provider. DeepL translates plain text (no JSON-instruction
 * following), so each block is sent as one text entry and results are zipped
 * back by index.
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';
import { deeplTranslateURL } from './urls';

const DEFAULT_BASE_FREE = 'https://api-free.deepl.com';
const DEFAULT_BASE_PRO = 'https://api.deepl.com';

function baseURL(settings: ProviderSettings): string {
	if (settings.apiBaseURL) {
		return settings.apiBaseURL.replace(/\/+$/, '');
	}
	return settings.apiKey.endsWith(':fx') ? DEFAULT_BASE_FREE : DEFAULT_BASE_PRO;
}

function translateURL(settings: ProviderSettings): string {
	return deeplTranslateURL(baseURL(settings));
}

function mapLang(code: string, isTarget: boolean): string {
	switch (code) {
		case 'zh-CN': return 'ZH-HANS';
		case 'zh-TW': return 'ZH-HANT';
		case 'zh': return isTarget ? 'ZH-HANS' : 'ZH';
		case 'en': return isTarget ? 'EN-US' : 'EN';
		case 'auto': return '';
		default: return code.toUpperCase();
	}
}

export const deeplProvider: TranslationProvider = {
	id: 'deepl',
	displayName: 'DeepL',
	defaultBaseURL: DEFAULT_BASE_PRO,
	defaultModel: '',
	requiresApiKey: true,

	endpointFor(settings: ProviderSettings): string {
		return translateURL(settings);
	},

	async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
		if (!settings.apiKey) {
			return { ok: false, message: 'NO_API_KEY' };
		}
		try {
			const { status, elapsedMs } = await requestJSON(translateURL(settings), {
				headers: {
					'Content-Type': 'application/json',
					Authorization: `DeepL-Auth-Key ${settings.apiKey}`
				},
				body: { text: ['ok'], target_lang: 'ZH-HANS' },
				timeoutMs: Math.min(settings.timeoutMs, 30000)
			});
			return { ok: true, httpStatus: status, modelAvailable: true, elapsedMs };
		}
		catch (e) {
			const err = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			return { ok: false, message: err.code, httpStatus: err.httpStatus };
		}
	},

	async translate(request: TranslationRequest, settings: ProviderSettings, options: TranslateOptions): Promise<TranslationResponse> {
		const texts = request.blocks.map(b => b.text);
		const body: Record<string, unknown> = {
			text: texts,
			target_lang: mapLang(request.targetLanguage, true),
			preserve_formatting: true
		};
		const source = mapLang(request.sourceLanguage, false);
		if (source) {
			body.source_lang = source;
		}
		const { json } = await requestJSON(translateURL(settings), {
			headers: {
				'Content-Type': 'application/json',
				Authorization: `DeepL-Auth-Key ${settings.apiKey}`
			},
			body,
			timeoutMs: settings.timeoutMs,
			signal: options.signal
		});
		const translations = (json as { translations?: { text?: string }[] })?.translations;
		if (!Array.isArray(translations) || translations.length !== request.blocks.length) {
			throw new PaperMirrorError('BAD_RESPONSE', 'DeepL returned an unexpected number of translations.');
		}
		return {
			translations: request.blocks.map((block, i) => ({
				id: block.id,
				translatedText: translations[i]?.text ?? ''
			}))
		};
	}
};
