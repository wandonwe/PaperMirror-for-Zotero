/**
 * Anthropic Claude API provider (Messages API).
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { validateResponse } from '../responseValidator';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const API_VERSION = '2023-06-01';

function headers(settings: ProviderSettings): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'x-api-key': settings.apiKey,
		'anthropic-version': API_VERSION
	};
}

function messagesURL(settings: ProviderSettings): string {
	const base = (settings.apiBaseURL || DEFAULT_BASE).replace(/\/+$/, '');
	return `${base}/v1/messages`;
}

function extractText(json: unknown): string {
	const content = (json as { content?: { type?: string; text?: string }[] })?.content;
	if (!Array.isArray(content)) {
		throw new PaperMirrorError('BAD_RESPONSE', 'Unexpected Anthropic response shape.');
	}
	return content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
}

export const anthropicProvider: TranslationProvider = {
	id: 'anthropic',
	displayName: 'Anthropic Claude',
	defaultBaseURL: DEFAULT_BASE,
	defaultModel: DEFAULT_MODEL,
	requiresApiKey: true,

	async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
		if (!settings.apiKey) {
			return { ok: false, message: 'NO_API_KEY' };
		}
		try {
			const { status, json, elapsedMs } = await requestJSON(messagesURL(settings), {
				headers: headers(settings),
				body: {
					model: settings.model || DEFAULT_MODEL,
					max_tokens: 32,
					messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
				},
				timeoutMs: Math.min(settings.timeoutMs, 30000)
			});
			const text = extractText(json);
			return { ok: true, httpStatus: status, modelAvailable: text.length > 0, elapsedMs };
		}
		catch (e) {
			const err = e instanceof PaperMirrorError ? e : new PaperMirrorError('UNKNOWN', String(e));
			return { ok: false, message: err.code, httpStatus: err.httpStatus };
		}
	},

	async translate(request: TranslationRequest, settings: ProviderSettings, options: TranslateOptions): Promise<TranslationResponse> {
		const { json } = await requestJSON(messagesURL(settings), {
			headers: headers(settings),
			body: {
				model: settings.model || DEFAULT_MODEL,
				max_tokens: 8192,
				system: buildSystemPrompt(request, settings.customPrompt),
				messages: [{ role: 'user', content: buildUserPayload(request) }]
			},
			timeoutMs: settings.timeoutMs,
			signal: options.signal
		});
		const text = extractText(json);
		const { translations } = validateResponse(text, request.blocks.map(b => b.id));
		return { translations };
	}
};
