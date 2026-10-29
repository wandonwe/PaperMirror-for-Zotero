import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TranslationRequest, TranslationResponse } from '../../src/types/models';
import { planContinuationRequest } from '../../src/translation/continuationRequest';
import { validateResponse } from '../../src/translation/responseValidator';

function sourceRequest(): TranslationRequest {
	return {
		sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 'Complete source sentences', previousContext: '',
		blocks: [
			{ id: 'first-parent', type: 'paragraph', text: 'the first component. A separate complete statement.',
				continuationContext: { before: 'The result included', after: '' } },
			{ id: 'ordinary-parent', type: 'paragraph', text: 'A complete independent paragraph.' },
			{ id: 'last-parent', type: 'paragraph', text: 'The final observation was not',
				continuationContext: { before: '', after: 'detected in the cohort.' } }
		]
	};
}

type Plan = ReturnType<typeof planContinuationRequest>;
type Row = { id: string; translatedText: unknown };
const usage = { inputTokens: 120, outputTokens: 60, cachedInputTokens: 20 };

function validRows(plan: Plan): Row[] {
	return plan.request.blocks.map((b, i) => ({ id: b.id, translatedText: `译文片段${i}` }));
}

// This is the real provider response ordering: raw model JSON is validated
// before the joint planner receives TranslationResponse. In particular, the
// validator must not erase duplicate evidence by choosing its first row.
function restoreRaw(plan: Plan, rows: Row[]): TranslationResponse {
	const parsed = validateResponse(JSON.stringify({ translations: rows }), plan.request.blocks.map(b => b.id), {
		rejectDuplicateIds: plan.request.blocks.some(b => b.continuationUnit)
	});
	return plan.restore({ translations: parsed.translations, usage });
}

test('raw validated joint responses restore only original ids and retain token accounting', () => {
	const original = sourceRequest(), snapshot = JSON.stringify(original), plan = planContinuationRequest(original);
	const restored = restoreRaw(plan, validRows(plan));
	assert.deepEqual(restored.translations.map(t => t.id), ['first-parent', 'ordinary-parent', 'last-parent']);
	assert.ok(restored.translations.every(t => !t.id.startsWith('__pm_cont_')));
	assert.equal(restored.usage, usage);
	assert.equal(JSON.stringify(original), snapshot);
});

test('raw duplicate borrowed or target parts invalidate the affected parent after provider validation', () => {
	const plan = planContinuationRequest(sourceRequest());
	const firstParts = plan.request.blocks.slice(0, 3);
	assert.equal(firstParts.length, 3, 'borrowed predecessor, target head and target middle are present');
	for (const affected of firstParts) {
		for (const duplicate of [affected.text, '另一份矛盾译文', null]) {
			const restored = restoreRaw(plan, [...validRows(plan), { id: affected.id, translatedText: duplicate }]);
			assert.deepEqual(restored.translations.map(t => t.id), ['ordinary-parent', 'last-parent'], affected.id);
			assert.equal(restored.usage, usage);
		}
	}
});

test('raw unknown ids cannot substitute for a missing borrowed or target sentence part', () => {
	const plan = planContinuationRequest(sourceRequest());
	for (const missing of plan.request.blocks.slice(0, 3)) {
		const rows = validRows(plan).filter(row => row.id !== missing.id);
		rows.push({ id: 'provider-invented-id', translatedText: '身份不匹配的译文' });
		const restored = restoreRaw(plan, rows);
		assert.deepEqual(restored.translations.map(t => t.id), ['ordinary-parent', 'last-parent']);
		assert.ok(restored.translations.every(t => !t.translatedText.includes('身份不匹配')));
	}
});

test('raw empty and malformed required parts cannot yield a supposedly complete parent', () => {
	const plan = planContinuationRequest(sourceRequest());
	for (const missing of plan.request.blocks.slice(0, 3)) {
		for (const empty of ['', '  ', null, 0]) {
			const rows = validRows(plan).map(row => row.id === missing.id ? { ...row, translatedText: empty } : row);
			assert.deepEqual(restoreRaw(plan, rows).translations.map(t => t.id), ['ordinary-parent', 'last-parent']);
		}
	}
});

test('internal JSON used by plain joint recovery also rejects duplicate part evidence', () => {
	const original = { ...sourceRequest(), plain: true, blocks: [sourceRequest().blocks[0]!] };
	const plan = planContinuationRequest(original);
	assert.equal(plan.request.plain, false);
	const rows = validRows(plan);
	assert.deepEqual(restoreRaw(plan, rows).translations.map(t => t.id), ['first-parent']);
	rows.push({ id: rows[0]!.id, translatedText: '重复借入部分' });
	assert.deepEqual(restoreRaw(plan, rows).translations, []);
});

test('extra unknown rows do not leak through restoration or invalidate a complete unrelated parent', () => {
	const plan = planContinuationRequest(sourceRequest());
	const rows = validRows(plan);
	rows.reverse();
	rows.push({ id: 'unknown', translatedText: '不属于原文的内容' }, { id: 'unknown', translatedText: '不属于原文的另一份内容' });
	const restored = restoreRaw(plan, rows);
	assert.deepEqual(restored.translations.map(t => t.id), ['first-parent', 'ordinary-parent', 'last-parent']);
	assert.ok(restored.translations.every(t => !t.translatedText.includes('不属于原文')));
});
