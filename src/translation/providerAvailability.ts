/**
 * 菜单栏「翻译服务」只列出**已设置**的引擎 (5.0)。
 *
 * 此前菜单把 16 个服务商全部列出 —— 包括用户从没填过密钥、点了只会报
 * 「缺少 API 密钥」的那些。现在按下面的规则过滤,未设置的引擎去「设置…」里配。
 *
 *   - 免费引擎(微软 / 谷歌)无需任何设置,始终可用,始终列出;
 *   - 需要密钥的服务商:已保存密钥才列出;
 *   - OpenAI 兼容 / 自定义端点:填了 Base URL 才列出(后端未知,没有默认地址);
 *   - Ollama(本地,无需密钥):设置里为它保存过配置才列出;
 *   - **当前选中的引擎永远列出** —— 否则菜单里没有勾选项,用户看不出自己在用什么。
 *
 * 纯函数,无 Zotero / DOM 依赖,单测覆盖。
 */

import type { ProviderProfiles } from './providerProfiles';

/** 无需任何设置即可翻译的引擎。 */
export const ZERO_SETUP_PROVIDERS: ReadonlySet<string> = new Set(['bing-free', 'google-free']);

/** 没有默认 Base URL、必须由用户填地址的端点类服务商。 */
const ENDPOINT_PROVIDERS: ReadonlySet<string> = new Set(['openai-compatible', 'custom']);

export interface ProviderAvailabilityInput {
	/** 全部服务商,按注册表顺序。 */
	providers: { id: string; requiresApiKey: boolean }[];
	/** 已保存密钥的服务商 id。 */
	withKey: ReadonlySet<string>;
	/** 每服务商配置(providerProfiles 首选项解析结果)。 */
	profiles: ProviderProfiles;
	/** 当前选中的服务商 id。 */
	current: string;
}

export function isProviderConfigured(
	provider: { id: string; requiresApiKey: boolean },
	withKey: ReadonlySet<string>,
	profiles: ProviderProfiles
): boolean {
	const { id } = provider;
	if (ZERO_SETUP_PROVIDERS.has(id)) {
		return true;
	}
	if (ENDPOINT_PROVIDERS.has(id)) {
		return !!profiles[id]?.apiBaseUrl?.trim();
	}
	if (provider.requiresApiKey) {
		return withKey.has(id);
	}
	// 无需密钥的非免费引擎(Ollama):保存过配置即视为已设置。
	return Object.prototype.hasOwnProperty.call(profiles, id);
}

/** 菜单里应列出的服务商 id,保持注册表顺序。 */
export function configuredProviderIds(input: ProviderAvailabilityInput): string[] {
	return input.providers
		.filter(p => p.id === input.current || isProviderConfigured(p, input.withKey, input.profiles))
		.map(p => p.id);
}
