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
 * Lists compiled 2026-11-19 (5.0) from each provider's official docs (linked per
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

const CHECKED = '2026-11-19';

export const MODEL_CATALOG: Record<string, ProviderCatalogEntry> = {
	openai: {
		checked: CHECKED,
		source: 'https://developers.openai.com/api/docs/models',
		models: [
			// GPT-6 family (2026-11): Luna = cost-sensitive high volume, Terra = fast,
			// Sol = balance, Astra = hardest tasks. gpt-5 / gpt-5-mini / gpt-4.1*
			// are scheduled for shutdown and are no longer offered here.
			{ id: 'gpt-6-luna', group: 'recommended', recommended: true },
			{ id: 'gpt-6.2-sol', group: 'quality' },
			{ id: 'gpt-6.2-astra', group: 'quality' },
			{ id: 'gpt-6.1-terra', group: 'fast' },
			{ id: 'gpt-5.6-luna', group: 'legacy' },
			{ id: 'gpt-5.6-sol', group: 'legacy' },
			{ id: 'gpt-5.5', group: 'legacy' },
			{ id: 'gpt-5.4-mini', group: 'legacy' }
		]
	},
	gemini: {
		checked: CHECKED,
		source: 'https://ai.google.dev/gemini-api/docs/models',
		models: [
			// Google recommends 3.8 Flash or 3.5 Flash-Lite for new projects; the
			// 2.5 family is only available to prior users.
			{ id: 'gemini-3.8-flash', group: 'recommended', recommended: true },
			{ id: 'gemini-4-argon', group: 'quality' },
			{ id: 'gemini-3.6-flash', group: 'quality' },
			{ id: 'gemini-3.5-flash-lite', group: 'fast' },
			{ id: 'gemini-3.1-flash-lite', group: 'fast' },
			{ id: 'gemini-3.1-pro-preview', group: 'preview' },
			{ id: 'gemini-3-flash-preview', group: 'preview' },
			{ id: 'gemini-2.5-flash', group: 'legacy' },
			{ id: 'gemini-2.5-flash-lite', group: 'legacy' },
			{ id: 'gemini-2.5-pro', group: 'legacy' }
		]
	},
	anthropic: {
		checked: CHECKED,
		source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
		models: [
			{ id: 'claude-sonnet-5-5', group: 'recommended', recommended: true },
			{ id: 'claude-opus-5-5', group: 'quality' },
			{ id: 'claude-fable-5-2', group: 'quality' },
			{ id: 'claude-haiku-5-5', group: 'fast' },
			{ id: 'claude-sonnet-5', group: 'legacy' },
			{ id: 'claude-opus-5', group: 'legacy' },
			{ id: 'claude-fable-5-1', group: 'legacy' },
			{ id: 'claude-opus-4-8', group: 'legacy' },
			{ id: 'claude-haiku-4-5', group: 'legacy' }
		]
	},
	deepseek: {
		checked: CHECKED,
		source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
		// deepseek-flash = V4.1 Flash; V4 Pro remains available.
		models: [
			{ id: 'deepseek-flash', group: 'recommended', recommended: true },
			{ id: 'deepseek-v4-pro', group: 'quality' }
		]
	},
	moonshot: {
		checked: CHECKED,
		source: 'https://platform.kimi.ai/docs/models',
		models: [
			// Base https://api.moonshot.ai/v1. K3 / K3.1 always think (effort low/high/max),
			// temperature fixed. kimi-k2.6 is closed to new registrations; code models excluded.
			{ id: 'kimi-k3', group: 'recommended', recommended: true },
			{ id: 'kimi-k3.1-pro', group: 'quality' },
			{ id: 'kimi-k3.1-pro-highspeed', group: 'fast' },
			{ id: 'kimi-k2.6', group: 'legacy' }
		]
	},
	qwen: {
		checked: CHECKED,
		source: 'https://help.aliyun.com/zh/model-studio/text-generation-model',
		models: [
			{ id: 'qwen3.7-plus', group: 'recommended', recommended: true },
			{ id: 'qwen4-max', group: 'quality' },
			{ id: 'qwen3.8-flash', group: 'fast' },
			{ id: 'qwen3.8-max', group: 'legacy' },
			{ id: 'qwen3.7-flash', group: 'legacy' }
		]
	},
	zhipu: {
		checked: CHECKED,
		source: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
		models: [
			{ id: 'glm-5.3', group: 'recommended', recommended: true },
			{ id: 'glm-5.3-flashx', group: 'fast' },
			{ id: 'glm-5.3-flash', group: 'fast' },
			{ id: 'glm-4.7-flash', group: 'fast', label: 'glm-4.7-flash(免费)' },
			{ id: 'glm-5.2', group: 'legacy' },
			{ id: 'glm-4.7', group: 'legacy' },
			{ id: 'glm-4.5-air', group: 'legacy' }
		]
	},
	groq: {
		checked: CHECKED,
		source: 'https://console.groq.com/docs/models',
		models: [
			// llama-3.x were deprecated for free/dev tiers (2026-08-16); qwen3.6-27b shut down.
			{ id: 'openai/gpt-oss-120b', group: 'recommended', recommended: true },
			{ id: 'openai/gpt-oss-20b', group: 'fast' },
			{ id: 'qwen/qwen3.8-27b', group: 'preview' },
			{ id: 'minimaxai/minimax-m2.7', group: 'preview' }
		]
	},
	openrouter: {
		checked: CHECKED,
		source: 'https://openrouter.ai/models',
		models: [
			// Meta-router with 600+ models — common cross-vendor entries only;
			// the custom input is essential here.
			{ id: 'openrouter/auto', group: 'recommended', recommended: true },
			{ id: 'openai/gpt-6.2-sol', group: 'quality' },
			{ id: 'anthropic/claude-sonnet-5.5', group: 'quality' },
			{ id: 'anthropic/claude-opus-5.5', group: 'quality' },
			{ id: 'qwen/qwen4-max', group: 'quality' },
			{ id: 'moonshotai/kimi-k3', group: 'quality' },
			{ id: 'deepseek/deepseek-v4-pro', group: 'quality' },
			{ id: 'google/gemini-3.8-flash', group: 'fast' },
			{ id: 'deepseek/deepseek-v4.1-flash', group: 'fast' },
			{ id: 'qwen/qwen3.8-flash', group: 'fast' },
			{ id: 'anthropic/claude-haiku-4.5', group: 'legacy' }
		]
	},
	siliconflow: {
		checked: CHECKED,
		source: 'https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions',
		models: [
			// Only ids listed in SiliconFlow's chat-completions model enum; newer
			// deployments (e.g. V4.1 Flash, GLM-5.3) can be typed in the custom box.
			{ id: 'deepseek-ai/DeepSeek-V4-Flash', group: 'recommended', recommended: true },
			{ id: 'deepseek-ai/DeepSeek-V4-Pro', group: 'quality' },
			{ id: 'zai-org/GLM-5.1', group: 'quality' },
			{ id: 'moonshotai/Kimi-K2.6', group: 'quality' },
			{ id: 'Qwen/Qwen3.5-397B-A17B', group: 'quality' },
			{ id: 'Qwen/Qwen3.6-35B-A3B', group: 'fast' },
			{ id: 'zai-org/GLM-4.5-Air', group: 'fast' },
			{ id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', group: 'legacy' }
		]
	},
	ollama: {
		checked: CHECKED,
		source: 'https://ollama.com/library',
		models: [
			// Local — you must `ollama pull` the model first; type whatever you have.
			{ id: 'qwen3.5', group: 'recommended', recommended: true },
			{ id: 'qwen3.6', group: 'quality' },
			{ id: 'gemma4', group: 'quality' },
			{ id: 'gpt-oss', group: 'quality' },
			{ id: 'qwen3', group: 'fast' },
			{ id: 'gemma3', group: 'fast' },
			{ id: 'llama3.3', group: 'legacy' }
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
