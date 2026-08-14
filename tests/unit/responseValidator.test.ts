import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResponse, extractJSON } from '../../src/translation/responseValidator';
import { PaperMirrorError } from '../../src/types/models';

test('extractJSON parses plain JSON', () => {
	const data = extractJSON('{"translations":[]}') as { translations: unknown[] };
	assert.deepEqual(data.translations, []);
});

test('extractJSON strips markdown fences', () => {
	const raw = '```json\n{"translations":[{"id":"a","translatedText":"译"}]}\n```';
	const data = extractJSON(raw) as { translations: { id: string }[] };
	assert.equal(data.translations[0]!.id, 'a');
});

test('extractJSON recovers JSON embedded in prose', () => {
	const raw = 'Sure! {"translations":[{"id":"x","translatedText":"y"}]} done';
	const data = extractJSON(raw) as { translations: { id: string }[] };
	assert.equal(data.translations[0]!.id, 'x');
});

test('validateResponse reports missing ids', () => {
	const raw = '{"translations":[{"id":"p-1","translatedText":"译1"}]}';
	const result = validateResponse(raw, ['p-1', 'p-2']);
	assert.deepEqual(result.missingIds, ['p-2']);
	assert.equal(result.translations.length, 1);
});

test('validateResponse ignores extra and duplicate ids', () => {
	const raw = '{"translations":[{"id":"p-1","translatedText":"a"},{"id":"p-1","translatedText":"dup"},{"id":"zzz","translatedText":"x"}]}';
	const result = validateResponse(raw, ['p-1']);
	assert.equal(result.translations.length, 1);
	assert.equal(result.translations[0]!.translatedText, 'a');
	assert.deepEqual(result.extraIds, ['zzz']);
});

test('validateResponse throws on non-JSON', () => {
	assert.throws(() => validateResponse('not json at all', ['a']), PaperMirrorError);
});

test('validateResponse throws when translations missing', () => {
	assert.throws(() => validateResponse('{"foo":1}', ['a']), (e: unknown) => e instanceof PaperMirrorError && e.code === 'BAD_RESPONSE');
});

// ---------------------------------------------------------------------------
// 0.9.26 批次3: 纯文本兜底解析
// ---------------------------------------------------------------------------

import { parsePlainResponse } from '../../src/translation/responseValidator';

test('parsePlainResponse strips fences, labels and quotes', () => {
	assert.equal(parsePlainResponse('```\n这是译文。\n```', 'b1').translations[0]!.translatedText, '这是译文。');
	assert.equal(parsePlainResponse('译文:这是译文。', 'b1').translations[0]!.translatedText, '这是译文。');
	assert.equal(parsePlainResponse('"这是译文。"', 'b1').translations[0]!.translatedText, '这是译文。');
	assert.equal(parsePlainResponse('这是译文。', 'b1').translations[0]!.id, 'b1');
});

test('parsePlainResponse throws on empty output', () => {
	assert.throws(() => parsePlainResponse('   ', 'b1'));
});
