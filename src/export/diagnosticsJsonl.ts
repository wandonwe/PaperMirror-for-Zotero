/**
 * 诊断文件的写出 (2.8.6, 导出方案 P1)。
 *
 * 一次导出 = **一个 JSONL 纯文本文件**,一行一个 JSON 对象:
 *
 * ```
 * {"kind":"manifest", …}   ← 第 1 行: 版本、时间、冻结的页清单与统计
 * {"kind":"summary",  …}   ← 第 2 行: 会话级汇总(引擎 / usage / render / cacheWrites)
 * {"kind":"page","page":1, …}
 * …
 * {"kind":"result",   …}   ← 最后一行: 实际写出的页数与失败计数
 * ```
 *
 * 写法上的公共规矩(逐行追加、result 行的含义、阶段化报错、逐页短时 pin)在
 * `jsonlWriter.ts`,与语料导出共用。这里只管**诊断文件的内容**。
 *
 * **某一页读失败不终止导出,但必须被数出来**:那页照样出一行,`availability` 标
 * `missing:read-failed`,并计入 `result.pageReadFailures`。不能静默漏页 —— 导出的
 * 价值全在"这就是当时的全貌",少一页而不说,比导出失败更坏。
 */

import {
	LineWriter, readPinned, requireVersion, sortedScope, statusTally,
	type JsonlSink, type PageScopeEntry
} from './jsonlWriter';

// 既有调用方(与 P1 的测试)按这个模块名引这几个符号 —— 继续从这里导出。
export { ExportStageError, type ExportStage, type JsonlSink, type PageScopeEntry } from './jsonlWriter';

export interface DiagnosticsExportSource {
	/** 运行中的插件版本。空值直接拒绝导出(见 prepare 阶段)。 */
	pluginVersion: string;
	generatedAt: Date;
	/** 冻结的页清单 —— 导出期间不再重新枚举。 */
	scope: PageScopeEntry[];
	/** 会话级汇总。 */
	summary(): unknown;
	/** 读一页的诊断记录。抛错不终止导出,但会被记进这一页与 result。 */
	readPage(pageIndex: number): unknown;
	/** 逐页短时保护(复用 2.8.3 的 inUse 闸),读完立即释放。 */
	pin?(pageIndex: number): void;
	unpin?(pageIndex: number): void;
	onProgress?(done: number, total: number): void;
}

export interface ExportResult {
	pagesWritten: number;
	pageReadFailures: number;
	linesWritten: number;
}

/**
 * 写出整份诊断文件。**逐行 append,绝不把整份内容拼成一个字符串。**
 *
 * 失败一律抛 `ExportStageError`,带上阶段 —— 调用方据此提示"读取第 N 页失败"
 * 而不是笼统的"导出失败",更不能在失败后提示成功。
 */
export async function writeDiagnosticsJsonl(sink: JsonlSink, source: DiagnosticsExportSource): Promise<ExportResult> {
	const version = requireVersion(source.pluginVersion);
	const scope = sortedScope(source.scope);
	const writer = new LineWriter(sink);

	await writer.write('prepare', {
		kind: 'manifest',
		plugin: 'PaperMirror',
		pluginVersion: version,
		content: 'diagnostics',
		containsSourceText: false,
		generatedAt: source.generatedAt.toISOString(),
		// 逐页快照,不谎称整篇原子 (方案 §4)。
		snapshotPolicy: 'page-at-a-time',
		scope: {
			pagesTotal: scope.length,
			byStatus: statusTally(scope),
			evicted: scope.filter(p => p.evicted === true).length,
			pages: scope.map(p => p.pageIndex + 1)
		}
	});

	await writer.write('summary', { kind: 'summary', ...(source.summary() as object ?? {}) });

	let pagesWritten = 0;
	let pageReadFailures = 0;
	for (const entry of scope) {
		const read = await readPinned(entry.pageIndex, source);
		if (!read.ok) {
			pageReadFailures++;
		}
		await writer.write('write-page', read.ok
			? {
				kind: 'page',
				page: entry.pageIndex + 1,
				availability: { pageRecord: 'live' },
				record: read.record
			}
			: {
				kind: 'page',
				page: entry.pageIndex + 1,
				status: entry.status,
				availability: { pageRecord: 'missing:read-failed' },
				// 2.8.15: 只是异常的**种类**(枚举 code / 类名),不含任何消息内容。
				// 真机连着两次导出各有一页读失败,旧文件只说"失败了一页",
				// 连是抛错、超时还是类型错都看不出来。
				readFailureKind: read.kind
			});
		pagesWritten++;
		source.onProgress?.(pagesWritten, scope.length);
	}

	await writer.write('finalize', {
		kind: 'result',
		pagesWritten,
		pageReadFailures,
		complete: true
	});

	return { pagesWritten, pageReadFailures, linesWritten: writer.linesWritten };
}
