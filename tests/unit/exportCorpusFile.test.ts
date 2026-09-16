/**
 * 翻译语料的导出 (2.8.7, 导出方案 P2)。
 *
 * 这份文件与诊断文件相反 —— 它**故意**含原文与译文。所以测试钉的不是"别泄露",
 * 而是**别说谎**:
 *
 *   1. spans 恒标 `re-extracted`,**匹配也不升格**;
 *   2. 四项跨页/可变输入任一已知变化 → `unverifiable`,哪怕逐项全等;
 *   3. 结构不匹配 → **写出器就地扣下译文**,记 `missing:structure-mismatch`,
 *      并且扣了几页要数得出来;
 *   4. 比对不止 id 与原文哈希 —— 类型、坐标、阅读序、栏、表格行列、翻译模式
 *      各自成一类计数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkStructure, mayAttachTranslations, BOX_TOLERANCE_PX, type UnverifiableReason } from '../../src/export/structureMatch';
import { writeCorpusJsonl, type CorpusExportSource, type CorpusPageRecord } from '../../src/export/corpusJsonl';
import type { JsonlSink, PageScopeEntry } from '../../src/export/jsonlWriter';
import type { SourceBlock } from '../../src/types/models';

const SRC = 'Photon-counting CT improves spatial resolution.';
const TGT = '光子计数 CT 提升了空间分辨率。';

function block(id: string, over: Partial<SourceBlock> = {}): SourceBlock {
	return {
		id, pageIndex: 0, order: 0, readingIndex: 0, type: 'paragraph', sourceText: SRC,
		boundingBox: { x: 10, y: 20, width: 100, height: 40 }, column: 0,
		...over
	} as SourceBlock;
}

// ---- 1. 三态判定 -------------------------------------------------------------

test('逐项全等 → matched;并写明坐标容差 (2.8.7 P2)', () => {
	const stored = [block('b0'), block('b1', { readingIndex: 1 })];
	const rebuilt = [block('b0'), block('b1', { readingIndex: 1 })];
	const check = checkStructure(stored, rebuilt);
	assert.equal(check.structureMatch, 'matched');
	assert.equal(check.blocksCompared, 2);
	assert.equal(check.boxTolerancePx, BOX_TOLERANCE_PX, '"相等"是多相等,必须写进文件');
	// 亚像素抖动不该报成结构变化。
	const jittered = [block('b0', { boundingBox: { x: 10.2, y: 20, width: 100, height: 40 } }), block('b1', { readingIndex: 1 })];
	assert.equal(checkStructure(stored, jittered).structureMatch, 'matched');
});

test('四项可变输入任一已知变化 → unverifiable,哪怕逐项全等 (2.8.7 P2)', () => {
	const same = [block('b0')];
	const reasons: UnverifiableReason[] = [
		'body-font-size-changed', 'references-state-unknown', 'prefs-changed', 'extract-path-changed'
	];
	for (const reason of reasons) {
		const check = checkStructure(same, [block('b0')], { inputsChanged: [reason] });
		assert.equal(check.structureMatch, 'unverifiable',
			`${reason}: 输入变了,全等也只是碰巧,不许写 matched`);
		assert.deepEqual(check.unverifiableReasons, [reason]);
		assert.equal(check.mismatchKinds, undefined, '不可核时不该给出分类计数 —— 那会让人以为比过了');
	}
});

test('留存结构已被淘汰或从未留存 → unverifiable (2.8.7 P2)', () => {
	for (const stored of [null, undefined, []]) {
		const check = checkStructure(stored, [block('b0')]);
		assert.equal(check.structureMatch, 'unverifiable');
		assert.deepEqual(check.unverifiableReasons, ['no-stored-structure']);
		assert.equal(check.blocksCompared, 0);
	}
});

// ---- 2. 比对哪些字段 ---------------------------------------------------------

test('比对不止 id 与原文哈希: 六类差异各自成一类 (2.8.7 P2)', () => {
	const stored = [
		block('b0'), block('b1'), block('b2'), block('b3'), block('b4'), block('b5')
	];
	const rebuilt = [
		block('b0', { type: 'heading' }),                                        // type
		block('b1', { boundingBox: { x: 40, y: 20, width: 100, height: 40 } }),  // box
		block('b2', { readingIndex: 9 }),                                        // 阅读序
		block('b3', { tableRow: 2, tableCol: 1 }),                               // 表格行列
		block('b4', { translationMode: 'preserve' }),                            // 翻译模式
		block('b5', { sourceText: `${SRC} Extra sentence.` })                    // 原文
	];
	const check = checkStructure(stored, rebuilt);
	assert.equal(check.structureMatch, 'mismatched');
	const kinds = check.mismatchKinds!;
	assert.equal(kinds.type, 1);
	assert.equal(kinds.box, 1);
	assert.equal(kinds.readingOrder, 1);
	assert.equal(kinds.tableCell, 1);
	assert.equal(kinds.translationMode, 1);
	assert.equal(kinds.text, 1);
	assert.equal(kinds.count, 6, 'count 数的是有差异的块数');
});

test('表格行与表格列各自都要比 —— 只比其中一个,错行的表就混进语料了 (2.8.7 P2)', () => {
	const rowOnly = checkStructure([block('b0', { tableRow: 0, tableCol: 3 })],
		[block('b0', { tableRow: 5, tableCol: 3 })]);
	assert.equal(rowOnly.mismatchKinds!.tableCell, 1, '只有行号变了也是差异');
	const colOnly = checkStructure([block('b0', { tableRow: 2, tableCol: 0 })],
		[block('b0', { tableRow: 2, tableCol: 4 })]);
	assert.equal(colOnly.mismatchKinds!.tableCell, 1, '只有列号变了也是差异');
});

test('换了栏算阅读序差异 —— 文字一样但被切到另一栏,语料就毁了 (2.8.7 P2)', () => {
	const check = checkStructure([block('b0', { column: 0 })], [block('b0', { column: 1 })]);
	assert.equal(check.structureMatch, 'mismatched');
	assert.equal(check.mismatchKinds!.readingOrder, 1);
});

test('缺块与多块分开数 (2.8.7 P2)', () => {
	const check = checkStructure(
		[block('b0'), block('b1'), block('b2')],
		[block('b0'), block('bX'), block('bY')]);
	assert.equal(check.mismatchKinds!.missing, 2, '留存里有、重建里没有');
	assert.equal(check.mismatchKinds!.extra, 2, '重建里多出来的');
	assert.equal(check.structureMatch, 'mismatched');
});

test('只有 matched 能贴译文 (2.8.7 P2)', () => {
	assert.equal(mayAttachTranslations({ structureMatch: 'matched', blocksCompared: 1 }), true);
	assert.equal(mayAttachTranslations({ structureMatch: 'mismatched', blocksCompared: 1 }), false);
	assert.equal(mayAttachTranslations({ structureMatch: 'unverifiable', blocksCompared: 0 }), false);
});

// ---- 3. 写出 ----------------------------------------------------------------

class MemorySink implements JsonlSink {
	lines: string[] = [];
	async append(line: string): Promise<void> {
		this.lines.push(line);
	}
	parsed(): Record<string, unknown>[] {
		return this.lines.map(l => JSON.parse(l) as Record<string, unknown>);
	}
}

function scopeOf(n: number): PageScopeEntry[] {
	return Array.from({ length: n }, (_, i) => ({ pageIndex: i, status: 'done' }));
}

function record(over: Partial<CorpusPageRecord> = {}): CorpusPageRecord {
	return {
		spans: { items: [{ str: SRC }] },
		blocks: [{ id: 'page-0-region-0', sourceText: SRC }],
		blocksSource: 're-extracted' as const,
		check: { structureMatch: 'matched', blocksCompared: 1, boxTolerancePx: BOX_TOLERANCE_PX },
		translations: [{ id: 'page-0-region-0', translatedText: TGT }],
		translationSource: 'live',
		...over
	};
}

function sourceOf(over: Partial<CorpusExportSource> = {}): CorpusExportSource {
	return {
		pluginVersion: '2.8.7',
		generatedAt: new Date(2026, 8, 8, 16, 0, 0, 0),
		scope: scopeOf(1),
		summary: () => ({ usage: { httpAttempts: 3 } }),
		readPage: () => record(),
		...over
	};
}

test('首行自我声明含原文,且 spans 政策写进文件 (2.8.7 P2)', async () => {
	const sink = new MemorySink();
	await writeCorpusJsonl(sink, sourceOf());
	const manifest = sink.parsed()[0]!;
	assert.equal(Object.keys(manifest)[0], 'CONTAINS_SOURCE_TEXT',
		'自我声明必须是第一个字段 —— 打开文件第一眼就该知道手里是什么');
	assert.equal(manifest.CONTAINS_SOURCE_TEXT, true);
	assert.equal(manifest.content, 'corpus');
	assert.equal(manifest.spansPolicy, 're-extracted-at-export');
	assert.match(String(manifest.note), /不等于这就是翻译当时的 spans/);
	assert.deepEqual(sink.parsed().map(r => r.kind), ['manifest', 'summary', 'page', 'result']);
});

test('spans 恒标 re-extracted —— 匹配也不升格 (2.8.7 P2)', async () => {
	for (const match of ['matched', 'mismatched', 'unverifiable'] as const) {
		const sink = new MemorySink();
		await writeCorpusJsonl(sink, sourceOf({
			readPage: () => record({ check: { structureMatch: match, blocksCompared: 1 } })
		}));
		const page = sink.parsed().find(r => r.kind === 'page')!;
		const availability = page.availability as Record<string, string>;
		assert.equal(availability.spans, 're-extracted',
			`${match}: spans 没被留存过,任何情况下都不能声称它是当时那一份`);
	}
});

test('结构不匹配: 写出器就地扣下译文,并数得出来 (2.8.7 P2)', async () => {
	for (const match of ['mismatched', 'unverifiable'] as const) {
		const sink = new MemorySink();
		// 数据源**给了**译文 —— 把关的是写出器,不是数据源的自觉。
		const result = await writeCorpusJsonl(sink, sourceOf({
			readPage: () => record({ check: { structureMatch: match, blocksCompared: 1 } })
		}));
		const page = sink.parsed().find(r => r.kind === 'page')!;
		assert.equal((page.availability as Record<string, string>).translations, 'missing:structure-mismatch');
		assert.ok(!('translations' in page), `${match}: 照 id 贴译文会产出"看起来对齐、其实错位"的语料,比缺失更糟`);
		assert.ok(!JSON.stringify(page).includes(TGT), '译文一个字都不该漏进去');
		assert.equal(result.translationsWithheld, 1, '扣了几页必须数得出来');
		assert.equal(result.translationsAttached, 0);
		// 但结构与 spans 本身是真实的,照样给。
		assert.ok(page.spans, '缺的只有译文');
		assert.ok(page.blocks);
		assert.equal((sink.parsed().at(-1)!).translationsWithheld, 1);
	}
});

test('匹配的页才带译文,并记明来路 (2.8.7 P2)', async () => {
	const sink = new MemorySink();
	const result = await writeCorpusJsonl(sink, sourceOf({
		scope: scopeOf(2),
		readPage: (pageIndex) => record(pageIndex === 0
			? { translationSource: 'live' }
			: { translationSource: 'restored-from-cache' })
	}));
	const pages = sink.parsed().filter(r => r.kind === 'page');
	assert.equal((pages[0]!.availability as Record<string, string>).translations, 'live');
	assert.equal((pages[1]!.availability as Record<string, string>).translations, 'restored-from-cache',
		'从页缓存复原的译文要与内存里的分开标');
	assert.ok(JSON.stringify(pages[0]).includes(TGT));
	assert.equal(result.translationsAttached, 2);
	assert.equal(result.translationsWithheld, 0);
});

test('匹配但没译文: 记具体原因,不冒充结构不匹配 (2.8.7 P2)', async () => {
	const sink = new MemorySink();
	const result = await writeCorpusJsonl(sink, sourceOf({
		readPage: () => record({ translations: null, translationsMissing: 'missing:cache-miss' })
	}));
	const page = sink.parsed().find(r => r.kind === 'page')!;
	assert.equal((page.availability as Record<string, string>).translations, 'missing:cache-miss');
	assert.equal(result.translationsWithheld, 0, '本来就没有,不算被扣下');
});

test('三态计数进 result —— 任何一页的任何一维缺失都数得出来 (2.8.7 P2)', async () => {
	const sink = new MemorySink();
	const states = ['matched', 'mismatched', 'unverifiable', 'matched'] as const;
	const result = await writeCorpusJsonl(sink, sourceOf({
		scope: scopeOf(4),
		readPage: (pageIndex) => record({
			check: { structureMatch: states[pageIndex]!, blocksCompared: 1 }
		})
	}));
	assert.deepEqual(result.structureMatch, { 'as-translated': 0, matched: 2, mismatched: 1, unverifiable: 1 });
	assert.deepEqual((sink.parsed().at(-1)!).structureMatch,
		{ 'as-translated': 0, matched: 2, mismatched: 1, unverifiable: 1 });
});

test('探针未采样标 not-sampled,且不阻止导出 (2.8.7 P2)', async () => {
	const sink = new MemorySink();
	const result = await writeCorpusJsonl(sink, sourceOf({ readPage: () => record({ probe: undefined }) }));
	const page = sink.parsed().find(r => r.kind === 'page')!;
	assert.equal((page.availability as Record<string, string>).probe, 'missing:not-sampled');
	assert.equal(result.pagesWritten, 1, '调试日志没开只是少一份探针,不该拦住语料导出');
});

test('某页读失败照样出一行并被数出来 (2.8.7 P2)', async () => {
	const sink = new MemorySink();
	const result = await writeCorpusJsonl(sink, sourceOf({
		scope: scopeOf(3),
		readPage: (pageIndex) => {
			if (pageIndex === 1) {
				throw new Error('/Users/someone/Papers/unpublished.pdf is gone');
			}
			return record();
		}
	}));
	const pages = sink.parsed().filter(r => r.kind === 'page');
	assert.equal(pages.length, 3, '不能静默漏页');
	assert.equal((pages[1]!.availability as Record<string, string>).spans, 'missing:read-failed');
	assert.equal(result.pageReadFailures, 1);
	assert.ok(!JSON.stringify(pages[1]).includes('unpublished'), '异常原始消息不进文件');
});

test('语料文件同样遵守 P1 的骨架: 末行 result、逐行追加、拒绝空版本 (2.8.7 P2)', async () => {
	const sink = new MemorySink();
	await writeCorpusJsonl(sink, sourceOf({ scope: scopeOf(2) }));
	assert.equal(sink.lines.length, 5, 'manifest + summary + 2 页 + result');
	for (const line of sink.lines) {
		assert.equal(line.split('\n').length, 2, '一行一个 JSON');
	}
	assert.equal((sink.parsed().at(-1)!).complete, true);
	await assert.rejects(() => writeCorpusJsonl(new MemorySink(), sourceOf({ pluginVersion: '' })));
});

// ---- 2.8.12 真机修正: 内存原件优先 ------------------------------------------

test('内存里的原件带译文,且不需要"核对" (2.8.12 真机修正)', async () => {
	const sink = new MemorySink();
	const result = await writeCorpusJsonl(sink, sourceOf({
		readPage: () => record({
			blocksSource: 'live',
			check: { structureMatch: 'as-translated', blocksCompared: 1 }
		})
	}));
	const page = sink.parsed().find(r => r.kind === 'page')!;
	assert.equal((page.availability as Record<string, string>).blocks, 'live',
		'如实报来路: 这不是重建的近似,是翻译当时用的那份');
	assert.equal(page.structureMatch, 'as-translated');
	assert.ok(JSON.stringify(page).includes(TGT),
		'原件与译文同源同 id,对齐是定义上成立的 —— 不该被"结构不匹配"扣下');
	assert.equal(result.translationsAttached, 1);
	assert.equal(result.translationsWithheld, 0);
	assert.deepEqual(result.blocksBySource, { live: 1, 're-extracted': 0, archived: 0, missing: 0 });
});

test('一块都没重建出来: 标 missing,不拿空数组冒充"重解析过了" (2.8.12 真机修正)', async () => {
	// 真机上 39 页全是这种: 抽取路径是 text-layer,而文本层只对渲染着的页存在,
	// 导出时早翻过去了 —— 重解析拿到 0 块。旧版把它标成 're-extracted' + 空数组,
	// 读的人会以为"这页真的没内容"。
	const sink = new MemorySink();
	const result = await writeCorpusJsonl(sink, sourceOf({
		readPage: () => record({
			blocks: [],
			blocksSource: 're-extracted',
			blocksMissing: 'missing:not-rendered',
			check: {
				structureMatch: 'unverifiable', blocksCompared: 0,
				unverifiableReasons: ['re-extraction-unavailable']
			},
			translations: null,
			translationsMissing: 'missing:evicted'
		})
	}));
	const page = sink.parsed().find(r => r.kind === 'page')!;
	assert.equal((page.availability as Record<string, string>).blocks, 'missing:not-rendered');
	assert.deepEqual(page.unverifiableReasons, ['re-extraction-unavailable']);
	assert.equal((page.availability as Record<string, string>).translations, 'missing:evicted');
	assert.deepEqual(result.blocksBySource, { live: 0, 're-extracted': 0, archived: 0, missing: 1 });
});

test('result 里数得出这份语料有多少是原件 (2.8.12 真机修正)', async () => {
	const sink = new MemorySink();
	const kinds = ['live', 're-extracted', 'missing', 'live'] as const;
	const result = await writeCorpusJsonl(sink, sourceOf({
		scope: scopeOf(4),
		readPage: (pageIndex) => {
			const kind = kinds[pageIndex]!;
			if (kind === 'live') {
				return record({ blocksSource: 'live', check: { structureMatch: 'as-translated', blocksCompared: 1 } });
			}
			if (kind === 'missing') {
				return record({
					blocks: [], blocksSource: 're-extracted', blocksMissing: 'missing:not-rendered',
					check: { structureMatch: 'unverifiable', blocksCompared: 0 }, translations: null
				});
			}
			return record({ check: { structureMatch: 'unverifiable', blocksCompared: 0 }, translations: null });
		}
	}));
	assert.deepEqual(result.blocksBySource, { live: 2, 're-extracted': 1, archived: 0, missing: 1 },
		'一眼看出多少是原件、多少是重建、多少压根没有');
	assert.deepEqual((sink.parsed().at(-1)!).blocksBySource, { live: 2, 're-extracted': 1, archived: 0, missing: 1 });
	assert.equal(result.structureMatch['as-translated'], 2);
});

test('manifest 说清 spans 与重解析都依赖文本层 (2.8.12 真机修正)', async () => {
	const sink = new MemorySink();
	await writeCorpusJsonl(sink, sourceOf());
	const note = String(sink.parsed()[0]!.note);
	assert.match(note, /文本层只对当前渲染着的页存在/,
		'读的人要知道 missing:not-rendered 是怎么来的,不然会以为文档半边是空的');
	assert.match(note, /as-translated/, 'as-translated 是最强的一档,要在说明里点出来');
});

// ---- 结构闸 ------------------------------------------------------------------

test('导出期间不发翻译请求,不碰缓存写入 (结构性回归闸, 2.8.7)', () => {
	for (const file of ['src/export/corpusJsonl.ts', 'src/export/structureMatch.ts', 'src/export/jsonlWriter.ts']) {
		const src = readFileSync(join(process.cwd(), file), 'utf8');
		assert.ok(!/translateRequest|httpJSON|fetch\(|writeCache|writePage\(/.test(src),
			`${file}: 导出只读不写,更不发请求`);
	}
	// 扣译文这条闸必须在写出器里 —— 交给数据源自觉,迟早有一条路径漏掉。
	const corpus = readFileSync(join(process.cwd(), 'src/export/corpusJsonl.ts'), 'utf8');
	assert.ok(/const allowed = mayAttachTranslations\(record\.check\);/.test(corpus));
	assert.ok(/\.\.\.\(attach \? \{ translations: record\.translations \} : \{\}\)/.test(corpus),
		'译文只在 attach 为真时才进文件');
});

test('宿主接线: 内存里有原件就用原件,没有才重解析 (结构性回归闸, 2.8.12 真机修正)', () => {
	const src = readFileSync(join(process.cwd(), 'src/reader/readerSession.ts'), 'utf8');
	const start = src.indexOf('readPage: async (pageIndex: number): Promise<CorpusPageRecord>');
	assert.ok(start > 0, '找不到语料的 readPage');
	const body = src.slice(start, src.indexOf('pin: (pageIndex: number) => { this.exportPins.add(pageIndex); }', start));

	// 1. 最短路径优先: 没被淘汰的页,内存里那份就是翻译当时用的结构。
	const live = body.indexOf('if (state && state.blocks.length) {');
	const reExtract = body.indexOf('await this.extractor.extractPage(pageIndex)');
	assert.ok(live > 0 && live < reExtract,
		'内存里有原件就直接用 —— 重解析是退路,不是首选');
	assert.ok(/blocks: JSON\.parse\(JSON\.stringify\(state\.blocks\)\) as SourceBlock\[\],\s*\n\s*blocksSource: 'live',\s*\n\s*check: \{ structureMatch: 'as-translated'/.test(body),
		'原件要标 as-translated: 它就是那份结构,不是"重建得一样"');

	// 2. 退路仍然走与翻译相同的流水线,并且先查四项可变输入。
	assert.ok(/const rebuilt = await this\.extractor\.extractPage\(pageIndex\);/.test(body),
		'重解析必须直接调 extractor.extractPage —— 不能另写一份"检查用的解析"');
	assert.ok(/const inputsChanged = changedExtractInputs\(before, \{/.test(body)
		&& /checkStructure\(null, rebuilt, \{ inputsChanged \}\)/.test(body),
		'四项可变输入必须先查,而且查出来的结果要真的喂给 checkStructure;'
		+ '被卸过的页没有留存结构可比,对照侧只能传 null');

	// 3. 一块都没重建出来 ≠ 这页没内容。
	assert.ok(/if \(!rebuilt\.length\) \{/.test(body)
		&& /blocksMissing: 'missing:not-rendered'/.test(body)
		&& /unverifiableReasons: \['re-extraction-unavailable'\]/.test(body),
		'重解析拿不到块要如实说是"文本层不在",不能拿空数组冒充"重解析过了,这页就是空的"');

	assert.ok(/spansMissing: 'missing:not-rendered'/.test(body),
		'没渲染过的页拿不到文本层 —— 不拿重建结构冒充 spans');
	assert.ok(!/translateRequest|retranslate|ensurePage/.test(body), '导出绝不发起翻译');

	// 译文来路三分,缺失原因分开说。
	const translations = src.slice(src.indexOf('private async corpusTranslations('), src.indexOf('private pageSpans('));
	assert.ok(/translationSource: 'live'/.test(translations)
		&& /translationSource: 'restored-from-cache'/.test(translations));
	assert.ok(/state\.evicted \? 'missing:evicted' : 'missing:cache-miss'/.test(translations),
		'"被卸了且缓存没有"与"从没缓存过"是两回事');
	assert.ok(/'missing:never-processed'/.test(translations));
});
