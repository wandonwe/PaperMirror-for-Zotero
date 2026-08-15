import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaceholderRegistry } from '../../src/translation/placeholderRegistry';

test('registry: protect → verify → restore round-trip through one boundary', () => {
	const reg = PlaceholderRegistry.protect('We model $E = mc^2$ with n = 42 here.');
	assert.ok(reg.count >= 2, `masked math and n=42: ${reg.count}`);
	assert.ok(!reg.text.includes('mc^2'));
	const translated = reg.text.replace('We model', '我们建模').replace('here', '于此');
	assert.equal(reg.ok(translated), true);
	const restored = reg.restore(translated);
	assert.ok(restored.includes('$E = mc^2$') && restored.includes('n = 42'), restored);
});

test('registry: extra literals masked; empty registry is always ok', () => {
	const reg = PlaceholderRegistry.protect('Keep BERT verbatim in this sentence.', ['BERT']);
	assert.ok(reg.entries.some(p => p.original === 'BERT'));
	assert.ok(!reg.text.includes('BERT'));
	const empty = PlaceholderRegistry.protect('普通句子,无需保护。');
	assert.equal(empty.count, 0);
	assert.equal(empty.ok('anything at all'), true);
});

test('registry: status tracks accept/reject counts without any text content', () => {
	const reg = PlaceholderRegistry.protect('$a=1$ and $b=2$');
	assert.equal(reg.ok(`译文 ${reg.entries[0]!.token} ${reg.entries[1]!.token}`), true);
	assert.equal(reg.ok('译文丢了所有占位符'), false);
	const s = reg.status;
	assert.equal(s.count, 2);
	assert.equal(s.accepted, 1);
	assert.equal(s.rejected, 1);
	assert.ok(s.last && !s.last.ok && s.last.missing.length === 2);
	// 日志卫生: status 不携带原文/译文内容,只有 token 名。
	assert.ok(!JSON.stringify(s).includes('a=1'));
});

test('registry: hallucinated variants accepted and restored (delegates 1.0.6 normalization)', () => {
	const reg = PlaceholderRegistry.protect('$x=y$');
	assert.equal(reg.ok('译文 【PM0】'), true);
	assert.ok(reg.restore('译文 【PM0】').includes('$x=y$'));
});
