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
	resolveBingApiBase,
	runPool,
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

test('parses the CURRENT bing page variable (params_AbusePreventionHelper)', () => {
	const html = `<html><div id="tta_input" data-iid="translator.5028"></div>
	<script>var params_AbusePreventionHelper = [1700000000000,"HgQ2rT9-tokenvalue_",3600000];</script>
	<script>_G={IG:"ABCDEF0123456789"};</script></html>`;
	const session = parseBingTranslatorPage(html);
	assert.ok(session, 'new variable name must parse');
	assert.equal(session!.key, '1700000000000');
	assert.equal(session!.token, 'HgQ2rT9-tokenvalue_');
	assert.equal(session!.ig, 'ABCDEF0123456789');
	assert.equal(session!.iid, 'translator.5028');
});

// ---- Bing API host selection (the www/cn token-mismatch regression) ---------

test('the API call follows the session-issuing host', () => {
	// Mainland: page 302s to cn.bing.com; the token is only valid THERE.
	assert.equal(resolveBingApiBase('', 'https://cn.bing.com'), 'https://cn.bing.com');
	assert.equal(resolveBingApiBase(undefined, 'https://www.bing.com'), 'https://www.bing.com');
});

test('the auto-filled default Base URL is not a real override', () => {
	// The settings pane writes the provider default (www.bing.com) into the
	// preference on its own; treating that as an override posted cn-issued
	// tokens to www — the exact bug that kept the engine dead.
	assert.equal(resolveBingApiBase('https://www.bing.com', 'https://cn.bing.com'), 'https://cn.bing.com');
	assert.equal(resolveBingApiBase('https://cn.bing.com/', 'https://www.bing.com'), 'https://www.bing.com');
	assert.equal(resolveBingApiBase('https://www.bing.com/', 'https://cn.bing.com'), 'https://cn.bing.com');
});

test('a genuine non-bing mirror IS an override', () => {
	assert.equal(
		resolveBingApiBase('https://bing-mirror.example.com', 'https://cn.bing.com'),
		'https://bing-mirror.example.com'
	);
	// Trailing slashes are normalised either way.
	assert.equal(
		resolveBingApiBase('https://bing-mirror.example.com/', 'https://cn.bing.com'),
		'https://bing-mirror.example.com'
	);
});

test('garbage in the Base URL falls back to the session origin', () => {
	assert.equal(resolveBingApiBase('not a url', 'https://cn.bing.com'), 'https://cn.bing.com');
});

// ---- the request pool -------------------------------------------------------

test('runPool preserves order while running concurrently', async () => {
	const started: number[] = [];
	const results = await runPool([30, 10, 20], 3, async (delay, i) => {
		started.push(i);
		await new Promise(resolve => setTimeout(resolve, delay));
		return `r${i}`;
	});
	assert.deepEqual(results, ['r0', 'r1', 'r2'], 'results in input order regardless of finish order');
	assert.deepEqual(started.sort(), [0, 1, 2]);
});

test('runPool honours the concurrency cap', async () => {
	let inFlight = 0;
	let peak = 0;
	await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise(resolve => setTimeout(resolve, 10));
		inFlight--;
	});
	assert.equal(peak, 2, 'never more than the cap in flight');
});

test('runPool propagates the first failure', async () => {
	await assert.rejects(
		runPool([1, 2, 3], 2, async (n) => {
			if (n === 2) {
				throw new Error('boom');
			}
			return n;
		}),
		/boom/
	);
});

// ---- P3 (2.0.6): 共享 in-flight promise 与调用方信号解耦 --------------------

test('raceSignal: 一个调用者取消只影响自己,共享结果继续供别人使用', async () => {
	const { raceSignal } = await import('../../src/translation/providers/bingFree');
	let resolveShared!: (v: string) => void;
	const shared = new Promise<string>(r => { resolveShared = r; });
	const ctrlA = new AbortController();
	const waiterA = raceSignal(shared, ctrlA.signal);
	const waiterB = raceSignal(shared, new AbortController().signal);
	ctrlA.abort(); // 标签页 A 取消(关页/翻页)
	await assert.rejects(waiterA, (e: unknown) =>
		e instanceof PaperMirrorError && e.code === 'CANCELLED');
	resolveShared('session-token'); // 共享请求没有被 A 的取消打断
	assert.equal(await waiterB, 'session-token', 'B 必须照常拿到共享结果');
});

test('raceSignal: 预先已取消 → 立即 CANCELLED;无 signal → 原样透传', async () => {
	const { raceSignal } = await import('../../src/translation/providers/bingFree');
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(raceSignal(Promise.resolve('x'), aborted.signal), (e: unknown) =>
		e instanceof PaperMirrorError && e.code === 'CANCELLED');
	assert.equal(await raceSignal(Promise.resolve('y'), undefined), 'y');
});
