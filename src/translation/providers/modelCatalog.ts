/**
 * Built-in model catalog.
 *
 * A small, curated, GROUPED list per provider of current, paper-translation-
 * suitable TEXT models — recommended first, then quality / fast / preview /
 * legacy, and always a "自定义模型…" escape hatch. Deliberately excludes image,
 * audio/realtime, embedding, code-only, safety and retiring models.
 *
 * This is a *fallback for the picker*, NEVER a call whitelist: a model the user
 * types themselves is always shown and used. Free MT engines (Bing/Google) and
 * DeepL take no model, so they are absent — see providerNeedsModel().
 * OpenAI-compatible / Custom endpoints have no catalog on purpose (the backend
 * is unknown), so the picker shows only the custom input.
 *
 * Lists compiled 2026-08-10 from each provider's official docs (linked per
 * entry). Defaults favor low latency + stable structured output over the
 * strongest/most-expensive model.
 */

export type ModelGroup = 'recommended' | 'quality' | 'fast' | 'preview' | 'legacy';

/** Display order and headers for the grouped picker. */
export const MODEL_GROUP_ORDER: ModelGroup[] = ['recommended', 'quality', 'fast', 'preview', 'legacy'];
export const MODEL_GROUP_LABELS: Record<ModelGroup, string> = {
	recommended: '推荐',
	quality: '高质量',
	fast: '快速 / 低成本',
	preview: '预览版',
	legacy: '旧版兼容'
};

export interface CatalogModel {
	/** Exact model string passed to the API. */
	id: string;
	/** Optional friendly label; falls back to the id. */
	label?: string;
	/** Which section of the picker this model sits in. */
	group: ModelGroup;
	/** The single recommended default (first one wins). */
	recommended?: boolean;
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
		source: 'https://developers.openai.com/api/docs/models/all',
		models: [
			{ id: 'gpt-5.6-luna', group: 'recommended', recommended: true },
			{ id: 'gpt-5.6-terra', group: 'quality' },
			{ id: 'gpt-5.6-sol', group: 'quality' },
			{ id: 'gpt-5.5', group: 'quality' },
			{ id: 'gpt-5.4', group: 'quality' },
			{ id: 'gpt-5.4-mini', group: 'fast' },
			{ id: 'gpt-5.4-nano', group: 'fast' },
			{ id: 'gpt-5-mini', group: 'legacy' },
			{ id: 'gpt-4.1', group: 'legacy' },
			{ id: 'gpt-4.1-mini', group: 'legacy' }
		]
	},
	gemini: {
		checked: CHECKED,
		source: 'https://ai.google.dev/gemini-api/docs/models',
		models: [
			// 2026-04 起 Google 收紧免费档:免费 API Key 只开放 2.5-flash / lite;
			// 3.x 与 Pro 需付费档 — 默认必须选对所有账户都可用的。
			{ id: 'gemini-2.5-flash', group: 'recommended', recommended: true },
			{ id: 'gemini-2.5-flash-lite', group: 'fast' },
			{ id: 'gemini-3.6-flash', label: 'gemini-3.6-flash（需付费档）', group: 'quality' },
			{ id: 'gemini-3.5-flash', label: 'gemini-3.5-flash（需付费档）', group: 'quality' },
			{ id: 'gemini-2.5-pro', label: 'gemini-2.5-pro（需付费档）', group: 'quality' },
			{ id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite（需付费档）', group: 'fast' },
			{ id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview（预览·需付费档）', group: 'preview' }
		]
	},
	anthropic: {
		checked: CHECKED,
		source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
		models: [
			{ id: 'claude-sonnet-5', group: 'recommended', recommended: true },
			{ id: 'claude-opus-5', group: 'quality' },
			{ id: 'claude-fable-5', group: 'quality' },
			{ id: 'claude-haiku-4-5', group: 'fast' },
			{ id: 'claude-opus-4-8', group: 'legacy' },
			{ id: 'claude-opus-4-7', group: 'legacy' },
			{ id: 'claude-sonnet-4-6', group: 'legacy' }
		]
	},
	deepseek: {
		checked: CHECKED,
		source: 'https://api-docs.deepseek.com/api/list-models',
		models: [
			{ id: 'deepseek-v4-flash', group: 'recommended', recommended: true },
			{ id: 'deepseek-v4-pro', group: 'quality' }
		]
	},
	moonshot: {
		checked: CHECKED,
		source: 'https://platform.kimi.ai/docs/models',
		models: [
			// Base https://api.moonshot.ai/v1. kimi-k2.7-code is code-focused → excluded.
			{ id: 'kimi-k3', group: 'recommended', recommended: true },
			{ id: 'kimi-k2.6', group: 'quality' },
			{ id: 'kimi-k2.5', group: 'legacy' }
		]
	},
	qwen: {
		checked: CHECKED,
		source: 'https://help.aliyun.com/zh/model-studio/text-generation-model',
		models: [
			// Old aliases qwen-plus/max/turbo are retiring → excluded.
			{ id: 'qwen3.7-plus', group: 'recommended', recommended: true },
			{ id: 'qwen3.7-max', group: 'quality' },
			{ id: 'qwen3.6-flash', group: 'fast' },
			{ id: 'qwen3.8-max-preview', label: 'qwen3.8-max-preview（预览）', group: 'preview' },
			{ id: 'qwen3.6-plus', group: 'legacy' }
		]
	},
	zhipu: {
		checked: CHECKED,
		source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5',
		models: [
			{ id: 'glm-5', group: 'recommended', recommended: true },
			{ id: 'glm-4.7', group: 'quality' },
			{ id: 'glm-4.5-air', group: 'fast' },
			{ id: 'glm-4.5-flash', group: 'fast' },
			{ id: 'glm-4-flash-250414', group: 'legacy' },
			{ id: 'glm-4-air-250414', group: 'legacy' },
			{ id: 'glm-4-flashx-250414', group: 'legacy' }
		]
	},
	groq: {
		checked: CHECKED,
		source: 'https://console.groq.com/docs/models',
		models: [
			{ id: 'llama-3.3-70b-versatile', group: 'recommended', recommended: true },
			{ id: 'openai/gpt-oss-120b', group: 'quality' },
			{ id: 'qwen/qwen3.6-27b', group: 'quality' },
			{ id: 'minimaxai/minimax-m2.7', group: 'quality' },
			{ id: 'llama-3.1-8b-instant', group: 'fast' },
			{ id: 'openai/gpt-oss-20b', group: 'fast' }
		]
	},
	openrouter: {
		checked: CHECKED,
		source: 'https://openrouter.ai/docs/guides/overview/models',
		models: [
			// Meta-router with 400+ models — these are common cross-vendor entries;
			// the custom input is essential here.
			{ id: 'openrouter/auto', group: 'recommended', recommended: true },
			{ id: 'anthropic/claude-sonnet-5', group: 'quality' },
			{ id: 'openai/gpt-5.6-luna', group: 'quality' },
			{ id: 'google/gemini-3.6-flash', group: 'quality' },
			{ id: 'deepseek/deepseek-v4-pro', group: 'quality' },
			{ id: 'qwen/qwen3.7-plus', group: 'quality' },
			{ id: 'moonshotai/kimi-k3', group: 'quality' },
			{ id: 'openai/gpt-5.4-mini', group: 'fast' },
			{ id: 'google/gemini-2.5-flash', group: 'fast' },
			{ id: 'anthropic/claude-haiku-4.5', group: 'fast' },
			{ id: 'deepseek/deepseek-v4-flash', group: 'fast' }
		]
	},
	siliconflow: {
		checked: CHECKED,
		source: 'https://www.siliconflow.com/models',
		models: [
			// Aggregator — exact ids follow the SiliconFlow console; custom stays.
			{ id: 'deepseek-ai/DeepSeek-V4-Flash', group: 'recommended', recommended: true },
			{ id: 'deepseek-ai/DeepSeek-V4-Pro', group: 'quality' },
			{ id: 'Qwen/Qwen3.7-Plus', group: 'quality' },
			{ id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', group: 'quality' },
			{ id: 'THUDM/GLM-4.5-Air', group: 'quality' },
			{ id: 'Qwen/Qwen3.6-Flash', group: 'fast' },
			{ id: 'Qwen/Qwen3-30B-A3B-Instruct-2507', group: 'fast' },
			{ id: 'moonshotai/Kimi-K2.5', group: 'fast' }
		]
	},
	ollama: {
		checked: CHECKED,
		source: 'https://ollama.com/library',
		models: [
			// Local — you must `ollama pull` the model first; type whatever you have.
			{ id: 'qwen3.5', group: 'recommended', recommended: true },
			{ id: 'llama3.3', group: 'quality' },
			{ id: 'deepseek-r1', group: 'quality' },
			{ id: 'qwen3', group: 'fast' },
			{ id: 'gemma3', group: 'fast' },
			{ id: 'mistral-small3.1', group: 'fast' }
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
