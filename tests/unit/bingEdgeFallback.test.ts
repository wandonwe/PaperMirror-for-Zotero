import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCustomBingBase } from '../../src/translation/providers/bingFree';
import { resolveBingApiBase } from '../../src/translation/providers/freeEngineUtils';

/**
 * P1-3 (2.0.1): translateViaScrape 尊重 settings.apiBaseURL,但 translateViaEdge
 * 的端点是硬编码的微软主机,完全不读它。bing-free 又是默认引擎 —— 机构用户把
 * Base URL 指向内网代理正是为了让论文不出网,代理一次 502 就会让原文被 POST
 * 到 api-edge.cognitive.microsofttranslator.com,且 UI 毫无提示。
 * 现在:配置了自定义 Base URL 时禁用 Edge 兜底,改为报错让用户看见。
 */

test('自定义第三方 Base URL 被识别为覆盖', () => {
	assert.equal(hasCustomBingBase('https://mt.corp.internal'), true);
	assert.equal(hasCustomBingBase('https://mt.corp.internal/'), true);
	assert.equal(hasCustomBingBase('http://192.168.1.10:8080'), true);
});

test('空值 / bing.com / 解析失败都不算覆盖(仍走官方通道)', () => {
	assert.equal(hasCustomBingBase(undefined), false);
	assert.equal(hasCustomBingBase(''), false);
	assert.equal(hasCustomBingBase('   '), false);
	assert.equal(hasCustomBingBase('https://www.bing.com'), false);
	assert.equal(hasCustomBingBase('https://cn.bing.com/'), false);
	assert.equal(hasCustomBingBase('https://bing.com'), false);
	assert.equal(hasCustomBingBase('not a url'), false);
});

test('判据与 resolveBingApiBase 严格一致(防两处漂移)', () => {
	const origin = 'https://www.bing.com';
	const cases = ['', '   ', 'https://www.bing.com', 'https://cn.bing.com/', 'https://bing.com',
		'not a url', 'https://mt.corp.internal', 'http://192.168.1.10:8080/'];
	for (const c of cases) {
		const resolved = resolveBingApiBase(c, origin);
		const isOverride = resolved !== origin.replace(/\/+$/, '');
		assert.equal(hasCustomBingBase(c), isOverride,
			`"${c}": hasCustomBingBase 与 resolveBingApiBase 的判定必须一致`);
	}
});
