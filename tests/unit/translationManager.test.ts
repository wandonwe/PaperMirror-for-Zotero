import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationManager, looksContextBleed, looksTranslated, type PageTranslationState, type TranslationDeps } from '../../src/translation/translationManager';
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
	// New contract (0.9.8): total requests for a page are capped at 2×chunks + 2,
	// so an engine that keeps dropping ids can never explode into per-block
	// storms. Whatever comes back within budget is kept; the rest is left for
	// 「刷新本页」 (and the circuit breaker reroutes to a backup engine).
	const N = 12;
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
	// N short blocks → one planned chunk → cap = 2×1 + 2 = 4 total requests.
	assert.ok(totalCalls <= 4, `page requests are bounded, ran ${totalCalls}`);
	// Successful blocks are always retained (never re-requested or dropped).
	assert.ok(state.translations.size >= 1 && state.translations.size < N, `kept ${state.translations.size} recovered blocks`);
	manager.dispose();
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
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: true, delayFn: () => Promise.resolve() });
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
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: true, maxConcurrent: 1, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(5);
	await new Promise(r => setTimeout(r, 20));
	assert.ok(order.includes(5), 'the current page 5 translated');
	assert.ok(!order.includes(4), 'page 4 is queued behind the blocked page 6 prefetch');
	manager.setCurrentPage(4); // page 4 was a queued prefetch → promote + run
	await new Promise(r => setTimeout(r, 20));
	assert.ok(order.includes(4), 'navigating to the queued page runs it now, not stuck behind page 6');
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
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: true, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(3);
	await new Promise(r => setTimeout(r, 30));
	assert.equal(order[0], 3, 'the current page is translated first');
	assert.ok(order.includes(2) && order.includes(4), 'neighbours are prefetched afterwards');
	assert.ok(order.indexOf(3) < order.indexOf(4), 'current page precedes its neighbours');
	manager.dispose();
});

test('chunks of one page run concurrently (2-way), and every block still lands', async () => {
	// Two big blocks (5000 chars each) → planChunks(8000 budget) → 2 chunks.
	let active = 0;
	let maxActive = 0;
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => [0, 1].map(i => ({
			id: `page-${pageIndex}-block-${i}`,
			pageIndex, order: i, type: 'paragraph' as const,
			sourceText: 'x'.repeat(5000)
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
