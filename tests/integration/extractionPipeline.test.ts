/**
 * Integration tests: run the full extraction + translation pipeline against
 * synthetic fixtures for each required document type, using a fake in-memory
 * provider. Exercises blockBuilder -> TranslationManager -> formula guard ->
 * cache, without Zotero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlocks } from '../../src/reader/blockBuilder';
import { TranslationManager, type TranslationDeps } from '../../src/translation/translationManager';
import type { SourceBlock, TranslationRequest, TranslationResponse } from '../../src/types/models';
import { PaperMirrorError } from '../../src/types/models';
import * as fixtures from '../fixtures/pageFixtures';

function blocksFor(chars: typeof fixtures.englishSingleColumn, includeReferences = false): SourceBlock[] {
	return buildBlocks(chars, { pageIndex: 0, pageWidth: 600, pageHeight: 792, includeReferences }).blocks;
}

function fakeProvider(): TranslationDeps['translateRequest'] {
	// A realistic mock: a predominantly-Chinese translation that PRESERVES the
	// tokens a real translation keeps verbatim — formula placeholders (⟦PMn⟧),
	// numbers, percentages, and short acronyms (CI, MRI). Echoing the raw
	// English back would (correctly) be rejected by the completeness check.
	const KEEP = /⟦PM\d+⟧|[A-Za-z]*\d[\w.,%±\-–/]*|[A-Z]{2,4}/g;
	return async (request: TranslationRequest): Promise<TranslationResponse> => ({
		translations: request.blocks.map(b => ({
			id: b.id,
			translatedText: '译文内容' + (b.text.match(KEEP) ?? []).map(t => ' ' + t).join('') + '。'
		}))
	});
}

function managerFor(blocks: SourceBlock[], translate = fakeProvider()): TranslationManager {
	const cache = new Map<number, { id: string; translatedText: string }[]>();
	const deps: TranslationDeps = {
		extractPage: async () => blocks,
		translateRequest: translate,
		readCache: async (p) => cache.get(p) ?? null,
		writeCache: async (p, _b, t) => { cache.set(p, t); },
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Fixture',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => 1
	};
	return new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
}

test('English single-column: headings + paragraphs extracted and translated', async () => {
	const blocks = blocksFor(fixtures.englishSingleColumn);
	assert.ok(blocks.some(b => b.type === 'heading' || b.type === 'title'));
	assert.ok(blocks.some(b => /radiomics/i.test(b.sourceText)));
	const manager = managerFor(blocks);
	await manager.ensurePage(0, 10);
	const state = manager.getPageState(0)!;
	assert.equal(state.status, 'done');
	assert.equal(state.translations.size, blocks.length);
	manager.dispose();
});

test('English two-column: left column ordered before right', async () => {
	const blocks = blocksFor(fixtures.englishTwoColumn);
	const order = blocks.map(b => b.sourceText.slice(0, 12));
	const l1 = order.findIndex(t => t.startsWith('Left column'));
	const r1 = order.findIndex(t => t.startsWith('Right column'));
	assert.ok(l1 !== -1 && r1 !== -1 && l1 < r1);
});

test('Chinese paper: extracted (direction handled upstream)', async () => {
	const blocks = blocksFor(fixtures.chinesePaper);
	assert.ok(blocks.some(b => /影像组学/.test(b.sourceText)));
	const manager = managerFor(blocks);
	await manager.ensurePage(0, 10);
	assert.equal(manager.getPageState(0)!.status, 'done');
	manager.dispose();
});

test('Mixed-language paper: numbers and CI preserved through pipeline', async () => {
	const blocks = blocksFor(fixtures.mixedLanguage);
	const manager = managerFor(blocks);
	await manager.ensurePage(0, 10);
	const joined = [...manager.getPageState(0)!.translations.values()].join(' ');
	assert.match(joined, /1\.42/);
	assert.match(joined, /95% CI/);
	manager.dispose();
});

test('Formula paper: LaTeX restored verbatim after translation', async () => {
	const blocks = blocksFor(fixtures.withFormula);
	const manager = managerFor(blocks);
	await manager.ensurePage(0, 10);
	const joined = [...manager.getPageState(0)!.translations.values()].join('\n');
	assert.ok(joined.includes('$y = \\beta_0 + \\beta_1 x_1$'), 'LaTeX span restored');
	manager.dispose();
});

test('Captions/tables classified', async () => {
	const blocks = blocksFor(fixtures.withCaption);
	assert.ok(blocks.some(b => b.type === 'caption'));
	assert.ok(blocks.some(b => b.type === 'table'));
});

test('References 默认保留为 preserve 几何块,打开开关则可译 (P2-5, 2.0.8)', async () => {
	const preserved = blocksFor(fixtures.withReferences, false);
	const ref = preserved.find(b => /Smith J/.test(b.sourceText));
	assert.ok(ref, '条目保留在 blocks 里 (纯几何身份,供 inkObstacles 避让)');
	assert.equal(ref!.translationMode, 'preserve', '默认绝不进入翻译');
	const included = blocksFor(fixtures.withReferences, true);
	const translatable = included.find(b => /Smith J/.test(b.sourceText));
	assert.ok(translatable && translatable.translationMode === undefined);
});

test('Scanned page (no chars) yields no blocks (caller surfaces OCR notice)', async () => {
	const blocks = blocksFor(fixtures.scannedPage);
	assert.equal(blocks.length, 0);
});

test('Provider failure surfaces as error status, not a blank pane', async () => {
	const blocks = blocksFor(fixtures.englishSingleColumn);
	const manager = managerFor(blocks, async () => {
		throw new PaperMirrorError('RATE_LIMITED', 'slow down', { retryable: false });
	});
	await manager.ensurePage(0, 10);
	assert.equal(manager.getPageState(0)!.status, 'error');
	manager.dispose();
});

test('50+ page document: pages translate independently and cache', async () => {
	const cache = new Map<number, { id: string; translatedText: string }[]>();
	let translateCalls = 0;
	const deps: TranslationDeps = {
		extractPage: async (p) => [{ id: `page-${p}-block-0`, pageIndex: p, order: 0, type: 'paragraph', sourceText: `Body text for page ${p}.` }],
		translateRequest: async (req) => { translateCalls++; return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '译' })) }; },
		readCache: async (p) => cache.get(p) ?? null,
		writeCache: async (p, _b, t) => { cache.set(p, t); },
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Long',
		getGlossary: () => [],
		useContext: () => false,
		pageCount: () => 60
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	for (let p = 0; p < 55; p++) {
		await manager.ensurePage(p, 5);
	}
	assert.equal(translateCalls, 55);
	// Re-visiting a page uses cache (no new call)
	const before = translateCalls;
	manager.dispose();
	const manager2 = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager2.ensurePage(10, 5);
	assert.equal(translateCalls, before);
	manager2.dispose();
});
