import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceBlock, TranslationRequest } from '../../src/types/models';
import { TranslationManager, segmentHash, type TranslationDeps } from '../../src/translation/translationManager';
import { buildSystemPrompt, buildUserPayload } from '../../src/translation/promptBuilder';
import { contextualSourceText } from '../../src/translation/sourceContinuity';
import { fnv1a64 } from '../../src/cache/cacheSchema';

// These are source-input and lifecycle regressions. Mock responses cannot
// certify translation quality; Gori/Kitagawa native acceptance covers that.
const negatedHead = 'All participants completed the examination without complications (i.e. no failed';
const negatedTail = 'acquisitions or intolerance). Subjects underwent a complete examination.';
const bleedTail = 'acquisitions or intolerance). Subjects underwent a complete diagnostic examination.';
const timingHead = 'Baseline blood pressure and heart rate are measured before rate-control agents';
const timingTail = 'and/or nitroglycerin are administered, and patients are coached on breath-holding.';

function body(id: string, text: string, pageIndex = 0, column = 0, y = 100, height = 24): SourceBlock {
	const x = column === 0 ? 40 : 310;
	return {
		id, pageIndex, order: 0, readingIndex: 0, type: 'paragraph', sourceText: text,
		column, fontSize: 8,
		boundingBox: { x, y, width: 240, height },
		lineRectsPdf: [[x, 792 - y - height, x + 240, 792 - y - height + 8]],
		sourceRegion: { id: `${id}-body`, kind: 'body-column',
			boundsPdf: [x, 792 - y - height, x + 240, 792 - y], evidence: 'column-geometry' }
	};
}

function ordered(blocks: SourceBlock[]): SourceBlock[] {
	return blocks.map((b, i) => ({ ...b, order: i, readingIndex: i }));
}

function splitColumn(tailText = negatedTail): SourceBlock[] {
	return ordered([body('left', negatedHead, 0, 0, 700), body('right', tailText, 0, 1, 60)]);
}

function translation(text: string): string {
	return '译文保留原有语义和关系。'.repeat(Math.max(1, Math.ceil(text.length / 60)));
}

function harness(pages: Map<number, SourceBlock[]>, overrides: Partial<TranslationDeps> = {}) {
	const requests: TranslationRequest[] = [];
	const extracted: number[] = [];
	const deps: TranslationDeps = {
		extractPage: async p => { extracted.push(p); return structuredClone(pages.get(p) ?? []); },
		translateRequest: async req => {
			requests.push(structuredClone(req));
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: translation(b.text) })) };
		},
		readCache: async () => null,
		writeCache: async () => {},
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'A paper with a complete source sentence',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => Math.max(1, ...[...pages.keys()].map(p => p + 1)),
		...overrides
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	return { manager, deps, requests, extracted };
}

function requested(requests: TranslationRequest[], id: string) {
	return requests.flatMap(r => r.blocks).filter(b => b.id === id);
}

test('disabling context strips stale continuation metadata from incoming source blocks', async () => {
 const pages = splitColumn().map(b => ({...b, continuationContext: {before:'Old source evidence', after:''}}));
 const h = harness(new Map([[0,pages]]), {useContext:()=>false});
 try {
  await h.manager.ensurePage(0,10);
  assert.ok(h.manager.getPageState(0)!.blocks.every(b=>b.continuationContext===undefined));
  assert.ok(h.requests.flatMap(r=>r.blocks).every(b=>b.continuationContext===undefined));
  assert.deepEqual(h.extracted,[0]);
 } finally {h.manager.dispose();}
});

test('cross-column requests carry both source directions while retaining ids and source geometry', async () => {
	const blocks = splitColumn();
	const before = structuredClone(blocks);
	const h = harness(new Map([[0, blocks]]));
	try {
		await h.manager.ensurePage(0, 10);
		assert.ok(requested(h.requests, 'left')[0]?.continuationContext?.after.includes('acquisitions or intolerance'));
		assert.ok(requested(h.requests, 'right')[0]?.continuationContext?.before.includes('no failed'));
		const state = h.manager.getPageState(0)!;
		assert.equal(state.status, 'done');
		assert.deepEqual(state.blocks.map(b => b.id), before.map(b => b.id));
		assert.deepEqual(state.blocks.map(b => b.sourceText), before.map(b => b.sourceText));
		assert.deepEqual(state.blocks.map(b => [b.boundingBox, b.lineRectsPdf]), before.map(b => [b.boundingBox, b.lineRectsPdf]));
		assert.deepEqual(blocks, before, 'source extractor objects are not mutated');
	}
	finally { h.manager.dispose(); }
});

test('opening a page directly reads the previous source page without translating it', async () => {
	const h = harness(new Map([
		[0, [body('previous', timingHead, 0, 1, 700)]],
		[1, [body('current', timingTail, 1, 0, 500)]]
	]));
	try {
		await h.manager.ensurePage(1, 10);
		assert.ok(h.extracted.includes(0), 'source context must not depend on visiting the preceding page');
		assert.ok(requested(h.requests, 'current')[0]?.continuationContext?.before.includes('before rate-control agents'));
		assert.ok(h.requests.every(r => r.pageIndex === 1), 'neighbour extraction is source-only');
		assert.equal(h.manager.getPageState(0), undefined, 'context extraction is not a completed translation page');
	}
	finally { h.manager.dispose(); }
});

test('opening the earlier page reads following source before translating an unfinished timing clause', async () => {
	const h = harness(new Map([
		[0, [body('current', timingHead, 0, 1, 700)]],
		[1, [body('following', timingTail, 1, 0, 500)]]
	]));
	try {
		await h.manager.ensurePage(0, 10);
		assert.ok(h.extracted.includes(1));
		assert.ok(requested(h.requests, 'current')[0]?.continuationContext?.after.includes('nitroglycerin are administered'));
		assert.ok(h.requests.every(r => r.pageIndex === 0));
	}
	finally { h.manager.dispose(); }
});

test('adjacent-page context chooses body flow rather than trailing table cells or preceding captions', async () => {
	const cell: SourceBlock = { ...body('table', 'Reconstruction software.', 0, 1, 600), tableRow: 1, tableCol: 1,
		sourceRegion: { id: 'table-cell', kind: 'table-cell', boundsPdf: [40, 100, 280, 120], evidence: 'table-model' } };
	const caption: SourceBlock = { ...body('caption', 'Figure 2 Scan phases.', 1, 0, 100), type: 'caption',
		sourceRegion: { id: 'caption-region', kind: 'caption', boundsPdf: [40, 600, 280, 625], evidence: 'label-aligned-lines' } };
	const h = harness(new Map([
		[0, ordered([body('previous', timingHead, 0, 1, 700), cell])],
		[1, ordered([caption, body('current', timingTail, 1, 0, 500)])]
	]));
	try {
		await h.manager.ensurePage(1, 10);
		const c = requested(h.requests, 'current')[0]?.continuationContext;
		assert.ok(c?.before.includes('before rate-control agents'));
		assert.ok(!c?.before.includes('Reconstruction software'));
		assert.ok(!c?.before.includes('Figure 2'));
		assert.equal(requested(h.requests, 'caption')[0]?.continuationContext, undefined);
	}
	finally { h.manager.dispose(); }
});

test('a cached preceding fragment still supplies source context to a missing fragment', async () => {
	let cacheBlocks: SourceBlock[] = [];
	const h = harness(new Map([[0, splitColumn()]]), {
		readCache: async (_p, blocks) => {
			cacheBlocks = structuredClone(blocks);
			return [{ id: 'left', translatedText: '所有参与者均完成检查，未出现失败的' }];
		}
	});
	try {
		await h.manager.ensurePage(0, 10);
		assert.ok(cacheBlocks.find(b => b.id === 'right')?.continuationContext?.before.includes('no failed'),
			'continuity identity exists before the page-cache lookup');
		assert.equal(requested(h.requests, 'left').length, 0);
		assert.ok(requested(h.requests, 'right')[0]?.continuationContext?.before.includes('no failed'));
	}
	finally { h.manager.dispose(); }
});

test('an isolated slow chunk retains the source continuation omitted from its request batch', async () => {
	const longTail = negatedTail + ' The remaining participants had complete follow-up and stable measurements.'.repeat(45);
	const h = harness(new Map([[0, splitColumn(longTail)]]));
	try {
		await h.manager.ensurePage(0, 10);
		const slow = h.requests.find(r => r.blocks.some(b => b.id === 'right'))!;
		assert.equal(slow.blocks.length, 1, 'long paragraph is routed independently');
		assert.ok(slow.blocks[0]?.continuationContext?.before.includes('no failed'));
		assert.equal(h.manager.getPageState(0)?.status, 'done');
	}
	finally { h.manager.dispose(); }
});

test('segment identity includes continuation but preserves the old hash for independent text', () => {
	const a = { before: negatedHead, after: '' };
	const b = { before: 'The participants experienced failed', after: '' };
	assert.notEqual(segmentHash(negatedTail, 'en', 'zh-CN', a), segmentHash(negatedTail, 'en', 'zh-CN', b));
	assert.notEqual(segmentHash(negatedTail, 'en', 'zh-CN', a), segmentHash(negatedTail, 'en', 'zh-CN'));
	assert.equal(segmentHash('A complete independent sentence.', 'en', 'zh-CN'),
		fnv1a64('A complete independent sentence.\u0000en\u0000zh-CN'));
});

test('page-cache source identity changes with the adjoining sentence rather than display text', () => {
	const block = body('fragment', negatedTail);
	assert.equal(contextualSourceText(block), negatedTail);
	const a = { ...block, continuationContext: { before: negatedHead, after: '' } };
	const b = { ...block, continuationContext: { before: 'Participants reported failed', after: '' } };
	assert.notEqual(contextualSourceText(a), contextualSourceText(b));
	assert.notEqual(contextualSourceText(a), negatedTail);
	assert.equal(a.sourceText, negatedTail);
});

test('the old context-free fragment cache cannot prefill a contextual fragment', async () => {
	const oldHash = segmentHash(negatedTail, 'en', 'zh-CN');
	const lookedUp: string[] = [];
	const h = harness(new Map([[0, splitColumn()]]), {
		readSegments: async (_p, hashes) => {
			lookedUp.push(...hashes);
			return new Map([[oldHash, '发生采集或不耐受。']]);
		}
	});
	try {
		await h.manager.ensurePage(0, 10);
		assert.ok(!lookedUp.includes(oldHash));
		assert.ok(requested(h.requests, 'right').length > 0);
		assert.notEqual(h.manager.getPageState(0)?.translations.get('right'), '发生采集或不耐受。');
	}
	finally { h.manager.dispose(); }
});

test('identical fragments with different adjoining clauses are not deduplicated together', async () => {
	const tail = 'acquisitions or intolerance).';
	const blocks = ordered([
		body('negative-head', negatedHead, 0, 0, 100), body('negative-tail', tail, 0, 0, 126),
		body('positive-head', 'Some participants experienced failed', 0, 0, 200), body('positive-tail', tail, 0, 0, 226)
	]);
	const h = harness(new Map([[0, blocks]]));
	try {
		await h.manager.ensurePage(0, 10);
		const negative = requested(h.requests, 'negative-tail')[0]!;
		const positive = requested(h.requests, 'positive-tail')[0]!;
		assert.ok(negative, 'negative fragment is sent under its own id');
		assert.ok(positive, 'positive fragment is sent under its own id');
		assert.notDeepEqual(negative.continuationContext, positive.continuationContext);
		assert.ok(negative.continuationContext?.before.includes('no failed'));
		assert.ok(positive.continuationContext?.before.includes('experienced failed'));
	}
	finally { h.manager.dispose(); }
});

test('stable neighbouring source reuses contextual segments while changed source invalidates only that identity', async () => {
	const pages = new Map([
		[0, [body('previous', negatedHead, 0, 1, 700)]],
		[1, [body('current', negatedTail, 1, 0, 60)]]
	]);
	const segments = new Map<string, string>();
	const storage: Partial<TranslationDeps> = {
		readSegments: async (_p, hashes) => new Map(hashes.flatMap(hash => {
			const value = segments.get(hash);
			return value === undefined ? [] : [[hash, value] as [string, string]];
		})),
		writeSegments: async (_p, entries) => { for (const entry of entries) segments.set(entry.hash, entry.translatedText); }
	};
	const first = harness(pages, storage);
	try {
		await first.manager.ensurePage(1, 10);
		assert.ok(first.requests.length > 0);
		const block = first.manager.getPageState(1)!.blocks[0]!;
		assert.ok(segments.has(segmentHash(block.sourceText, 'en', 'zh-CN', block.continuationContext)),
			'initial and partial persistence use the contextual key');
	}
	finally { first.manager.dispose(); }
	const repeat = harness(pages, storage);
	try {
		await repeat.manager.ensurePage(1, 10);
		assert.equal(repeat.requests.length, 0, 'same adjoining source costs no new translation');
		assert.equal(repeat.manager.getPageState(1)?.diagnostics?.segmentHits, 1);
	}
	finally { repeat.manager.dispose(); }
	pages.set(0, [body('previous', 'Some participants experienced failed', 0, 1, 700)]);
	const changed = harness(pages, storage);
	try {
		await changed.manager.ensurePage(1, 10);
		assert.ok(changed.requests.length > 0, 'changed source context cannot reuse the previous negative translation');
		assert.ok(requested(changed.requests, 'current')[0]?.continuationContext?.before.includes('experienced failed'));
	}
	finally { changed.manager.dispose(); }
});

test('one-block retranslation retains source-only continuation and writes its contextual segment hash', async () => {
	const written: { hash: string; translatedText: string }[] = [];
	const h = harness(new Map([[0, splitColumn()]]), { writeSegments: async (_p, entries) => { written.push(...entries); } });
	try {
		await h.manager.ensurePage(0, 10);
		h.requests.length = 0;
		assert.equal(await h.manager.retranslateBlock(0, 'right'), true);
		const sent = requested(h.requests, 'right')[0]!;
		assert.ok(sent.continuationContext?.before.includes('no failed'));
		assert.ok(!JSON.stringify(sent.continuationContext).includes('译文'));
		const saved = h.manager.getPageState(0)!.blocks.find(b => b.id === 'right')!;
		const expected = segmentHash(saved.sourceText, 'en', 'zh-CN', saved.continuationContext);
		assert.equal(written.at(-1)?.hash, expected);
	}
	finally { h.manager.dispose(); }
});

test('layout compression preserves the same continuation and cache identity', async () => {
	const written: { hash: string; translatedText: string }[] = [];
	const h = harness(new Map([[0, splitColumn()]]), { writeSegments: async (_p, entries) => { written.push(...entries); } });
	try {
		await h.manager.ensurePage(0, 10);
		const before = h.manager.getPageState(0)!.blocks.find(b => b.id === 'right')!.continuationContext;
		h.requests.length = 0;
		h.deps.translateRequest = async req => {
			h.requests.push(structuredClone(req));
			return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '无采集失败或不耐受。' })) };
		};
		await h.manager.compressBlocks(0, [{ id: 'right', maxChars: 14 }]);
		const compressed = requested(h.requests, 'right')[0]!;
		assert.equal(compressed.charBudget, 14);
		assert.deepEqual(compressed.continuationContext, before);
		assert.equal(written.at(-1)?.hash, segmentHash(negatedTail, 'en', 'zh-CN', before));
	}
	finally { h.manager.dispose(); }
});

test('missing-id and single-block salvage requests retain continuation evidence', async () => {
	const h = harness(new Map([[0, splitColumn()]]));
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		if (h.requests.length <= 2) {
			return { translations: req.blocks.filter(b => b.id === 'left').map(b => ({ id: b.id, translatedText: translation(b.text) })) };
		}
		return { translations: req.blocks.map(b => ({ id: b.id, translatedText: '没有采集失败或不耐受。' })) };
	};
	try {
		await h.manager.ensurePage(0, 10);
		const tailRequests = requested(h.requests, 'right');
		assert.ok(tailRequests.length >= 3, 'batch, missing-id retry and single salvage reached');
		assert.ok(tailRequests.every(b => b.continuationContext?.before.includes('no failed')));
		assert.equal(h.manager.getPageState(0)?.translations.get('right'), '没有采集失败或不耐受。');
	}
	finally { h.manager.dispose(); }
});

test('grouped salvage keeps each missing fragment paired with its own source clause', async () => {
	const names = ['first', 'second', 'third'];
	const blocks = ordered(names.flatMap((name, i) => [
		body(`head-${name}`, `The ${name} cohort completed the examination without complications (i.e. no failed`, 0, 0, 100 + i * 100),
		body(`tail-${name}`, 'acquisitions or intolerance).', 0, 0, 126 + i * 100)
	]));
	const h = harness(new Map([[0, blocks]]));
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		return { translations: req.blocks.filter(b => !b.id.startsWith('tail-') || h.requests.length >= 3)
			.map(b => ({ id: b.id, translatedText: translation(b.text) })) };
	};
	try {
		await h.manager.ensurePage(0, 10);
		const grouped = h.requests.find((r, i) => i >= 2 && r.blocks.length === 3
			&& r.blocks.every(b => b.id.startsWith('tail-')));
		assert.ok(grouped, 'three missing ids reach grouped salvage');
		for (const fragment of grouped.blocks) {
			const name = fragment.id.slice('tail-'.length);
			assert.ok(fragment.continuationContext?.before.includes(`The ${name} cohort`));
			assert.ok(fragment.continuationContext?.before.includes('no failed'));
		}
	}
	finally { h.manager.dispose(); }
});

test('plain final recovery receives continuation in both request and actual prompt payload', async () => {
	const h = harness(new Map([[0, splitColumn()]]));
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		return { translations: req.blocks.filter(b => b.id === 'left' || req.plain)
			.map(b => ({ id: b.id, translatedText: req.plain ? '没有采集失败或不耐受。' : translation(b.text) })) };
	};
	try {
		await h.manager.ensurePage(0, 10);
		const plain = h.requests.find(r => r.plain && r.blocks.some(b => b.id === 'right'))!;
		assert.ok(plain, 'final plain recovery is exercised');
		assert.ok(plain.blocks[0]?.continuationContext?.before.includes('no failed'));
		assert.ok(buildUserPayload(plain).includes('no failed'), 'the provider sees continuation, not only the bare fragment');
		assert.ok(/continu|scope|negat|fragment|sentence/i.test(buildSystemPrompt(plain)), 'plain system retains the source-sentence rule');
	}
	finally { h.manager.dispose(); }
});

test('complete independent prose needs no neighbouring source-page extraction', async () => {
	const h = harness(new Map([
		[0, [body('before', 'The earlier independent paragraph ends here.', 0)]],
		[1, [body('complete', 'An independent complete sentence starts and ends on this page.', 1)]],
		[2, [body('after', 'The following independent paragraph ends here.', 2)]]
	]));
	try {
		await h.manager.ensurePage(1, 10);
		assert.deepEqual(h.extracted, [1]);
		assert.ok(h.requests.flatMap(r => r.blocks).every(b => b.continuationContext === undefined));
	}
	finally { h.manager.dispose(); }
});

test('independent prose continues to reuse its existing context-free segment cache', async () => {
	const text = 'An independent complete sentence starts and ends on this page.';
	const oldHash = segmentHash(text, 'en', 'zh-CN');
	const h = harness(new Map([[0, [body('independent', text)]]]), {
		readSegments: async (_p, hashes) => {
			assert.deepEqual(hashes, [oldHash]);
			return new Map([[oldHash, '独立完整的句子在本页开始并结束。']]);
		}
	});
	try {
		await h.manager.ensurePage(0, 10);
		assert.equal(h.requests.length, 0);
		assert.equal(h.manager.getPageState(0)?.diagnostics?.segmentHits, 1);
	}
	finally { h.manager.dispose(); }
});

test('disabled contextual reading does not extract adjoining pages or inject their source', async () => {
	const h = harness(new Map([
		[0, [body('before', timingHead, 0, 1, 700)]],
		[1, [body('current', timingTail, 1, 0, 500)]]
	]), { useContext: () => false });
	try {
		await h.manager.ensurePage(1, 10);
		assert.deepEqual(h.extracted, [1]);
		assert.ok(h.requests.flatMap(r => r.blocks).every(b => b.continuationContext === undefined));
	}
	finally { h.manager.dispose(); }
});

test('unavailable adjoining source never invents continuation or translates that page', async () => {
	const h = harness(new Map([[0, [body('current', timingHead, 0, 1, 700)]], [1, []]]));
	h.deps.extractPage = async p => {
		h.extracted.push(p);
		if (p === 1) throw new Error('unavailable source page');
		return [body('current', timingHead, 0, 1, 700)];
	};
	try {
		await h.manager.ensurePage(0, 10);
		assert.equal(h.manager.getPageState(0)?.status, 'done');
		assert.ok(h.requests.every(r => r.pageIndex === 0));
		assert.ok(h.extracted.filter(p => p === 1).length <= 2, 'missing context does not recursively walk the document');
		assert.ok(requested(h.requests, 'current').every(b => !b.continuationContext?.after));
	}
	finally { h.manager.dispose(); }
});

test('idle partial snapshot drops the old translation when missing source continuation becomes available', async () => {
	const current = body('current', negatedTail, 1, 0, 60);
	const independent = body('independent', 'A new complete independent sentence follows.', 1, 0, 150);
	const h = harness(new Map([
		[0, [body('previous', negatedHead, 0, 1, 700)]],
		[1, ordered([current, independent])]
	]), {
		restoreSnapshot: async p => p !== 1 ? null : {
			pageIndex: 1, status: 'idle', cached: false,
			blocks: ordered([{ ...current, continuationContext: { before: '', after: '' } }, independent]),
			translations: new Map([['current', '旧的无上下文误译残片。']])
		}
	});
	try {
		await h.manager.ensurePage(1, 10);
		assert.ok(requested(h.requests, 'current').length > 0,
			'a resumed translation must not survive its changed source identity');
		assert.ok(requested(h.requests, 'current')[0]?.continuationContext?.before.includes('no failed'));
		assert.notEqual(h.manager.getPageState(1)?.translations.get('current'), '旧的无上下文误译残片。');
	}
	finally { h.manager.dispose(); }
});

test('idle partial snapshot preserves a translation when its verified source continuation is unchanged', async () => {
	const current = body('current', negatedTail, 1, 0, 60);
	const independent = body('independent', 'A new complete independent sentence follows.', 1, 0, 150);
	const h = harness(new Map([
		[0, [body('previous', negatedHead, 0, 1, 700)]],
		[1, ordered([current, independent])]
	]), {
		restoreSnapshot: async p => p !== 1 ? null : {
			pageIndex: 1, status: 'idle', cached: false,
			blocks: ordered([{ ...current, continuationContext: { before: negatedHead, after: '' } }, independent]),
			translations: new Map([['current', '没有采集失败或不耐受。']])
		}
	});
	try {
		await h.manager.ensurePage(1, 10);
		assert.equal(requested(h.requests, 'current').length, 0,
			'an unchanged verified fragment remains a reusable partial translation');
		assert.equal(h.manager.getPageState(1)?.translations.get('current'), '没有采集失败或不耐受。');
		assert.ok(requested(h.requests, 'independent').length > 0);
	}
	finally { h.manager.dispose(); }
});

test('normal retry recovers newly available neighbour source and cannot reuse the fallback identity', async () => {
	let available = false;
	const segments = new Map<string, string>();
	const h = harness(new Map([
		[0, [body('previous', negatedHead, 0, 1, 700)]],
		[1, [body('current', negatedTail, 1, 0, 60)]]
	]), {
		extractPage: async p => {
			if (p === 0 && !available) throw new Error('source page is not ready');
			return p === 0 ? [body('previous', negatedHead, 0, 1, 700)] : [body('current', negatedTail, 1, 0, 60)];
		},
		readSegments: async (_p, hashes) => new Map(hashes.flatMap(hash => {
			const value = segments.get(hash);
			return value === undefined ? [] : [[hash, value] as [string, string]];
		})),
		writeSegments: async (_p, entries) => { for (const entry of entries) segments.set(entry.hash, entry.translatedText); }
	});
	try {
		await h.manager.ensurePage(1, 10);
		const oldBlock = h.manager.getPageState(1)!.blocks[0]!;
		const fallbackIdentity = segmentHash(oldBlock.sourceText, 'en', 'zh-CN', oldBlock.continuationContext);
		assert.ok(segments.has(fallbackIdentity));
		available = true;
		h.requests.length = 0;
		await h.manager.retranslatePage(1, 'normal');
		const recovered = h.manager.getPageState(1)!.blocks[0]!;
		assert.ok(recovered.continuationContext?.before.includes('no failed'));
		assert.notEqual(segmentHash(recovered.sourceText, 'en', 'zh-CN', recovered.continuationContext), fallbackIdentity);
		assert.ok(requested(h.requests, 'current').length > 0);
	}
	finally { h.manager.dispose(); }
});

test('cancelling while adjacent source extraction is pending prevents a later translation request', async () => {
	let signalStarted!: () => void;
	const neighbourStarted = new Promise<void>(resolve => { signalStarted = resolve; });
	let finishNeighbour!: (blocks: SourceBlock[]) => void;
	const neighbour = new Promise<SourceBlock[]>(resolve => { finishNeighbour = resolve; });
	const h = harness(new Map([
		[0, [body('current', timingHead, 0, 1, 700)]],
		[1, [body('following', timingTail, 1, 0, 500)]]
	]), {
		extractPage: async p => {
			if (p === 1) { signalStarted(); return neighbour; }
			return [body('current', timingHead, 0, 1, 700)];
		}
	});
	try {
		const work = h.manager.ensurePage(0, 10);
		await neighbourStarted;
		h.manager.cancelPage(0);
		finishNeighbour([body('following', timingTail, 1, 0, 500)]);
		await work;
		assert.equal(h.requests.length, 0, 'the pending context phase must respect explicit page cancellation');
	}
	finally { h.manager.dispose(); }
});

test('navigation beyond the wanted window while source context is pending releases stale work', async () => {
	let signalStarted!: () => void;
	const neighbourStarted = new Promise<void>(resolve => { signalStarted = resolve; });
	let finishNeighbour!: (blocks: SourceBlock[]) => void;
	const neighbour = new Promise<SourceBlock[]>(resolve => { finishNeighbour = resolve; });
	let signalFarTranslated!: () => void;
	const farTranslated = new Promise<void>(resolve => { signalFarTranslated = resolve; });
	const h = harness(new Map([
		[0, [body('current', timingHead, 0, 1, 700)]],
		[1, [body('following', timingTail, 1, 0, 500)]],
		[3, [body('far', 'An independent complete sentence occupies the selected page.', 3)]]
	]), {
		extractPage: async p => {
			if (p === 1) { signalStarted(); return neighbour; }
			if (p === 3) return [body('far', 'An independent complete sentence occupies the selected page.', 3)];
			return [body('current', timingHead, 0, 1, 700)];
		}
	});
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		if (req.pageIndex === 3) signalFarTranslated();
		return { translations: req.blocks.map(b => ({ id: b.id, translatedText: translation(b.text) })) };
	};
	try {
		const work = h.manager.ensurePage(0, 10);
		await neighbourStarted;
		h.manager.setCurrentPage(3);
		await farTranslated;
		finishNeighbour([body('following', timingTail, 1, 0, 500)]);
		await work;
		assert.ok(h.requests.every(r => r.pageIndex === 3), 'late source context cannot restart an unwanted page');
		assert.notEqual(h.manager.getPageState(0)?.status, 'done');
	}
	finally { h.manager.dispose(); }
});

test('cancelling all pending work also covers pre-scheduler neighbouring source reads', async () => {
	let signalStarted!: () => void;
	const neighbourStarted = new Promise<void>(resolve => { signalStarted = resolve; });
	let finishNeighbour!: (blocks: SourceBlock[]) => void;
	const neighbour = new Promise<SourceBlock[]>(resolve => { finishNeighbour = resolve; });
	const h = harness(new Map([
		[0, [body('current', timingHead, 0, 1, 700)]],
		[1, [body('following', timingTail, 1, 0, 500)]]
	]), {
		extractPage: async p => {
			if (p === 1) { signalStarted(); return neighbour; }
			return [body('current', timingHead, 0, 1, 700)];
		}
	});
	try {
		const work = h.manager.ensurePage(0, 10);
		await neighbourStarted;
		h.manager.cancelAll();
		finishNeighbour([body('following', timingTail, 1, 0, 500)]);
		await work;
		assert.equal(h.requests.length, 0);
		assert.notEqual(h.manager.getPageState(0)?.status, 'done');
	}
	finally { h.manager.dispose(); }
});

test('reset while neighbouring source is pending cannot revive the discarded page state', async () => {
	let signalStarted!: () => void;
	const neighbourStarted = new Promise<void>(resolve => { signalStarted = resolve; });
	let finishNeighbour!: (blocks: SourceBlock[]) => void;
	const neighbour = new Promise<SourceBlock[]>(resolve => { finishNeighbour = resolve; });
	const h = harness(new Map([
		[0, [body('current', timingHead, 0, 1, 700)]],
		[1, [body('following', timingTail, 1, 0, 500)]]
	]), {
		extractPage: async p => {
			if (p === 1) { signalStarted(); return neighbour; }
			return [body('current', timingHead, 0, 1, 700)];
		}
	});
	try {
		const work = h.manager.ensurePage(0, 10);
		await neighbourStarted;
		h.manager.resetAll();
		finishNeighbour([body('following', timingTail, 1, 0, 500)]);
		await work;
		assert.equal(h.requests.length, 0);
		assert.equal(h.manager.getPageState(0), undefined);
	}
	finally { h.manager.dispose(); }
});

test('source-context bleed in a non-first batch fragment is rejected and retried', async () => {
	const bloated = '这里错误重复了整句前文并吞入不属于当前片段的内容。'.repeat(8);
	const h = harness(new Map([[0, splitColumn(bleedTail)]]));
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		return { translations: req.blocks.map(b => ({ id: b.id,
			translatedText: h.requests.length === 1 && b.id === 'right' ? bloated : translation(b.text) })) };
	};
	try {
		await h.manager.ensurePage(0, 10);
		assert.equal(h.requests[0]?.blocks[1]?.id, 'right', 'the affected fragment is not the first batch block');
		assert.ok(requested(h.requests, 'right').length >= 2, 'the oversized context echo must enter retry');
		assert.notEqual(h.manager.getPageState(0)?.translations.get('right'), bloated);
	}
	finally { h.manager.dispose(); }
});

test('one-block salvage with an existing sibling id still checks the unique requested source for bleed', async () => {
	const bloated = '这里错误重复了整句前文并吞入不属于当前片段的内容。'.repeat(8);
	const independent = body('independent', 'A separate control paragraph finishes here.', 0, 1, 160);
	const h = harness(new Map([[0, ordered([...splitColumn(bleedTail), independent])]]));
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		if (req.plain) return { translations: [{ id: 'right', translatedText: '没有采集失败或不耐受。' }] };
		if (h.requests.length === 1) {
			return { translations: req.blocks.filter(b => b.id !== 'right').map(b => ({ id: b.id, translatedText: translation(b.text) })) };
		}
		if (h.requests.length === 2) return { translations: [] };
		// A known but unrequested id must not select the sibling's unrelated
		// source/context for validation of this single-fragment response.
		return { translations: [{ id: 'independent', translatedText: bloated }] };
	};
	try {
		await h.manager.ensurePage(0, 10);
		assert.ok(h.requests.some(r => r.plain), 'bad single salvage must fall through to plain recovery');
		assert.equal(h.manager.getPageState(0)?.translations.get('right'), '没有采集失败或不耐受。');
	}
	finally { h.manager.dispose(); }
});

test('compression cannot replace an oversized old cached result with another source-context echo', async () => {
	const oldOversized = '这是旧缓存中已经过长的译文内容。'.repeat(24);
	const bloated = '这里错误重复了整句前文并吞入不属于当前片段的内容。'.repeat(8);
	assert.ok(bloated.length < oldOversized.length, 'shorter alone is insufficient evidence for acceptance');
	const written: { hash: string; translatedText: string }[] = [];
	const h = harness(new Map([[0, splitColumn(bleedTail)]]), {
		readCache: async () => [
			{ id: 'left', translatedText: '所有参与者均完成检查，未出现失败的' },
			{ id: 'right', translatedText: oldOversized }
		],
		writeSegments: async (_p, entries) => { written.push(...entries); }
	});
	try {
		await h.manager.ensurePage(0, 10);
		assert.equal(h.manager.getPageState(0)?.translations.get('right'), oldOversized);
		h.deps.translateRequest = async req => {
			h.requests.push(structuredClone(req));
			return { translations: [{ id: 'right', translatedText: bloated }] };
		};
		const compressed = await h.manager.compressBlocks(0, [{ id: 'right', maxChars: 40 }]);
		assert.equal(compressed.size, 0, 'context bleed cannot become accepted solely by being shorter');
		assert.equal(h.manager.getPageState(0)?.translations.get('right'), oldOversized);
		assert.ok(!written.some(entry => entry.translatedText === bloated));
	}
	finally { h.manager.dispose(); }
});

test('shared-unit cache-only responses add no fallback HTTP attempt or missing-usage report', async () => {
	const h = harness(new Map([[0, [body('complete', 'A complete independent source paragraph ends here.')]]]));
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		return { translations: req.blocks.map(b => ({ id: b.id, translatedText: translation(b.text) })), cacheOnly: true,
			usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } };
	};
	try {
		await h.manager.ensurePage(0, 10);
		const usage = (h.manager.exportDiagnostics() as { usage: Record<string, number> }).usage;
		assert.equal(h.requests.length, 1, 'one logical executor call may be entirely served by shared-unit cache');
		assert.equal(usage.httpAttempts, 0);
		assert.equal(usage.usageReports, 0);
		assert.equal(usage.usageMissing, 0);
		assert.equal(usage.inputTokens, 0);
		assert.equal(usage.outputTokens, 0);
		assert.equal(h.manager.getPageState(0)?.diagnostics?.attempts ?? 0, 0);
	}
	finally { h.manager.dispose(); }
});

test('legacy provider stubs without attempt hooks retain one fallback HTTP attempt', async () => {
	const h = harness(new Map([[0, [body('complete', 'A complete independent source paragraph ends here.')]]]));
	try {
		await h.manager.ensurePage(0, 10);
		const usage = (h.manager.exportDiagnostics() as { usage: Record<string, number> }).usage;
		assert.equal(usage.httpAttempts, 1);
		assert.equal(usage.usageMissing, 1);
		assert.equal(usage.usageReports, 0);
	}
	finally { h.manager.dispose(); }
});

test('an actual reported HTTP attempt cannot be hidden by a contradictory cache-only response flag', async () => {
	const h = harness(new Map([[0, [body('complete', 'A complete independent source paragraph ends here.')]]]));
	h.deps.translateRequest = async (req, _signal, hooks) => {
		hooks?.onAttempt?.();
		return { translations: req.blocks.map(b => ({ id: b.id, translatedText: translation(b.text) })), cacheOnly: true };
	};
	try {
		await h.manager.ensurePage(0, 10);
		const usage = (h.manager.exportDiagnostics() as { usage: Record<string, number> }).usage;
		assert.equal(usage.httpAttempts, 1);
		assert.equal(usage.usageMissing, 1);
	}
	finally { h.manager.dispose(); }
});

test('metered source metadata is built from each real parent registry without sharing PM token scope', async () => {
	const leftText = 'The baseline matrix was 1024² and no failed';
	const rightText = 'acquisitions or intolerance). A second matrix was 768².';
	const h = harness(new Map([[0, ordered([
		body('left', leftText, 0, 0, 700), body('right', rightText, 0, 1, 60)
	])]]));
	h.deps.translateRequest = async req => {
		h.requests.push(structuredClone(req));
		return { translations: req.blocks.map(b => ({ id: b.id,
			translatedText: translation(b.text) + ' ' + (b.text.match(/⟦PM\d+⟧/g) ?? []).join(' ') })) };
	};
	try {
		await h.manager.ensurePage(0, 10);
		const left = requested(h.requests, 'left')[0]!, right = requested(h.requests, 'right')[0]!;
		assert.equal(left.sourceText, leftText);
		assert.equal(right.sourceText, rightText);
		assert.ok(left.protectedLiterals?.some(entry => entry.original === '1024²'));
		assert.ok(right.protectedLiterals?.some(entry => entry.original === '768²'));
		assert.ok(!left.protectedLiterals?.some(entry => entry.original === '768²'));
		assert.ok(!right.protectedLiterals?.some(entry => entry.original === '1024²'));
		const leftPower = left.protectedLiterals!.find(entry => entry.original === '1024²')!;
		const rightPower = right.protectedLiterals!.find(entry => entry.original === '768²')!;
		assert.equal(leftPower.token, rightPower.token, 'same local PM name has distinct parent-owned values');
		assert.ok(h.manager.getPageState(0)?.translations.get('left')?.includes('1024²'));
		assert.ok(h.manager.getPageState(0)?.translations.get('right')?.includes('768²'));
	}
	finally { h.manager.dispose(); }
});

test('disabling contextual reading before a block retry removes internal source and placeholder metadata', async () => {
	let useContext = true;
	const h = harness(new Map([[0, splitColumn()]]), { useContext: () => useContext });
	try {
		await h.manager.ensurePage(0, 10);
		assert.ok(requested(h.requests, 'right')[0]?.sourceText);
		assert.ok(requested(h.requests, 'right')[0]?.continuationContext);
		useContext = false;
		h.requests.length = 0;
		assert.equal(await h.manager.retranslateBlock(0, 'right'), true);
		const sent = requested(h.requests, 'right')[0]!;
		assert.equal(sent.continuationContext, undefined);
		assert.equal(sent.sourceText, undefined);
		assert.equal(sent.protectedLiterals, undefined);
		assert.equal(sent.rawText, undefined);
		assert.equal(sent.continuationUnit, undefined);
	}
	finally { h.manager.dispose(); }
});

test('stable policy identity versions continuation segments without invalidating independent prose or leaking into requests', async () => {
	let identity = 'config-identity-A';
	const segments = new Map<string, string>();
	const independent = body('independent', 'An independent complete source paragraph ends here.', 0, 1, 180);
	const h = harness(new Map([[0, ordered([...splitColumn(), independent])]]), {
		continuityIdentity: () => identity,
		readSegments: async (_p, hashes) => new Map(hashes.flatMap(hash => {
			const value = segments.get(hash);
			return value === undefined ? [] : [[hash, value] as [string, string]];
		})),
		writeSegments: async (_p, entries) => { for (const entry of entries) segments.set(entry.hash, entry.translatedText); }
	});
	try {
		await h.manager.ensurePage(0, 10);
		const firstBlocks = structuredClone(h.manager.getPageState(0)!.blocks);
		const firstLeft = firstBlocks.find(b => b.id === 'left')!, firstIndependent = firstBlocks.find(b => b.id === 'independent')!;
		assert.equal(firstLeft.continuationContext?.identity, identity);
		assert.equal(firstIndependent.continuationContext, undefined);
		assert.ok(h.requests.every(r => !JSON.stringify(r).includes('config-identity-A')), 'cache policy is internal provenance');
		identity = 'config-identity-B';
		h.requests.length = 0;
		await h.manager.retranslatePage(0, 'normal');
		const secondBlocks = h.manager.getPageState(0)!.blocks;
		const secondLeft = secondBlocks.find(b => b.id === 'left')!, secondIndependent = secondBlocks.find(b => b.id === 'independent')!;
		assert.equal(secondLeft.sourceText, firstLeft.sourceText);
		assert.equal(secondLeft.continuationContext?.identity, identity);
		assert.notEqual(segmentHash(firstLeft.sourceText, 'en', 'zh-CN', firstLeft.continuationContext),
			segmentHash(secondLeft.sourceText, 'en', 'zh-CN', secondLeft.continuationContext));
		assert.equal(segmentHash(firstIndependent.sourceText, 'en', 'zh-CN', firstIndependent.continuationContext),
			segmentHash(secondIndependent.sourceText, 'en', 'zh-CN', secondIndependent.continuationContext));
		assert.ok(requested(h.requests, 'left').length > 0);
		assert.equal(requested(h.requests, 'independent').length, 0, 'independent text still reuses its existing cache');
		assert.ok(h.requests.every(r => !JSON.stringify(r).includes('config-identity-B')));
	}
	finally { h.manager.dispose(); }
});

test('provider progress hooks keep the logical request active without adding HTTP attempts or usage', async () => {
	const h = harness(new Map([[0, [body('complete', 'A complete independent source paragraph ends here.')]]]));
	let progressCalls = 0;
	h.deps.translateRequest = async (req, _signal, hooks) => {
		assert.equal(typeof hooks?.onProgress, 'function');
		for (let i = 0; i < 4; i++) { hooks!.onProgress!(); progressCalls++; }
		return { translations: req.blocks.map(b => ({ id: b.id, translatedText: translation(b.text) })), cacheOnly: true };
	};
	try {
		await h.manager.ensurePage(0, 10);
		assert.equal(progressCalls, 4);
		const usage = (h.manager.exportDiagnostics() as { usage: Record<string, number> }).usage;
		assert.equal(usage.httpAttempts, 0);
		assert.equal(usage.usageMissing, 0);
		assert.equal(usage.usageReports, 0);
		assert.equal(usage.inputTokens, 0);
		assert.equal(usage.outputTokens, 0);
		assert.equal(h.manager.getPageState(0)?.status, 'done');
	}
	finally { h.manager.dispose(); }
});
