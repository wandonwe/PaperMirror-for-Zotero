import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationManager, type PageTranslationState, type TranslationDeps } from '../../src/translation/translationManager';
import type { SourceBlock, TranslationRequest, TranslationResponse } from '../../src/types/models';

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

test('salvage recovers ALL dropped ids, not just the first eight', async () => {
	const N = 12;
	let singleCalls = 0;
	const { deps } = makeDeps({
		extractPage: async (pageIndex) => Array.from({ length: N }, (_, i) => ({
			id: `page-${pageIndex}-block-${i}`,
			pageIndex, order: i, type: 'paragraph' as const,
			sourceText: `Paragraph ${i} with enough text to be a real block on page ${pageIndex}.`
		})),
		translateRequest: async (request) => {
			if (request.blocks.length > 1) {
				// A provider that drops everything but the first block of any batch.
				return { translations: [{ id: request.blocks[0]!.id, translatedText: '批量译文内容' }] };
			}
			// Single-block salvage always succeeds (no id drift possible).
			singleCalls++;
			return { translations: [{ id: request.blocks[0]!.id, translatedText: '单块译文救回内容' }] };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	assert.equal(state.translations.size, N, 'every block is translated, not just 8');
	assert.ok(singleCalls >= N - 2, `salvage ran for all the dropped blocks (ran ${singleCalls})`);
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
