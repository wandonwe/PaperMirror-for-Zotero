import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	calcGoogleTk,
	cleanGoogleAnnotatedText,
	escapeHTML,
	unescapeHTML,
	mapBingLang,
	mapGoogleLang,
	parseBingTranslatorPage,
	splitLongText
} from '../../src/translation/providers/freeEngineUtils';
import { parseGoogleEntries } from '../../src/translation/providers/googleFree';
import { PaperMirrorError } from '../../src/types/models';

test('calcGoogleTk is deterministic and shaped like tk', () => {
	const a = calcGoogleTk('Hello world');
	const b = calcGoogleTk('Hello world');
	const c = calcGoogleTk('Hello world!');
	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.match(a, /^\d+\.\d+$/);
});

test('calcGoogleTk handles CJK and surrogate pairs', () => {
	assert.match(calcGoogleTk('影像组学与总生存期𝒳'), /^\d+\.\d+$/);
});

test('escape/unescape round-trip', () => {
	const s = `a < b & "c" > 'd'`;
	assert.equal(unescapeHTML(escapeHTML(s)), s);
});

test('cleanGoogleAnnotatedText strips pre/b/i annotations and unescapes', () => {
	const raw = '<pre><b>这是译文一。</b><i>This is source one.</i><b>这是译文二 &amp; 更多。</b><i>Second.</i></pre>';
	const cleaned = cleanGoogleAnnotatedText(raw);
	assert.equal(cleaned, '这是译文一。 这是译文二 & 更多。');
});

test('cleanGoogleAnnotatedText passes through unannotated text', () => {
	assert.equal(cleanGoogleAnnotatedText('简单译文'), '简单译文');
	assert.equal(cleanGoogleAnnotatedText('<pre>简单译文</pre>'), '简单译文');
});

test('parseGoogleEntries aligns strings and [text,lang] pairs', () => {
	assert.deepEqual(parseGoogleEntries(['一', '二'], 2), ['一', '二']);
	assert.deepEqual(parseGoogleEntries([['一', 'en'], ['二', 'en']], 2), ['一', '二']);
	assert.deepEqual(parseGoogleEntries('单条', 1), ['单条']);
});

test('parseGoogleEntries rejects count mismatches', () => {
	assert.throws(() => parseGoogleEntries(['只有一条'], 2), PaperMirrorError);
});

test('splitLongText respects limit and prefers sentence boundaries', () => {
	const text = 'First sentence. Second sentence is a bit longer! Third one? 第四句。';
	const parts = splitLongText(text, 30);
	assert.ok(parts.length >= 2);
	for (const part of parts) {
		assert.ok(part.length <= 30);
	}
	assert.equal(parts.join('').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
});

test('splitLongText hard-cuts a single huge sentence', () => {
	const parts = splitLongText('x'.repeat(2500), 900);
	assert.equal(parts.length, 3);
});

test('parseBingTranslatorPage extracts IG/IID/key/token', () => {
	const html = `
		<html><head><script>var x=1; IG:"ABCDEF1234567890"; </script></head>
		<body><div id="tta" data-iid="translator.5024.1"></div>
		<script>var params_RichTranslateHelper = [1721400000000,"qWeRtY123_-tokenvalue",3600000,true];</script>
		</body></html>`;
	const session = parseBingTranslatorPage(html);
	assert.ok(session);
	assert.equal(session!.ig, 'ABCDEF1234567890');
	assert.equal(session!.iid, 'translator.5024.1');
	assert.equal(session!.key, '1721400000000');
	assert.equal(session!.token, 'qWeRtY123_-tokenvalue');
});

test('parseBingTranslatorPage returns null on layout change', () => {
	assert.equal(parseBingTranslatorPage('<html>nothing here</html>'), null);
});

test('bing/google language mapping', () => {
	assert.equal(mapBingLang('auto'), 'auto-detect');
	assert.equal(mapBingLang('zh-CN'), 'zh-Hans');
	assert.equal(mapBingLang('zh-TW'), 'zh-Hant');
	assert.equal(mapBingLang('en'), 'en');
	assert.equal(mapGoogleLang('zh'), 'zh-CN');
	assert.equal(mapGoogleLang('auto'), 'auto');
});
