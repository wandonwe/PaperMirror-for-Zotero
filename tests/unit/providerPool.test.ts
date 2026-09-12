import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPool, pickProviderForPage, rankProvidersForPage, laneBandFor, poolLanePlan, prefetchWindowFor, normalizeGlobalMax, normalizePerfMode, customLaneRange, customBandFor } from '../../src/translation/providerPool';

test('page→provider is deterministic and every provider gets some pages', () => {
	const pool = ['openai', 'deepseek', 'moonshot'];
	// Deterministic per page — this is what keeps a page's cache aligned.
	for (let p = 0; p < 5; p++) {
		assert.equal(pickProviderForPage(pool, p), pickProviderForPage(pool, p));
	}
	// Coverage: across many pages every provider owns at least one.
	const owners = new Set(Array.from({ length: 60 }, (_, p) => pickProviderForPage(pool, p)));
	assert.deepEqual([...owners].sort(), [...pool].sort());
});

test('a single-provider pool always answers the primary', () => {
	assert.equal(pickProviderForPage(['openai'], 7), 'openai');
});

test('an invalid page index is deterministic (normalised to page 0)', () => {
	assert.equal(pickProviderForPage(['a', 'b'], -1), pickProviderForPage(['a', 'b'], 0));
	assert.equal(pickProviderForPage(['a', 'b'], Number.NaN), pickProviderForPage(['a', 'b'], 0));
});

// ---- 一致性哈希稳定映射 (2.2.1, 第三批 item1) --------------------------------

test('reordering the pool changes no page assignment (order-independent)', () => {
	for (let p = 0; p < 50; p++) {
		assert.equal(
			pickProviderForPage(['a', 'b', 'c'], p),
			pickProviderForPage(['c', 'a', 'b'], p),
			`page ${p} must not move when only the pool order changes`
		);
	}
});

test('adding a provider only ever moves a page ONTO the new provider', () => {
	const before = ['a', 'b', 'c'];
	const after = ['a', 'b', 'c', 'd'];
	let moved = 0;
	for (let p = 0; p < 300; p++) {
		const o = pickProviderForPage(before, p);
		const n = pickProviderForPage(after, p);
		if (o !== n) {
			moved++;
			// HRW invariant: a page can only migrate to the newcomer, never between
			// two incumbents.
			assert.equal(n, 'd', `page ${p} moved ${o}→${n}, not onto the new provider`);
		}
	}
	// And roughly 1/N migrate — nowhere near the near-total churn of modulo.
	assert.ok(moved > 0 && moved < 300 * 0.5, `expected ~1/4 to move, got ${moved}/300`);
});

test('removing a provider only remaps pages that belonged to it', () => {
	const before = ['a', 'b', 'c'];
	const after = ['a', 'b'];
	for (let p = 0; p < 300; p++) {
		const o = pickProviderForPage(before, p);
		const n = pickProviderForPage(after, p);
		if (o !== 'c') {
			assert.equal(n, o, `page ${p} owned by ${o} must not move when 'c' is removed`);
		}
		else {
			assert.ok(n === 'a' || n === 'b', `orphaned page ${p} must fall to a surviving provider`);
		}
	}
});

test('rankProvidersForPage is a best-first permutation of the pool', () => {
	const pool = ['a', 'b', 'c', 'd'];
	for (let p = 0; p < 10; p++) {
		const rank = rankProvidersForPage(pool, p);
		assert.equal(rank.length, pool.length);
		assert.deepEqual([...rank].sort(), [...pool].sort(), 'no dups, no drops');
		assert.equal(rank[0], pickProviderForPage(pool, p), 'head of the rank is the owner');
	}
});

test('buildPool keeps the primary first and dedupes', () => {
	assert.deepEqual(buildPool('openai', ['deepseek', 'openai', 'deepseek', '']), ['openai', 'deepseek']);
	assert.deepEqual(buildPool('openai', []), ['openai']);
});

test('laneBandFor: per-type bands vary by performance mode', () => {
	const free = { id: 'bing-free', requiresApiKey: false, local: false };
	const llm = { id: 'openai', requiresApiKey: true, local: false };
	const local = { id: 'ollama', requiresApiKey: false, local: true };
	// Free engines are one lane in every mode.
	assert.deepEqual(laneBandFor(free, 'stable'), { min: 1, initial: 1, max: 1 });
	assert.deepEqual(laneBandFor(free, 'high'), { min: 1, initial: 1, max: 1 });
	// Cloud LLM: stable fixed 2, auto 3→6, high fixed 6.
	assert.deepEqual(laneBandFor(llm, 'stable'), { min: 1, initial: 2, max: 2 });
	assert.deepEqual(laneBandFor(llm, 'auto'), { min: 1, initial: 3, max: 6 });
	assert.deepEqual(laneBandFor(llm, 'high'), { min: 1, initial: 6, max: 6 });
	// Local: stable 1, auto 1→2, high 2.
	assert.deepEqual(laneBandFor(local, 'auto'), { min: 1, initial: 1, max: 2 });
});

test('poolLanePlan: bands per provider + sum of initial caps', () => {
	// Screenshot case (auto): Google free + OpenAI + Gemini → 1 + 3 + 3 = 7 initial.
	const plan = poolLanePlan([
		{ id: 'google-free', requiresApiKey: false, local: false },
		{ id: 'openai', requiresApiKey: true, local: false },
		{ id: 'gemini', requiresApiKey: true, local: false }
	], 'auto');
	assert.equal(plan.initialSum, 7);
	assert.deepEqual(plan.laneBands.openai, { min: 1, initial: 3, max: 6 });
	assert.deepEqual(plan.laneBands['google-free'], { min: 1, initial: 1, max: 1 });
	// Stable lowers the LLM lanes: 1 + 2 + 2 = 5.
	assert.equal(poolLanePlan([
		{ id: 'google-free', requiresApiKey: false, local: false },
		{ id: 'openai', requiresApiKey: true, local: false },
		{ id: 'gemini', requiresApiKey: true, local: false }
	], 'stable').initialSum, 5);
});

test('prefetchWindowFor: per-mode windows (2.1.9 收窄)', () => {
	// 省流: 只当前 + 下一页。
	assert.deepEqual(prefetchWindowFor('stable', 3), { forward: 1, backward: 1 });
	// 高速: ≤5,不再固定 12。
	assert.deepEqual(prefetchWindowFor('high', 3), { forward: 5, backward: 1 });
	// auto: 顺读渐扩,单引擎 1、随池到 3。
	assert.deepEqual(prefetchWindowFor('auto', 1), { forward: 1, backward: 1 });
	assert.deepEqual(prefetchWindowFor('auto', 3), { forward: 3, backward: 1 });
	assert.deepEqual(prefetchWindowFor('auto', 9), { forward: 3, backward: 1 }); // clamp 3
});

test('normalizeGlobalMax: 0/legacy → 8 (2.1.7 默认降峰), clamp [2,24]', () => {
	assert.equal(normalizeGlobalMax(0), 8);
	assert.equal(normalizeGlobalMax(undefined), 8);
	assert.equal(normalizeGlobalMax(-5), 8);
	assert.equal(normalizeGlobalMax(1), 2);
	assert.equal(normalizeGlobalMax(3), 3);
	assert.equal(normalizeGlobalMax(99), 24);
});

test('normalizePerfMode: defaults to auto for anything unknown', () => {
	assert.equal(normalizePerfMode('stable'), 'stable');
	assert.equal(normalizePerfMode('high'), 'high');
	assert.equal(normalizePerfMode('auto'), 'auto');
	assert.equal(normalizePerfMode('nonsense'), 'auto');
	assert.equal(normalizePerfMode(undefined), 'auto');
});

test('normalizePerfMode accepts custom', () => {
	assert.equal(normalizePerfMode('custom'), 'custom');
});

test('customLaneRange: per-type limits, free locked', () => {
	assert.deepEqual(customLaneRange({ id: 'openai', requiresApiKey: true, local: false }), { min: 1, max: 6, locked: false, default: 3 });
	assert.deepEqual(customLaneRange({ id: 'deepl', requiresApiKey: true, local: false }), { min: 1, max: 4, locked: false, default: 3 });
	assert.deepEqual(customLaneRange({ id: 'ollama', requiresApiKey: false, local: true }), { min: 1, max: 2, locked: false, default: 1 });
	assert.deepEqual(customLaneRange({ id: 'bing-free', requiresApiKey: false, local: false }), { min: 1, max: 1, locked: true, default: 1 });
});

test('customBandFor: clamps to the provider range; undefined → default', () => {
	const llm = { id: 'openai', requiresApiKey: true, local: false };
	assert.deepEqual(customBandFor(llm, 4), { min: 1, initial: 4, max: 4 });
	assert.deepEqual(customBandFor(llm, 99), { min: 1, initial: 6, max: 6 }); // clamp to 6
	assert.deepEqual(customBandFor(llm, undefined), { min: 1, initial: 3, max: 3 }); // default 3
	// Free is always 1 regardless of the requested value.
	assert.deepEqual(customBandFor({ id: 'bing-free', requiresApiKey: false, local: false }, 5), { min: 1, initial: 1, max: 1 });
});

test('poolLanePlan(custom) uses the user values, free stays 1', () => {
	const caps = [
		{ id: 'openai', requiresApiKey: true, local: false },
		{ id: 'bing-free', requiresApiKey: false, local: false }
	];
	const plan = poolLanePlan(caps, 'custom', { openai: 5 });
	assert.equal(plan.laneBands.openai!.initial, 5);
	assert.equal(plan.laneBands['bing-free']!.initial, 1);
	assert.equal(plan.initialSum, 6);
});

// ---- 按页分流的分布质量 (2.11.2) ---------------------------------------------
//
// 真机第十二轮:`requestTimings[].provider` 把「慢在哪」答死了 —— 同一份文档里
// google-free 的请求 95–450 ms,openai 1434–9453 ms,gemini 11984–16329 ms。
// 页与页之间差十几倍,差的是**引擎**,不是代码。
//
// 而归属是 HRW 算的,`pickProviderForPage` 对真机 12 页的预测 12/12 吻合 ——
// 分配确定且可复现。问题出在分布本身:FNV-1a 的最后一步是 (h ^ c) * PRIME,
// 页号在字符串末尾,之后再无混淆,相邻页的分数只差一个 PRIME(16777619),
// 而服务商之间差 10^9 —— 排名几乎不动,于是**成片聚集**。

const POOL5 = ['openai', 'bing-free', 'google-free', 'deepseek', 'gemini'];

/** 连续归属同一家的段数。段数越接近页数,相邻页越可能换家。 */
function runCount(pool: string[], pages: number): number {
	let runs = 1;
	for (let i = 1; i < pages; i++) {
		if (pickProviderForPage(pool, i) !== pickProviderForPage(pool, i - 1)) {
			runs++;
		}
	}
	return runs;
}

function tally(pool: string[], pages: number): Map<string, number> {
	const c = new Map(pool.map(p => [p, 0]));
	for (let i = 0; i < pages; i++) {
		const q = pickProviderForPage(pool, i);
		c.set(q, (c.get(q) ?? 0) + 1);
	}
	return c;
}

/** 卡方统计量(自由度 = 家数-1)。自由度 4 时 5% 临界值 9.49。 */
function chiSquare(counts: Map<string, number>, pages: number): number {
	const expected = pages / counts.size;
	let x = 0;
	for (const observed of counts.values()) {
		x += ((observed - expected) ** 2) / expected;
	}
	return x;
}

test('每一家都分得到页 —— 补雪崩前有两家一页都没有 (2.11.2)', () => {
	const counts = tally(POOL5, 30);
	for (const [id, n] of counts) {
		assert.ok(n > 0, `${id} 一页都没分到 —— 用户把它配进 parallelProviders 就是要用它的`);
	}
});

test('分布不显著偏离均匀 (2.11.2)', () => {
	// 补雪崩前:30 页 χ² = 32.0(16/10/4/0/0),远超临界值。补之后约 1.7。
	for (const pages of [30, 121]) {
		const x = chiSquare(tally(POOL5, pages), pages);
		assert.ok(x < 9.49,
			`${pages} 页的 χ² = ${x.toFixed(1)},超过自由度 4 的 5% 临界值 9.49 —— 分布不均`);
	}
});

test('相邻页尽量换家 —— 不许连着十几页压在同一家 (2.11.2)', () => {
	// 这才是用户感受到的那件事:补雪崩前 30 页只有 5 段,其中一段是
	// **连续 10 页全归 gemini**,而 gemini 实测 12–16 秒/页。
	// "读着读着连着十几页每页等十几秒" —— 长文档变慢最初就是这么被报上来的。
	const pages = 30;
	assert.ok(runCount(POOL5, pages) >= pages * 0.6,
		`30 页只有 ${runCount(POOL5, pages)} 段 —— 成片聚集会把最慢的引擎连着压在一段连续阅读上`);
	// 最长连续段也要有界。
	let longest = 1, cur = 1;
	for (let i = 1; i < 60; i++) {
		if (pickProviderForPage(POOL5, i) === pickProviderForPage(POOL5, i - 1)) {
			cur++; longest = Math.max(longest, cur);
		}
		else {
			cur = 1;
		}
	}
	assert.ok(longest <= 4, `最长连续 ${longest} 页归同一家 —— 补雪崩前是 10`);
});

test('哈希仍是纯的、确定的 (2.11.2 守住既有性质)', () => {
	for (let i = 0; i < 20; i++) {
		assert.equal(pickProviderForPage(POOL5, i), pickProviderForPage(POOL5, i),
			'同样输入必须同样输出');
		// 池内顺序不影响归属 —— 模块开头就写着"改顺序:零变化"。
		assert.equal(pickProviderForPage(POOL5, i), pickProviderForPage([...POOL5].reverse(), i),
			'归属只认 id 与页号,与池内位置无关');
	}
});

test('末位字符的改动要扩散到全部 32 位 (2.11.2 盯根因)', () => {
	const src = readFileSync(join(process.cwd(), 'src/translation/providerPool.ts'), 'utf8');
	const fn = src.slice(src.indexOf('function hrwScore('), src.indexOf('\n}', src.indexOf('function hrwScore(')));
	// FNV 循环之后必须还有混淆,否则相邻页只差一个 PRIME。
	const afterLoop = fn.slice(fn.lastIndexOf('}') );
	assert.ok(/h \^= h >>> \d+/.test(fn) && /Math\.imul\(h, 0x[0-9a-f]+\)/.test(afterLoop || fn),
		'FNV 循环之后要有 移位-异或-乘法 的雪崩步骤');
	assert.ok((fn.match(/h \^= h >>> /g) ?? []).length >= 3,
		'至少三次移位异或 —— 少了扩散不充分');
});
