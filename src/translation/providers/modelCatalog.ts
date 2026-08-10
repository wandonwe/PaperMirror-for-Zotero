/**
 * Built-in model catalog (spec 0.9.3 §B).
 *
 * A small, curated fallback list of currently-valid model IDs per provider, so
 * the settings pane can offer a recommended model + a few current alternatives
 * without a live network call, and so the default never points at a retired
 * model that answers 404. Each entry records WHEN it was checked and the
 * official documentation source it was checked against — model line-ups move
 * fast, and a dated provenance is the only honest way to ship a static list.
 *
 * This is a *fallback*, never a whitelist: a model the user has saved that is
 * not in this list is still shown and used (the pane surfaces it as the current
 * custom model). Free MT engines (Bing/Google) and DeepL take no model, so they
 * are absent here — see providerNeedsModel().
 *
 * Verified 2026-08-10 against each provider's official docs.
 */

export interface CatalogModel {
	/** Exact model string passed to the API. */
	id: string;
	/** Optional friendly label; falls back to the id. */
	label?: string;
	/** The single recommended default (first one wins). */
	recommended?: boolean;
	/** Marked as a legacy/deprecated id kept only for users who still rely on it. */
	legacy?: boolean;
}

export interface ProviderCatalogEntry {
	models: CatalogModel[];
	/** ISO date this list was last verified. */
	checked: string;
	/** Official documentation URL the list was verified against. */
	source: string;
}

const CHECKED = '2026-08-10';

export const MODEL_CATALOG: Record<string, ProviderCatalogEntry> = {
	openai: {
		checked: CHECKED,
		source: 'https://developers.openai.com/api/docs/models',
		models: [
			// GPT-5.6 family (sol/terra/luna). The older gpt-5-mini / gpt-4o-mini
			// IDs are being retired, so they are not offered here.
			{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (推荐 · 省)', recommended: true },
			{ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (均衡)' },
			{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (最强)' }
		]
	},
	anthropic: {
		checked: CHECKED,
		source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
		models: [
			{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (推荐)', recommended: true },
			{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (最省)' },
			{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (最强)' },
			{ id: 'claude-fable-5', label: 'Claude Fable 5 (旗舰)' },
			{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (旧)', legacy: true }
		]
	},
	gemini: {
		checked: CHECKED,
		source: 'https://ai.google.dev/gemini-api/docs/models',
		models: [
			{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (推荐)', recommended: true },
			{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (新)' },
			{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (最新)' },
			{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (最省)' },
			{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (最强)' }
		]
	},
	deepseek: {
		checked: CHECKED,
		source: 'https://api-docs.deepseek.com/quick_start/pricing',
		models: [
			// deepseek-chat / deepseek-reasoner were discontinued 2026-07-24.
			{ id: 'deepseek-v4-flash', label: 'DeepSeek V4-Flash (推荐)', recommended: true },
			{ id: 'deepseek-v4-pro', label: 'DeepSeek V4-Pro (最强)' }
		]
	},
	moonshot: {
		checked: CHECKED,
		source: 'https://platform.kimi.ai/docs/models',
		models: [
			// moonshot-v1-* is being sunset; kimi-latest / kimi-k2 discontinued.
			// Current Kimi models run on base https://api.moonshot.ai/v1.
			{ id: 'kimi-k3', label: 'Kimi K3 (推荐)', recommended: true },
			{ id: 'kimi-k2.6', label: 'Kimi K2.6 (性价比)' },
			{ id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code (代码)' },
			{ id: 'kimi-k2.5', label: 'Kimi K2.5 (最省)' }
		]
	},
	qwen: {
		checked: CHECKED,
		source: 'https://help.aliyun.com/zh/model-studio/getting-started/models',
		models: [
			// Alibaba keeps qwen-plus/max/turbo as stable aliases → latest snapshot.
			{ id: 'qwen-plus', label: 'qwen-plus (推荐)', recommended: true },
			{ id: 'qwen-max', label: 'qwen-max (最强)' },
			{ id: 'qwen-turbo', label: 'qwen-turbo (最省)' },
			{ id: 'qwen3.7-plus', label: 'qwen3.7-plus (新)' },
			{ id: 'qwen3.7-flash', label: 'qwen3.7-flash (新·快)' }
		]
	},
	zhipu: {
		checked: CHECKED,
		source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-4',
		models: [
			// The free/current IDs are DATED; the bare glm-4-flash alias is retired.
			{ id: 'glm-4-flash-250414', label: 'GLM-4-Flash (推荐 · 免费)', recommended: true },
			{ id: 'glm-4-plus', label: 'GLM-4-Plus (最强)' },
			{ id: 'glm-4-air-250414', label: 'GLM-4-Air (性价比)' },
			{ id: 'glm-4-flashx-250414', label: 'GLM-4-FlashX (快)' },
			{ id: 'glm-4-airx', label: 'GLM-4-AirX (高速)' }
		]
	},
	openrouter: {
		checked: CHECKED,
		source: 'https://openrouter.ai/models',
		models: [
			// OpenRouter is a meta-router with hundreds of models — type any slug.
			{ id: 'deepseek/deepseek-v4-flash-latest', label: 'deepseek/deepseek-v4-flash-latest (推荐)', recommended: true },
			{ id: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro' },
			{ id: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash' }
		]
	},
	siliconflow: {
		checked: CHECKED,
		source: 'https://www.siliconflow.com/models',
		models: [
			// SiliconFlow hosts 200+ models (Qwen3, DeepSeek-V4…) — type any id.
			{ id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5-7B-Instruct (推荐 · 免费)', recommended: true },
			{ id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen2.5-72B-Instruct (较强)' }
		]
	},
	groq: {
		checked: CHECKED,
		source: 'https://console.groq.com/docs/models',
		models: [
			{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (推荐)', recommended: true },
			{ id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (最快)' },
			{ id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
			{ id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' }
		]
	},
	ollama: {
		checked: CHECKED,
		source: 'https://ollama.com/library',
		models: [
			// Local — you must `ollama pull` the model first; type whatever you have.
			{ id: 'qwen3', label: 'qwen3 (推荐)', recommended: true },
			{ id: 'llama3.3', label: 'llama3.3' },
			{ id: 'gemma3', label: 'gemma3' },
			{ id: 'mistral', label: 'mistral' }
		]
	}
};

/** Providers that translate without a model choice (fixed MT / no model param). */
const NO_MODEL_PROVIDERS = new Set(['bing-free', 'google-free', 'deepl']);

/** True when this provider exposes a model choice in settings. */
export function providerNeedsModel(providerId: string): boolean {
	return !NO_MODEL_PROVIDERS.has(providerId);
}

/** The curated model list for a provider (empty when the user must type one). */
export function catalogModelsFor(providerId: string): CatalogModel[] {
	return MODEL_CATALOG[providerId]?.models.slice() ?? [];
}

/** The recommended default model id, or '' when there is no catalog. */
export function recommendedModelFor(providerId: string): string {
	const models = MODEL_CATALOG[providerId]?.models ?? [];
	return (models.find(m => m.recommended) ?? models[0])?.id ?? '';
}

/** True when this exact model id appears in the provider's catalog. */
export function catalogHasModel(providerId: string, modelId: string): boolean {
	const id = modelId.trim();
	if (!id) {
		return false;
	}
	return (MODEL_CATALOG[providerId]?.models ?? []).some(m => m.id === id);
}

/** Provenance for display: when checked, against which doc. */
export function catalogProvenance(providerId: string): { checked: string; source: string } | null {
	const entry = MODEL_CATALOG[providerId];
	return entry ? { checked: entry.checked, source: entry.source } : null;
}
