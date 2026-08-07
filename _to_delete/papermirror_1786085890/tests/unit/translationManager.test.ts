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
				return { translations: [{ id: request.blocks[0]!.id, translatedText: 'ok' }] };
			}
			// Retry: return the requested (missing) blocks
			return { translations: request.blocks.map(b => ({ id: b.id, translatedText: 'retry' })) };
		}
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.translations.size, 2);
	assert.equal(state.translations.get('page-0-block-1'), 'retry');
	manager.dispose();
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
