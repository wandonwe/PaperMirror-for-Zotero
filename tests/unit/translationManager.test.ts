import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationManager, looksContextBleed, looksTranslated, untranslatedLatinWords, type PageTranslationState, type TranslationDeps } from '../../src/translation/translationManager';
import type { GlossaryRule, SourceBlock, TranslationRequest, TranslationResponse } from '../../src/types/models';

function makeBlocks(pageIndex: number, n: number): SourceBlock[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `page-${pageIndex}-block-${i}`,
		pageIndex,
		order: i,
		type: 'paragraph' as const,
		sourceText: `Source paragraph ${i} on page ${pageIndex}.`
	}));
}

function makeDeps(overrides: Partial<TranslationDeps> = {}): { deps: TranslationDeps; calls: { translate: number } } {
	const calls = { translate: 0 };
	const cache = new Map<number, { id: string; translatedText: string }[]>();
	const deps: TranslationDeps = {
		extractPage: async (pageIndex) => makeBlocks(pageIndex, 2),
		translateRequest: async (request: TranslationRequest): Promise<TranslationResponse> => {
			calls.translate++;
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '译:' + b.text })) };
		},
		readCache: async (pageIndex) => cache.get(pageIndex) ?? null,
		writeCache: async (pageIndex, _blocks, translations) => { cache.set(pageIndex, translations); },
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Test Doc',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => 10,
		...overrides
	};
	return { deps, calls };
}

test('translates the current page and reports done', async () => {
	const { deps } = makeDeps();
	const states: PageTranslationState[] = [];
	const manager = new TranslationManager(deps, { onPageUpdate: s => states.push({ ...s }) }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const final = manager.getPageState(0)!;
	assert.equal(final.status, 'done');
	assert.equal(final.translations.size, 2);
	assert.equal(final.translations.get('page-0-block-0'), '译:Source paragraph 0 on page 0.');
	manager.dispose();
});

test('second visit uses cache (no extra translate calls)', async () => {
	const { deps, calls } = makeDeps();
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const first = calls.translate;
	// New manager sharing the same cache-backed deps
	const manager2 = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager2.ensurePage(0, 10);
	assert.equal(calls.translate, first, 'no new translate calls on cache hit');
	assert.equal(manager2.getPageState(0)!.fromCache, true);
	manager.dispose();
	manager2.dispose();
});

test('retries only missing ids', async () => {
	let attempt = 0;
	const { deps } = makeDeps({
		translateRequest: async (request) => {
			attempt++;
			if (attempt === 1) {
				// Return only the first block
				return { translations: [{ id: request.blocks[0]!.id, translatedText: '确定' }] };
			}
			// Retry: return the requested (missing) blocks
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '重试译文' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.translations.size, 2);
	assert.equal(state.translations.get('page-0-block-1'), '重试译文');
	manager.dispose();
});

test('salvage: ids dropped by batch AND retry get single-block requests', async () => {
	// The JACC mixed-language page: the provider answers batches but keeps
	// omitting one block's id. The batch retry ALSO omits it. Only a
	// single-block request converges — and even then the model may rewrite
	// the id, which must not matter when there is exactly one block.
	const singleRequests: string[] = [];
	const { deps } = makeDeps({
		translateRequest: async (request) => {
			if (request.blocks.length === 1) {
				singleRequests.push(request.blocks[0]!.id);
				// Model rewrites the id — salvage must still accept it.
				return { translations: [{ id: 'whatever-the-model-said', translatedText: '单独救回' }] };
			}
			// Batches always drop the last block, batch retry included.
			return {
				translations: request.blocks.slice(0, -1).map(b => ({ id: b.id, translatedText: '批量' }))
			};
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	assert.equal(state.translations.size, 2, 'every block translated');
	assert.equal(state.translations.get('page-0-block-1'), '单独救回');
	assert.ok(singleRequests.includes('page-0-block-1'), 'the dropped id went out as a single-block request');
	manager.dispose();
});

test('a page with unrecovered blocks is NOT cached, so a revisit retries', async () => {
	let failSalvage = true;
	let translateCalls = 0;
	const { deps } = makeDeps({
		translateRequest: async (request) => {
			translateCalls++;
			if (request.blocks.length === 1 && failSalvage) {
				// Even the salvage request fails for this block.
				const { PaperMirrorError } = await import('../../src/types/models');
				throw new PaperMirrorError('NETWORK', 'flaky');
			}
			if (request.blocks.length === 1) {
				return { translations: [{ id: request.blocks[0]!.id, translatedText: '第二次成功' }] };
			}
			return { translations: request.blocks.slice(0, -1).map(b => ({ id: b.id, translatedText: '批量' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	assert.equal(manager.getPageState(0)!.status, 'done', 'partial page still shows what it has');
	assert.equal(manager.getPageState(0)!.translations.size, 1);
	assert.ok(translateCalls > 0);

	// Next session: the flaky failure is gone. Because the partial page was
	// never cached, the pipeline runs again and completes.
	failSalvage = false;
	const manager2 = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager2.ensurePage(0, 10);
	const state2 = manager2.getPageState(0)!;
	assert.equal(state2.fromCache, undefined, 'partial result was not served from cache');
	assert.equal(state2.translations.size, 2, 'revisit completes the page');
	manager.dispose();
	manager2.dispose();
});

test('no-text-layer surfaces as its own status', async () => {
	const { deps } = makeDeps({
		extractPage: async () => {
			const { PaperMirrorError } = await import('../../src/types/models');
			throw new PaperMirrorError('NO_TEXT_LAYER', 'needs OCR');
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	assert.equal(manager.getPageState(0)!.status, 'no-text-layer');
	manager.dispose();
});

test('formula placeholders are protected and restored around translation', async () => {
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [{
			id: `page-${pageIndex}-block-0`,
			pageIndex,
			order: 0,
			type: 'paragraph',
			sourceText: 'The equation $E=mc^2$ is famous.'
		}],
		translateRequest: async (request) => {
			// Model must have received a placeholder, not raw formula
			assert.ok(!request.blocks[0]!.text.includes('mc^2'), 'formula should be masked in request');
			// Echo the placeholder back inside the translation
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '这个方程 ' + b.text.match(/⟦PM\d+⟧/)?.[0] + ' 很有名。' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const text = manager.getPageState(0)!.translations.get('page-0-block-0')!;
	assert.ok(text.includes('$E=mc^2$'), 'formula restored');
	manager.dispose();
});

test('scrolling does not cancel an in-flight compress for a still-wanted page', async () => {
	let release: () => void = () => {};
	let compressAborted: boolean | null = null;
	const { deps } = makeDeps();
	const plain = deps.translateRequest;
	deps.translateRequest = async (request, signal) => {
		if (request.blocks.some(b => b.charBudget !== undefined)) {
			// Slow compress round: hold it open so setCurrentPage races it.
			await new Promise<void>(r => { release = r; });
			compressAborted = signal.aborted;
			// Genuinely shorter than the original — the manager accepts it.
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '短译' })) };
		}
		return plain(request, signal);
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const compress = manager.compressBlocks(0, [{ id: 'page-0-block-0', maxChars: 40 }]);
	// Let the compress task start running before the "scroll" arrives.
	await new Promise(r => setTimeout(r, 5));
	manager.setCurrentPage(0); // the exact scroll event that used to kill it
	release();
	const accepted = await compress;
	assert.equal(compressAborted, false, 'page-0-compress must survive setCurrentPage(0)');
	assert.equal(accepted.get('page-0-block-0'), '短译', 'the shorter retry is returned to the caller');
	assert.equal(
		manager.getPageState(0)!.translations.get('page-0-block-0'),
		'短译',
		'the budgeted re-translation landed in page state'
	);
	manager.dispose();
});

test('compressBlocks rejects a retry that is not shorter than the current translation', async () => {
	const { deps } = makeDeps();
	const plain = deps.translateRequest;
	deps.translateRequest = async (request, signal) => {
		if (request.blocks.some(b => b.charBudget !== undefined)) {
			// A service that echoes back a NOT-shorter string must NOT overwrite
			// (base translation '译:Source paragraph 0 on page 0.' is 31 chars).
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '这个压缩结果并没有真正变短反而还更长了一点点所以必须被拒绝掉才对' })) };
		}
		return plain(request, signal);
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const before = manager.getPageState(0)!.translations.get('page-0-block-0');
	const accepted = await manager.compressBlocks(0, [{ id: 'page-0-block-0', maxChars: 4 }]);
	assert.equal(accepted.size, 0, 'a non-shorter retry is rejected');
	assert.equal(manager.getPageState(0)!.translations.get('page-0-block-0'), before, 'the good translation is kept');
	manager.dispose();
});

test('a compress for a page no longer wanted IS cancelled on scroll', async () => {
	let sawAbort = false;
	const { deps } = makeDeps();
	const plain = deps.translateRequest;
	deps.translateRequest = async (request, signal) => {
		if (request.blocks.some(b => b.charBudget !== undefined)) {
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, 200);
				signal.addEventListener?.('abort', () => { clearTimeout(t); sawAbort = true; reject(new Error('aborted')); });
			});
			return { translations: [] };
		}
		return plain(request, signal);
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const compress = manager.compressBlocks(0, [{ id: 'page-0-block-0', maxChars: 40 }]);
	await new Promise(r => setTimeout(r, 5));
	manager.setCurrentPage(7); // far away — page 0 is not wanted anymore
	await compress; // compressBlocks swallows cancellation
	assert.equal(sawAbort, true, 'far-page compress should still be dropped');
	manager.dispose();
});

test('salvage is BOUNDED: a dropping provider cannot cause a request storm', async () => {
	// Contract (0.9.8, 预算在 1.1.8 扩了一档): 打捞链本身封顶在 2×chunks + 2,
	// 纯文本兜底另有一份不与打捞共享、上限 FINAL_RECOVERY_MAX 的预算 —— 单
	// chunk 的页面因此是 4 + 4 = 8 次。扩这一档的理由见 canSpendFinal 的注释
	// (Horst 2024 第 1 页: 打捞正好烧完 4 次, 兜底永远轮不到, 三个块直接落进
	// unrecovered)。
	//
	// 真正要守住的不变量不是那个具体数字, 而是「请求数不随块数增长」—— 所以
	// 这里用两个相差 3 倍的块数跑同一个最坏情况引擎, 断言同一个上限。
	const run = async (N: number, cap: number): Promise<number> => {
		let totalCalls = 0;
		const { deps } = makeDeps({
			extractPage: async (pageIndex) => Array.from({ length: N }, (_, i) => ({
				id: `page-${pageIndex}-block-${i}`,
				pageIndex, order: i, type: 'paragraph' as const,
				sourceText: `Paragraph ${i} with enough text to be a real block on page ${pageIndex}.`
			})),
			translateRequest: async (request) => {
				totalCalls++;
				// A provider that drops everything but the first block of any batch,
				// and even fails single-block salvage → worst case for the budget.
				return { translations: [{ id: request.blocks[0]!.id, translatedText: '批量译文内容' }] };
			}
		});
		const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
		await manager.ensurePage(0, 10);
		const state = manager.getPageState(0)!;
		assert.equal(state.status, 'done');
		assert.ok(totalCalls <= cap, `page requests are bounded, ran ${totalCalls} for N=${N} (cap ${cap})`);
		// Successful blocks are always retained (never re-requested or dropped).
		assert.ok(state.translations.size >= 1 && state.translations.size < N, `kept ${state.translations.size} recovered blocks`);
		manager.dispose();
		return totalCalls;
	};
	// 12 个短块 → 1 个批次 → 2×1 + 2 + 4 = 8。
	const small = await run(12, 8);
	// 36 个短块 → 2 个批次 → 2×2 + 2 + 4 = 10。预算跟的是批次数, 不是块数。
	const large = await run(36, 10);
	// 这才是「不会变成请求风暴」的定义: 块数翻三倍, 请求数远低于每块一次。
	assert.ok(large < 36 / 3, `requests must not scale per-block (${large} for 36 blocks)`);
	assert.ok(large - small <= 2, `tripling blocks added ${large - small} request(s), not a storm`);
});

test('熔断: >25% of a chunk missing fires onProviderUnstable exactly once per page', async () => {
	const N = 8;
	const unstable: { pageIndex: number; ratio: number }[] = [];
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => Array.from({ length: N }, (_, i) => ({
			id: `page-${pageIndex}-block-${i}`,
			pageIndex, order: i, type: 'paragraph' as const,
			sourceText: `Paragraph ${i} with enough English words to count as prose content.`
		})),
		translateRequest: async (request) => {
			if (request.blocks.length > 1) {
				// Batches drop everything except the first block → far over 25%.
				return { translations: [{ id: request.blocks[0]!.id, translatedText: '批量译文的中文内容在此。' }] };
			}
			return { translations: [{ id: request.blocks[0]!.id, translatedText: '单块救回的中文译文内容。' }] };
		}
	});
	const manager = new TranslationManager(
		deps,
		{ onPageUpdate: () => {}, onProviderUnstable: (pageIndex, ratio) => unstable.push({ pageIndex, ratio }) },
		{ prefetch: false, delayFn: () => Promise.resolve() }
	);
	await manager.ensurePage(0, 10);
	assert.equal(unstable.length, 1, 'fired exactly once for the page');
	assert.equal(unstable[0]!.pageIndex, 0);
	assert.ok(unstable[0]!.ratio > 0.25, 'reported ratio reflects the miss rate');
	manager.dispose();
});

test('P2-16: 熔断切换引擎后,429 反馈打到新引擎的 lane,旧引擎不受牵连', async () => {
	// 页面从引擎 A 开始;熔断把剩余请求切到 B;此后 B 的 429 必须惩罚 B 的
	// lane —— 旧实现把 lane 在页面开始时快照为 A,B 的 429 去砍 A 的上限。
	const { PaperMirrorError } = await import('../../src/types/models');
	const N = 8;
	let offset = 0; // 模拟 readerSession.pageProviderOffset
	let rateLimitFired = false;
	const { deps } = makeDeps({
		laneFor: () => (offset === 0 ? 'A' : 'B'),
		extractPage: async (pageIndex) => Array.from({ length: N }, (_, i) => ({
			id: `page-${pageIndex}-block-${i}`,
			pageIndex, order: i, type: 'paragraph' as const,
			sourceText: `Paragraph ${i} with enough English words to count as prose content.`
		})),
		translateRequest: async (request) => {
			if (request.blocks.length > 1) {
				// 批量丢弃 >25% → 触发熔断切换。
				return { translations: [{ id: request.blocks[0]!.id, translatedText: '批量译文的中文内容在此。' }] };
			}
			// 切换后 (offset=1, 引擎 B):第一次单块救回撞 429。
			if (offset === 1 && !rateLimitFired) {
				rateLimitFired = true;
				throw new PaperMirrorError('RATE_LIMITED', 'too many requests', { retryable: true });
			}
			return { translations: [{ id: request.blocks[0]!.id, translatedText: '单块救回的中文译文内容。' }] };
		}
	});
	const manager = new TranslationManager(
		deps,
		{ onPageUpdate: () => {}, onProviderUnstable: () => { offset = 1; } },
		{ prefetch: false, delayFn: () => Promise.resolve() }
	);
	// min=1, initial=max=4: 成功奖励封顶不再上调,唯一能改变 cap 的是 429 惩罚。
	manager.setLaneCaps({ A: { min: 1, initial: 4, max: 4 }, B: { min: 1, initial: 4, max: 4 } });
	await manager.ensurePage(0, 10);
	assert.equal(rateLimitFired, true, '场景成立: B 确实收到过 429');
	const scheduler = (manager as any).scheduler;
	assert.ok(scheduler.laneCap('B') < 4, `B 的 lane 必须被惩罚 (cap=${scheduler.laneCap('B')})`);
	assert.equal(scheduler.laneCap('A'), 4, 'A 的 lane 不得为 B 的 429 买单');
	manager.dispose();
});

test('looksTranslated rejects echoed English prose but accepts CJK and acronym cells', async () => {
	const { looksTranslated } = await import('../../src/translation/translationManager');
	// Provider echoes the English source unchanged → rejected for a zh target.
	assert.equal(
		looksTranslated('PCCT improved feature visualization despite lower dose', 'PCCT improved feature visualization despite lower dose', 'zh-CN'),
		false
	);
	// A real Chinese translation → accepted.
	assert.equal(looksTranslated('PCCT improved feature visualization', 'PCCT 改善了特征可视化', 'zh-CN'), true);
	// A short acronym/numeric cell with no CJK → accepted (nothing to translate).
	assert.equal(looksTranslated('PCCT (n=30)', 'PCCT (n=30)', 'zh-CN'), true);
	// Non-CJK target → no cheap check, accept.
	assert.equal(looksTranslated('some source text here', 'some source text here', 'fr'), true);
});

test('an echoed-English response is treated as untranslated, not accepted', async () => {
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [{
			id: `page-${pageIndex}-block-0`, pageIndex, order: 0, type: 'paragraph',
			sourceText: 'PCCT improved feature visualization despite a lower radiation dose.'
		}],
		// Batch echoes English; single-block salvage returns real Chinese.
		translateRequest: async (request) => {
			if (request.blocks.length === 1) {
				return { translations: [{ id: request.blocks[0]!.id, translatedText: 'PCCT 在更低辐射剂量下改善了特征可视化。' }] };
			}
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: b.text })) }; // echo
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	assert.equal(
		manager.getPageState(0)!.translations.get('page-0-block-0'),
		'PCCT 在更低辐射剂量下改善了特征可视化。',
		'the echoed English was rejected and salvage produced the real translation'
	);
	manager.dispose();
});

test('looksTranslated rejects a HALF-translated / mixed response, not just pure echo', async () => {
	const { looksTranslated } = await import('../../src/translation/translationManager');
	const source = 'PCCT improved feature visualization despite a lower radiation dose in these patients';
	// Mostly English with a couple of Chinese words dropped in — the old
	// "contains any CJK" check accepted this; the ratio check must reject it.
	assert.equal(
		looksTranslated(source, 'PCCT 改善 feature visualization despite a lower radiation dose in these patients', 'zh-CN'),
		false
	);
	// A fully Chinese translation with the usual embedded acronyms → accepted.
	assert.equal(
		looksTranslated(source, '在这些患者中，PCCT 在更低的辐射剂量下改善了特征的可视化。', 'zh-CN'),
		true
	);
});

test('initialCharBudget: first request carries a geometry-derived budget', async () => {
	const { initialCharBudget } = await import('../../src/translation/translationManager');
	const block: SourceBlock = {
		id: 'p0-b0', pageIndex: 0, order: 0, type: 'paragraph',
		sourceText: 'A long enough English paragraph with plenty of words to translate here.',
		fontSize: 10,
		// 3 lines × 300pt wide at 10pt font → 30 cols each → 90 cols ×0.9 = 81
		lineRectsPdf: [[50, 700, 350, 710], [50, 688, 350, 698], [50, 676, 350, 686]]
	};
	assert.equal(initialCharBudget(block, 'zh-CN'), 81);
	// Non-CJK target → no budget (no cheap width model for Latin scripts).
	assert.equal(initialCharBudget(block, 'fr'), undefined);
	// Headings are typeset differently → no budget.
	assert.equal(initialCharBudget({ ...block, type: 'heading' }, 'zh-CN'), undefined);
	// No geometry → no budget.
	assert.equal(initialCharBudget({ ...block, lineRectsPdf: undefined }, 'zh-CN'), undefined);
	// A tiny fragment (budget < 24) gets none — too tight to be guidance.
	assert.equal(
		initialCharBudget({ ...block, lineRectsPdf: [[50, 700, 150, 710]] }, 'zh-CN'),
		undefined
	);
});

test('the first batch request includes charBudget for prose blocks', async () => {
	let seen: (number | undefined)[] = [];
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [{
			id: `page-${pageIndex}-block-0`, pageIndex, order: 0, type: 'paragraph',
			sourceText: 'Enough English words to be a real prose paragraph for translation.',
			fontSize: 10,
			lineRectsPdf: [[50, 700, 350, 710], [50, 688, 350, 698]]
		}],
		translateRequest: async (request: TranslationRequest): Promise<TranslationResponse> => {
			seen = request.blocks.map(b => b.charBudget);
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '足够长的中文译文内容在此处呈现。' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	assert.equal(seen.length, 1);
	assert.equal(typeof seen[0], 'number', 'first request already carries the layout budget');
	manager.dispose();
});

test('hasEnglishResidue: fires on a 6+ word English run, not on idioms/acronyms', async () => {
	const { hasEnglishResidue } = await import('../../src/translation/translationManager');
	// A dropped English clause inside Chinese → residue.
	assert.equal(hasEnglishResidue('本研究表明 the model improved feature visualization despite lower dose 显著'), true);
	// Short Latin idiom + acronyms → no false positive.
	assert.equal(hasEnglishResidue('在 in vitro 和 in vivo 实验中,PCCT 与 MRI 表现一致。'), false);
	// Fully Chinese → no residue.
	assert.equal(hasEnglishResidue('这是一个完整的中文译文段落,没有残留英文。'), false);
	// A URL is not counted as prose.
	assert.equal(hasEnglishResidue('详见 https://example.com/a/b/c/d/e/f 的补充材料。'), false);
});

test('局部英文残留: only the residual block is re-translated, and it is patched in place', async () => {
	let batchCalls = 0;
	let singleCalls = 0;
	const { deps } = makeDeps({
		extractPage: async (p) => [
			{ id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph',
				sourceText: 'A clean paragraph that translates fully into Chinese here.' },
			{ id: `page-${p}-block-1`, pageIndex: p, order: 1, type: 'paragraph',
				sourceText: 'A paragraph whose middle clause is dropped by the batch model.' }
		],
		readCache: async () => null,
		translateRequest: async (request: TranslationRequest): Promise<TranslationResponse> => {
			if (request.blocks.length > 1) {
				batchCalls++;
				return { translations: request.blocks.map((b) => ({
					id: b.id,
					// block-1 comes back mostly Chinese but with an English run left in.
					translatedText: b.id.endsWith('block-1')
						? '本段落 whose middle clause is dropped by the 模型,需要补译。'
						: '这是一段完整的中文译文内容,足够长。'
				})) };
			}
			singleCalls++;
			return { translations: [{ id: request.blocks[0]!.id, translatedText: '本段落的中间从句已被补译为完整中文内容。' }] };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	assert.equal(singleCalls, 1, 'exactly the one residual block was re-translated');
	const { hasEnglishResidue } = await import('../../src/translation/translationManager');
	assert.equal(hasEnglishResidue(state.translations.get('page-0-block-1')!), false, 'residue cleared after local re-translate');
	assert.ok(state.translations.get('page-0-block-0')!.includes('完整的中文'), 'the clean block was left untouched');
	manager.dispose();
});

test('段落级缓存: hits skip requests entirely; misses translate and are stored', async () => {
	const { segmentHash } = await import('../../src/translation/translationManager');
	const store = new Map<string, string>();
	let requests = 0;
	const mkBlocks = (pageIndex: number): SourceBlock[] => [
		{ id: `page-${pageIndex}-block-0`, pageIndex, order: 0, type: 'paragraph',
			sourceText: 'First English paragraph with plenty of words to translate properly.' },
		{ id: `page-${pageIndex}-block-1`, pageIndex, order: 1, type: 'paragraph',
			sourceText: 'Second English paragraph, also long enough to be prose for the test.' }
	];
	const { deps } = makeDeps({
		extractPage: async p => mkBlocks(p),
		readCache: async () => null, // page cache always misses → segments decide
		translateRequest: async (request: TranslationRequest): Promise<TranslationResponse> => {
			requests++;
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '这是一个足够长的中文译文段落内容。' })) };
		},
		readSegments: async (_p, hashes) => {
			const out = new Map<string, string>();
			for (const h of hashes) {
				const hit = store.get(h);
				if (hit) {
					out.set(h, hit);
				}
			}
			return out;
		},
		writeSegments: async (_p, entries) => {
			for (const e of entries) {
				store.set(e.hash, e.translatedText);
			}
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	assert.equal(requests, 1, 'first pass translates (one batch)');
	assert.equal(store.size, 2, 'both segments stored');
	// 普通刷新: page state dropped, page cache bypassed — segments must serve it
	// with ZERO new requests.
	await manager.retranslatePage(0, 'normal');
	assert.equal(requests, 1, 'normal refresh reuses qualified segments, no new requests');
	assert.equal(manager.getPageState(0)?.status, 'done');
	assert.equal(manager.getPageState(0)?.translations.size, 2);
	// 强制重译: bypasses the segment store too.
	await manager.retranslatePage(0, 'force');
	assert.equal(requests, 2, 'force retranslate re-requests everything');
	// Same source text on ANOTHER page → same hash → reused across pages.
	const h = segmentHash(mkBlocks(0)[0]!.sourceText, 'en', 'zh-CN');
	assert.ok(store.has(h), 'segment key is content-based, reusable across pages');
	manager.dispose();
});

test('段落级缓存: only the failed segment re-requests on normal refresh', async () => {
	const store = new Map<string, string>();
	const requestedTexts: string[][] = [];
	const { deps } = makeDeps({
		extractPage: async pageIndex => [
			{ id: `page-${pageIndex}-block-0`, pageIndex, order: 0, type: 'paragraph',
				sourceText: 'A good paragraph that translates fine with plenty of words.' },
			{ id: `page-${pageIndex}-block-1`, pageIndex, order: 1, type: 'paragraph',
				sourceText: 'A difficult paragraph the provider keeps echoing back in English.' }
		],
		readCache: async () => null,
		translateRequest: async (request: TranslationRequest): Promise<TranslationResponse> => {
			requestedTexts.push(request.blocks.map(b => b.text));
			return { translations: request.blocks.map((b) => ({
				id: b.id,
				// The 'difficult' block echoes English (rejected); the good one translates.
				translatedText: b.text.includes('difficult') ? b.text : '合格的中文译文内容,足够长的一段。'
			})) };
		},
		readSegments: async (_p, hashes) => {
			const out = new Map<string, string>();
			for (const h of hashes) {
				const hit = store.get(h);
				if (hit) {
					out.set(h, hit);
				}
			}
			return out;
		},
		writeSegments: async (_p, entries) => {
			for (const e of entries) {
				store.set(e.hash, e.translatedText);
			}
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	assert.equal(store.size, 1, 'only the qualified segment is stored');
	const callsBefore = requestedTexts.length;
	await manager.retranslatePage(0, 'normal');
	const refreshCalls = requestedTexts.slice(callsBefore);
	// Every request in the refresh should touch ONLY the difficult block.
	assert.ok(refreshCalls.length >= 1, 'the failed segment is re-requested');
	for (const texts of refreshCalls) {
		assert.ok(texts.every(t => t.includes('difficult')), 'good segment is never re-requested');
	}
	manager.dispose();
});

test('provider pool: another lane prefetches WHILE the current page (its lane) is still translating', async () => {
	const { PaperMirrorError } = await import('../../src/types/models');
	const order: number[] = [];
	let releaseCurrent!: () => void;
	const { deps } = makeDeps({
		pageCount: () => 10,
		laneFor: (p: number) => (p % 2 === 0 ? 'A' : 'B'), // even→A, odd→B
		extractPage: async (p) => [{
			id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph',
			sourceText: `Body text for page ${p} with enough words to be prose here.`
		}],
		translateRequest: async (request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResponse> => {
			const p = request.pageIndex ?? -1;
			if (p === 0) {
				await new Promise<void>((resolve, reject) => {
					releaseCurrent = resolve;
					signal?.addEventListener?.('abort', () => reject(new PaperMirrorError('CANCELLED', 'aborted')));
				});
			}
			order.push(p);
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '译文内容' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: true, delayFn: () => Promise.resolve(), prefetchDebounceMs: 0 });
	manager.setLaneCaps({ A: 1, B: 1 });
	manager.setGlobalConcurrency(4);
	manager.setPrefetchWindow(2, 1);
	manager.setCurrentPage(0); // page 0 on lane A blocks; page 1 (lane B) should prefetch
	await new Promise(r => setTimeout(r, 20));
	assert.ok(order.includes(1), 'lane B page prefetched while lane A current page was still blocked');
	assert.ok(!order.includes(2), 'the same-lane (A) neighbour waited for the current page');
	assert.ok(!order.includes(0), 'the current page is still translating (blocked)');
	releaseCurrent();
	await new Promise(r => setTimeout(r, 20));
	assert.ok(order.includes(0), 'current page finishes after release');
	manager.dispose();
});

test('navigating to a QUEUED prefetch page promotes it to run now (not stuck)', async () => {
	// Problem one: a page enqueued as a low-priority prefetch used to be
	// unreachable — ensurePage early-returned on isScheduled, so navigating to it
	// left it at prefetch priority behind a blocked neighbour. It must now be
	// promoted to the foreground and run immediately.
	const { PaperMirrorError } = await import('../../src/types/models');
	const order: number[] = [];
	const { deps } = makeDeps({
		pageCount: () => 10,
		extractPage: async (p) => [{
			id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph',
			sourceText: `Body text for page ${p} with enough words here now.`
		}],
		translateRequest: async (request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResponse> => {
			const p = request.pageIndex ?? -1;
			if (p === 6) {
				// page 6 seizes the single slot and holds it until aborted.
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener?.('abort', () => reject(new PaperMirrorError('CANCELLED', 'aborted')));
				});
			}
			order.push(p);
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '译文内容' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: true, maxConcurrent: 1, delayFn: () => Promise.resolve(), prefetchDebounceMs: 0 });
	manager.setCurrentPage(5);
	await new Promise(r => setTimeout(r, 20));
	assert.ok(order.includes(5), 'the current page 5 translated');
	assert.ok(!order.includes(4), 'page 4 is queued behind the blocked page 6 prefetch');
	manager.setCurrentPage(4); // page 4 was a queued prefetch → promote + run
	await new Promise(r => setTimeout(r, 20));
	assert.ok(order.includes(4), 'navigating to the queued page runs it now, not stuck behind page 6');
	manager.dispose();
});

test('按方向备下一页 (2.3.2 item4): 向回看时预取窗口翻转到行进方向', async () => {
	const order: number[] = [];
	const { deps } = makeDeps({
		pageCount: () => 10,
		extractPage: async (p) => [{
			id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph',
			sourceText: `Body text for page ${p} with enough words here.`
		}],
		translateRequest: async (request) => {
			order.push(request.pageIndex ?? -1);
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '译文内容' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: true, delayFn: () => Promise.resolve(), prefetchDebounceMs: 0 });
	manager.setPrefetchWindow(2, 1);
	manager.setCurrentPage(5); // 从 0 → 5: 向前读,窗口 5,6,7 + 身后 4
	await new Promise(r => setTimeout(r, 30));
	assert.ok(order.includes(6) && order.includes(7), '向前读时预取 6、7');
	manager.setCurrentPage(4); // 5 → 4: 向回看 —— 窗口应翻转为 4,3,2 + 身后 5
	await new Promise(r => setTimeout(r, 30));
	assert.ok(order.includes(3), '回看时行进方向的下一页 (3) 被预取');
	assert.ok(order.includes(2), '回看时 forward 窗口整个翻向行进方向 (2 也预取) —— 旧实现只会备 3');
	manager.dispose();
});

test('优先翻译当前页: the current page translates before any neighbour is prefetched', async () => {
	const order: number[] = [];
	const { deps } = makeDeps({
		pageCount: () => 10,
		extractPage: async (p) => [{
			id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph',
			sourceText: `Body text for page ${p} with enough words here.`
		}],
		translateRequest: async (request) => {
			order.push(request.pageIndex ?? -1);
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '译文内容' })) };
		}
	});
	// prefetch ON so neighbours are eligible; the current page must still win.
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: true, delayFn: () => Promise.resolve(), prefetchDebounceMs: 0 });
	manager.setCurrentPage(3);
	await new Promise(r => setTimeout(r, 30));
	assert.equal(order[0], 3, 'the current page is translated first');
	assert.ok(order.includes(2) && order.includes(4), 'neighbours are prefetched afterwards');
	assert.ok(order.indexOf(3) < order.indexOf(4), 'current page precedes its neighbours');
	manager.dispose();
});

test('chunks of one page run concurrently (2-way), and every block still lands', async () => {
	// Two big blocks (5000 chars each) → planChunks(8000 budget) → 2 chunks.
	// 文本必须互不相同 (2.3.5, API-2): 同页同文块现在会被去重成一个请求 —— 本
	// 测试考的是 chunk 并发,不是去重,夹具改为两段不同文本。
	let active = 0;
	let maxActive = 0;
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [0, 1].map(i => ({
			id: `page-${pageIndex}-block-${i}`,
			pageIndex, order: i, type: 'paragraph' as const,
			sourceText: (i === 0 ? 'x' : 'y').repeat(5000)
		})),
		translateRequest: async (request) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise(r => setTimeout(r, 15));
			active--;
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '译文内容:' + b.id })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	assert.equal(state.translations.size, 2, 'both chunks translated');
	assert.equal(maxActive, 2, 'the two chunks were in flight simultaneously');
	manager.dispose();
});

test('extraction runs outside provider slots with its own concurrency cap of 2', async () => {
	let active = 0;
	let maxActive = 0;
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise(r => setTimeout(r, 12));
			active--;
			return makeBlocks(pageIndex, 1);
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, maxConcurrent: 8, delayFn: () => Promise.resolve() });
	await Promise.all([0, 1, 2, 3, 4].map(p => manager.ensurePage(p, 10)));
	assert.ok(maxActive <= 2, `at most 2 concurrent extractions, saw ${maxActive}`);
	for (const p of [0, 1, 2, 3, 4]) {
		assert.equal(manager.getPageState(p)!.status, 'done', `page ${p} completed`);
	}
	manager.dispose();
});

test('cancelled pages persist already-translated segments (增量持久化)', async () => {
	const written: { hash: string; translatedText: string }[] = [];
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [0, 1].map(i => ({
			id: `page-${pageIndex}-block-${i}`,
			pageIndex, order: i, type: 'paragraph' as const,
			sourceText: 'x'.repeat(5000) // two chunks → chunk 1 completes, chunk 2 cancels
		})),
		writeSegments: async (_p, entries) => { written.push(...entries); },
		translateRequest: (() => {
			let calls = 0;
			return async (request: TranslationRequest, sig: AbortSignal): Promise<TranslationResponse> => {
				calls++;
				if (calls === 1) {
					return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '第一批译文成功保留' })) };
				}
				// Second chunk: the user cancels mid-flight.
				const { PaperMirrorError } = await import('../../src/types/models');
				void sig;
				throw new PaperMirrorError('CANCELLED', 'user cancelled');
			};
		})()
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	assert.ok(written.length >= 1, 'the completed chunk was persisted despite the cancel');
	assert.equal(written[0]!.translatedText, '第一批译文成功保留');
	manager.dispose();
});

// ---------------------------------------------------------------------------
// 0.9.24 批次1: 统计密集行不再被"疑似未翻译"误拒;丢占位符的译文被拒收
// ---------------------------------------------------------------------------

test('stats-dense perfect translation passes looksTranslated (斑马纹误拒修复)', () => {
	const source = 'The hazard ratio for mortality was 0.82 (95% CI: 0.71–0.94, p = 0.003) among the n = 342 patients enrolled [12].';
	const translated = '在纳入的 n = 342 例患者中,死亡率的风险比为 0.82(95% CI: 0.71–0.94, p = 0.003)[12]。';
	assert.equal(looksTranslated(source, translated, 'zh-CN'), true);
});

test('echoed English still fails looksTranslated after prose-only scoring', () => {
	const source = 'The hazard ratio for mortality was significantly lower in the treatment group over time.';
	assert.equal(looksTranslated(source, source, 'zh-CN'), false);
});

test('formula-dense block travels alone in a slow-lane request (三分道)', async () => {
	const requests: TranslationRequest[] = [];
	const blocks: SourceBlock[] = [
		{ id: 'n1', pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'Plain prose paragraph one for the fast lane batch.' },
		{ id: 'n2', pageIndex: 0, order: 1, type: 'paragraph', sourceText: 'Plain prose paragraph two for the fast lane batch.' },
		{ id: 'risky', pageIndex: 0, order: 2, type: 'paragraph', sourceText: 'Equations $a=1$ then $b=2$ then $c=3$ then $d=4$ then $e=5$ appear densely here in one block.' }
	];
	const { deps } = makeDeps({
		extractPage: async () => blocks,
		translateRequest: async (req) => {
			requests.push(req);
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '这是一个完整的中文译文段落示例。' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	assert.equal(manager.getPageState(0)!.status, 'done');
	const risky = requests.filter(r => r.blocks.some(b => b.id === 'risky'));
	assert.ok(risky.length >= 1);
	assert.equal(risky[0]!.blocks.length, 1, 'risky block must be isolated in its own request');
	manager.dispose();
});

test('plain-mode recovery rescues a block the JSON chain kept rejecting (批次3)', async () => {
	const plainSeen: TranslationRequest[] = [];
	const blocks: SourceBlock[] = [
		{ id: 'ok', pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'This paragraph translates fine on the very first attempt today.' },
		{ id: 'stuck', pageIndex: 0, order: 1, type: 'paragraph', sourceText: 'This stubborn paragraph keeps coming back as an English echo every time.' }
	];
	const { deps } = makeDeps({
		extractPage: async () => blocks,
		translateRequest: async (req) => {
			if (req.plain) {
				plainSeen.push(req);
				return { translations: [{ id: req.blocks[0]!.id, translatedText: '顽固段落终于翻译成功了,这就是完整的中文译文。' }] };
			}
			return {
				translations: req.blocks.map(b => ({
					id: b.id,
					// JSON 链对 stuck 永远回声英文 → looksTranslated 拒收
					translatedText: b.id === 'stuck' ? b.text : '正常段落的完整中文译文内容。'
				}))
			};
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	assert.ok(plainSeen.length >= 1, 'plain-mode rescue must have been attempted');
	assert.ok(state.translations.get('stuck')?.includes('顽固段落'), 'plain rescue result stored');
	assert.equal(state.keepOrigin?.size ?? 0, 0);
	manager.dispose();
});

test('a hash that failed on two pages is keep-origin skipped on a third page (止损)', async () => {
	const CURSED = 'A cursed paragraph that the provider refuses to ever translate properly.';
	let cursedRequests = 0;
	const pageBlocks = (p: number): SourceBlock[] => [
		{ id: `p${p}-good`, pageIndex: p, order: 0, type: 'paragraph', sourceText: 'Short good text.' },
		{ id: `p${p}-cursed`, pageIndex: p, order: 1, type: 'paragraph', sourceText: CURSED }
	];
	const { deps } = makeDeps({
		extractPage: async p => pageBlocks(p),
		readCache: async () => null,
		translateRequest: async (req) => {
			if (req.blocks.some(b => b.text.includes('cursed') || b.text === CURSED || b.text.includes('refuses'))) {
				cursedRequests++;
			}
			return {
				translations: req.blocks.map(b => ({
					id: b.id,
					translatedText: b.id.endsWith('cursed') ? b.text : '好段落的完整中文译文内容示例。'
				}))
			};
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10); // failure #1 for the hash
	await manager.ensurePage(1, 10); // failure #2 (same text, different page)
	const before = cursedRequests;
	await manager.ensurePage(2, 10); // third page with the same hash → skipped
	assert.equal(cursedRequests, before, 'third page must not spend requests on the dead hash');
	assert.equal(manager.getPageState(2)!.keepOrigin?.get('p2-cursed'), 'repeated-failure');
	// 审核 P1 修复: keepOrigin pages stay OUT of the page cache, and an EXPLICIT
	// 普通刷新 of the page clears its 止损 memory — the retry really happens.
	await manager.retranslatePage(2, 'normal');
	assert.ok(cursedRequests > before, '普通刷新 must give the skipped segment a fresh chance');
	manager.dispose();
});

test('term pairs learned on one page are injected as suggested rules on the next (文档记忆)', async () => {
	const seenGlossaries: (GlossaryRule[] | undefined)[] = [];
	const pageBlocks = (p: number): SourceBlock[] => [{
		id: `p${p}b0`, pageIndex: p, order: 0, type: 'paragraph',
		sourceText: p === 0
			? 'Contrast-enhanced ultrasound (CEUS) improves detection of hepatic lesions in cirrhotic patients today.'
			: 'Follow-up imaging with CEUS confirmed the lesion characteristics in most patients over time.'
	}];
	const { deps } = makeDeps({
		extractPage: async p => pageBlocks(p),
		readCache: async () => null,
		translateRequest: async (req) => {
			seenGlossaries.push(req.glossary);
			return {
				translations: req.blocks.map(b => ({
					id: b.id,
					translatedText: b.id === 'p0b0'
						? '对比增强超声(CEUS)提高了肝硬化患者肝脏病灶的检出率。'
						: '随访 CEUS 影像证实了大多数患者的病灶特征。'
				}))
			};
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	await manager.ensurePage(1, 10);
	const later = seenGlossaries.slice(1).flat().filter(Boolean) as GlossaryRule[];
	assert.ok(later.some(r => r.source === 'CEUS' && r.target === '对比增强超声' && r.mode === 'suggested'),
		`page-2 request must carry the remembered pair, got ${JSON.stringify(later)}`);
	manager.dispose();
});

// ---------------------------------------------------------------------------
// 0.9.29 批次6: 段级诊断 + 单段重译 + 脱敏导出
// ---------------------------------------------------------------------------

test('page diagnostics record requests and 429s; export carries no text (批次6)', async () => {
	let first = true;
	const { deps } = makeDeps({
		translateRequest: async (req) => {
			if (first) {
				first = false;
				const err = new (await import('../../src/types/models')).PaperMirrorError('RATE_LIMITED', '429');
				throw err;
			}
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '这是完整的中文译文段落内容。' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	assert.ok(state.diagnostics, 'diagnostics must be recorded');
	assert.ok(state.diagnostics!.rateLimited >= 1, '429 must be counted');
	assert.ok(state.diagnostics!.requests >= 1);
	const exported = JSON.stringify(manager.exportDiagnostics());
	assert.ok(!exported.includes('Source paragraph'), 'export must not contain source text');
	assert.ok(!exported.includes('中文译文'), 'export must not contain translations');
	assert.ok(exported.includes('"state":"translated"'));
	manager.dispose();
});

test('retranslateBlock replaces one segment and clears keep-origin (单段重译)', async () => {
	let mode: 'echo' | 'good' = 'echo';
	const blocks: SourceBlock[] = [
		{
			id: 'fine', pageIndex: 0, order: 0, type: 'paragraph',
			sourceText: 'A perfectly ordinary paragraph that translates fine on the first attempt.'
		},
		{
			id: 'seg', pageIndex: 0, order: 1, type: 'paragraph',
			sourceText: 'A paragraph the provider first echoes back and later translates properly.'
		}
	];
	const { deps } = makeDeps({
		extractPage: async () => blocks,
		readCache: async () => null,
		translateRequest: async (req) => ({
			translations: req.blocks.map(b => ({
				id: b.id,
				translatedText: b.id === 'seg' && mode === 'echo' ? b.text : '服务商给出了完整的中文译文段落。'
			}))
		})
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	assert.equal(manager.getPageState(0)!.keepOrigin?.get('seg'), 'unrecovered');
	mode = 'good';
	const ok = await manager.retranslateBlock(0, 'seg');
	assert.equal(ok, true);
	const state = manager.getPageState(0)!;
	assert.ok(state.translations.get('seg')?.includes('中文译文'));
	assert.equal(state.keepOrigin?.has('seg'), false);
	manager.dispose();
});

// ---------------------------------------------------------------------------
// 0.9.30 批次7: 跨页续接上下文 + context_bleed 校验 + 不译词列表
// ---------------------------------------------------------------------------

test('looksContextBleed flags an impossibly long first-block translation', () => {
	const source = 'This continuation sentence carries roughly a dozen ordinary English words in total here.';
	const normal = '这句续接的译文长度完全正常,大约二三十个汉字。';
	const bloated = '上一页的尾巴内容也被整段翻译了进来,'.repeat(12) + '然后才是本段的译文。';
	assert.equal(looksContextBleed(source, normal, true), false);
	assert.equal(looksContextBleed(source, bloated, true), true);
	assert.equal(looksContextBleed(source, bloated, false), false, 'no context → no bleed check');
});

test('an unfinished previous-page tail is injected as chunk-0 context (跨页续接)', async () => {
	const contexts: string[] = [];
	const pageBlocks = (p: number): SourceBlock[] => [{
		id: `p${p}b0`, pageIndex: p, order: 0, type: 'paragraph',
		sourceText: p === 0
			? 'The measurement protocol was applied to every cohort, and the resulting values were' // ends mid-sentence
			: 'subsequently normalized against the baseline scans acquired before contrast injection.'
	}];
	const { deps } = makeDeps({
		extractPage: async p => pageBlocks(p),
		readCache: async () => null,
		translateRequest: async (req) => {
			contexts.push(req.previousContext);
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '这是完整的中文译文段落内容示例。' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	await manager.ensurePage(1, 10);
	assert.ok(contexts.some(c => c.includes('resulting values were')),
		`page-2 chunk 0 must carry the page-1 tail, got ${JSON.stringify(contexts)}`);
	manager.dispose();
});

test('no-translate literals are masked in requests and restored in results (不译词)', async () => {
	const sent: string[] = [];
	const blocks: SourceBlock[] = [{
		id: 'b', pageIndex: 0, order: 0, type: 'paragraph',
		sourceText: 'The RetainNet framework consistently outperforms every baseline model in our experiments.'
	}];
	const { deps } = makeDeps({
		extractPage: async () => blocks,
		readCache: async () => null,
		getNoTranslate: () => ['RetainNet'],
		translateRequest: async (req) => {
			sent.push(req.blocks.map(b => b.text).join('\n'));
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: b.text.replace(/The .* framework consistently outperforms every baseline model in our experiments\./, '该⟦PM0⟧框架在我们的实验中始终优于所有基线模型。') })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.ok(sent.every(t => !t.includes('RetainNet')), 'literal must be masked in every request');
	assert.ok(state.translations.get('b')?.includes('RetainNet'), 'literal restored in the stored translation');
	manager.dispose();
});

// ---------------------------------------------------------------------------
// 0.9.31 核心算法对齐 (retain-pdf 源码移植): 截断/混合残留/作者名单 in looksTranslated
// ---------------------------------------------------------------------------

test('looksTranslated: truncated stub rejected, author byline accepted (源码对齐)', () => {
	const longSource = 'The measurement protocol was applied to every cohort in the study and the resulting attenuation values were subsequently normalized against baseline scans acquired before contrast injection. '.repeat(2);
	assert.equal(looksTranslated(longSource, '协议已应用。', 'zh-CN'), false, 'a stub answer for a long source is a truncation');
	const byline = 'John A. Smith, Maria García, Wei Zhang, and Pierre Dubois';
	assert.equal(looksTranslated(byline, byline, 'zh-CN'), true, 'author list legitimately stays Latin');
});

test('looksTranslated: Chinese-dominant output with a copied tail clause is rejected', () => {
	const source = 'Contrast enhancement increases proportionally with iodine concentration in every patient cohort. For a given tube voltage the proportionality of contrast enhancement to iodine concentration remains nearly constant across scanner generations and vendors, which simplifies protocol design considerably in clinical practice.';
	const half = '对比增强在每个患者队列中都随碘浓度成比例增加,这是稳定的物理规律,临床上极为有用,协议设计因此大为简化,各代设备之间基本一致,厂商差异也很小,总体表现稳定可靠。 For a given tube voltage the proportionality of contrast enhancement to iodine concentration remains nearly constant across scanner generations and vendors.';
	assert.equal(looksTranslated(source, half, 'zh-CN'), false);
});

test('hasEnglishResidue: Title-Case residue span caught, NMR line exempt (跨度规则)', async () => {
	const { hasEnglishResidue } = await import('../../src/translation/translationManager');
	assert.equal(hasEnglishResidue('该方法优于基线。 The Proposed Method Consistently Outperforms Existing Baselines On Every Benchmark Considered Here. 其余正常。'), true);
	assert.equal(hasEnglishResidue('产物表征 1H NMR (400 MHz, CDCl3) 7.42 (d, J = 8.2 Hz, 2H), 7.21 (t, 1H), 3.85 (s, 3H) 与文献一致。'), false);
});

// ---------------------------------------------------------------------------
// 1.0.1: 每页必点圆环 bug —— 提取悬挂不再卡死状态与信号量
// ---------------------------------------------------------------------------

test('a hung extraction times out, releases the page, and the next visit retries automatically', async () => {
	let calls = 0;
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => {
			calls++;
			if (calls === 1) {
				return new Promise(() => { /* hangs forever (unrendered page) */ });
			}
			return [{
				id: `page-${pageIndex}-block-0`, pageIndex, order: 0, type: 'paragraph',
				sourceText: 'Short paragraph here.'
			}];
		},
		readCache: async () => null
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, extractTimeoutMs: 40 });
	await manager.ensurePage(0, 10); // hangs → times out → state released
	assert.equal(manager.getPageState(0), undefined, 'timed-out page must be forgotten, not stuck at extracting');
	await manager.ensurePage(0, 10); // the "revisit" — must run WITHOUT any manual click
	assert.equal(manager.getPageState(0)!.status, 'done');
	assert.equal(calls, 2);
	manager.dispose();
});

test('two hung extractions do not deadlock the 2-slot semaphore for later pages', async () => {
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => {
			if (pageIndex <= 1) {
				return new Promise(() => { /* pages 1+2 hang */ });
			}
			return [{
				id: `page-${pageIndex}-block-0`, pageIndex, order: 0, type: 'paragraph',
				sourceText: 'Third page text.'
			}];
		},
		readCache: async () => null
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, extractTimeoutMs: 40 });
	await Promise.all([
		manager.ensurePage(0, 10),
		manager.ensurePage(1, 10),
		manager.ensurePage(2, 10) // queued behind the two hung slots
	]);
	assert.equal(manager.getPageState(2)!.status, 'done', 'page 3 must not starve behind hung extractions');
	manager.dispose();
});

test('timed-out current page recovers from rendered text without starting a duplicate worker extraction', async () => {
	let workerCalls = 0;
	let renderedCalls = 0;
	const { deps } = makeDeps({
		extractPage: async () => {
			workerCalls++;
			return new Promise(() => { /* worker promise remains alive */ });
		},
		extractRenderedPage: async (pageIndex) => {
			renderedCalls++;
			return makeBlocks(pageIndex, 1);
		},
		translateRequest: async request => ({
			translations: request.blocks.map(block => ({ id: block.id, translatedText: '当前页译文已恢复完成。' }))
		}),
		readCache: async () => null
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, extractTimeoutMs: 30 });
	await manager.ensurePage(0, 10);
	const recoveredPage = manager.getPageState(0);
	assert.equal(recoveredPage?.status, 'done', recoveredPage?.error?.message);
	assert.equal(workerCalls, 1);
	assert.equal(renderedCalls, 1);
	await manager.ensurePage(0, 10);
	assert.equal(workerCalls, 1, 'the still-live worker extraction is never duplicated');
	manager.dispose();
});

test('an extraction completed after navigation cannot enqueue stale translation work', async () => {
	let resolveOld!: (blocks: SourceBlock[]) => void;
	const translatedPages: number[] = [];
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => pageIndex === 0
			? new Promise<SourceBlock[]>(resolve => { resolveOld = resolve; })
			: makeBlocks(pageIndex, 1),
		translateRequest: async request => {
			translatedPages.push(request.blocks[0]!.id.startsWith('page-0-') ? 0 : 5);
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: `译:${b.text}` })) };
		},
		readCache: async () => null
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	const old = manager.ensurePage(0, 10);
	await Promise.resolve();
	manager.setCurrentPage(5);
	resolveOld(makeBlocks(0, 1));
	await old;
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(!translatedPages.includes(0), 'the page left behind must not reach a provider');
	manager.dispose();
});

test('a keep-origin page is never written to the page cache (审核 P1)', async () => {
	const CURSED = 'A cursed paragraph that the provider refuses to ever translate properly.';
	const cacheWrites: number[] = [];
	const pageBlocks = (p: number): SourceBlock[] => [
		{ id: `p${p}-good`, pageIndex: p, order: 0, type: 'paragraph', sourceText: 'Short good text.' },
		{ id: `p${p}-cursed`, pageIndex: p, order: 1, type: 'paragraph', sourceText: CURSED }
	];
	const { deps } = makeDeps({
		extractPage: async p => pageBlocks(p),
		readCache: async () => null,
		writeCache: async (pageIndex) => { cacheWrites.push(pageIndex); },
		translateRequest: async req => ({
			translations: req.blocks.map(b => ({
				id: b.id,
				translatedText: b.id.endsWith('cursed') ? b.text : '好段落的完整中文译文内容示例。'
			}))
		})
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	await manager.ensurePage(1, 10);
	await manager.ensurePage(2, 10); // keepOrigin page (repeated-failure skip)
	assert.ok(!cacheWrites.includes(2), 'the keepOrigin page must stay uncached so repair can run again');
	manager.dispose();
});

test('visible page with hung worker AND empty text layer surfaces a retryable error, not idle', async () => {
	const { deps } = makeDeps({
		extractPage: async () => new Promise(() => { /* hangs */ }),
		extractRenderedPage: async () => [],
		readCache: async () => null
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, extractTimeoutMs: 30 });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0);
	assert.equal(state?.status, 'error');
	assert.equal(state?.error?.code, 'EXTRACTION_FAILED');
	assert.equal(state?.error?.retryable, true);
	manager.dispose();
});

// ---------------------------------------------------------------------------
// 1.0.3: 到页仍要点圆环 —— 文字层未就绪的空结果绝不能标 done
// ---------------------------------------------------------------------------

test('zombie fallback retries the text layer and never marks an empty page done', async () => {
	let renderedCalls = 0;
	const { deps } = makeDeps({
		extractPage: async () => new Promise(() => { /* worker hangs → zombie */ }),
		extractRenderedPage: async (pageIndex) => {
			renderedCalls++;
			// The text layer appears on the third read (user just arrived).
			return renderedCalls >= 3 ? makeBlocks(pageIndex, 1) : [];
		},
		readCache: async () => null
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, extractTimeoutMs: 30, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10); // times out → rendered retry loop kicks in
	const state = manager.getPageState(0);
	assert.equal(state?.status, 'done', state?.error?.message);
	assert.ok(renderedCalls >= 3, 'the empty first reads must be retried');
	assert.ok(state!.translations.size > 0, 'the page really translated after the layer appeared');
	manager.dispose();
});

test('a permanently empty text layer surfaces a retryable error, never a fake done', async () => {
	const { deps } = makeDeps({
		extractPage: async () => new Promise(() => { /* worker hangs */ }),
		extractRenderedPage: async () => [],
		readCache: async () => null
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, extractTimeoutMs: 30, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0);
	assert.equal(state?.status, 'error');
	assert.equal(state?.error?.retryable, true);
	// The zombie path on a REVISIT must behave the same (error, not done).
	await manager.ensurePage(0, 10);
	assert.equal(manager.getPageState(0)?.status, 'error');
	manager.dispose();
});

test('glyph formula runs are masked as literals in requests (字形级公式, 1.0.4)', async () => {
	const sent: string[] = [];
	const blocks: SourceBlock[] = [{
		id: 'b', pageIndex: 0, order: 0, type: 'paragraph',
		sourceText: 'The regression y = βx + ε predicts the outcome in every cohort we studied.',
		formulaRuns: ['y = βx + ε']
	}];
	const { deps } = makeDeps({
		extractPage: async () => blocks,
		readCache: async () => null,
		translateRequest: async (req) => {
			sent.push(req.blocks.map(b => b.text).join('\n'));
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: b.text.replace(/The regression (⟦PM\d+⟧) predicts the outcome in every cohort we studied\./, '回归模型 $1 在我们研究的每个队列中都能预测结局。') })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.ok(sent.every(t => !t.includes('βx')), `formula literal must be masked: ${sent[0]}`);
	assert.ok(state.translations.get('b')?.includes('y = βx + ε'), 'formula restored byte-identical');
	manager.dispose();
});

test('cross-page tail is NOT injected when the last line falls short of the block edge (MinerU 几何收紧)', async () => {
	const contexts: string[] = [];
	const pageBlocks = (p: number): SourceBlock[] => [{
		id: `p${p}b0`, pageIndex: p, order: 0, type: 'paragraph',
		sourceText: p === 0
			? 'The protocol was applied to every cohort and the resulting values were' // 未完句…
			: 'subsequently normalized against baseline scans acquired before injection.',
		// …但末行远未顶到块右边界 (行右 300 vs 块右 500, 行高 10) → 段落其实已结束。
		boundingBox: { x: 60, y: 100, width: 440, height: 60 },
		lineRectsPdf: p === 0 ? [[60, 700, 500, 710], [60, 688, 300, 698]] : [[60, 700, 500, 710]]
	}];
	const { deps } = makeDeps({
		extractPage: async p => pageBlocks(p),
		readCache: async () => null,
		translateRequest: async (req) => {
			contexts.push(req.previousContext);
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '这是完整的中文译文段落内容示例。' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	await manager.ensurePage(1, 10);
	assert.ok(!contexts.some(c => c.includes('resulting values were')),
		'short last line must veto the injection');
	manager.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.1.8 超短块验收 (Horst 2024 第 1 页 region-2 / region-4 连拒的真实载体)
// ─────────────────────────────────────────────────────────────────────────────

test('looksTranslated: 专名密集的短标题, 忠实译文不再被小样本比率误拒', () => {
	// 保留 5 个专名/缩写的短标题。旧规则: 中文 4 字 vs 拉丁词 9 个 → 比率
	// 0.31 < 0.45 → 拒。新规则只数「还没翻译的普通词」(这里是 0) → 收。
	const source = 'Siemens Naeotom Alpha PCD CT and Somatom Force EID CT scanners';
	assert.equal(
		looksTranslated(source, 'Siemens Naeotom Alpha PCD CT 与 Somatom Force EID CT 扫描仪', 'zh-CN'),
		true,
		'保留原样的专名不该被算作未翻译的拉丁词'
	);
});

test('looksTranslated: 被拆到第二行的署名行原样返回即为正确答案 (专名放行)', () => {
	// Horst 2024 第 1 页 region-2 的原文, 一字不差 (58 字符)。整块没有一个
	// 可译的普通词, 原样返回就是对的; looksLikeAuthorNameList 因为只剩两个
	// 人名分段而失效, 短块规则接住了它。
	const byline = 'Marilyn J. Siegel, MD • Juan Carlos Ramirez-Giraldo, PhD •';
	assert.equal(byline.length, 58, '语料对齐: 诊断里 region-2 是 58 字符');
	assert.equal(looksTranslated(byline, byline, 'zh-CN'), true);
});

test('looksTranslated: 短标题的纯英文回声仍被拒 (真未翻译)', () => {
	// 同一条短标题, 原样回声。普通词 (and / scanners) 原封不动地留着,
	// 中文字数为 0 → 比率 0 → 拒。放宽比率不等于放行回声。
	const source = 'Siemens Naeotom Alpha PCD CT and Somatom Force EID CT scanners';
	assert.equal(looksTranslated(source, source, 'zh-CN'), false);
});

test('looksTranslated: 短标题只译了一半 (专名之外的散文仍是英文) 被拒', () => {
	const source = 'Automatic exposure control in pediatric photon-counting CT';
	assert.equal(
		looksTranslated(source, 'automatic exposure control 在儿科 photon counting CT', 'zh-CN'),
		false,
		'普通词一个都没动 → 残留 5 词 vs 中文 3 字 → 比率 0.375 < 0.45'
	);
});

test('looksTranslated: 全大写/专名短块的原样输出放行, 但空输出仍被拒', () => {
	const source = 'NAEOTOM Alpha Siemens Healthineers Somatom Force Bruker Avance';
	assert.equal(looksTranslated(source, source, 'zh-CN'), true, '无可译普通词 → 放行');
	assert.equal(looksTranslated(source, '   ', 'zh-CN'), false, '空输出永远是失败');
});

test('正常段落的验收强度未被放松: 长段落的低比率译文仍被拒', () => {
	// 短块规则的闸门是「散文 ≤80 字符」。这一段 300+ 字符, 走的还是原来的
	// MIN_TARGET_RATIO, 哪怕它同样专名密集。
	const source = 'The Siemens Naeotom Alpha PCD CT scanner and the Somatom Force EID CT scanner were '
		+ 'compared across a range of pediatric body sizes, with attention to radiation dose, image '
		+ 'noise, and spectral separation at each of the available tube potentials in routine clinical use.';
	assert.ok(source.length > 80, '前提: 这是一个正常段落 (>80 字符散文), 不是短块');
	assert.equal(
		looksTranslated(source, 'Siemens Naeotom Alpha PCD CT scanner and Somatom Force EID CT scanner 做了比较。', 'zh-CN'),
		false,
		'长段落的半译输出必须照旧被拒'
	);
});

test('untranslatedLatinWords: 只数小写开头的普通词', () => {
	assert.equal(untranslatedLatinWords('Siemens Naeotom Alpha PCD CT'), 0);
	assert.equal(untranslatedLatinWords('Siemens and Somatom scanners'), 2, 'and / scanners');
	assert.equal(untranslatedLatinWords('Marilyn J. Siegel, MD • Juan Carlos Ramirez-Giraldo, PhD •'), 0);
	assert.equal(untranslatedLatinWords('光子计数 CT 扫描仪'), 0, '中文里没有拉丁散文词');
});

// ---- 页面缓存完整性 (1.3.0, 审核 P1) -----------------------------------------

test('不完整的页面缓存只作预填, 缺失块继续翻译, 不允许直接 done', async () => {
	// 缓存里只有 block-0 的译文(比如压缩路径曾写入部分结果),block-1 缺失。
	// 旧行为: 命中即 done,block-1 永远英文。新行为: 预填 block-0,翻译 block-1。
	const { deps, calls } = makeDeps({
		readCache: async () => [{ id: 'page-0-block-0', translatedText: '缓存译文零' }]
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const final = manager.getPageState(0)!;
	assert.equal(final.status, 'done');
	assert.equal(final.translations.get('page-0-block-0'), '缓存译文零', '有效缓存被复用');
	assert.equal(final.translations.get('page-0-block-1'), '译:Source paragraph 1 on page 0.', '缺失块被翻译');
	assert.ok(calls.translate >= 1, '不完整缓存必须触发翻译');
	assert.notEqual(final.fromCache, true, '不完整命中不算 fromCache 整页命中');
	manager.dispose();
});

test('缓存含过期 ID 与回显英文时: 过期 ID 忽略, 未通过校验的译文不复用', async () => {
	// 用足够长的散文源文,确保回显英文会被 looksTranslated 拒绝
	// (短标签源文有小样本豁免,是既有设计)。
	const longSrc = (i: number): string =>
		`The quick brown fox jumps over the lazy dog while the committee deliberates extensively on paragraph ${i} of the manuscript today.`;
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [0, 1].map(i => ({
			id: `page-${pageIndex}-block-${i}`, pageIndex, order: i,
			type: 'paragraph' as const, sourceText: longSrc(i)
		})),
		translateRequest: async (request) => ({
			translations: request.blocks.map(b => ({ id: b.id, translatedText: '敏捷的棕色狐狸跳过懒狗,与此同时委员会今天对稿件的这一段进行了详尽的审议。' }))
		}),
		readCache: async () => [
			{ id: 'page-0-block-999', translatedText: '幽灵块' },   // 过期 ID
			{ id: 'page-0-block-0', translatedText: longSrc(0) },   // 回显英文
			{ id: 'page-0-block-1', translatedText: '这是一段完全有效的中文译文,足够长也足够中文。' }
		]
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const final = manager.getPageState(0)!;
	assert.equal(final.status, 'done');
	assert.equal(final.translations.get('page-0-block-1'), '这是一段完全有效的中文译文,足够长也足够中文。');
	assert.ok(/敏捷的棕色狐狸/.test(final.translations.get('page-0-block-0') ?? ''), '回显英文被重翻');
	assert.equal(final.translations.has('page-0-block-999'), false, '过期 ID 不进状态');
	manager.dispose();
});

test('完整且全部通过校验的缓存仍整页命中 (行为不回退)', async () => {
	const { deps, calls } = makeDeps({
		readCache: async () => [
			{ id: 'page-0-block-0', translatedText: '译文零' },
			{ id: 'page-0-block-1', translatedText: '译文一' }
		]
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const final = manager.getPageState(0)!;
	assert.equal(final.status, 'done');
	assert.equal(final.fromCache, true);
	assert.equal(calls.translate, 0, '完整命中零请求');
	manager.dispose();
});

// ---- P2-11 (2.0.2): 重译此段的完整性判据必须给 preserve 块豁免 --------------

test('含 preserve 块的页面: 重译此段后新译文能进页面缓存', async () => {
	// 表格数据单元格是 translationMode:'preserve',永远不会进 translations。
	// 旧判据 state.blocks.every(b => translations.has(b.id)) 在这类页面恒假 →
	// 重译当场生效但写不进页面缓存 → 重开文档回退旧译文,反复重译反复丢失。
	const written: { id: string; translatedText: string }[][] = [];
	const blocks: SourceBlock[] = [
		{ id: 'page-0-block-0', pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'Prose to retranslate.' },
		{ id: 'page-0-cell-0', pageIndex: 0, order: 1, type: 'paragraph', sourceText: '42.7', translationMode: 'preserve' }
	];
	const { deps } = makeDeps({
		extractPage: async () => blocks,
		readCache: async () => null,
		writeCache: async (_p, _b, translations) => { written.push(translations); }
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 1);
	written.length = 0;

	const ok = await manager.retranslateBlock(0, 'page-0-block-0');
	assert.equal(ok, true, '重译应成功');
	assert.equal(written.length, 1, 'preserve 块不得阻止页面缓存写入');
	assert.ok(written[0]!.some(t => t.id === 'page-0-block-0'), '应写入被重译的块');
	assert.ok(!written[0]!.some(t => t.id === 'page-0-cell-0'), 'preserve 块不应出现在缓存条目里');
	manager.dispose();
});

test('仍有未译的可翻译块时, 页面缓存不得写入(不变量不放宽)', async () => {
	const written: unknown[] = [];
	const blocks: SourceBlock[] = [
		{ id: 'page-0-block-0', pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'First prose block.' },
		{ id: 'page-0-block-1', pageIndex: 0, order: 1, type: 'paragraph', sourceText: 'Second prose block.' }
	];
	const { deps } = makeDeps({
		extractPage: async () => blocks,
		readCache: async () => null,
		// 只翻第一个块,第二个永远缺席
		translateRequest: async (request) => ({
			translations: request.blocks.filter(b => b.id === 'page-0-block-0')
				.map(b => ({ id: b.id, translatedText: '译文' }))
		}),
		writeCache: async () => { written.push(1); }
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 1);
	written.length = 0;
	await manager.retranslateBlock(0, 'page-0-block-0');
	assert.equal(written.length, 0, '页面不完整时绝不能写页面缓存');
	manager.dispose();
});

// ---- P1-8 (2.0.2): 取消竞态 —— 刷新本页不得被"已中止但仍在 active"的旧任务挡回 ----

test('翻译进行中点「刷新本页」: 必须真的重翻, 而不是两头落空', async () => {
	// cancel() 对运行中的任务只发 abort,任务要等 run() reject 后才离开 active。
	// 旧实现同步 cancel + 立即 ensurePage → isScheduled 仍为真 → early-return,
	// 而页面状态已被删除、新任务又没入队,该页彻底不翻译(点了圆环什么都没发生)。
	let release: () => void = () => {};
	let calls = 0;
	const { deps } = makeDeps({
		translateRequest: async (request, signal) => {
			calls++;
			if (calls === 1) {
				await new Promise<void>((resolve, reject) => {
					release = resolve;
					signal?.addEventListener('abort', () => reject(new Error('aborted')));
				});
			}
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '新译文' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });

	const first = manager.ensurePage(0, 10).catch(() => { /* 会被取消 */ });
	for (let i = 0; i < 100 && calls === 0; i++) { await new Promise(r => setTimeout(r, 0)); }
	assert.equal(calls, 1, '第一次翻译应已在飞行中');

	await manager.retranslatePage(0, 'normal');

	const state = manager.getPageState(0);
	assert.ok(state, '刷新后必须有页面状态,而不是被删掉后什么都没有');
	assert.equal(state!.status, 'done', `刷新应真的完成翻译,实际 ${state!.status}`);
	assert.ok(calls >= 2, `必须发出新的翻译请求,实际只发了 ${calls} 次`);
	release();
	await first;
	manager.dispose();
});

// ---- P3 (2.0.6): 止损记忆并发轮次 / resetAll / 孤儿错误 / 不完整页缓存 ------

test('止损: 并发页面同一段只算一轮;此后的新运行才叠加;resetAll 清记忆', async () => {
	const { segmentHash } = await import('../../src/translation/translationManager');
	const DOOMED = 'This doomed paragraph never translates properly at all.';
	const seenPages = new Set<number>();
	let releaseBarrier!: () => void;
	const barrier = new Promise<void>(r => { releaseBarrier = r; });
	const { deps } = makeDeps({
		pageCount: () => 10,
		// 每页一好一坏: 全部失败会直接进 error 分支,不会走 keep-origin 记账。
		extractPage: async (p) => [
			{ id: `page-${p}-good`, pageIndex: p, order: 0, type: 'paragraph' as const, sourceText: 'A perfectly fine paragraph with words.' },
			{ id: `page-${p}-block-0`, pageIndex: p, order: 1, type: 'paragraph' as const, sourceText: DOOMED }
		],
		translateRequest: async (req) => {
			// 并发屏障: 两页的首个请求都在飞之前谁也不返回 —— 确保两轮真正重叠
			// (瞬时 mock 下 Promise.all 也可能实际串行,那样"计 2"反而是对的)。
			if (typeof req.pageIndex === 'number' && req.pageIndex <= 1) {
				seenPages.add(req.pageIndex);
				if (seenPages.size >= 2) {
					releaseBarrier();
				}
				await barrier;
			}
			return {
				// 引擎永远丢弃 DOOMED 的 id,好段照常翻。
				translations: req.blocks.filter(b => !b.id.endsWith('block-0'))
					.map(b => ({ id: b.id, translatedText: '好段落的中文译文内容。' }))
			};
		}
	});
	// maxConcurrent 4: 默认 2 减去 1 个前台保留位只剩 1 个后台槽,两页会被迫串行。
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve(), maxConcurrent: 4 });
	const h = segmentHash(DOOMED, 'en', 'zh-CN');
	const fs = (manager as any).failedSegments as Map<string, { count: number; at: number }>;

	// 一轮并发: 两页同一段同时失败 → 只能算一轮。
	await Promise.all([manager.ensurePage(0, 10), manager.ensurePage(1, 10)]);
	assert.equal(fs.get(h)?.count, 1, '并发轮次必须去重 (旧实现这里是 2,一轮打满阈值)');

	// 失败记录之后新发起的运行 → 第二轮,照常尝试 (unrecovered 而非 skipped)。
	await manager.ensurePage(2, 10);
	assert.equal(manager.getPageState(2)!.keepOrigin?.get('page-2-block-0'), 'unrecovered', '第二轮仍要真正尝试');
	assert.equal(fs.get(h)?.count, 2);

	// 阈值已到 → 第三轮被止损跳过。
	await manager.ensurePage(3, 10);
	assert.equal(manager.getPageState(3)!.keepOrigin?.get('page-3-block-0'), 'repeated-failure', '两轮后止损生效');

	// resetAll (刷新全部/换配置) 必须清止损记忆 —— 它比 force 重译意图更强。
	manager.resetAll();
	assert.equal(fs.size, 0, 'resetAll 后止损记忆必须为空');
	await manager.ensurePage(4, 10);
	assert.equal(manager.getPageState(4)!.keepOrigin?.get('page-4-block-0'), 'unrecovered', '重置后重新尝试');
	manager.dispose();
});

test('孤儿 state 的迟到错误不得推给 UI (身份校验闸)', async () => {
	const { PaperMirrorError } = await import('../../src/types/models');
	let releaseExtract!: () => void;
	const gate = new Promise<void>(r => { releaseExtract = r; });
	const states: PageTranslationState[] = [];
	const { deps } = makeDeps({
		extractPage: async () => {
			await gate;
			throw new PaperMirrorError('NO_TEXT_LAYER', 'no text layer', { retryable: false });
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: s => states.push({ ...s }) }, { prefetch: false, delayFn: () => Promise.resolve() });
	const running = manager.ensurePage(0, 10);
	await new Promise(r => setTimeout(r, 10));
	// 模拟 supersession: 新运行已接管该页 (retranslatePage 删旧建新)。
	const fresh = { pageIndex: 0, status: 'translating', blocks: [], translations: new Map() };
	(manager as any).pages.set(0, fresh);
	releaseExtract();
	await running;
	assert.ok(!states.some(s => s.pageIndex === 0 && (s.status === 'no-text-layer' || s.status === 'error')),
		'旧任务迟到的失败不得把错误胶囊推给正在正常运行的新页面');
	assert.equal((manager as any).pages.get(0), fresh, '新状态不受影响');
	manager.dispose();
});

test('全段落缓存分支: keepOrigin 非空时不写页面缓存(否则跳过的段永远无法重试)', async () => {
	const { segmentHash } = await import('../../src/translation/translationManager');
	const DOOMED = 'Another doomed sentence that keeps failing everywhere still.';
	const GOOD = 'A perfectly ordinary paragraph with plenty of words in it.';
	const pageCacheWrites: number[] = [];
	const { deps } = makeDeps({
		pageCount: () => 10,
		extractPage: async (p) => [
			{ id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph' as const, sourceText: GOOD },
			{ id: `page-${p}-block-1`, pageIndex: p, order: 1, type: 'paragraph' as const, sourceText: DOOMED }
		],
		translateRequest: async (req) => ({
			// DOOMED 的 id 永远被丢弃,GOOD 照常翻 (全失败会走 error 分支)。
			translations: req.blocks.filter(b => !b.text.includes('doomed'))
				.map(b => ({ id: b.id, translatedText: '正常段落的中文译文内容。' }))
		}),
		writeCache: async (pageIndex) => { pageCacheWrites.push(pageIndex); },
		readSegments: async (_p, hashes) => {
			// 段落缓存命中 GOOD,不命中 DOOMED。
			const doomedHash = segmentHash(DOOMED, 'en', 'zh-CN');
			return new Map(hashes.filter(x => x !== doomedHash).map(x => [x, '来自段落缓存的译文。']));
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	// 先把 DOOMED 打满两轮止损 (顺序运行,轮次真实)。
	await manager.ensurePage(0, 10);
	(manager as any).pages.delete(0);
	await manager.ensurePage(0, 10);
	pageCacheWrites.length = 0;
	// 页面 1: GOOD 全部由段落缓存服务,DOOMED 被止损 keep-origin → toTranslate 空。
	await manager.ensurePage(1, 10);
	const s1 = manager.getPageState(1)!;
	assert.equal(s1.status, 'done');
	assert.equal(s1.keepOrigin?.get('page-1-block-1'), 'repeated-failure', '场景成立: 确实走了止损');
	assert.equal(s1.translations.get('page-1-block-0'), '来自段落缓存的译文。', '场景成立: 确实全由段落缓存服务');
	assert.ok(!pageCacheWrites.includes(1), 'keepOrigin 非空的页绝不能写页面缓存');
	manager.dispose();
});

// ---- P2-2 (2.0.7): 孤儿 compress 不落盘 -------------------------------------

test('压缩请求飞行期间页面被刷新接管 → 旧 compress 结果不再写缓存', async () => {
	let releaseCompress!: () => void;
	const gate = new Promise<void>(r => { releaseCompress = r; });
	const pageCacheWrites: number[] = [];
	const { deps } = makeDeps({
		extractPage: async (p) => [{
			id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph' as const,
			sourceText: 'A paragraph long enough to be compressed properly here.'
		}],
		translateRequest: async (req) => {
			if (req.blocks.some(b => typeof b.charBudget === 'number')) {
				await gate; // compress 请求悬停,模拟 120s 飞行窗口
				return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '短译' })) };
			}
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '这是一个比较长的初始译文内容。' })) };
		},
		writeCache: async (pageIndex) => { pageCacheWrites.push(pageIndex); }
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const baseline = pageCacheWrites.length;
	const compressing = manager.compressBlocks(0, [{ id: 'page-0-block-0', maxChars: 4 }]);
	await new Promise(r => setTimeout(r, 10));
	// 模拟「刷新本页」接管: 新 state 已就位。
	const fresh = { pageIndex: 0, status: 'done', blocks: [], translations: new Map() };
	(manager as any).pages.set(0, fresh);
	releaseCompress();
	await compressing;
	assert.equal(pageCacheWrites.length, baseline, '被接管后旧 compress 绝不能再写页面缓存');
	manager.dispose();
});

// ---- P2-3 (2.0.7): 取消路径的部分落盘必须在任务解绕前完成 -------------------

test('resetAllAndWait 返回时,被取消任务的 persistPartial 已经落盘完成', async () => {
	const { PaperMirrorError } = await import('../../src/types/models');
	let segWriteDone = false;
	let sawSalvageHang = false;
	const { deps } = makeDeps({
		// 两个超长段各占一个 chunk: chunk 1 完整完成 (results 已收录),
		// chunk 2 悬停到被 abort —— persistPartial 应把 chunk 1 落盘。
		extractPage: async (p) => [0, 1].map(i => ({
			id: `page-${p}-block-${i}`, pageIndex: p, order: i, type: 'paragraph' as const,
			sourceText: `Paragraph ${i}. ` + 'Plenty of English words here. '.repeat(300)
		})),
		translateRequest: async (req, signal) => {
			if (req.blocks.some(b => b.id === 'page-0-block-1')) {
				sawSalvageHang = true; // 第二个 chunk 悬停直到 abort
				return new Promise((_resolve, reject) => {
					signal?.addEventListener?.('abort', () => reject(new PaperMirrorError('CANCELLED', 'aborted')));
				});
			}
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '这里是足够长的完整中文译文内容。'.repeat(200) })) };
		},
		writeSegments: async () => {
			await new Promise(r => setTimeout(r, 20)); // 模拟慢磁盘
			segWriteDone = true;
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	const running = manager.ensurePage(0, 10);
	await new Promise(r => setTimeout(r, 30));
	assert.equal(sawSalvageHang, true, '场景成立: 救回请求确实在飞');
	await manager.resetAllAndWait();
	assert.equal(segWriteDone, true,
		'resetAllAndWait 返回即意味着没有写还悬在队列里 —— 否则「刷新全部」的清盘会与它竞态,被丢弃的译文复活');
	await running.catch(() => { /* cancelled */ });
	manager.dispose();
});

// ---- P2-6 (2.0.8): 轮换刷新必须真正重译 (bypassSegments),且不清全局止损 ----

test("retranslatePage('rotate') 绕过段落库真正重译;'normal' 仍复用段落", async () => {
	const { segmentHash } = await import('./../../src/translation/translationManager');
	let translateCalls = 0;
	const TEXT = 'A paragraph with plenty of English words to translate here.';
	const { deps } = makeDeps({
		extractPage: async (p) => [{
			id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph' as const,
			sourceText: TEXT
		}],
		translateRequest: async (req) => {
			translateCalls++;
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '新引擎的完整中文译文内容。' })) };
		},
		readSegments: async (_p, hashes) =>
			new Map(hashes.map(h => [h, '旧引擎存进段落库的译文。'])),
		writeSegments: async () => {}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	assert.equal(translateCalls, 0, '场景成立: 首次由段落库整页服务');
	assert.equal(manager.getPageState(0)!.translations.get('page-0-block-0'), '旧引擎存进段落库的译文。');

	// 'normal' 刷新: 段落库照旧命中,零请求 —— 这正是轮换后「刷新没反应」的机制。
	await manager.retranslatePage(0, 'normal');
	assert.equal(translateCalls, 0);
	assert.equal(manager.getPageState(0)!.translations.get('page-0-block-0'), '旧引擎存进段落库的译文。');

	// 'rotate' 刷新: 绕过段落库,新引擎真正重译。
	const seeded = segmentHash('unrelated doomed segment elsewhere', 'en', 'zh-CN');
	(manager as any).failedSegments.set(seeded, { count: 2, seq: 1 });
	await manager.retranslatePage(0, 'rotate');
	assert.ok(translateCalls > 0, '轮换刷新必须发出真实请求');
	assert.equal(manager.getPageState(0)!.translations.get('page-0-block-0'), '新引擎的完整中文译文内容。');
	assert.ok((manager as any).failedSegments.has(seeded), "'rotate' 不得像 'force' 那样清掉别处的全局止损记忆");
	manager.dispose();
});

// ---- 2.3.5 (第四批 item7 · API-2): 同页相同内容去重 -------------------------

test('同页同文块只翻译一次,其余镜像共享译文', async () => {
	const requested: string[][] = [];
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [
			{ id: `page-${pageIndex}-block-0`, pageIndex, order: 0, type: 'paragraph' as const, sourceText: 'Repeated boilerplate sentence here.' },
			{ id: `page-${pageIndex}-block-1`, pageIndex, order: 1, type: 'paragraph' as const, sourceText: 'A different body paragraph entirely.' },
			{ id: `page-${pageIndex}-block-2`, pageIndex, order: 2, type: 'paragraph' as const, sourceText: 'Repeated boilerplate sentence here.' }
		],
		translateRequest: async (request) => {
			requested.push(request.blocks.map(b => b.id));
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: '译文:' + b.id })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	const sent = requested.flat();
	assert.ok(!sent.includes('page-0-block-2'), '重复块不进请求(只送代表块)');
	assert.equal(state.translations.size, 3, '三个块全部拿到译文');
	assert.equal(state.translations.get('page-0-block-2'), state.translations.get('page-0-block-0'), '重复块镜像代表块的译文');
	manager.dispose();
});
