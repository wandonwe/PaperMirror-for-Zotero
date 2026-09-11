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

test('尝试去向明细只含枚举键与数字,错误消息一律不进诊断 (2.7.9)', async () => {
	const { PaperMirrorError } = await import('../../src/types/models');
	const deps = makeDeps();
	let n = 0;
	deps.translateRequest = async (_r, _s, hooks): Promise<TranslationResponse> => {
		n++;
		hooks?.onAttempt?.();
		if (n === 1) {
			hooks?.onParamHeal?.('temperature');
			hooks?.onAttempt?.();
			// 错误消息里塞进原文哨兵: 它进了 message,但绝不能进诊断。
			throw new PaperMirrorError('NETWORK', `upstream said: ${SRC}`, { retryable: true });
		}
		return { translations: [{ id: 'page-0-block-0', translatedText: TGT }] };
	};
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 1);
	const diag = manager.exportDiagnostics() as { usage: { paramHeals?: Record<string, number>; attemptErrors?: Record<string, number> } };
	const json = JSON.stringify(diag);
	assert.ok(!json.includes(SRC), '错误消息里的原文不得随 attemptErrors 泄进诊断');
	assert.ok(!json.includes(TGT));
	assert.deepEqual(diag.usage.paramHeals, { temperature: 1 });
	assert.deepEqual(diag.usage.attemptErrors, { NETWORK: 1 });
	const ENUMS = new Set(['temperature', 'reasoning_effort', 'thinking', 'model', 'other']);
	for (const k of Object.keys(diag.usage.paramHeals ?? {})) {
		assert.ok(ENUMS.has(k), `paramHeals 的键必须是 RejectedParam 枚举: ${k}`);
	}
	for (const [k, v] of Object.entries(diag.usage.attemptErrors ?? {})) {
		assert.ok(/^[A-Z_]+$/.test(k), `attemptErrors 的键必须是错误码枚举: ${k}`);
		assert.equal(typeof v, 'number');
	}
	manager.dispose();
});

test('readerSession 把三个计量钩子原样转给适配器 (结构性回归闸, 2.7.9)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const call = /provider\.translate\(request,[^;]*?\);/s.exec(src);
	assert.ok(call, '找不到 provider.translate 调用');
	for (const hook of ['onAttempt', 'onUsage', 'onParamHeal']) {
		assert.ok(new RegExp(`${hook}: hooks\\?\\.${hook}`).test(call[0]),
			`${hook} 必须转给适配器 —— 漏一个,诊断里那一类尝试就永远是 0`);
	}
});

test('第五批计量只有数字: 时序、热页数、写盘、渲染,一个字都不带 (2.8.4)', async () => {
	const deps = makeDeps();
	const manager = new TranslationManager(deps, { onPageUpdate: () => {} }, { prefetch: false });
	await manager.ensurePage(0, 1);
	const diag = manager.exportDiagnostics() as {
		pages: { metrics: Record<string, unknown> }[];
		usage: Record<string, unknown>;
	};
	const json = JSON.stringify(diag);
	assert.ok(!json.includes(SRC) && !json.includes(TGT), '计量字段不得夹带文本');

	const metrics = diag.pages[0]!.metrics;
	for (const field of ['extractMs', 'firstTextMs']) {
		assert.equal(typeof metrics[field], 'number', `${field} 应为毫秒数`);
		assert.ok((metrics[field] as number) >= 0);
	}
	assert.equal(typeof diag.usage.hotPages, 'number', '热页面数量');
	assert.equal(diag.usage.hotPages, 1);
	assert.equal(typeof diag.usage.retainedPages, 'number');
	manager.dispose();
});

test('缓存写盘计量只累计次数/字节/毫秒 (2.8.4)', async () => {
	const cache = await import('../../src/cache/cacheManager');
	cache.resetCacheWriteStats();
	const zero = cache.cacheWriteStats();
	for (const [key, value] of Object.entries(zero)) {
		assert.equal(value, 0, `${key} 归零`);
		assert.equal(typeof value, 'number');
	}
	assert.deepEqual(Object.keys(zero).sort(), [
		'failures', 'pageBytes', 'pageMs', 'pageWrites',
		'segmentBytes', 'segmentEntriesWritten', 'segmentFlushes', 'segmentMs'
	], '字段集合固定,不该混进路径或内容');
	// 快照是拷贝,外部改不到内部计数。
	const snapshot = cache.cacheWriteStats();
	snapshot.pageWrites = 999;
	assert.equal(cache.cacheWriteStats().pageWrites, 0, '快照必须是拷贝');
});

test('第五批只加计量、不改行为: 缓存与补译路径原样 (结构性回归闸, 2.8.4)', () => {
	const src = readFileSync(join(process.cwd(), 'src/cache/cacheManager.ts'), 'utf8');
	// 计量只能出现在写盘成功之后与失败分支里,不能掺进"写什么/写到哪"的决策。
	const write = src.slice(src.indexOf('export async function writePage('), src.indexOf('/**\n * 段落级缓存 read'));
	assert.ok(/writeStats\.pageWrites\+\+;/.test(write));
	assert.ok(!/if \(writeStats/.test(src), '计量绝不参与任何分支判断 —— 那就不是"只量"了');
	// 真的分片会带来"按哈希选文件"的逻辑;注释里提到"分片"是说明动机,不算实现。
	assert.ok(!/shardOf|shardPath|segmentsPath\([^)]*shard/.test(src),
		'第五批不做分片,先量再改');
	assert.equal(src.split('await IOUtils.writeJSON(').length - 1, 2,
		'仍然是页缓存 + 段落库两处整体写盘,没有引入新的写盘路径');
});

test('extractPath 是枚举,永远装不下真实文件路径 (2.8.5 P0)', async () => {
	// 字段名里带 "path",最容易在后续改动里被塞进一个真实文件路径 —— 那就是
	// 把用户的目录结构(往往含姓名、机构、稿件标题)写进了可粘贴的诊断包。
	const { ExtractPath } = await import('../../src/reader/textExtractor') as unknown as Record<string, never>;
	assert.equal(ExtractPath, undefined, 'ExtractPath 是纯类型,不该有运行期值');
	const src = readFileSync(join(process.cwd(), 'src/reader/textExtractor.ts'), 'utf8');
	const decl = /export type ExtractPath = ([^;]+);/.exec(src);
	assert.ok(decl, '找不到 ExtractPath 的声明');
	const values = decl![1]!.split('|').map(s => s.trim());
	assert.deepEqual(values.slice().sort(),
		["'chars'", "'empty'", "'plain-text'", "'rendered-recovery'", "'text-content'", "'text-layer'"],
		'只允许这六个枚举值 —— 新增取值必须是枚举,不能是路径/文件名/URL');
	// 记录现场也只能写这几个字面量,不能写变量。
	const sets = [...src.matchAll(/this\.pathByPage\.set\(pageIndex, ([^)]+)\)/g)].map(m => m[1]!.trim());
	assert.equal(sets.length, 6, '六个出口各记一次(2.9.7 起多了 text-content)');
	for (const value of sets) {
		assert.ok(values.includes(value), `记的必须是枚举字面量,实际 ${value}`);
	}
});

test('诊断不再导出真实端点主机名 (2.8.6 P1)', () => {
	// 2.3.0–2.8.5 期间诊断里带的是 endpointHost —— 用户自建网关的域名、公司内网
	// 主机名会随一份"可以放心贴进 issue"的诊断一起公开。改为 endpointKind 枚举。
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const start = src.indexOf('private async engineSelfCheck(');
	assert.ok(start > 0, '找不到 engineSelfCheck');
	const body = src.slice(start, src.indexOf('async diagnosticsExportSource('));
	assert.ok(!/endpointHost|new URL\(/.test(body),
		'自检不得再取主机名 —— 端点只报 endpointKind 枚举');
	assert.ok(!/selfCheckError|e instanceof Error \? e\.message/.test(body),
		'自检异常的原始消息常带端点 URL,只能报一个布尔');
	assert.ok(/engineExportRow\(id, null, \{/.test(body), '失败分支也走同一个脱敏构造');
});
