import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TranslationRequest, TranslationResponse } from '../../src/types/models';
import { planContinuationRequest } from '../../src/translation/continuationRequest';

type Block = TranslationRequest['blocks'][number];
const block = (id: string, text: string, before = '', after = '', extra: Partial<Block> = {}): Block => ({
	id, text, type: 'paragraph', ...((before || after) ? { continuationContext: { before, after } } : {}), ...extra
});
const request = (...blocks: Block[]): TranslationRequest => ({
	sourceLanguage: 'en', targetLanguage: 'zh-CN', documentTitle: 'Independent study', previousContext: '', blocks
});
const response = (req: TranslationRequest): TranslationResponse => ({
	translations: req.blocks.map(b => ({ id: b.id, translatedText: `译文(${b.text})` })),
	usage: { inputTokens: 120, outputTokens: 60, cachedInputTokens: 20 }
});

test('ordinary requests and empty contexts retain their exact request/response identities', () => {
	for (const original of [request(block('a', 'A complete paragraph.')),
		request(block('a', 'A complete paragraph.', '', '', { continuationContext: { before: '', after: '' } }))]) {
		const plan = planContinuationRequest(original), received = response(original);
		assert.equal(plan.request, original);
		assert.equal(plan.restore(received), received);
	}
});

test('a prefix and borrowed predecessor become two actually translated parts of a complete sentence', () => {
	const original = request(block('parent', 'and/or another agent was administered. The next scan began.',
		'Measurements were recorded before rate-control treatment', '', { charBudget: 30 }));
	const snapshot = JSON.stringify(original), plan = planContinuationRequest(original);
	assert.equal(JSON.stringify(original), snapshot);
	const parts = plan.request.blocks;
	assert.equal(parts.length, 3);
	assert.equal(parts[0]!.text, 'Measurements were recorded before rate-control treatment');
	assert.equal(parts[1]!.text, 'and/or another agent was administered.');
	assert.equal(parts[0]!.continuationUnit?.id, parts[1]!.continuationUnit?.id);
	assert.equal(parts[0]!.continuationUnit?.source, `${parts[0]!.text} ${parts[1]!.text}`);
	assert.deepEqual(parts.slice(0, 2).map(b => b.continuationUnit?.partIndex), [0, 1]);
	assert.ok(parts.every(b => !b.continuationContext));
	assert.equal(parts[0]!.charBudget, undefined);
	assert.equal(parts[1]!.charBudget, undefined);
	assert.equal(parts[2]!.charBudget, undefined, 'a tiny proportional budget must not compress a middle fragment to a few characters');
	assert.equal(parts[2]!.continuationUnit, undefined);
	const restored = plan.restore(response(plan.request));
	assert.deepEqual(restored.translations, [{ id: 'parent', translatedText: `译文(${parts[1]!.text}) 译文(${parts[2]!.text})` }]);
	assert.ok(!restored.translations[0]!.translatedText.includes('rate-control treatment'));
});

test('a negated tail and borrowed successor are jointly translated without moving source ownership', () => {
	const original = request(block('parent', 'The first observation was complete. There were no failed', '', 'acquisitions or intolerance).'));
	const plan = planContinuationRequest(original), parts = plan.request.blocks;
	assert.equal(parts.length, 3);
	assert.equal(parts[0]!.text, 'The first observation was complete.');
	assert.equal(parts[1]!.text, 'There were no failed');
	assert.equal(parts[2]!.text, 'acquisitions or intolerance).');
	assert.equal(parts[1]!.continuationUnit?.source, 'There were no failed acquisitions or intolerance).');
	assert.equal(parts[1]!.continuationUnit?.parts, 2);
	assert.equal(plan.restore(response(plan.request)).translations[0]!.id, original.blocks[0]!.id);
});

test('head and tail have independent sentence units while the middle is translated once', () => {
	const original = request(block('parent', 'the first component. An independent middle sentence. The final component was not',
		'The result included', 'detected in the second acquisition.', { charBudget: 80 }));
	const plan = planContinuationRequest(original), parts = plan.request.blocks;
	assert.equal(parts.length, 5);
	assert.deepEqual(parts.map(b => b.text), ['The result included', 'the first component.', 'An independent middle sentence.', 'The final component was not', 'detected in the second acquisition.']);
	assert.notEqual(parts[0]!.continuationUnit?.id, parts[3]!.continuationUnit?.id);
	assert.equal(parts[2]!.continuationUnit, undefined);
	assert.ok(parts[2]!.charBudget! >= 24 && parts[2]!.charBudget! < 80);
	assert.equal(parts.filter(b => b.text === 'An independent middle sentence.').length, 1);
	assert.equal(plan.restore(response(plan.request)).translations[0]!.translatedText,
		'译文(the first component.) 译文(An independent middle sentence.) 译文(The final component was not)');
});

test('incomplete one-sided sentence evidence is not labelled as a complete joint unit', () => {
	for (const source of [
		block('a', 'the incomplete continuation', 'The preceding analysis reported'),
		block('a', 'the incomplete continuation', '', 'was later completed.'),
		block('a', '20 participants in', '', 'the first cohort were examined.'),
		block('a', '(95% CI: 0.23 to', '', '0.45) was observed.'),
		block('a', '⟦PM0⟧ participants in', '', 'the first cohort were examined.')
	]) {
		const original = request(source);
		assert.equal(planContinuationRequest(original).request, original, source.text);
	}
	const knownStart = request(block('a', 'No independent effect was', '', 'observed in the cohort.'));
	assert.notEqual(planContinuationRequest(knownStart).request, knownStart);
});

test('a short fragment with both sides is one three-part sentence, never a duplicated target', () => {
	const original = request(block('fragment', 'integrated discrimination', 'Continuous net reclassification improvement and', 'improvement were 0.289 and 0.029, respectively.'));
	const plan = planContinuationRequest(original), parts = plan.request.blocks;
	assert.equal(parts.length, 3);
	assert.equal(parts.filter(b => b.text === 'integrated discrimination').length, 1);
	assert.deepEqual(parts.map(b => b.continuationUnit?.partIndex), [0, 1, 2]);
	assert.ok(parts.every(b => b.continuationUnit?.parts === 3));
	assert.deepEqual(plan.restore(response(plan.request)).translations, [{ id: 'fragment', translatedText: '译文(integrated discrimination)' }]);
});

test('plain fallback becomes internal JSON only when joint parts are planned', () => {
	const original = { ...request(block('p', 'the acquisition was complete.', 'The review confirmed that')), plain: true };
	const plan = planContinuationRequest(original);
	assert.equal(plan.request.plain, false);
	assert.equal(plan.restore(response(plan.request)).translations[0]!.id, 'p');
	const plain = { ...request(block('normal', 'An independent complete paragraph.')), plain: true };
	assert.equal(planContinuationRequest(plain).request, plain);
});

test('joint planning is idempotent and never expands a payload already carrying continuation units', () => {
	const first = planContinuationRequest(request(block('p', 'the acquisition was complete.', 'The review confirmed that')));
	const second = planContinuationRequest(first.request);
	assert.equal(second.request, first.request);
	const received = response(first.request);
	assert.equal(second.restore(received), received);
});

test('protected PM citations immediately after a full stop remain atomic sentence suffixes', () => {
	const original = request(block('p', 'another agent was administered,⟦PM10⟧ and quality was verified.⟦PM0⟧ The next exam began.',
		'The measurements preceded treatment and', '', { protectedLiterals: [
			{ token: '⟦PM10⟧', original: '¹¹' }, { token: '⟦PM0⟧', original: '¹²' }
		] }));
	const parts = planContinuationRequest(original).request.blocks;
	assert.equal(parts[1]!.text, 'another agent was administered,⟦PM10⟧ and quality was verified.⟦PM0⟧');
	assert.equal(parts[2]!.text, 'The next exam began.');
	assert.equal(parts.map(b => b.text).join('').match(/⟦PM10⟧/g)?.length, 1);
	assert.equal(parts.map(b => b.text).join('').match(/⟦PM0⟧/g)?.length, 1);
});

test('style tags closing immediately after a sentence stay balanced in their own target part', () => {
	const original = request(block('p', '⟦b⟧the first result.⟦/b⟧ A second independent sentence.', 'The study confirmed'));
	const parts = planContinuationRequest(original).request.blocks;
	assert.equal(parts[1]!.text, '⟦b⟧the first result.⟦/b⟧');
	assert.equal(parts[2]!.text, 'A second independent sentence.');
});

test('unsafe style-spanning sentence cuts or malformed protected tokens fall back unchanged', () => {
	for (const text of ['⟦b⟧the first result. Another result⟦/b⟧ was recorded.', 'the first result ⟦PM0.',
		'the first result.⟦/b⟧', '⟦b⟧the first result.⟦i⟧text⟦/i⟧⟦/b⟧', 'the first result ⟦unknown⟧.']) {
		const original = request(block('p', text, 'The study confirmed'));
		assert.equal(planContinuationRequest(original).request, original, text);
	}
});

test('academic abbreviations, decimal values and personal initials do not select a false tail sentence', () => {
	for (const tail of ['The result was not replicated by Smith et al. in', 'The result was not replicated by Dr. Green in',
		'The result was not included in Fig. S2 of', 'The result was not replicated by A. J. Smith in', 'The coefficient was not above 0.039 in']) {
		const original = request(block('p', `An earlier observation was complete. ${tail}`, '', 'the independent cohort.'));
		const parts = planContinuationRequest(original).request.blocks;
		assert.equal(parts[1]!.text, tail, tail);
	}
});

test('restoration requires every target and borrowed part exactly once, and preserves usage', () => {
	const plan = planContinuationRequest(request(block('parent', 'the first component. The last component was not',
		'The result included', 'detected.'))), valid = response(plan.request);
	assert.equal(plan.restore(valid).usage, valid.usage);
	for (const id of plan.request.blocks.map(b => b.id)) {
		const missing = { ...valid, translations: valid.translations.filter(t => t.id !== id) };
		assert.equal(plan.restore(missing).translations.length, 0, `missing ${id}`);
		const duplicate = { ...valid, translations: [...valid.translations, valid.translations.find(t => t.id === id)!] };
		assert.equal(plan.restore(duplicate).translations.length, 0, `duplicate ${id}`);
		const empty = { ...valid, translations: valid.translations.map(t => t.id === id ? { ...t, translatedText: '  ' } : t) };
		assert.equal(plan.restore(empty).translations.length, 0, `empty ${id}`);
	}
});

test('out-of-order provider responses are restored in parent source order and unrelated IDs are discarded', () => {
	const original = request(block('first', 'the first component.', 'The result included'), block('normal', 'An ordinary block.'),
		block('last', 'The final result was not', '', 'detected.'));
	const plan = planContinuationRequest(original), valid = response(plan.request);
	valid.translations.reverse();
	valid.translations.push({ id: 'hallucinated-id', translatedText: 'unrelated content' });
	const restored = plan.restore(valid);
	assert.deepEqual(restored.translations.map(t => t.id), ['first', 'normal', 'last']);
	assert.ok(restored.translations.every(t => !t.translatedText.includes('unrelated content')));
});

test('synthetic IDs cannot collide with supplied parent IDs', () => {
	const original = request(block('__pm_cont_0', 'A normal block.'), block('__pm_cont_1', 'the result.', 'The trial confirmed'));
	const plan = planContinuationRequest(original), ids = plan.request.blocks.map(b => b.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(!ids.slice(1).includes('__pm_cont_0'));
	assert.ok(!ids.slice(1).includes('__pm_cont_1'));
	assert.deepEqual(plan.restore(response(plan.request)).translations.map(t => t.id), ['__pm_cont_0', '__pm_cont_1']);
});

test('current-parent PM tokens are not recovered from borrowed translations or another parent scope', () => {
	const original = request(block('a', 'the value was ⟦PM0⟧.', 'The first analysis confirmed', '',
		{ protectedLiterals: [{ token: '⟦PM0⟧', original: '0.039' }] }),
		block('b', 'the different value was ⟦PM0⟧.', 'The second analysis confirmed', '',
			{ protectedLiterals: [{ token: '⟦PM0⟧', original: '0.192' }] }));
	const plan = planContinuationRequest(original);
	const received = { translations: plan.request.blocks.map(b => ({ id: b.id,
		translatedText: b.text.includes('⟦PM0⟧') ? '当前父块数值⟦PM0⟧。' : '借入译文必须被丢弃。' })) };
	const restored = plan.restore(received);
	assert.deepEqual(restored.translations.map(t => t.translatedText), ['当前父块数值⟦PM0⟧。', '当前父块数值⟦PM0⟧。']);
});

test('two pages with different local PM numbering expose exactly the same raw sentence unit', () => {
	const source = 'Measurements precede treatment at 0.7 mL/kg and/or another agent is administered.¹¹';
	const earlier = request(block('earlier-parent', 'An independent earlier result. Measurements precede treatment at ⟦PM8⟧', '',
		'and/or another agent is administered.¹¹', { sourceText: 'An independent earlier result. Measurements precede treatment at 0.7 mL/kg',
			protectedLiterals: [{ token: '⟦PM8⟧', original: '0.7 mL/kg' }, { token: '⟦PM1⟧', original: 'unrelated unused literal' }] }));
	const later = request(block('later-parent', 'and/or another agent is administered.⟦PM0⟧ A following complete result.',
		'Measurements precede treatment at 0.7 mL/kg', '', {
			sourceText: 'and/or another agent is administered.¹¹ A following complete result.',
			protectedLiterals: [{ token: '⟦PM0⟧', original: '¹¹' }]
		}));
	const a = planContinuationRequest(earlier).request.blocks.filter(b => b.continuationUnit);
	const b = planContinuationRequest(later).request.blocks.filter(part => part.continuationUnit);
	assert.equal(a.length, 2);
	assert.equal(b.length, 2);
	assert.deepEqual(a.map(part => part.rawText), b.map(part => part.rawText));
	assert.ok([...a, ...b].every(part => part.continuationUnit?.source === source));
	assert.equal(a[0]!.text, 'Measurements precede treatment at ⟦PM8⟧');
	assert.equal(a[1]!.text, 'and/or another agent is administered.¹¹');
	assert.equal(b[0]!.text, 'Measurements precede treatment at 0.7 mL/kg');
	assert.equal(b[1]!.text, 'and/or another agent is administered.⟦PM0⟧');
	assert.deepEqual(a[0]!.protectedLiterals, [{ token: '⟦PM8⟧', original: '0.7 mL/kg' }]);
	assert.deepEqual(a[1]!.protectedLiterals, [], 'borrowed side has no tokens from the current parent');
	assert.deepEqual(b[0]!.protectedLiterals, []);
	assert.deepEqual(b[1]!.protectedLiterals, [{ token: '⟦PM0⟧', original: '¹¹' }]);
});

test('raw current parts use only their own parent placeholder scope and preserve styles', () => {
	const original = request(
		block('a', 'the ⟦b⟧value⟦/b⟧ was ⟦PM0⟧. A middle measure was ⟦PM1⟧.', 'The first analysis confirmed', '', {
			protectedLiterals: [{ token: '⟦PM0⟧', original: '0.039' }, { token: '⟦PM1⟧', original: '1024²' }]
		}),
		block('b', 'the ⟦i⟧different value⟦/i⟧ was ⟦PM0⟧.', 'The second analysis confirmed', '', {
			protectedLiterals: [{ token: '⟦PM0⟧', original: '0.192' }]
		})
	);
	const snapshot = JSON.stringify(original), parts = planContinuationRequest(original).request.blocks;
	assert.equal(JSON.stringify(original), snapshot);
	const a = parts.find(part => part.text === 'the ⟦b⟧value⟦/b⟧ was ⟦PM0⟧.')!;
	const middle = parts.find(part => part.text === 'A middle measure was ⟦PM1⟧.')!;
	const b = parts.find(part => part.text === 'the ⟦i⟧different value⟦/i⟧ was ⟦PM0⟧.')!;
	assert.equal(a.rawText, 'the ⟦b⟧value⟦/b⟧ was 0.039.');
	assert.equal(middle.rawText, 'A middle measure was 1024².');
	assert.equal(b.rawText, 'the ⟦i⟧different value⟦/i⟧ was 0.192.');
	assert.deepEqual(a.protectedLiterals, [{ token: '⟦PM0⟧', original: '0.039' }]);
	assert.deepEqual(middle.protectedLiterals, [{ token: '⟦PM1⟧', original: '1024²' }]);
	assert.deepEqual(b.protectedLiterals, [{ token: '⟦PM0⟧', original: '0.192' }]);
	assert.ok(parts.every(part => part.sourceText === undefined), 'whole-parent raw text is not copied into each internal part');
});

test('unresolved or ambiguous PM token provenance never becomes a shared raw sentence', () => {
	for (const literals of [undefined, [], [{ token: '⟦PM1⟧', original: 'wrong scope' }],
		[{ token: '⟦PM0⟧', original: '0.039' }, { token: '⟦PM0⟧', original: '0.192' }]]) {
		const original = request(block('p', 'the value was ⟦PM0⟧.', 'The analysis confirmed', '', { protectedLiterals: literals }));
		assert.equal(planContinuationRequest(original).request, original);
	}
});

test('source paragraph boundaries between target parts survive restoration', () => {
	const original = request(block('p', 'the first observation.\n\nAn independent middle paragraph.\n\nThe final component was not',
		'The result included', 'detected.'));
	const plan = planContinuationRequest(original), restored = plan.restore(response(plan.request));
	assert.equal(restored.translations[0]!.translatedText.split('\n\n').length, 3);
});

test('joint expansion is bounded in flat block count and repeated source-metadata character cost', () => {
	const original = request(...Array.from({ length: 30 }, (_, i) => block(`p${i}`, 'the result was verified.', `The independent analysis ${i} confirmed that`)));
	const plan = planContinuationRequest(original);
	assert.ok(plan.request.blocks.length <= 64);
	assert.ok(plan.restore(response(plan.request)).translations.length === 30);
	const large = request(...Array.from({ length: 20 }, (_, i) => block(`p${i}`, 'the result was verified.', `The analysis ${i} ` + 'confirmed '.repeat(140))));
	const expanded = planContinuationRequest(large).request;
	const cost = (b: Block): number => b.text.length + (b.continuationUnit?.source.length ?? 0)
		+ (b.continuationContext?.before.length ?? 0) + (b.continuationContext?.after.length ?? 0);
	assert.ok(expanded.blocks.reduce((n, b) => n + cost(b), 0) - large.blocks.reduce((n, b) => n + cost(b), 0) <= 16000);
});

test('parents crowded out of a joint batch remain missing until a smaller retry can translate their complete unit', () => {
 const original=request(...Array.from({length:35},(_,i)=>block(`crowded${i}`,'the result was verified.',`The independent analysis ${i} confirmed that`)));
 const plan=planContinuationRequest(original);
 const deferred=plan.request.blocks.filter(b=>b.continuationContext);
 assert.ok(deferred.length>0);
 const restored=plan.restore(response(plan.request));
 for(const parent of deferred){
  assert.ok(!restored.translations.some(t=>t.id===parent.id),'context-only reply cannot earn a joint-unit cache entry');
  const retry=planContinuationRequest(request(parent));
  assert.ok(retry.request.blocks.every(b=>b.continuationUnit));
  assert.deepEqual(retry.restore(response(retry.request)).translations.map(t=>t.id),[parent.id]);
 }
});

test('oversized or contradictory sentence sides and duplicate input IDs are conservative', () => {
	for (const original of [
		request(block('a', 'the result.', 'No ' + 'oversized '.repeat(250))),
		request(block('a', 'A complete result.', '', 'an unrelated next sentence.')),
		request(block('a', 'the fragment', 'The preceding source', 'a '.repeat(1000))),
		request(block('same', 'the fragment.', 'The result included'), block('same', 'another block.')),
		request(...Array.from({ length: 65 }, (_, i) => block(`p${i}`, 'the fragment.', 'The result included')))
	]) assert.equal(planContinuationRequest(original).request, original);
});
