import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeProviderForPage, fastestProvider, type ProviderThroughput } from '../../src/translation/providerPool';
import { TranslationManager, setHedgeAfterMs, type TranslationDeps } from '../../src/translation/translationManager';

/**
 * 5.0 调度 (真机 Vitamin E 一文: OpenAI 87 字/秒、DeepSeek 392、Gemini 318;
 * 按页固定分配让正在读的页等 22–28 秒)。
 */
const pool = ['openai', 'deepseek', 'gemini'];
const stats: Record<string, ProviderThroughput> = {
	openai: { samples: 9, charsPerSecond: 87 },
	deepseek: { samples: 6, charsPerSecond: 392 },
	gemini: { samples: 5, charsPerSecond: 318 }
};

test('当前页交给测得最快的引擎', () => {
	for (let page = 0; page < 30; page++) {
		const p = routeProviderForPage(pool, page, page, stats);
		assert.ok(p === 'deepseek' || p === 'gemini', `page ${page} → ${p}`);
	}
});

test('当前页前后两页避开慢引擎;更远的页慢引擎照常分到', () => {
	let farSlow = 0;
	for (let page = 0; page < 60; page++) {
		for (const d of [1, 2]) assert.notEqual(routeProviderForPage(pool, page + d, page, stats), 'openai');
		if (routeProviderForPage(pool, page + 10, page, stats) === 'openai') farSlow++;
	}
	assert.ok(farSlow > 0, '慢引擎仍做远处预取,不是被踢出池');
});

test('冷启动(样本不足)与 2.12 加权分配完全一致,不改派', () => {
	const cold = { openai: { samples: 2, charsPerSecond: 50 }, deepseek: { samples: 1, charsPerSecond: 900 } };
	const seen = new Set<string>();
	for (let page = 0; page < 40; page++) seen.add(routeProviderForPage(pool, page, page, cold));
	assert.ok(seen.has('openai'), '没有可信测量时不替用户做决定');
});

test('免费机翻引擎再快也不会顶替大模型', () => {
	const mixed = ['google-free', 'openai', 'deepseek'];
	const s = { ...stats, 'google-free': { samples: 20, charsPerSecond: 6000 } };
	assert.equal(fastestProvider(mixed, s), 'deepseek');
	assert.equal(fastestProvider(mixed, s, 'deepseek'), 'openai');
});

function deps(overrides: Partial<TranslationDeps>): TranslationDeps {
	return {
		extractPage: async pageIndex => [{ id: `b${pageIndex}`, pageIndex, order: 0, type: 'paragraph', sourceText: 'An ordinary source paragraph for testing.' }],
		readCache: async () => null, writeCache: async () => true,
		translateRequest: async request => ({ translations: request.blocks.map(b => ({ id: b.id, translatedText: 'Traduction complète.' })) }),
		getLanguages: () => ({ source: 'en', target: 'fr' }), getDocumentTitle: () => '', getGlossary: () => [], useContext: () => false,
		pageCount: () => 10, laneFor: () => 'openai', poolSize: () => 2, ...overrides
	};
}

test('当前页请求超时未回 → 备选引擎对冲,先回来的用,慢的被取消', async () => {
	setHedgeAfterMs(20);
	let slowAborted = false;
	const m = new TranslationManager(deps({
		hedgeProviderFor: (_p, current) => current === 'openai' ? 'deepseek' : '',
		translateRequest: (request, signal, hooks) => {
			if (hooks?.provider === 'deepseek') {
				return Promise.resolve({ translations: request.blocks.map(b => ({ id: b.id, translatedText: 'Traduction rapide.' })) });
			}
			return new Promise((_, reject) => signal.addEventListener('abort', () => { slowAborted = true; reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); }, { once: true }));
		}
	}), { onPageUpdate: () => {} }, { prefetch: false, maxConcurrent: 2 });
	try {
		await m.ensurePage(0, 10);
		assert.equal(m.getPageState(0)!.translations.get('b0'), 'Traduction rapide.');
		assert.equal(slowAborted, true);
	} finally { m.dispose(); setHedgeAfterMs(8000); }
});

test('主请求按时回来就不对冲;没有备选也不对冲', async () => {
	setHedgeAfterMs(50);
	let hedgeAsked = 0, calls = 0;
	const m = new TranslationManager(deps({
		hedgeProviderFor: () => { hedgeAsked++; return ''; },
		translateRequest: async request => { calls++; return { translations: request.blocks.map(b => ({ id: b.id, translatedText: 'Traduction complète.' })) }; }
	}), { onPageUpdate: () => {} }, { prefetch: false, maxConcurrent: 2 });
	try {
		await m.ensurePage(0, 10);
		assert.equal(hedgeAsked, 0); assert.equal(calls, 1);
	} finally { m.dispose(); setHedgeAfterMs(8000); }
});
