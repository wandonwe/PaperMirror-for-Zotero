/**
 * 抽取分段计时 · 就绪短路 · 失败种类 (2.8.15, 真机第二轮)。
 *
 * ## 这一版量什么、为什么
 *
 * 真机 30 页的诊断里,**15 页的 `extractMs` 在 0.8–2.6 秒,而这些页一次接口请求
 * 都没发**(`requests: 0, fromCache: true`)—— 用户感到的"翻到后面越来越慢"
 * 落在抽取里,不在网络上。同一条路最快的页只要 **14 ms**,所以那 2.6 秒是
 * **等**,不是算。可 `extractMs` 是一个总数,回答不了"等在哪":
 *
 *   - 等 PDFWorker 的 char 流?本文档 30/30 页最终都落到 `text-layer`,说明
 *     路径 1 **每次都白跑**,但它到底多贵,旧日志一个字都没有;
 *   - 还是等 PDF.js 把文本层渲染稳定?
 *
 * 两者的修法南辕北辙,所以先分段量,再决定改哪边。
 *
 * ## 顺带堵上 2.8.13 的另一半
 *
 * 2.8.13 给 `waitForTextLayer` 加了"连续两次采样 span 数不变才算就绪"的判据,
 * 但调用处有一道 `if (!hasRenderedTextLayer(...))` 短路 —— 而 `hasRenderedTextLayer`
 * 就是"span 数 > 0"。于是这条稳定判据**恰恰在它唯一要防的情形下被跳过**:
 * 文本层已长出第一批 span、还在继续长,短路当场放行,读到半成品。真机第 9 页
 * 当初只抽出 2 个块、抽取耗时 7 ms,正是这条短路放的行。2.8.13 只堵住了
 * "层根本不在"那一半;这一版把另一半也堵上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failureKind } from '../../src/export/jsonlWriter';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

// ---- 1. 就绪判据不再被短路绕过 ------------------------------------------------

test('文本层就绪必须无条件等,不许被 "已经有 span 了" 短路掉 (结构性回归闸, 2.8.15)', () => {
	const src = read('src/reader/textExtractor.ts');
	const start = src.indexOf('private async extractFromTextLayer');
	const body = src.slice(start, src.indexOf('\n\tprivate async loadFullText', start));
	assert.ok(/await adapter\.waitForTextLayer\(this\.reader, pageIndex\);/.test(body),
		'必须调用就绪等待');
	assert.ok(!/if \(!adapter\.hasRenderedTextLayer\([\s\S]{0,80}await adapter\.waitForTextLayer/.test(body),
		'不许用 hasRenderedTextLayer(= span 数>0) 把就绪等待短路掉 —— 那正是"层还在长"的情形,'
		+ '2.8.13 的稳定判据就是为它加的,短路等于把它绕开了');
});

// ---- 2. 分段计时覆盖三条路 ---------------------------------------------------

test('三条抽取路径各自计时,等待与建块分开 (结构性回归闸, 2.8.15)', () => {
	const src = read('src/reader/textExtractor.ts');
	for (const field of ['obstaclesMs', 'charsPathMs', 'textLayerMs', 'textLayerWaitMs', 'plainTextMs', 'buildMs']) {
		assert.ok(new RegExp(`phases\\.${field}\\s*[+]?=`).test(src) || new RegExp(`${field}: 0`).test(src),
			`${field} 必须真的被写入,不能只在类型里声明`);
	}
	// charsPathMs 要在 catch 之后记 —— 走不通的那趟正是"白付的往返",
	// 只在成功分支计时就永远量不到它。
	const charsEnd = src.indexOf('phases.charsPathMs = Date.now() - charsStartedAt;');
	const catchEnd = src.indexOf('logger.warn(MODULE, `getPageData path failed');
	assert.ok(catchEnd > 0 && charsEnd > catchEnd,
		'路径 1 的计时必须落在 try/catch 之后 —— 本文档 30/30 页都走不通路径 1,白跑的那趟才是要量的');
	// 等待与建块是两段: 一段是等 PDF.js,一段是我们自己的 CPU。
	assert.ok(src.indexOf('const buildStartedAt') > src.indexOf('const waitStartedAt'),
		'先等后建 —— 两段必须分开记,混在一起就分不出该优化哪边');
});

test('分段计时只是毫秒数,不带任何文本 (隐私闸, 2.8.15)', () => {
	const src = read('src/translation/translationManager.ts');
	const decl = src.slice(src.indexOf('extractPhases?: {'), src.indexOf('}', src.indexOf('extractPhases?: {')));
	assert.ok(/^[^:]*(\s*\w+\??: number;)+/m.test(decl) && !/string/.test(decl),
		'extractPhases 的每个字段都必须是 number —— 诊断文件不含原文,这条不能被一个字符串字段破掉');
});

// ---- 3. 渲染计数必须对得上账 --------------------------------------------------

test('渲染的每条出路都有计数,started 不再留缺口 (结构性回归闸, 2.8.15)', () => {
	const src = read('src/ui/translationPane.ts');
	// 真机: started=79, committed=47, cancelled=5, failed=0 —— 27 次(34%)没有去向。
	// 缺口既可能是合法路径也可能是泄漏,数字本身分不出来,于是只能猜。
	assert.ok(/renderStats = \{ started: 0, committed: 0, cancelled: 0, failed: 0, superseded: 0, notReady: 0, totalMs: 0 \}/.test(src),
		'两条此前不记数的合法出路(被取代 / 渲染器说还没内容)必须各自有计数器');
	const commit = src.slice(src.indexOf('private commitRender('), src.indexOf('private releaseFarSlots'));
	assert.ok(/this\.renderStats\.superseded\+\+;[\s\S]{0,40}return;/.test(commit),
		'"渲染期间被取代"这条早退路径必须记数,否则它就是 started 与 committed 之间无从解释的缺口');
	assert.ok(/else \{[\s\S]{0,200}this\.renderStats\.notReady\+\+;/.test(commit),
		'"渲染器返回 false(这页还没内容)"也要记数');
});

// ---- 4. 导出读失败的种类: 够用来排查,且不泄露内容 ----------------------------

test('读失败记种类不记消息 (2.8.15)', () => {
	class PMErr extends Error { code = 'EXTRACTION_FAILED'; }
	assert.equal(failureKind(new PMErr('第 12 页 /Users/someone/私密论文.pdf 读失败')), 'EXTRACTION_FAILED',
		'PaperMirrorError 取它的枚举 code');
	assert.equal(failureKind(new TypeError('cannot read property x of undefined')), 'TypeError',
		'内置异常取构造函数名');
	assert.equal(failureKind(null), 'unknown');
	assert.equal(failureKind(undefined), 'unknown');
	assert.equal(failureKind('这是一段原文'), 'String',
		'字符串被抛出时取的是 String 这个类名,不是字符串本身');
	// 形状白名单是隐私保证的执行者: 不像枚举/类名的一律降成 unknown。
	assert.equal(failureKind({ code: 'endpoint https://internal.example/v1 refused' }), 'Object',
		'带空格/斜杠的 code 不是枚举 —— 不许原样带出去');
	assert.equal(failureKind({ code: 'A'.repeat(80) }), 'Object', '超长 code 一样拦下');
});

test('两个写出器都把种类写进失败那一行 (结构性回归闸, 2.8.15)', () => {
	for (const file of ['src/export/diagnosticsJsonl.ts', 'src/export/corpusJsonl.ts']) {
		assert.ok(/readFailureKind: read\.kind/.test(read(file)),
			`${file}: pageReadFailures 只说"失败了一页",连是抛错还是类型错都看不出来 —— 种类必须落进文件`);
	}
});

// ---- 5. 2.9.5: 路径 1 为什么不出活 --------------------------------------------
//
// 真机第七轮:`charsPathMs` 整轮 **80 ms / 85 页**,约 **1 ms 一页**。PDFWorker
// 的 RPC 往返不可能这么快 —— 这不是"慢",是**立刻失败或立刻返回空**。
//
// 这件事要紧,是因为路径 1 是唯一**不依赖页面渲染**的抽取方式。2.9.0–2.9.4 五个
// 版本都在绕"文本层什么时候渲染好"这个时序难题;路径 1 若能用,这个难题从根上
// 就不存在了。而现有日志对它一个字都没有。

test('路径 1 的每一种结局都有枚举计数 (结构性回归闸, 2.9.5)', () => {
	const src = read('src/reader/textExtractor.ts');
	const fn = src.slice(src.indexOf('async extractPage(pageIndex: number)'), src.indexOf('async extractRenderedPage'));
	for (const outcome of ['no-chars-array', 'empty-chars', 'undecoded-cid', 'chars-but-no-blocks', 'ok']) {
		assert.ok(fn.includes(`'${outcome}'`), `结局 ${outcome} 必须被记下来`);
	}
	assert.ok(/this\.noteCharsOutcome\(pageIndex, `threw:\$\{failureKind\(e\)\}`\)/.test(fn),
		'抛错的种类是排查这条路的关键 —— 此前它只进了 logger');
});

test('路径 1 的结局只记枚举,不带原文或路径 (隐私闸, 2.9.5)', () => {
	const src = read('src/reader/textExtractor.ts');
	// failureKind 已经把 message 挡在外面(见 jsonlWriter 的白名单);
	// 这里钉住"用的就是它",而不是某天顺手换成 e.message。
	assert.ok(/failureKind\(e\)/.test(src) && !/noteCharsOutcome\([^)]*e\.message/.test(src),
		'异常 message 可能带路径或接口返回 —— 一个字都不许进诊断');
	const decl = src.slice(src.indexOf('private noteCharsOutcome'), src.indexOf('private charsNoted'));
	assert.ok(/this\.charsNoted\.has\(pageIndex\)/.test(decl),
		'一页只记第一个结论 —— 同一页被反复抽取时(真机上很常见)不该把分布压歪');
});

test('结局分布进了导出 (结构性回归闸, 2.9.5)', () => {
	const src = read('src/reader/readerSession.ts');
	assert.ok(/charsPath: this\.extractor\.charsPathOutcomes\(\)/.test(src),
		'不进导出就等于没量');
});
