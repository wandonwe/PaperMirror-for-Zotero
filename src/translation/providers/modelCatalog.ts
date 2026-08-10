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
			{ id: 'gpt-5-mini', label: 'GPT-5 mini (推荐)', recommended: true },
			{ id: 'gpt-5', label: 'GPT-5' },
			{ id: 'gpt-5-nano', label: 'GPT-5 nano (最省)' },
			{ id: 'gpt-4o', label: 'GPT-4o' },
			{ id: 'gpt-4o-mini', label: 'GPT-4o mini (旧)', legacy: true }
		]
	},
	anthropic: {
		checked: CHECKED,
		source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
		models: [
			{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (推荐)', recommended: true },
			{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (最省)' },
			{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (最强)' },
			{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (旧)', legacy: true }
		]
	},
	gemini: {
		checked: CHECKED,
		source: 'https://ai.google.dev/gemini-api/docs/models',
		models: [
			{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (推荐)', recommended: true },
			{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
			{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (最省)' },
			{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (最强)' }
		]
	},
	deepseek: {
		checked: CHECKED,
		source: 'https://api-docs.deepseek.com/updates/',
		models: [
			{ id: 'deepseek-v4-flash', label: 'DeepSeek V4-Flash (推荐)', recommended: true },
			{ id: 'deepseek-v4-pro', label: 'DeepSeek V4-Pro (最强)' },
			{ id: 'deepseek-chat', label: 'deepseek-chat (已停用)', legacy: true }
		]
	},
	moonshot: {
		checked: CHECKED,
		source: 'https://platform.kimi.ai/docs/models',
		models: [
			{ id: 'moonshot-v1-8k', label: 'moonshot-v1-8k (推荐)', recommended: true },
			{ id: 'moonshot-v1-32k', label: 'moonshot-v1-32k' },
			{ id: 'moonshot-v1-128k', label: 'moonshot-v1-128k (长文)' },
			{ id: 'kimi-k2', label: 'Kimi K2' }
		]
	},
	qwen: {
		checked: CHECKED,
		source: 'https://help.aliyun.com/zh/model-studio/models',
		models: [
			{ id: 'qwen-plus', label: 'qwen-plus (推荐)', recommended: true },
			{ id: 'qwen-max', label: 'qwen-max (最强)' },
			{ id: 'qwen-turbo', label: 'qwen-turbo (最省)' },
			{ id: 'qwen-long', label: 'qwen-long (长文)' }
		]
	},
	zhipu: {
		checked: CHECKED,
		source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-4',
		models: [
			{ id: 'glm-4-flash', label: 'GLM-4-Flash (推荐 · 免费)', recommended: true },
			{ id: 'glm-4-plus', label: 'GLM-4-Plus (最强)' },
			{ id: 'glm-4-air', label: 'GLM-4-Air (性价比)' },
			{ id: 'glm-4-flashx', label: 'GLM-4-FlashX (快)' }
		]
	},
	openrouter: {
		checked: CHECKED,
		source: 'https://openrouter.ai/models',
		models: [
			{ id: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini (推荐)', recommended: true },
			{ id: 'anthropic/claude-sonnet-4.5', label: 'anthropic/claude-sonnet-4.5' },
			{ id: 'deepseek/deepseek-chat', label: 'deepseek/deepseek-chat' },
			{ id: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash' }
		]
	},
	siliconflow: {
		checked: CHECKED,
		source: 'https://www.siliconflow.com/models',
		models: [
			{ id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5-7B-Instruct (推荐 · 免费)', recommended: true },
			{ id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen2.5-72B-Instruct (最强)' },
			{ id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3' }
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
			{ id: 'qwen2.5', label: 'qwen2.5 (推荐)', recommended: true },
			{ id: 'llama3.1', label: 'llama3.1' },
			{ id: 'gemma2', label: 'gemma2' },
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
