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
import { TranslationManager, MAX_RELEASES, RELEASE_RETRY_RADIUS, type TranslationDeps } from '../../src/translation/translationManager';
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
