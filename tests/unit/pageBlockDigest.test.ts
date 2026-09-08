/**
 * 逐块诊断摘要 (2.8.5, 导出方案 P0)。
 *
 * 钉住三件事:
 *   1. 摘要里**只有枚举与数字**,永远不含原文/译文/异常原始消息;
 *   2. 被卸过的页在诊断里仍然有逐块明细,而且与卸之前**逐字相同** ——
 *      省内存不能改变诊断结论;
 *   3. 活块与摘要走同一个函数,`state` 口径仍是 2.3.7 那套
 *      (translated / preserved / keepOrigin 原因 / untranslated),
 *      下游 joinPlacementOutcome 与 baseline-report 不受影响。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestRows, buildPageDigest, diagnosticRows, type DigestSource } from '../../src/translation/pageBlockDigest';
import { TranslationManager, type TranslationDeps } from '../../src/translation/translationManager';
import type { SourceBlock } from '../../src/types/models';

const SRC = 'UNPUBLISHED_MANUSCRIPT_SENTINEL_TEXT';
const TGT = '未发表稿件译文哨兵';

function block(id: string, over: Partial<SourceBlock> = {}): SourceBlock {
	return {
		id, pageIndex: 0, order: 0, type: 'paragraph', sourceText: SRC, ...over
	} as SourceBlock;
}

function source(over: Partial<DigestSource> = {}): DigestSource {
	return { blocks: [], translations: new Map(), ...over };
}

test('三种去向: 译出 / 有意保留原文 / 没译成 (2.8.5 P0)', () => {
	const rows = digestRows(source({
		blocks: [
			block('b0'),
			block('b1', { translationMode: 'preserve' }),
			block('b2')
		],
		translations: new Map([['b0', TGT]])
	}));
	assert.deepEqual(rows.map(r => r.outcome), ['translated', 'preserved', 'untranslated']);
	assert.deepEqual(rows.map(r => r.chars), [SRC.length, SRC.length, SRC.length],
		'只记字符数,不记内容');
	// preserve 块(数据单元格、公式等)是**有意**不翻译 —— 报成 untranslated
	// 会把一张全是数字的表算成"整页翻译失败"。
	assert.equal(rows[1]!.outcome, 'preserved');
});

test('摘要只收枚举,原文与译文一个字都进不来 (2.8.5 P0)', () => {
	const digest = buildPageDigest(source({
		blocks: [block('b0'), block('b1')],
		translations: new Map([['b0', TGT]]),
		keepOrigin: new Map([['b1', 'repeated-failure']]),
		rejectReasons: new Map([['b1', 'validator']])
	}), 7, 3);
	const json = JSON.stringify(digest);
	assert.ok(!json.includes(SRC), '摘要绝不能含原文');
	assert.ok(!json.includes(TGT), '摘要绝不能含译文');
	assert.equal(digest.runId, 7, '审计位: 这份明细属于哪一轮');
	assert.equal(digest.revision, 3);
	assert.equal(digest.blocks[1]!.keepOrigin, 'repeated-failure');
	assert.equal(digest.blocks[1]!.lastReject, 'validator');
});

test('译出的块不带 keepOrigin / lastReject —— 那是它没译成时的旧账 (2.8.5 P0)', () => {
	// 同一块可能先被拒过、重试后译成了。终态是 translated,就不该再挂着拒绝原因,
	// 否则诊断里会出现一批"既译出了又被拒了"的自相矛盾行。
	const rows = digestRows(source({
		blocks: [block('b0')],
		translations: new Map([['b0', TGT]]),
		keepOrigin: new Map([['b0', 'unrecovered']]),
		rejectReasons: new Map([['b0', 'placeholder']])
	}));
	assert.equal(rows[0]!.outcome, 'translated');
	assert.equal(rows[0]!.keepOrigin, undefined);
	assert.equal(rows[0]!.lastReject, undefined);
});

test('诊断行沿用 2.3.7 的 state 口径,keepOrigin 另列一栏 (2.8.5 P0)', () => {
	const rows = diagnosticRows(digestRows(source({
		blocks: [block('b0'), block('b1', { translationMode: 'preserve' }), block('b2'), block('b3')],
		translations: new Map([['b0', TGT]]),
		keepOrigin: new Map([['b2', 'unrecovered']]),
		rejectReasons: new Map([['b3', 'plain-ascii']])
	})));
	// 下游 (joinPlacementOutcome / baseline-report.mjs) 按这四种取值读,不能改。
	assert.deepEqual(rows.map(r => r.state),
		['translated', 'preserved', 'unrecovered', 'untranslated']);
	assert.equal(rows[2]!.keepOrigin, 'unrecovered', '原因另外显式列一栏,便于机读');
	assert.equal(rows[0]!.keepOrigin, undefined);
	assert.equal(rows[3]!.lastReject, 'plain-ascii');
});

// ---- 行为闸: 卸载不得改变诊断结论 -------------------------------------------

function makeBlocks(pageIndex: number, n: number): SourceBlock[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `page-${pageIndex}-block-${i}`,
		pageIndex,
		order: i,
		type: 'paragraph' as const,
		sourceText: `Source paragraph ${i} on page ${pageIndex}.`
	}));
}

interface DiagPage {
	/** 诊断里是 1 基页码。 */
	page: number;
	blocks: { id: string; state: string }[];
	blockSource: string;
	extractPath?: string;
}

function pagesOf(manager: TranslationManager): DiagPage[] {
	return (manager.exportDiagnostics() as { pages: DiagPage[] }).pages;
}

test('被卸过的页在诊断里仍有逐块明细,且与卸之前逐字相同 (2.8.5 P0)', async () => {
	const cache = new Map<number, { id: string; translatedText: string }[]>();
	const deps: TranslationDeps = {
		extractPage: async (pageIndex) => makeBlocks(pageIndex, 3),
		translateRequest: async (request) => ({
			translations: request.blocks.map(b => ({ id: b.id, translatedText: '这是完整的中文译文段落内容。' }))
		}),
		readCache: async (pageIndex) => cache.get(pageIndex) ?? null,
		writeCache: async (pageIndex, _blocks, translations) => { cache.set(pageIndex, translations); },
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Doc',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => 40,
		isPageInUse: () => false,
		extractPathOf: () => 'chars'
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} },
		{ prefetch: false, delayFn: () => Promise.resolve(), retainLimit: 5 });

	await manager.ensurePage(0, 10);
	manager.setCurrentPage(0);
	const live = pagesOf(manager).find(p => p.page === 1)!;
	assert.equal(live.blockSource, 'live');
	assert.equal(live.blocks.length, 3);
	assert.equal(live.extractPath, 'chars', '抽取路径要记下来 —— 否则事后重建对不上也说不清');

	// 读到远处去,把第 0 页挤出保留窗口。
	for (let page = 1; page < 20; page++) {
		await manager.ensurePage(page, 10);
		manager.setCurrentPage(page);
	}
	assert.equal(manager.getPageState(0)?.evicted, true, '前提: 第 0 页确实被卸了');
	assert.equal(manager.getPageState(0)?.blocks.length, 0, '完整内容确实卸掉了');

	const after = pagesOf(manager).find(p => p.page === 1)!;
	assert.equal(after.blockSource, 'digest', '空块表不再需要靠猜是"没内容"还是"被卸了"');
	assert.deepEqual(after.blocks, live.blocks, '省内存不得改变逐块诊断结论');
	assert.equal(after.extractPath, 'chars', '轻量状态里也留着抽取路径');

	const json = JSON.stringify(manager.exportDiagnostics());
	assert.ok(!json.includes('Source paragraph'), '摘要随诊断导出,口径必须与 diagnosticsPrivacy 一致');
	assert.ok(!json.includes('这是完整的中文译文段落内容'), '译文同样不得进诊断');
	manager.dispose();
});

test('从没抽过的页标 none,不冒充"这页没有可译内容" (2.8.5 P0)', () => {
	const manager = new TranslationManager({
		extractPage: async () => [],
		translateRequest: async () => ({ translations: [] }),
		readCache: async () => null,
		writeCache: async () => {},
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Doc',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => 3
	}, { onPageUpdate: () => {} }, { prefetch: false });
	manager.setCurrentPage(0);
	for (const page of pagesOf(manager)) {
		assert.notEqual(page.blockSource, 'digest');
	}
	manager.dispose();
});

// ---- 接线的结构闸 -----------------------------------------------------------

test('摘要必须在卸载现场、清空之前拍下 (结构性回归闸, 2.8.5)', () => {
	const src = readFileSync(join(process.cwd(), 'src/translation/translationManager.ts'), 'utf8');
	const evict = src.slice(src.indexOf('private evictColdPages()'), src.indexOf('private pageInUse('));
	assert.ok(/state\.blockDigest = buildPageDigest\([\s\S]*?state\.blocks = \[\];/.test(evict),
		'必须先拍摘要再清空 —— 清空之后 blocks 与两个 Map 都没了,拍不出来');
	assert.ok(/state\.blockDigest = buildPageDigest\([\s\S]*?state\.keepOrigin = undefined;/.test(evict),
		'keepOrigin/rejectReasons 也要在清空前进摘要');
	// 活块与摘要必须共用同一个判定函数,否则两套口径迟早漂移。
	assert.ok(/blocks: diagnosticRows\(s\.blocks\.length \? digestRows\(s\) : \(s\.blockDigest\?\.blocks \?\? \[\]\)\)/.test(src),
		'诊断导出必须让活块与摘要走同一条判定路径');
});

test('宿主把抽取路径接上了 (结构性回归闸, 2.8.5)', () => {
	const session = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	assert.ok(/extractPathOf: pageIndex => this\.extractor\.extractPathFor\(pageIndex\)/.test(session),
		'诊断里的 extractPath 必须来自抽取器实际走通的那条路径');
	const extractor = readFileSync(join(process.cwd(), 'src/reader/textExtractor.ts'), 'utf8');
	for (const path of ['chars', 'text-layer', 'plain-text', 'rendered-recovery', 'empty']) {
		assert.ok(extractor.includes(`this.pathByPage.set(pageIndex, '${path}')`),
			`抽取路径 ${path} 的出口必须记路径 —— 漏一个就会把上一次的路径当成这次的`);
	}
});
