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

test('空值 / bing.com 不算覆盖;解析失败 fail-closed 算覆盖 (P3, 2.0.10)', () => {
	assert.equal(hasCustomBingBase(undefined), false);
	assert.equal(hasCustomBingBase(''), false);
	assert.equal(hasCustomBingBase('   '), false);
	assert.equal(hasCustomBingBase('https://www.bing.com'), false);
	assert.equal(hasCustomBingBase('https://cn.bing.com/'), false);
	assert.equal(hasCustomBingBase('https://bing.com'), false);
	// 2.0.10: 非空但解析失败(漏 scheme 的内网代理)= 用户想覆盖但写错了 ——
	// 按「未覆盖」处理会静默出网微软,必须 fail-closed。
	assert.equal(hasCustomBingBase('not a url'), true);
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

// ---- 3.1.9: Bing 的限流信号做成 RATE_LIMITED ------------------------------------
//
// Bing 抓取通道被限流时不是 HTTP 429,而是 200 里带 {statusCode: 429},或一个静默的空 200;
// 此前两者都是 BAD_RESPONSE,车道限流失明,按 400ms 快速重试继续锤。
test('3.1.9:bingRateLimited 是 RATE_LIMITED + 429 + 有界 retryAfterMs', async () => {
	const { bingRateLimited, BING_RATE_LIMIT_BACKOFF_MS } = await import('../../src/translation/providers/bingFree');
	const err = bingRateLimited('x');
	assert.equal(err.code, 'RATE_LIMITED');
	assert.equal(err.httpStatus, 429);
	assert.equal(err.retryable, true);
	assert.equal((err as { retryAfterMs?: number }).retryAfterMs, BING_RATE_LIMIT_BACKOFF_MS);
	assert.ok(BING_RATE_LIMIT_BACKOFF_MS >= 1000 && BING_RATE_LIMIT_BACKOFF_MS <= 10000, '退避有界:不是无限重试,也不是无限等待');
});

test('3.1.9:抓取通道里 statusCode 429 与二次空 200 都走 RATE_LIMITED,不再刷会话快速重试', async () => {
	const { readFileSync } = await import('node:fs');
	const { join } = await import('node:path');
	// 不剥注释:源码里 Accept: '*\/*' 会让块注释剥离器把后面整段吃掉;下面的锚点全是代码,不是注释。
	const src = readFileSync(join(process.cwd(), 'src/translation/providers/bingFree.ts'), 'utf8');
	const scrape = src.slice(src.indexOf('async function translateViaScrape('));
	const s429 = scrape.indexOf("if (statusCode === 429) {");
	const refresh = scrape.indexOf('if (allowRetry) {\n\t\t\tawait getSession(settings.timeoutMs, signal, true);');
	assert.ok(s429 > 0 && refresh > s429, '429 判定必须排在"刷会话重试"之前');
	assert.match(scrape, /e\.code === 'BAD_RESPONSE' && \/empty body\/i\.test\(e\.message\)\) \{\s*throw bingRateLimited\(/,
		'换过主机再来一次仍是空 200 → 限流');
});
