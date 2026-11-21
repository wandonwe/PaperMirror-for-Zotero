import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyStampFor, PROMPT_POLICIES } from '../../src/translation/promptPolicies';
import { blockSegmentHash, segmentHash, pageCacheRows, TranslationManager, type TranslationDeps } from '../../src/translation/translationManager';
import type { SourceBlock, TranslatedBlock, TranslationRequest, TranslationResponse } from '../../src/types/models';

const BODY = 'Photon-counting CT reduced image noise by 30% compared with energy-integrating detectors in all phantoms.';
const CONTACT = 'Naying He, hny12267@example.org';
const REF = '12. Smith J, Brown K. A study of imaging protocols. J Radiol. 2019;20:100-110.';
const BYLINE = 'Naying He¹, Youmin Zhang², Zehang Li¹, Zhihan Xu³ and Fuhua Yan¹';

test('5.0 规则版本: each block is stamped with the rules that concern it', () => {
	assert.equal(policyStampFor({ sourceText: BODY }), '', 'body text: no rule beyond v1 concerns it');
	assert.equal(policyStampFor({ sourceText: CONTACT }), `personNames${PROMPT_POLICIES.personNames}`);
	assert.equal(policyStampFor({ sourceText: BYLINE }), `personNames${PROMPT_POLICIES.personNames}`);
	assert.equal(policyStampFor({ sourceText: REF, isReference: true }), `personNames${PROMPT_POLICIES.personNames}|references${PROMPT_POLICIES.references}`);
	// A passing "Smith et al." in body text is deliberately NOT a name block.
	assert.equal(policyStampFor({ sourceText: 'As shown by Smith et al. [12], the dose can be reduced by half.' }), '');
});

test('5.0 规则版本: unaffected blocks keep their old segment key, affected ones get a new one', () => {
	assert.equal(blockSegmentHash({ sourceText: BODY }, 'en', 'zh-CN'), segmentHash(BODY, 'en', 'zh-CN'), 'old cache still hits');
	assert.notEqual(blockSegmentHash({ sourceText: CONTACT }, 'en', 'zh-CN'), segmentHash(CONTACT, 'en', 'zh-CN'), 'pre-4.99.15 translation no longer served');
	assert.notEqual(blockSegmentHash({ sourceText: REF, isReference: true }, 'en', 'zh-CN'), blockSegmentHash({ sourceText: REF }, 'en', 'zh-CN'));
});

test('5.0 规则版本: page-cache rows record their stamp', () => {
	const state = { translations: new Map([['a', '译文 A'], ['b', 'Naying He，hny12267@example.org']]), provisional: new Set<string>() };
	const rows = pageCacheRows(state, [{ id: 'a', sourceText: BODY }, { id: 'b', sourceText: CONTACT }]);
	assert.deepEqual(rows, [
		{ id: 'a', translatedText: '译文 A' },
		{ id: 'b', translatedText: 'Naying He，hny12267@example.org', policy: 'personNames2' }
	]);
});

test('5.0 规则版本: an old page-cache row is re-translated only where a newer rule applies', async () => {
	const blocks: SourceBlock[] = [
		{ id: 'page-0-block-0', pageIndex: 0, order: 0, type: 'paragraph', sourceText: BODY },
		{ id: 'page-0-block-1', pageIndex: 0, order: 1, type: 'paragraph', sourceText: CONTACT }
	];
	// Written before 4.99.15: no stamps, the name was transliterated (and the validator
	// would reject it anyway) — here we check the STAMP path on a row the validator accepts.
	const oldRows: TranslatedBlock[] = [
		{ id: 'page-0-block-0', translatedText: '与能量积分探测器相比，光子计数CT在所有体模中将图像噪声降低了30%。' },
		{ id: 'page-0-block-1', translatedText: 'Naying He, hny12267@example.org' }
	];
	const requested: string[][] = [];
	const deps: TranslationDeps = {
		extractPage: async () => blocks,
		translateRequest: async (r: TranslationRequest): Promise<TranslationResponse> => {
			requested.push(r.blocks.map(b => b.id));
			return { translations: r.blocks.map(b => ({ id: b.id, translatedText: b.text })) };
		},
		readCache: async () => oldRows,
		writeCache: async () => {},
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 't',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => 1
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 1);
	assert.deepEqual(requested.flat(), ['page-0-block-1'], 'only the contact record (a name block) is requested again');
	manager.dispose();
});
