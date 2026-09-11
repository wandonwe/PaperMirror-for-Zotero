/**
 * 文本层就绪判定 (2.8.13 真机修正)。
 *
 * 真机 19 页里有 **6 页整页没翻译**,还有几页只抽出零星几块。导出的诊断与语料
 * 把机制钉死了:
 *
 *   - 那 6 页 `extractPath: 'empty'`、0 块、状态 `done` —— 抽取当时认定"这页没有
 *     可译内容";而**同一份语料在导出时重解析出 12–14 个块、约 200 个 span**,
 *     证明文字一直都在,只是抽取当时那几页**还没渲染**,文本层根本不存在;
 *   - 第 9 页只抽出 2 个块,抽取耗时 **7 ms** —— 文本层当时刚开始长 span,
 *     旧的就绪判据"有一个 span 就算渲染好了"当场放行,读到了半成品。
 *
 * 所以这里钉三条:
 *   1. **等文本层稳定**(连续两次采样 span 数不变),不是"有就读";
 *   2. **"层不在" ≠ "没文字"** —— 前者可重试,后者才是定论;
 *   3. 预取页遇到"层不在"要**忘掉这次结果**,等用户翻过去重抽;当前页则如实
 *      报可重试的错,**绝不标完成**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- 1. 等稳定,不是"有就读" -------------------------------------------------

/**
 * 逐拍推进的假文本层: 每次采样返回预先排好的 span 数,模拟 PDF.js 边渲染边长。
 * 真实的 `waitForTextLayer` 会在采样之间 await 100 ms,这里把定时器换成立即
 * resolve,只考察**判据**而不是墙钟。
 */
function settleAfter(counts: number[]): { sample(): number; samples: number } {
	let i = 0;
	const probe = {
		samples: 0,
		sample(): number {
			probe.samples++;
			const value = counts[Math.min(i, counts.length - 1)]!;
			i++;
			return value;
		}
	};
	return probe;
}

/** `waitForTextLayer` 的判据本身(与平台 DOM 解耦的等价实现,逐字对应源码)。 */
async function waitUntilSettled(probe: { sample(): number }, maxSamples = 30): Promise<boolean> {
	let last = -1;
	for (let n = 0; n < maxSamples; n++) {
		const count = probe.sample();
		if (count > 0 && count === last) {
			return true;
		}
		last = count;
	}
	return probe.sample() > 0;
}

test('文本层还在长 span 时不算就绪 —— 等它两次采样不变 (2.8.13 真机修正)', async () => {
	// 3 → 40 → 193 → 193: 前三拍都还在长,第四拍才稳定。
	const probe = settleAfter([3, 40, 193, 193]);
	assert.equal(await waitUntilSettled(probe), true);
	assert.ok(probe.samples >= 4,
		'旧判据"有一个 span 就算好"在第一拍就放行,于是读到 3 个 span 的半成品 —— 真机第 9 页就是这么只剩 2 个块的');
});

test('一上来就是完整的一页,也要确认它不再长 (2.8.13 真机修正)', async () => {
	const probe = settleAfter([193, 193]);
	assert.equal(await waitUntilSettled(probe), true);
	assert.equal(probe.samples, 2, '稳定判据比"有没有"贵一次采样 —— 一页只付这一次');
});

test('一直是 0 就不算就绪 (2.8.13 真机修正)', async () => {
	const probe = settleAfter([0, 0, 0]);
	assert.equal(await waitUntilSettled(probe, 3), false,
		'0 == 0 不能当成"稳定了" —— 那是"这页压根没渲染"');
});

// ---- 2./3. 结构闸: 三处接线 --------------------------------------------------

test('就绪判据真的按"稳定"写,不是按"有没有" (结构性回归闸, 2.8.13)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/zoteroReaderAdapter.ts'), 'utf8');
	const wait = src.slice(src.indexOf('export async function waitForTextLayer'), src.indexOf('export const TEXT_LAYER_SETTLE_MS'));
	assert.ok(/if \(count > 0\) \{[\s\S]{0,200}if \(count === last\) \{/.test(wait),
		'必须是"连续两次采样相同且非零"才算渲染完');
	assert.ok(!/if \(hasRenderedTextLayer\(reader, pageIndex\)\) \{\s*\n\s*return true;/.test(wait),
		'不许退回"有一个 span 就返回"的旧判据');
	// 层在不在 与 层里有没有字,必须是两个函数 —— 它们回答的是两个问题。
	assert.ok(/export function textLayerExists/.test(src) && /export function textLayerSpanCount/.test(src),
		'"文本层存在吗"与"里面有多少字"要分开问');
	const existsStart = src.indexOf('export function textLayerExists');
	const exists = src.slice(existsStart, src.indexOf('\n}', existsStart));
	assert.ok(!/span/.test(exists), 'textLayerExists 只看层在不在,不看有没有 span');
});

// ---- 4. 2.9.1: 别再对着没渲染的页干等 2.5 秒 --------------------------------
//
// 真机第四轮的账: 59 页 `extractMs` 合计 50,987 ms,其中 `textLayerWaitMs`
// **占 40,729 ms(80%)**;而我原先怀疑的 PDFWorker char 流 `charsPathMs`
// **整轮只有 19 ms** —— 那条假设被证伪。最慢的页 p28=2583、p29=2527 直接跑满
// 2500 ms 上限,同一轮 `releaseReasons['text-layer-not-rendered'] = 29`。
//
// 根因: 旧的早退 `count === 0 && !pageViewOf(...)` **永远不触发** —— PDF.js
// 给文档里每一页都建了 PDFPageView,`pageViewOf` 对任何页号都返回非空。

/** 只实现这三个函数需要的最小 reader 形状。 */
function fakeReader(pages: Record<number, { spans: number; renderingState?: number }>): unknown {
	return {
		_internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfViewer: {
			getPageView: (i: number) => {
				const page = pages[i];
				if (!page) {
					return null;
				}
				return {
					renderingState: page.renderingState,
					div: { querySelector: (sel: string) => sel === '.textLayer'
						? { querySelectorAll: () => ({ length: page.spans }) }
						: null }
				};
			}
		} } } } }
	};
}

test('PDF.js 说这页还没排上(INITIAL)就立刻返回,不等 (2.9.1 真机第四轮)', async () => {
	const { waitForTextLayer } = await import('../../src/reader/zoteroReaderAdapter');
	const started = Date.now();
	const ok = await waitForTextLayer(fakeReader({ 7: { spans: 0, renderingState: 0 } }) as never, 7);
	assert.equal(ok, false);
	assert.ok(Date.now() - started < 200,
		'旧代码在这里白等满 2500 ms —— 真机一轮为此烧掉 40.7 秒,还占着抽取信号量挡住当前页');
});

test('PAUSED(排过又被推迟,离视口太远)同样立刻返回 (2.9.1)', async () => {
	const { waitForTextLayer } = await import('../../src/reader/zoteroReaderAdapter');
	const started = Date.now();
	assert.equal(await waitForTextLayer(fakeReader({ 7: { spans: 0, renderingState: 2 } }) as never, 7), false);
	assert.ok(Date.now() - started < 200, 'PAUSED 就是"PDF.js 决定先不渲这页",等它毫无意义');
});

test('拿不到 renderingState 时,冷启动上限兜底 (2.9.1)', async () => {
	const { waitForTextLayer } = await import('../../src/reader/zoteroReaderAdapter');
	// fork 改了 API / 字段缺失 —— 闸 1 失效,闸 2 必须接住。
	const started = Date.now();
	const ok = await waitForTextLayer(fakeReader({ 7: { spans: 0 } }) as never, 7, 2500, 250);
	const spent = Date.now() - started;
	assert.equal(ok, false);
	assert.ok(spent >= 250 && spent < 900,
		`冷启动上限之后就该放手,实际等了 ${spent} ms —— 这条不依赖任何 PDF.js 内部字段`);
});

test('正在渲染(RUNNING)的页照常等,且仍要等它长稳 (2.9.1)', async () => {
	const { waitForTextLayer } = await import('../../src/reader/zoteroReaderAdapter');
	// 第一拍就有 span → 两道冷启动闸都不适用,走 2.8.13 的稳定判据。
	const ok = await waitForTextLayer(fakeReader({ 7: { spans: 193, renderingState: 1 } }) as never, 7);
	assert.equal(ok, true, '已经在长 span 的页,等才是有意义的 —— 这一版没有削弱它');
});

test('冷启动上限只管"一个 span 都没有"的情形 (结构性回归闸, 2.9.1)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/zoteroReaderAdapter.ts'), 'utf8');
	const wait = src.slice(src.indexOf('export async function waitForTextLayer'), src.indexOf('export const TEXT_LAYER_SETTLE_MS'));
	assert.ok(/if \(!sawSpans\) \{/.test(wait),
		'两道闸必须都挂在 `一个 span 都没见过` 之下 —— 否则会把正在长 span 的页也砍掉,那就退回 2.8.13 之前的半成品抽取');
	assert.ok(/state === RENDER_STATE_INITIAL \|\| state === RENDER_STATE_PAUSED/.test(wait),
		'闸 1: 只认 INITIAL / PAUSED;RUNNING 与 FINISHED 都该继续等');
	assert.ok(/Date\.now\(\) - startedAt >= coldMs/.test(wait), '闸 2: 冷启动上限');
	assert.ok(!/if \(count === 0 && !pageViewOf\(reader, pageIndex\)\)/.test(wait),
		'不许退回那条永不触发的旧早退 —— PDF.js 给每一页都建了 PDFPageView');
	const state = src.slice(src.indexOf('export function pageRenderState'), src.indexOf('const RENDER_STATE_INITIAL'));
	assert.ok(/return null;/.test(state) && /catch/.test(state),
		'拿不到渲染状态要返回 null,交给冷启动上限 —— 绝不据此断言"这页没文字"');
});

test('抽不出文字时,"层不在"与"真没文字"必须分开 (结构性回归闸, 2.8.13)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/textExtractor.ts'), 'utf8');
	const tail = src.slice(src.indexOf('// —— 三条路都空'), src.indexOf('async extractRenderedPage'));
	// 顺序要紧: 先问"层在不在",再谈"这页有没有文字"。反过来就又把没渲染的页
	// 判成 empty 了。
	const notRendered = tail.indexOf('if (!adapter.textLayerExists(this.reader, pageIndex))');
	const emptyVerdict = tail.indexOf("this.pathByPage.set(pageIndex, 'empty')");
	assert.ok(notRendered > 0 && notRendered < emptyVerdict,
		'必须先排除"文本层不在",才轮得到"这页确实没有可译内容"这个定论');
	assert.ok(/throw new PaperMirrorError\('EXTRACTION_FAILED',[\s\S]{0,160}retryable: true/.test(tail),
		'"看不见"要抛可重试的错 —— 它不是定论');
});

test('预取页遇到"层不在"要重来,当前页要报错,都不许标完成 (结构性回归闸, 2.8.13)', () => {
	const src = readFileSync(join(process.cwd(), 'src/translation/translationManager.ts'), 'utf8');
	const start = src.indexOf("else if (err.code === 'EXTRACTION_FAILED' && err.retryable) {");
	assert.ok(start > 0, '找不到"文本层未渲染"的分支');
	const branch = src.slice(start, src.indexOf('// real extraction errors keep their error', start));
	assert.ok(/if \(pageIndex === this\.currentPage\) \{[\s\S]{0,200}state\.status = 'error';/.test(branch),
		'当前页: 如实报可重试的错');
	// 2.9.0: 预取页仍然忘掉这次结果,但必须**走 releasePage** —— 裸 delete 会让
	// 这一页从 exportScope 里整行消失(真机第 36/41/45 页就是这么没的),而且
	// 没有任何东西保证 2.8.13 指望的那次"用户翻过去"真的会发生。
	assert.ok(/this\.releasePage\(pageIndex, state, 'text-layer-not-rendered'\);/.test(branch),
		'预取页: 释放并记账,而不是裸 delete');
	assert.ok(!/this\.pages\.delete\(pageIndex\)/.test(branch),
		'不许绕过 releasePage 直接删 —— 删了就没人知道这一页存在过');
	assert.ok(!/state\.status = 'done'/.test(branch),
		'无论如何都不许标完成 —— 标了就永远不会再抽,用户翻过去一个字没译');
});
