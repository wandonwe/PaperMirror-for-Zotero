/**
 * 端点脱敏 (2.8.6, 导出方案 P1)。
 *
 * 诊断里此前带的是 `endpointHost` —— 真实主机名。排障时它确实有用,但代价是:
 * 一份"可以放心贴进 issue"的诊断,会把用户自建网关的域名、公司内网主机名、
 * 甚至带端口的内网地址一起公开出去。**这是不该由用户在贴之前自己检查的事。**
 *
 * 所以改为固定枚举 —— 排障真正需要知道的只是"用的是官方端点还是自定义的",
 * 而这五个取值把它说清楚了:
 *
 *   `official` 空或与该服务商默认 baseURL 等价 · `local` 回环地址 ·
 *   `invalid` URL 解析不了(这本身就是故障线索) · `custom` 其余 ·
 *   `unknown` 连服务商配置都读不到
 *
 * **不导出域名、IP、端口、路径,也不导出主机名哈希** —— 哈希看着无害,但候选集
 * 小到可以枚举(常见网关就那么几个),等于没脱敏。
 */

export type EndpointKind = 'official' | 'custom' | 'local' | 'invalid' | 'unknown';

/** 回环地址: 本机跑的模型,既不是官方端点也不该算"自定义远端"。 */
function isLoopback(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1'
		|| hostname === '[::1]' || hostname === '::1';
}

/** 尾斜杠与大小写不该让同一个端点被判成 custom。 */
function canonical(url: string): string {
	return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 判端点类别。**只返回枚举**,任何情况下都不回传 URL 的任何片段。
 *
 * @param configured 用户配置的 baseURL(空 = 用服务商默认值)
 * @param defaultBaseURL 该服务商的默认 baseURL(注册表里的常量)
 */
export function classifyEndpoint(configured: string | undefined | null, defaultBaseURL?: string | null): EndpointKind {
	const raw = (configured ?? '').trim();
	if (!raw) {
		// 没配就是用默认端点。默认端点本身是 localhost 的(Ollama)如实报 local。
		const fallback = (defaultBaseURL ?? '').trim();
		if (!fallback) {
			return 'official';
		}
		try {
			return isLoopback(new URL(fallback).hostname) ? 'local' : 'official';
		}
		catch {
			return 'official';
		}
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	}
	catch {
		return 'invalid';
	}
	if (isLoopback(parsed.hostname)) {
		return 'local';
	}
	if (defaultBaseURL && canonical(raw) === canonical(defaultBaseURL)) {
		return 'official';
	}
	return 'custom';
}

export interface EngineExportRow {
	id: string;
	model: string;
	endpointKind: EndpointKind;
	customEndpoint: boolean;
	keyConfigured: boolean;
	requiresKey: boolean;
	selfCheckFailed?: true;
}

export interface EngineSettingsLike {
	apiBaseURL?: string | null;
	model?: string | null;
}

/**
 * 引擎自检行(脱敏版)。密钥只报"配没配",端点只报类别,模型名照留 —— 模型名是
 * 公开的产品标识,不是用户的私有信息。
 *
 * `selfCheckFailed` 只报一个布尔: 自检异常的原始消息可能带端点 URL,不能进诊断。
 */
export function engineExportRow(
	id: string,
	settings: EngineSettingsLike | null,
	options: { defaultBaseURL?: string | null; keyConfigured: boolean; requiresKey: boolean }
): EngineExportRow {
	const kind = settings ? classifyEndpoint(settings.apiBaseURL, options.defaultBaseURL) : 'unknown';
	return {
		id,
		model: (settings?.model ?? '').trim() || '(default)',
		endpointKind: kind,
		customEndpoint: kind === 'custom' || kind === 'local',
		keyConfigured: options.keyConfigured,
		requiresKey: options.requiresKey,
		...(settings ? {} : { selfCheckFailed: true as const })
	};
}
