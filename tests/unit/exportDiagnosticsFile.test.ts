/**
 * 诊断文件的导出 (2.8.6, 导出方案 P1)。
 *
 * 钉住四类不变量:
 *   1. **命名**: 版本来自运行中的插件、时间带毫秒与时区、重名追加序号绝不覆盖、
 *      文件名里没有论文标题;
 *   2. **端点脱敏**: 只出枚举,域名/IP/端口/路径一个字符都不出现,也不出哈希;
 *   3. **JSONL 形状**: 首行 manifest、次行 summary、末行 result,一行一个 JSON,
 *      逐行追加(不把整份拼成一个字符串);
 *   4. **不静默漏页**: 读失败的页照样出一行并被数出来;失败必须报得出阶段,
 *      且失败的文件没有 result 行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportFileName, formatExportStamp } from '../../src/export/exportNaming';
import { classifyEndpoint, engineExportRow } from '../../src/export/endpointKind';
import {
	writeDiagnosticsJsonl, ExportStageError,
	type JsonlSink, type DiagnosticsExportSource, type PageScopeEntry
} from '../../src/export/diagnosticsJsonl';

// ---- 1. 命名 ----------------------------------------------------------------

test('时间戳带日期、时分秒、毫秒与时区偏移 (2.8.6 P1)', () => {
	const stamp = formatExportStamp(new Date(2026, 8, 8, 15, 30, 42, 287));
	assert.match(stamp, /^20260908_153042_287[+-]\d{4}$/,
		`跨时区提 issue 时"下午三点半"没有意义,偏移必须在里面,实际 ${stamp}`);
	// 个位数月/日/时要补零,否则同一天的两份文件排序会乱。
	assert.match(formatExportStamp(new Date(2026, 0, 2, 3, 4, 5, 6)), /^20260102_030405_006[+-]\d{4}$/);
});

test('文件名: 版本 + 内容 + 时间,不含论文标题 (2.8.6 P1)', () => {
	const at = new Date(2026, 8, 8, 15, 30, 42, 287);
	const name = exportFileName({ kind: 'diagnostics', version: '2.8.6', at });
	assert.match(name, /^PaperMirror_v2\.8\.6_diagnostics_20260908_153042_287[+-]\d{4}\.jsonl$/);
	// 文件名是别人第一眼看到的东西 —— 未发表稿件的标题绝不能出现在这里。
	assert.ok(!/[一-鿿]/.test(name), '文件名不含任何文档内容');
	assert.match(exportFileName({ kind: 'corpus', version: '2.8.6', at }), /_corpus_/);
});

test('重名追加序号,绝不覆盖 (2.8.6 P1)', () => {
	const at = new Date(2026, 8, 8, 15, 30, 42, 287);
	const first = exportFileName({ kind: 'diagnostics', version: '2.8.6', at });
	const taken = new Set([first]);
	const second = exportFileName({ kind: 'diagnostics', version: '2.8.6', at, taken });
	assert.notEqual(second, first, '同一毫秒内连点两次导出不该冲掉上一份');
	assert.match(second, /_2\.jsonl$/);
	taken.add(second);
	assert.match(exportFileName({ kind: 'diagnostics', version: '2.8.6', at, taken }), /_3\.jsonl$/);
});

test('版本里的路径分隔符与空白被清掉,空版本回落 unknown (2.8.6 P1)', () => {
	const at = new Date(2026, 8, 8, 15, 30, 42, 287);
	const name = exportFileName({ kind: 'diagnostics', version: '2.8.6/../../etc', at });
	assert.ok(!name.includes('/'), '版本号进文件名前必须消毒 —— 它来自外部输入');
	assert.match(exportFileName({ kind: 'diagnostics', version: '   ', at }), /_vunknown_/);
});

// ---- 2. 端点脱敏 ------------------------------------------------------------

const SECRET_HOST = 'gateway.internal.acme-pharma.example';

test('端点只出枚举: 域名、IP、端口、路径一个字符都不出现 (2.8.6 P1)', () => {
	const cases: [string, string | undefined, string][] = [
		['', 'https://api.openai.com', 'official'],
		['https://api.openai.com', 'https://api.openai.com', 'official'],
		['https://api.openai.com/', 'https://api.openai.com', 'official'],   // 尾斜杠不该判成 custom
		[`https://${SECRET_HOST}:8443/v1`, 'https://api.openai.com', 'custom'],
		['http://localhost:11434', 'https://api.openai.com', 'local'],
		['http://127.0.0.1:8080', undefined, 'local'],
		['http://[::1]:8080', undefined, 'local'],
		['not a url', 'https://api.openai.com', 'invalid'],
		['', 'http://localhost:11434', 'local']                              // Ollama 默认端点就是本机
	];
	for (const [configured, fallback, expected] of cases) {
		const kind = classifyEndpoint(configured, fallback);
		assert.equal(kind, expected, `${configured || '(空)'} → ${expected}`);
	}
	const row = engineExportRow('openai', { apiBaseURL: `https://${SECRET_HOST}:8443/v1`, model: 'gpt-4o' },
		{ defaultBaseURL: 'https://api.openai.com', keyConfigured: true, requiresKey: true });
	const json = JSON.stringify(row);
	assert.ok(!json.includes(SECRET_HOST), '自建网关的域名绝不能进诊断');
	assert.ok(!json.includes('8443') && !json.includes('/v1'), '端口与路径同样不导出');
	assert.equal(row.endpointKind, 'custom');
	assert.equal(row.customEndpoint, true);
	assert.equal(row.keyConfigured, true, '只报"配没配",不报密钥本身');
	assert.ok(!/sk-|key/i.test(json.replace(/keyConfigured|requiresKey/g, '')), '不得出现密钥字样');
});

test('自检失败只报一个布尔 —— 原始异常消息可能带端点 (2.8.6 P1)', () => {
	const row = engineExportRow('ollama', null, { keyConfigured: false, requiresKey: false });
	assert.equal(row.endpointKind, 'unknown');
	assert.equal(row.selfCheckFailed, true);
	assert.ok(!JSON.stringify(row).includes('http'), '连协议头都不该出现');
});

// ---- 3./4. JSONL 形状与漏页 --------------------------------------------------

class MemorySink implements JsonlSink {
	lines: string[] = [];
	failAt = -1;
	async append(line: string): Promise<void> {
		if (this.lines.length === this.failAt) {
			throw new Error('disk full');
		}
		assert.ok(line.endsWith('\n'), '每次 append 必须是完整的一行');
		this.lines.push(line);
	}
	parsed(): Record<string, unknown>[] {
		return this.lines.map(l => JSON.parse(l) as Record<string, unknown>);
	}
}

function scopeOf(n: number, over: Partial<PageScopeEntry> = {}): PageScopeEntry[] {
	return Array.from({ length: n }, (_, i) => ({ pageIndex: i, status: 'done', ...over }));
}

function sourceOf(over: Partial<DiagnosticsExportSource> = {}): DiagnosticsExportSource {
	return {
		pluginVersion: '2.8.6',
		generatedAt: new Date(2026, 8, 8, 15, 30, 42, 287),
		scope: scopeOf(3),
		summary: () => ({ usage: { httpAttempts: 7 } }),
		readPage: (pageIndex) => ({ page: pageIndex + 1, blocks: [], blockSource: 'live' }),
		...over
	};
}

test('首行 manifest、次行 summary、末行 result,页按序在中间 (2.8.6 P1)', async () => {
	const sink = new MemorySink();
	const result = await writeDiagnosticsJsonl(sink, sourceOf());
	const rows = sink.parsed();
	assert.deepEqual(rows.map(r => r.kind), ['manifest', 'summary', 'page', 'page', 'page', 'result']);
	assert.equal(rows[0]!.pluginVersion, '2.8.6');
	assert.equal(rows[0]!.containsSourceText, false);
	assert.equal(rows[0]!.snapshotPolicy, 'page-at-a-time', '逐页快照,不谎称整篇原子');
	assert.deepEqual(rows.filter(r => r.kind === 'page').map(r => r.page), [1, 2, 3]);
	assert.equal(result.pagesWritten, 3);
	assert.equal(result.linesWritten, sink.lines.length);
	// 逐行 append: 6 行就该有 6 次调用,不能先拼成一整份再写。
	assert.equal(sink.lines.length, 6);
});

test('一行一个 JSON,行内绝不出现真实换行 (2.8.6 P1)', async () => {
	const sink = new MemorySink();
	await writeDiagnosticsJsonl(sink, sourceOf({
		readPage: () => ({ note: 'line one\nline two\r\nline three' })
	}));
	for (const line of sink.lines) {
		assert.equal(line.split('\n').length, 2, '每次 append 恰好一行 + 行尾换行');
		assert.doesNotThrow(() => JSON.parse(line));
	}
});

test('没有 result 行 = 这份文件是半份 (2.8.6 P1)', async () => {
	const sink = new MemorySink();
	sink.failAt = 4; // 第 3 页写不下去了
	await assert.rejects(
		() => writeDiagnosticsJsonl(sink, sourceOf()),
		(e: unknown) => {
			assert.ok(e instanceof ExportStageError);
			assert.equal(e.stage, 'write-page', '失败必须报得出阶段,不能只说"导出失败"');
			return true;
		});
	assert.ok(!sink.parsed().some(r => r.kind === 'result'),
		'半份文件不能带完成标记 —— 读的人要一眼看得出它被截断了');
	// 但已经写出去的行仍然是可解析的 —— 这正是选 JSONL 而不是大数组的理由。
	assert.deepEqual(sink.parsed().map(r => r.kind), ['manifest', 'summary', 'page', 'page']);
});

test('某页读失败不终止导出,但必须被数出来 (2.8.6 P1)', async () => {
	const sink = new MemorySink();
	const result = await writeDiagnosticsJsonl(sink, sourceOf({
		scope: scopeOf(4),
		readPage: (pageIndex) => {
			if (pageIndex === 1) {
				throw new Error('secret path /Users/someone/Papers/unpublished.pdf');
			}
			return { page: pageIndex + 1 };
		}
	}));
	const rows = sink.parsed();
	const pages = rows.filter(r => r.kind === 'page');
	assert.equal(pages.length, 4, '读失败的页照样出一行 —— 不能静默漏页');
	assert.deepEqual((pages[1]!.availability as Record<string, string>), { pageRecord: 'missing:read-failed' });
	assert.equal(result.pageReadFailures, 1);
	assert.equal((rows.at(-1)!).pageReadFailures, 1, 'result 行要能数出失败页');
	assert.ok(!JSON.stringify(rows).includes('unpublished'),
		'异常原始消息可能带路径或内容 —— 只留"这页读失败了"这个事实');
});

test('逐页短时保护: 读完立刻释放,抛错也释放 (2.8.6 P1)', async () => {
	const events: string[] = [];
	await writeDiagnosticsJsonl(new MemorySink(), sourceOf({
		scope: scopeOf(3),
		pin: (p) => events.push(`pin${p}`),
		unpin: (p) => events.push(`unpin${p}`),
		readPage: (p) => {
			events.push(`read${p}`);
			if (p === 1) {
				throw new Error('boom');
			}
			return {};
		}
	}));
	assert.deepEqual(events,
		['pin0', 'read0', 'unpin0', 'pin1', 'read1', 'unpin1', 'pin2', 'read2', 'unpin2'],
		'一次只 pin 住一页,读完(哪怕抛错)立刻释放 —— 不在整个导出期间挂着');
});

test('拿不到运行中的版本就拒绝导出 (2.8.6 P1)', async () => {
	const sink = new MemorySink();
	await assert.rejects(
		() => writeDiagnosticsJsonl(sink, sourceOf({ pluginVersion: '  ' })),
		(e: unknown) => e instanceof ExportStageError && e.stage === 'prepare');
	assert.equal(sink.lines.length, 0,
		'版本写错的诊断比没有诊断更坏 —— 它会把排障引到另一份代码上,一个字节都不该写');
});

test('冻结的页清单进 manifest: 总数、状态分布、已卸页数 (2.8.6 P1)', async () => {
	const sink = new MemorySink();
	await writeDiagnosticsJsonl(sink, sourceOf({
		scope: [
			{ pageIndex: 4, status: 'done', evicted: true },
			{ pageIndex: 0, status: 'done' },
			{ pageIndex: 2, status: 'error' }
		]
	}));
	const manifest = sink.parsed()[0]!;
	const scope = manifest.scope as Record<string, unknown>;
	assert.equal(scope.pagesTotal, 3);
	assert.deepEqual(scope.byStatus, { done: 2, error: 1 });
	assert.equal(scope.evicted, 1);
	assert.deepEqual(scope.pages, [1, 3, 5], '页号按序、1 基 —— 导出范围必须写进文件');
	assert.deepEqual(sink.parsed().filter(r => r.kind === 'page').map(r => r.page), [1, 3, 5],
		'页行顺序与清单一致,不受传入顺序影响');
});

// ---- 结构闸 ------------------------------------------------------------------

test('导出模块不碰抽取/结构/排版,也不发请求 (结构性回归闸, 2.8.6)', () => {
	for (const file of ['src/export/diagnosticsJsonl.ts', 'src/export/endpointKind.ts', 'src/export/exportNaming.ts']) {
		const src = readFileSync(join(process.cwd(), file), 'utf8');
		assert.ok(!/from '\.\.\/(reader|layout|translation)\//.test(src),
			`${file}: 导出路径不得依赖抽取/排版/翻译模块 —— 它只搬运已经算好的数据`);
		assert.ok(!/translateRequest|httpJSON|fetch\(/.test(src),
			`${file}: 导出期间不发任何请求`);
	}
});

// ---- 与一次性诊断同源 --------------------------------------------------------

test('逐页导出与整份导出走同一条口径 (2.8.6 P1)', async () => {
	const { TranslationManager } = await import('../../src/translation/translationManager');
	const cache = new Map<number, { id: string; translatedText: string }[]>();
	const manager = new TranslationManager({
		extractPage: async (pageIndex) => Array.from({ length: 2 }, (_, i) => ({
			id: `page-${pageIndex}-block-${i}`, pageIndex, order: i,
			type: 'paragraph' as const, sourceText: `Source ${i} on page ${pageIndex}.`
		})),
		translateRequest: async (request) => ({
			translations: request.blocks.map(b => ({ id: b.id, translatedText: '这是完整的中文译文段落内容。' }))
		}),
		readCache: async (pageIndex) => cache.get(pageIndex) ?? null,
		writeCache: async (pageIndex, _b, translations) => { cache.set(pageIndex, translations); },
		getLanguages: () => ({ source: 'en', target: 'zh-CN' }),
		getDocumentTitle: () => 'Doc',
		getGlossary: () => [],
		useContext: () => true,
		pageCount: () => 3
	}, { onPageUpdate: () => {} }, { prefetch: false, delayFn: () => Promise.resolve() });
	await manager.ensurePage(0, 5);
	await manager.ensurePage(1, 5);

	const whole = (manager.exportDiagnostics() as { pages: Record<string, unknown>[] }).pages;
	// 同一份数据两条取法必须逐字节相同 —— 否则"一次性诊断"与"导出的文件"会
	// 各说各话,排障时没人知道该信哪份。
	assert.deepEqual(manager.exportPageDiagnostics(0), whole[0]);
	assert.deepEqual(manager.exportPageDiagnostics(1), whole[1]);
	assert.equal(manager.exportPageDiagnostics(7), null, '没有的页返回 null,由导出器记成缺失');
	assert.deepEqual(manager.exportScope().map(p => p.pageIndex), [0, 1]);
	assert.ok(manager.exportScope().every(p => !('blocks' in p)), '范围清单只带状态,不带内容');
	manager.dispose();
});

test('会话汇总不重复整份页数据 (2.8.6 P1, 结构性回归闸)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const start = src.indexOf('async diagnosticsExportSource(');
	assert.ok(start > 0, '找不到 diagnosticsExportSource');
	const body = src.slice(start, src.indexOf('private async copyDiagnostics('));
	assert.ok(/const \{ pages: _pages, \.\.\.session \} = diag;/.test(body),
		'summary 行必须剥掉 pages —— 否则整份文档的页数据出现两遍,文件大一倍且两处口径可能不一致');
	assert.ok(/pin: \(pageIndex: number\) => \{ this\.exportPins\.add\(pageIndex\); \}/.test(body)
		&& /unpin: \(pageIndex: number\) => \{ this\.exportPins\.delete\(pageIndex\); \}/.test(body),
		'逐页短时保护必须接上');
	assert.ok(/placementProbe.*\?\? 'not-sampled'/.test(body),
		'探针没采样要如实说,不能冒充"这页没问题"');
	assert.ok(/this\.exportPins\.has\(pageIndex\)/.test(src),
		'pin 住的页必须被 isPageInUse 认作在用 —— 否则保护是假的');
	// 全局暂停淘汰是被否决的做法(长文档导出内存一路上涨)。
	assert.ok(!/pauseEviction|suspendEviction|evictionPaused/.test(src),
		'不得引入全局暂停淘汰的开关');
});
