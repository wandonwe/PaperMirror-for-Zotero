/**
 * 释放 ≠ 消失 (2.9.0, 真机第三轮)。
 *
 * ## 真机证据
 *
 * 51 页的那一轮诊断里,**第 36、41、45 页不在 scope 里** —— 不是标成失败,是整行
 * 不见,而它们两侧的页都正常处理过。同一份文件里 `attemptErrors.CANCELLED = 36`。
 * 用户看到的是这几页一片英文,而诊断文件里连一行记账都没有。
 *
 * ## 根因
 *
 * 代码里有**五处**把页状态从 `this.pages` 里删掉,然后指望"用户翻过去时自然会
 * 重抽":抽取僵尸、抽取超时、文本层未渲染(2.8.13)、导航取代、请求取消。
 * 每一处都只写一行日志。于是:
 *
 *   - 页从 `exportScope()` 里消失 —— 违反本项目第一天就定下的「不许静默漏页」;
 *   - 那个指望本身有个洞: **单向顺读时用户只经过这一页一次**。释放若发生在他
 *     已经走过之后,就再也没有第二次 —— 这一趟永远不译。
 *
 * ## 这一版钉两条
 *
 *   1. 五处删除统一走 `releasePage`,释放过的页**留在导出清单里**,带原因与次数;
 *   2. 每次翻页把近处释放过的页**主动补回**,且**有界**(MAX_RELEASES)——
 *      到次数就停下并如实标 `exhausted`,不无限重试、也不无声耗着。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TranslationManager, MAX_RELEASES, MAX_RENDER_RETRIES, RELEASE_RETRY_RADIUS, type TranslationDeps } from '../../src/translation/translationManager';
import { PaperMirrorError, type SourceBlock, type TranslationRequest, type TranslationResponse } from '../../src/types/models';

function blocksFor(pageIndex: number): SourceBlock[] {
	return [{
		id: `page-${pageIndex}-block-0`,
		pageIndex,
		order: 0,
		type: 'paragraph' as const,
		sourceText: `Paragraph on page ${pageIndex}.`
	}];
}

/** 让指定页的抽取抛 `times` 次可重试错误,之后正常返回。 */
function depsFailing(failPage: number, times: number): { deps: TranslationDeps; attempts: () => number } {
	let attempts = 0;
	const cache = new Map<number, { id: string; translatedText: string }[]>();
	const deps: TranslationDeps = {
		extractPage: async (pageIndex) => {
			if (pageIndex === failPage) {
				attempts++;
				if (attempts <= times) {
					throw new PaperMirrorError('EXTRACTION_FAILED',
						`第 ${pageIndex + 1} 页的文字层尚未渲染,稍后重试。`, { retryable: true });
				}
			}
			return blocksFor(pageIndex);
		},
		translateRequest: async (request: TranslationRequest): Promise<TranslationResponse> =>
			({ translations: request.blocks.map(b => ({ id: b.id, translatedText: '译:' + b.text })) }),
		readCache: async (pageIndex) => cache.get(pageIndex) ?? null,
		writeCache: async (pageIndex, _blocks, translations) => { cache.set(pageIndex, translations); },
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Test Doc',
		getGlossary: () => [],
		useContext: () => false,
		pageCount: () => 60
	};
	return { deps, attempts: () => attempts };
}

/** 补回是 fire-and-forget 的,给微任务队列几拍时间落定。 */
async function settle(ticks = 30): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

function scopeOf(manager: TranslationManager): Map<number, string> {
	return new Map(manager.exportScope().map(e => [e.pageIndex, e.status]));
}

// ---- 1. 记账: 释放过的页必须留在导出清单里 ------------------------------------

test('被释放的页留在导出清单里,不再整行消失 (2.9.0 真机第 36/41/45 页)', async () => {
	const { deps } = depsFailing(20, 99);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(0);
	await manager.ensurePage(20, 10); // 非当前页 → 走释放路径

	assert.equal(manager.getPageState(20), undefined, '页状态确实被卸掉了(这部分行为不变)');
	assert.equal(scopeOf(manager).get(20), 'released',
		'但它必须**出现在导出清单里** —— 真机上这一步的缺失让第 36/41/45 页从诊断中整行消失');

	const row = manager.exportPageDiagnostics(20) as Record<string, unknown> | null;
	assert.ok(row, '释放过的页要有一行,内容就是"它为什么没有内容"');
	assert.equal(row!.status, 'released');
	assert.equal(row!.releaseReason, 'text-layer-not-rendered');
	assert.equal(row!.releaseCount, 1);
	assert.deepEqual(row!.blocks, [], '没有内容就是没有内容,不编');
	manager.dispose();
});

test('释放行不含任何原文 (隐私闸, 2.9.0)', async () => {
	const { deps } = depsFailing(20, 99);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(0);
	await manager.ensurePage(20, 10);
	const json = JSON.stringify(manager.exportPageDiagnostics(20));
	assert.ok(!/Paragraph on page/.test(json), '诊断文件不含原文 —— 释放行也不例外');
	assert.ok(!/文字层尚未渲染/.test(json), '异常 message 同样不许带出去(它可能带页码以外的东西)');
	manager.dispose();
});

// ---- 2. 补回: 不能只指望"用户翻过去" ------------------------------------------

test('翻页时把近处释放过的页补回来 —— 单向顺读只经过一次 (2.9.0)', async () => {
	const { deps } = depsFailing(20, 1); // 只失败一次
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(0);
	await manager.ensurePage(20, 10);
	assert.equal(scopeOf(manager).get(20), 'released');

	// 用户翻到第 19 页(0-based 19 = 第 20 页的前一页)。2.8.13 指望的是"翻到 20
	// 页那一刻会重抽",而真机上用户经过时释放才发生,于是那一刻永远不来。
	manager.setCurrentPage(19);
	await settle();
	assert.equal(manager.getPageState(20)?.status, 'done',
		'补回必须真的发生 —— 否则这一页这一趟一个字都不会译');
	manager.dispose();
});

test('太远的页不补 —— 不回头扫整篇文档 (2.9.0)', async () => {
	const { deps, attempts } = depsFailing(20, 99);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(0);
	await manager.ensurePage(20, 10);
	const before = attempts();
	manager.setCurrentPage(20 + RELEASE_RETRY_RADIUS + 5);
	await settle();
	assert.equal(attempts(), before,
		'距离超出半径就不补 —— 否则每次翻页都会把整篇文档的历史遗留重跑一遍');
	manager.dispose();
});

// ---- 3. 有界: 绝不无限重试 ----------------------------------------------------

test(`同一页最多释放 ${MAX_RELEASES} 次,之后停手但仍如实记账 (2.9.0)`, async () => {
	const { deps, attempts } = depsFailing(20, 99); // 永远失败
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(0);
	await manager.ensurePage(20, 10);

	// 反复在附近翻页(**不落到第 20 页本身** —— 用户真的翻到那一页时当然该无条件
	// 再试一次,那条路不受这个次数闸管),每次都会触发一次补回,直到次数用尽。
	for (let i = 0; i < MAX_RELEASES + 4; i++) {
		manager.setCurrentPage(19 - (i % 2));
		await settle();
	}
	assert.equal(attempts(), MAX_RELEASES,
		`抽取最多被试 ${MAX_RELEASES} 次 —— 无限重试在这个项目里是明令禁止的"修复"`);

	const row = manager.exportPageDiagnostics(20) as Record<string, unknown>;
	assert.equal(row.releaseCount, MAX_RELEASES);
	assert.equal(row.exhausted, true, '停手了就要说停手了,不能无声地耗着');
	assert.equal(scopeOf(manager).get(20), 'released', '停手之后照样留在清单里');
	manager.dispose();
});

test('用户亲手重译能清掉释放计数 (2.9.0)', async () => {
	const { deps, attempts } = depsFailing(20, 99);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(0);
	for (let i = 0; i < MAX_RELEASES + 2; i++) {
		await manager.ensurePage(20, 10);
	}
	assert.equal(attempts(), MAX_RELEASES + 2, '直接调用 ensurePage 不受补回的次数闸限制');
	await manager.retranslatePage(20);
	await settle();
	const row = manager.exportPageDiagnostics(20) as Record<string, unknown> | null;
	assert.ok(!row || row.releaseCount === 1,
		'自动重试有界是为了不空转,不该用来挡住用户自己点的那一次');
	manager.dispose();
});

// ---- 4. 结构闸: 五处删除必须全都走同一个出口 ----------------------------------

test('页状态的删除只剩两个合法出口: releasePage 与用户重译 (结构性回归闸, 2.9.0)', () => {
	const raw = readFileSync(join(process.cwd(), 'src/translation/translationManager.ts'), 'utf8');
	// 注释里提到这个调用是可以的(本文件的注释就在讲它),只数**语句**:
	// 行首缩进后直接是它,且这一行不是注释。
	const src = raw.split('\n').map(line => /^\s*(\*|\/\/)/.test(line) ? '' : line).join('\n');
	// `this.pages.delete(` 允许出现的地方只有两处: releasePage 自己,和
	// retranslatePage(用户亲手发起的重置,不是"释放等重试")。
	const sites = [...src.matchAll(/this\.pages\.delete\(/g)].map(m => m.index!);
	assert.equal(sites.length, 2,
		'多出来的每一处裸 delete 都是一页可能从诊断里凭空消失 —— 真机第 36/41/45 页就是这么没的');
	const funnel = src.indexOf('private releasePage(');
	const funnelEnd = src.indexOf('\n\t}', funnel);
	const inFunnel = sites.filter(i => i > funnel && i < funnelEnd).length;
	assert.equal(inFunnel, 1, '其中一处必须在 releasePage 里');
	// 另一处在用户重译里,且必须同时清掉释放计数。
	assert.ok(/this\.unstableFired\.delete\(pageIndex\);[\s\S]{0,200}this\.released\.delete\(pageIndex\);/.test(src),
		'用户重译要清掉释放计数');
});

test('补回有界、低优先级、不与当前页抢 (结构性回归闸, 2.9.0)', () => {
	const src = readFileSync(join(process.cwd(), 'src/translation/translationManager.ts'), 'utf8');
	const fn = src.slice(src.indexOf('private retryReleasedPages()'), src.indexOf('\n\t}', src.indexOf('private retryReleasedPages()')));
	assert.ok(/record\.count >= MAX_RELEASES/.test(fn), '必须有次数闸');
	assert.ok(/Math\.abs\(pageIndex - this\.currentPage\) > RELEASE_RETRY_RADIUS/.test(fn), '必须有距离闸');
	assert.ok(/PRIORITY\.RELEASED_RETRY/.test(fn) && /foreground: false/.test(fn),
		'补回是最低优先级的后台工作 —— 绝不跟当前页抢');
	assert.ok(/this\.pages\.has\(pageIndex\) \|\| this\.scheduler\.isScheduled/.test(fn),
		'已经被别的路径接手的页不重复入队');
	// 顺序: 补回必须排在预取之后,否则它会占掉预取的位置。
	const setCurrent = src.slice(src.indexOf('setCurrentPage(pageIndex: number): void'));
	assert.ok(setCurrent.indexOf('this.retryReleasedPages();') > setCurrent.indexOf('this.schedulePrefetch();'),
		'补回排在预取之后');
});

// ---- 5. 2.9.2: 事件驱动补回,别再靠翻页去猜 ------------------------------------
//
// 2.9.1 让抽取遇到"没渲染"时立刻放手,抽取人均 864 ms → 139 ms;但同一份日志里
// `text-layer-not-rendered` 释放 **29 → 52**、`releasedPending` **8 → 27**、
// 21 页 `exhausted`。原因很直白: **预取本来就发生在页面渲染之前** —— 以前那
// 2.5 秒干等里 PDF.js 常常正好把页渲染完,于是歪打正着;不等了,预取就必然落空。
//
// 靠翻页轮询补回是在**猜**"现在渲染好了吗",猜错要付一次配额。而 PDF.js 自己
// 会在渲染完文本层时发 `textlayerrendered` —— 那是确定的信号,不是猜。

test('文本层渲染完的那一刻立刻重抽 —— 不等用户翻页 (2.9.2)', async () => {
	const { deps } = depsFailing(20, 1); // 第一次抽失败(页还没渲染),之后成功
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	// 用户停在第 19 页 —— 第 20 页在预取窗口内(2.9.3 的条件),但去抖长到
	// 测试期内不会自己触发预取,所以下面观察到的重抽只可能来自渲染事件。
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10);
	assert.equal(scopeOf(manager).get(20), 'released');

	// PDF.js 渲染到这一页 —— 没有任何翻页动作。
	manager.onPageRendered(20);
	await settle();
	assert.equal(manager.getPageState(20)?.status, 'done',
		'渲染完成是确定的信号,这一刻重抽命中率接近 100% —— 不该等用户正好翻到附近');
	manager.dispose();
});

test('事件补回不消耗盲目轮询的配额 —— 两套预算分开 (2.9.2)', async () => {
	const { deps, attempts } = depsFailing(20, 99); // 永远失败
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10);

	// 先把事件补回的配额用光 —— 它**不该**动到 releaseCount。
	for (let i = 0; i < MAX_RENDER_RETRIES + 3; i++) {
		manager.onPageRendered(20);
		await settle();
	}
	assert.equal(attempts(), 1 + MAX_RENDER_RETRIES,
		`事件补回自己有一个很小的上限(${MAX_RENDER_RETRIES})防病态 —— 文本层都出来了还抽不到,再试只是重复同一个失败`);

	const row = manager.exportPageDiagnostics(20) as Record<string, unknown>;
	assert.equal(row.renderRetries, MAX_RENDER_RETRIES);
	// 关键: 翻页轮询的配额一分没被花掉。
	assert.ok((row.releaseCount as number) <= MAX_RENDER_RETRIES + 1,
		'两套预算必须分开 —— 猜错的配额不该拖累确定信号触发的重抽');
	manager.dispose();
});

test('释放过、但已经补回来的页,事件不再重复触发 (2.9.2)', async () => {
	const { deps, attempts } = depsFailing(20, 1); // 只失败一次
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10);          // 失败 → 释放(留下 released 记录)
	manager.onPageRendered(20);                 // 事件补回 → 成功,页状态回来了
	await settle();
	assert.equal(manager.getPageState(20)?.status, 'done');
	const before = attempts();
	const budget = (): number =>
		((manager.exportDiagnostics() as { usage: { renderRetries?: number } }).usage.renderRetries ?? 0);
	assert.equal(budget(), 1, '刚才那次事件补回花掉一次配额');
	// released 记录仍在(释放计数是整轮会话的账),但这一页此刻**有页状态** ——
	// 再收到渲染事件(滚动来回、缩放每次都会重发)既不许再抽,**也不许烧配额**。
	for (let i = 0; i < 4; i++) {
		manager.onPageRendered(20);
	}
	await settle();
	assert.equal(attempts(), before,
		'`textlayerrendered` 在滚动/缩放时会反复发 —— 只要这一页此刻有页状态就不该再抽');
	assert.equal(budget(), 1,
		'配额也不能被滚动事件烧掉 —— 烧光了,这一页日后真需要重抽时就没预算了');
	manager.dispose();
});

test('没释放过的页,事件什么也不做 (2.9.2)', async () => {
	const { deps, attempts } = depsFailing(-1, 0); // 从不失败
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(0);
	const before = attempts();
	manager.onPageRendered(33); // 这一页压根没碰过
	await settle();
	assert.equal(attempts(), before, '事件只唤醒"释放过且此刻没有页状态"的页');
	manager.dispose();
});

// ---- 6. 2.9.2: 中间的洞必须自己跳出来 ----------------------------------------

test('会话完全没碰过、却夹在碰过的页之间的页号要报出来 (2.9.2)', async () => {
	const { deps } = depsFailing(-1, 0);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	// 从第 7 页开始读 —— setCurrentPage 自己也会翻译当前页,它同样算"碰过"。
	manager.setCurrentPage(7);
	await settle();
	for (const p of [8, 11, 12]) {
		await manager.ensurePage(p, 10);
	}
	// 真机 2.9.1 那轮处理了第 8–88 页,中间第 9、25、26、27 页**完全不在清单里** ——
	// 既没有页状态,也不在 released 里。导出文件里它长得跟"用户没读到这儿"一样。
	assert.deepEqual(manager.scopeGaps(), [9, 10],
		'中间的洞要摆出来。这个函数不解释原因(现有数据解释不了),只陈述事实');
	manager.dispose();
});

test('只碰过一页时没有"洞"可言 (2.9.2)', async () => {
	const { deps } = depsFailing(-1, 0);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(5);
	await settle();
	assert.deepEqual(manager.scopeGaps(), [], '一个点构不成区间,别报假洞');
	manager.dispose();
});

test('一页都没碰过时也不报洞 (2.9.2)', () => {
	const { deps } = depsFailing(-1, 0);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve() });
	assert.deepEqual(manager.scopeGaps(), [], '空会话没有区间,更没有洞');
	manager.dispose();
});

test('事件补回接线在 readerSession 里,且只认 textlayerrendered (结构性回归闸, 2.9.2)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	assert.ok(/onPdfRenderEvents\(this\.reader, \(pageIndex\) => \{[\s\S]{0,300}this\.manager\?\.onPageRendered\(pageIndex\);[\s\S]{0,120}\}, \['textlayerrendered'\]\)/.test(src),
		"必须单独订阅 textlayerrendered —— 上面那个订阅收全部渲染事件、分不出种类,"
		+ "而 pagerendered(画布画完)早于文本层,拿它当信号会又一次落空");
	assert.ok(/this\.disposeTextLayerEvents\?\.\(\);/.test(src), '订阅要能解绑,否则换文档就漏一个监听器');
});

// ---- 7. 2.9.3: 事件补回与导航取消别再打架 -------------------------------------
//
// 2.9.2 真机 103 页那轮,尾部第 88–93 页释放了 **5–11 次**,原因多为 `cancelled`;
// `attemptErrors.CANCELLED` 涨到 58/174(33%),`segmentHitRate` 从 0.851 掉到
// 0.479。那不是重试,是**抖动**: 用户在末尾来回滚动 → cancelExcept 撤掉离开窗口
// 的任务 → 释放(cancelled)→ 滚动中 `textlayerrendered` 对刚离开的页照样发 →
// 事件补回又把它拉起来 → 又被撤掉。
//
// 两类释放的语义本来就不同:
//   `text-layer-not-rendered` = "当时看不见",渲染完就该立刻重来;
//   `cancelled` / `navigation-superseded` = "**用户已经不在这页了**"。

/** 造一个"因取消而释放"的页: 抽取阶段直接抛 CANCELLED。 */
function depsCancelling(failPage: number): { deps: TranslationDeps; attempts: () => number } {
	let attempts = 0;
	const { deps } = depsFailing(-1, 0);
	return {
		deps: {
			...deps,
			extractPage: async (pageIndex: number) => {
				if (pageIndex === failPage) {
					attempts++;
					throw new PaperMirrorError('CANCELLED', 'Superseded by navigation.');
				}
				return blocksFor(pageIndex);
			}
		},
		attempts: () => attempts
	};
}

test('因取消而释放的页,渲染事件不许把它拉起来 (2.9.3)', async () => {
	const { deps, attempts } = depsCancelling(20);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10);
	const row = manager.exportPageDiagnostics(20) as Record<string, unknown>;
	assert.equal(row.releaseReason, 'cancelled');

	const before = attempts();
	for (let i = 0; i < 5; i++) {
		manager.onPageRendered(20);
	}
	await settle();
	assert.equal(attempts(), before,
		'取消 = 用户已经不在这页了。滚动时 textlayerrendered 对刚离开的页照样发,'
		+ '被它拉起来就会"起来→又被撤→再起来" —— 真机上第 88–93 页因此释放了 5–11 次');
	manager.dispose();
});

test('已经滚出预取窗口的页,渲染事件也不拉 (2.9.3)', async () => {
	const { deps, attempts } = depsFailing(20, 99);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10); // 释放,原因 text-layer-not-rendered
	// 用户走远了 —— 第 20 页早已不在 current±1 里。
	manager.setCurrentPage(60);
	await settle();
	const before = attempts();
	manager.onPageRendered(20);
	await settle();
	assert.equal(attempts(), before,
		'渲染事件对已经滚出去的页一样会发 —— 拉起一页用户正在远离的内容只是再烧一次配额');
	manager.dispose();
});

test('仍在窗口内的"看不见"型释放,事件照常拉起 —— 2.9.2 的能力没被削掉 (2.9.3)', async () => {
	const { deps } = depsFailing(20, 1);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10);
	manager.onPageRendered(20);
	await settle();
	assert.equal(manager.getPageState(20)?.status, 'done',
		'这一条是 2.9.2 的本体 —— 收窄条件不能把它一起收掉');
	manager.dispose();
});

test('事件补回的两道新条件都在 (结构性回归闸, 2.9.3)', () => {
	const src = readFileSync(join(process.cwd(), 'src/translation/translationManager.ts'), 'utf8');
	const fn = src.slice(src.indexOf('onPageRendered(pageIndex: number): void'),
		src.indexOf('void this.ensurePage(pageIndex, PRIORITY.RELEASED_RETRY', src.indexOf('onPageRendered(pageIndex: number): void')));
	assert.ok(/record\.reason !== 'text-layer-not-rendered' && record\.reason !== 'extract-timeout'/.test(fn),
		'按释放原因分流 —— cancelled / navigation-superseded 是"用户走了",该等他回来');
	// 2.9.4: 距离闸取代了窗口闸。预取窗口只有 current ±1(3 页宽),渲染事件到达时
	// 用户常常已经走过两三页 —— 真机第 42–45 页正卡在这里,renderRetries 全是 0。
	assert.ok(/Math\.abs\(pageIndex - this\.currentPage\) > RELEASE_RETRY_RADIUS/.test(fn),
		'距离闸: 渲染事件本身就是"这一页现在抽得到"的确定信息,不需要预取窗口再背书;'
		+ '要防的只有"拉起一页用户已经远离的内容"');
	assert.ok(!/wantedPages\(\)\.includes\(pageIndex\)/.test(fn),
		'不许退回 ±1 的预取窗口 —— 那把 2.9.2 的本体能力一起压住了');
});

test('每一道闸挡掉多少次都要计数 (结构性回归闸, 2.9.4)', () => {
	const src = readFileSync(join(process.cwd(), 'src/translation/translationManager.ts'), 'utf8');
	const fn = src.slice(src.indexOf('onPageRendered(pageIndex: number): void'),
		src.indexOf('void this.ensurePage(pageIndex, PRIORITY.RELEASED_RETRY', src.indexOf('onPageRendered(pageIndex: number): void')));
	for (const kind of ['has-state', 'budget-spent', 'reason', 'too-far', 'already-queued']) {
		assert.ok(new RegExp(`bump\\(this\\.renderRetryBlocked, '${kind}'\\)`).test(fn),
			`${kind} 这道闸必须记数 —— 2.9.3 上第 42–45 页 renderRetries 全是 0,`
			+ '而日志分不出是哪一道挡的,只能猜;猜出来的结论不配写进代码');
	}
	assert.ok(/renderRetryBlocked: countsOf\(this\.renderRetryBlocked\)/.test(src),
		'计数要进导出,否则下一轮还是看不见');
});

test('渲染事件到达时用户已走过两三页,照样补得回来 (2.9.4 真机第 42–45 页)', async () => {
	const { deps } = depsFailing(20, 1);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10); // 释放: text-layer-not-rendered

	// 用户继续往后读 —— 第 20 页已经**不在** current ±1 的预取窗口内了。
	// 2.9.3 的窗口闸正是在这里把补回挡死的: 真机第 42–45 页 renderRetries 全是 0。
	manager.setCurrentPage(22);
	await settle();
	manager.onPageRendered(20);
	await settle();
	assert.equal(manager.getPageState(20)?.status, 'done',
		'渲染事件本身就是"这一页现在抽得到"的确定信息 —— 不该再要求它落在 3 页宽的预取窗口里');
	manager.dispose();
});

test('被挡掉的每一次都进了计数,且只有枚举不含文本 (2.9.4)', async () => {
	const { deps } = depsCancelling(20);
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: true, prefetchDebounceMs: 100000, delayFn: () => Promise.resolve() });
	manager.setCurrentPage(19);
	await settle();
	await manager.ensurePage(20, 10); // 释放: cancelled
	manager.onPageRendered(20);        // 被原因闸挡
	manager.setCurrentPage(40);
	await settle();
	manager.onPageRendered(20);        // 走远了 —— 被距离闸挡(原因闸也会挡,先到先算)
	await settle();
	const usage = (manager.exportDiagnostics() as { usage: Record<string, unknown> }).usage;
	const blocked = usage.renderRetryBlocked as Record<string, number>;
	assert.ok(blocked && (blocked.reason ?? 0) >= 1,
		'挡掉就要记 —— 2.9.3 上第 42–45 页 renderRetries 全是 0,而分不出是哪一道闸,只能猜');
	assert.ok(Object.keys(blocked).every(k => /^[a-z-]+$/.test(k)),
		'键只能是枚举名,不含页码、路径或任何文本');
	manager.dispose();
});
