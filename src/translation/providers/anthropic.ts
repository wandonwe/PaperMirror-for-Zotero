/**
 * Anthropic Claude API provider (Messages API).
 */

import type { ProviderSettings, TranslationRequest, TranslationResponse, ValidationResult } from '../../types/models';
import { PaperMirrorError } from '../../types/models';
import { buildSystemPrompt, buildUserPayload } from '../promptBuilder';
import { parseUsage } from '../usageMeter';
import { parsePlainResponse, validateResponse } from '../responseValidator';
import { requestJSON } from './httpClient';
import type { TranslateOptions, TranslationProvider } from './types';
import { anthropicMessagesURL } from './urls';

const DEFAULT_BASE = 'https://api.anthropic.com';
// claude-sonnet-5-5 is the current Sonnet — balanced quality/latency for
// translation (2026-11-19, platform.claude.com). Kept in sync w/ modelCatalog.
const DEFAULT_MODEL = 'claude-sonnet-5-5';
// 2026-10-21 exists, but its only change for our requests is that sampling
// parameters always 400 — we already omit them on every current model, and
// staying on 2023-06-01 keeps x-api-key gateways and older models (where we
// still send temperature 0) working unchanged.
const API_VERSION = '2023-06-01';

/**
 * Claude thinking contract per model family (platform.claude.com, 2026-11-19):
 *  - adaptive models: Claude 5.x, Opus 4.7/4.8 — budget_tokens returns 400 and a
 *    custom temperature returns 400;
 *  - cannot disable thinking: Fable 5.x, Mythos 5.x, Opus 5.5+ → keep adaptive at
 *    effort low when the user asks for 「禁用」;
 *  - Sonnet 5.5+ rejects `disabled`; `between_tools` (effort ≤ high) is the
 *    no-thinking equivalent for a single-turn request;
 *  - everything else in the adaptive set accepts `disabled`.
 */
const ADAPTIVE_MODEL = /^claude-(?:(?:sonnet|opus|haiku)-5|opus-4-[78]|(?:fable|mythos)-5)/;
const ALWAYS_THINKS_MODEL = /^claude-(?:(?:fable|mythos)-5|opus-5-(?:[5-9]|[1-9]\d)(?:$|-))/;
const BETWEEN_TOOLS_MODEL = /^claude-sonnet-5-(?:[5-9]|[1-9]\d)(?:$|-)/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function headers(settings: ProviderSettings): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'x-api-key': settings.apiKey,
		'anthropic-version': API_VERSION
	};
}

function messagesURL(settings: ProviderSettings): string {
	const path = (settings.apiPath ?? '').trim();
	if (path) {
		const b = (settings.apiBaseURL || DEFAULT_BASE).replace(/\/+$/, '');
		return b + (path.startsWith('/') ? path : `/${path}`);
	}
	return anthropicMessagesURL(settings.apiBaseURL, DEFAULT_BASE);
}

/** Model-specific thinking controls: adaptive for current Claude, budget for older models. */
export function advancedBody(settings: ProviderSettings, defaultMax: number): Record<string, unknown> {
	const maxTokens = settings.maxOutputTokens && settings.maxOutputTokens > 0
		? Math.floor(settings.maxOutputTokens)
		: defaultMax;
	const out: Record<string, unknown> = { max_tokens: maxTokens };
	const model = (settings.model || DEFAULT_MODEL).trim();
	if (ADAPTIVE_MODEL.test(model)) {
		if (typeof settings.temperature === 'number' && settings.temperature !== 1) {
			throw new PaperMirrorError('UNKNOWN', '当前 Claude 模型不支持自定义温度，请清除高级设置中的温度。');
		}
		const r = settings.reasoning || '';
		const off = !r || r === 'disabled';
		if (off && ALWAYS_THINKS_MODEL.test(model)) {
			out.thinking = { type: 'adaptive' };
			out.output_config = { effort: 'low' };
		}
		else if (off && BETWEEN_TOOLS_MODEL.test(model)) {
			out.thinking = { type: 'between_tools' };
			out.output_config = { effort: 'low' };
		}
		else if (off) {
			out.thinking = { type: 'disabled' };
		}
		else {
			out.thinking = { type: 'adaptive' };
			if (r !== 'auto') {
				const effort = r === 'minimal' ? 'low' : r;
				out.output_config = { effort: EFFORTS.has(effort) ? effort : 'low' };
			}
		}
		return out;
	}

	if (settings.reasoning === 'high' || settings.reasoning === 'xhigh') {
		// The thinking budget is ADDED ON TOP of the output allowance — carving
		// it out of max_tokens starved big batches (8000-char chunks need
		// ~4000–6000 output tokens; thoughts ate half and the JSON truncated,
		// which surfaces as a non-retryable BAD_RESPONSE losing the whole chunk).
		const budget = 2048;
		out.thinking = { type: 'enabled', budget_tokens: budget };
		out.max_tokens = maxTokens + budget;
	}
	else {
		// 温度默认 0 — deterministic output suits translation (thinking mode
		// forbids a custom temperature, hence the else branch).
		out.temperature = typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)
			? settings.temperature
			: 0;
	}
	return out;
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
	supportsCharBudget: true,

	endpointFor(settings: ProviderSettings): string {
		return messagesURL(settings);
	},

	async validateConfiguration(settings: ProviderSettings): Promise<ValidationResult> {
		if (!settings.apiKey) {
			return { ok: false, message: 'NO_API_KEY' };
		}
		try {
			const { status, json, elapsedMs } = await requestJSON(messagesURL(settings), {
				headers: headers(settings),
				body: {
					model: settings.model || DEFAULT_MODEL,
					...advancedBody({...settings,maxOutputTokens:256,reasoning:'disabled'},256),
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
				// 16384 (was 8192): an 8000-char source batch translates to
				// ~4000–6000 CJK output tokens plus JSON/id overhead — 8192 was
				// borderline and truncated JSON kills the whole chunk.
				...advancedBody(settings, 16384),
				system: buildSystemPrompt(request, settings.customPrompt),
				messages: [{ role: 'user', content: buildUserPayload(request) }]
			},
			timeoutMs: settings.timeoutMs,
			signal: options.signal,
			onAttempt: options.onAttempt
		});
		// 用量先于校验 (2.7.7): 校验失败的响应同样花了 token。只读数字。
		const usage = parseUsage(json);
		if (usage) {
			options.onUsage?.(usage);
		}
		const text = extractText(json);
		const { translations } = request.plain
			? parsePlainResponse(text, request.blocks[0]!.id)
			: validateResponse(text, request.blocks.map(b => b.id), {
				rejectDuplicateIds: request.blocks.some(b => b.continuationUnit)
			});
		return usage ? { translations, usage } : { translations };
	},

	async complete(prompt: string, settings: ProviderSettings, options: TranslateOptions): Promise<string> {
		const { json } = await requestJSON(messagesURL(settings), {
			headers: headers(settings),
			body: {
				model: settings.model || DEFAULT_MODEL,
				...advancedBody(settings, 4096),
				messages: [{ role: 'user', content: prompt }]
			},
			timeoutMs: settings.timeoutMs,
			signal: options.signal
		});
		return extractText(json);
	}
};
