import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TranslationManager, type TranslationDeps } from '../../src/translation/translationManager';
import type { SourceBlock, TranslationRequest, TranslationResponse } from '../../src/types/models';

/**
 * P0-2 (2.0.1): 硬性不变量 —— 诊断导出绝不含原文与译文。
 * 1.1.7 曾把「语料」并进「诊断」按钮,于是一个叫「诊断」的动作会把整页原文
 * 放进剪贴板;用户在「提交诊断」的心智下粘进 issue,就等于公开了未发表稿件。
 * 语料已拆回独立的「语料」按钮(名字与提示都明说含原文)。
 */

const SRC = 'UNPUBLISHED_MANUSCRIPT_SENTINEL_TEXT';
const TGT = '未发表稿件译文哨兵';

function makeDeps(): TranslationDeps {
	return {
		extractPage: async (pageIndex) => ([{
			id: `page-${pageIndex}-block-0`, pageIndex, order: 0,
			type: 'paragraph' as const, sourceText: SRC
		}] as SourceBlock[]),
		translateRequest: async (_r: TranslationRequest): Promise<TranslationResponse> =>
			({ translations: [{ id: 'page-0-block-0', translatedText: TGT }] }),
		readCache: async () => null,
		writeCache: async () => {},
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Confidential Submission Title',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => 1
	};
}

test('exportDiagnostics 不含原文、不含译文', async () => {
	const manager = new TranslationManager(makeDeps(), { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 1);
	const json = JSON.stringify(manager.exportDiagnostics());
	assert.ok(!json.includes(SRC), '诊断绝不能含原文');
	assert.ok(!json.includes(TGT), '诊断绝不能含译文');
	// 但必须仍然有用:结构与状态要在
	assert.ok(/page-0-block-0/.test(json), '应保留 block id 以便定位');
	assert.ok(/translated/.test(json), '应保留状态');
	manager.dispose();
});

test('会话侧的诊断载荷不再拼进 currentPageCorpus(结构性回归闸)', () => {
	// copyDiagnostics 需要大量 Zotero 环境才能直调;这里用源码级断言钉住不变量,
	// 防止有人再次把语料并回「诊断」。
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	// 2.3.0: copyDiagnostics 变 async(引擎自检需 await 服务商配置),签名两种都认。
	const sigMatch = /private (?:async )?copyDiagnostics\(/.exec(src);
	const start = sigMatch ? sigMatch.index : -1;
	assert.ok(start > 0, '找不到 copyDiagnostics');
	const end = src.indexOf('private copyLayoutCorpus(', start);
	assert.ok(end > start, '找不到 copyLayoutCorpus —— 语料必须是独立动作');
	const body = src.slice(start, end);
	assert.ok(!/currentPageCorpus|this\.layoutCorpus\(\)/.test(body),
		'copyDiagnostics 不得包含语料/原文');
});

test('语料导出仍然可用,且自我声明含原文', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const start = src.indexOf('private copyLayoutCorpus(');
	const body = src.slice(start, start + 1400);
	assert.ok(/this\.layoutCorpus\(\)/.test(body), '语料按钮必须真的导出语料');
	assert.ok(/CONTAINS SOURCE TEXT/.test(body), '载荷需自带含原文声明');
	assert.ok(/含本页原文/.test(body), 'toast 需提醒用户含原文');
});

test('token 用量进诊断 (2.7.0, 审核 F-2): 只有数字,按页与总账都在', async () => {
	const deps = makeDeps();
	deps.translateRequest = async (): Promise<TranslationResponse> => ({
		translations: [{ id: 'page-0-block-0', translatedText: TGT }],
		usage: { inputTokens: 123, outputTokens: 45, cachedInputTokens: 6 }
	});
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 1);
	const diag = manager.exportDiagnostics() as { pages: { metrics: Record<string, number> }[]; usage: Record<string, number> };
	assert.equal(diag.usage.inputTokens, 123);
	assert.equal(diag.usage.outputTokens, 45);
	assert.equal(diag.usage.cachedInputTokens, 6);
	assert.equal(diag.usage.usageReports, 1);
	assert.equal(diag.usage.usageMissing, 0);
	assert.equal(diag.pages[0]!.metrics.inputTokens, 123);
	const json = JSON.stringify(diag);
	assert.ok(!json.includes(SRC) && !json.includes(TGT), '用量字段不得夹带文本');
	manager.dispose();
});

test('服务商不报用量时计入 usageMissing,页指标不出现 token 字段', async () => {
	const manager = new TranslationManager(makeDeps(), { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 1);
	const diag = manager.exportDiagnostics() as { pages: { metrics: Record<string, unknown> }[]; usage: Record<string, number> };
	assert.equal(diag.usage.usageMissing, 1);
	assert.equal(diag.usage.inputTokens, 0);
	assert.ok(!('inputTokens' in diag.pages[0]!.metrics));
	manager.dispose();
});
