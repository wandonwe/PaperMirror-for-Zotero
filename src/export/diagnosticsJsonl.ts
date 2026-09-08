/**
 * 诊断文件的写出 (2.8.6, 导出方案 P1)。
 *
 * 一次导出 = **一个 JSONL 纯文本文件**,一行一个 JSON 对象:
 *
 * ```
 * {"kind":"manifest", …}   ← 第 1 行: 版本、时间、冻结的页清单与统计
 * {"kind":"summary",  …}   ← 第 2 行: 会话级汇总(引擎 / usage / render / cacheWrites)
 * {"kind":"page","page":1, …}
 * {"kind":"page","page":2, …}
 * …
 * {"kind":"result",   …}   ← 最后一行: 实际写出的页数与失败计数
 * ```
 *
 * 为什么不是一个大 JSON 数组:
 *
 *   - **逐页读、逐行追加写**,整篇文档不必同时在内存里 —— 这正是 2.8.3 内存淘汰
 *     的同一条纪律,导出不该把刚省下来的内存又吃回去;
 *   - 写到一半崩掉,**前面的行仍然可读**;大数组缺个 `]` 就整份废掉;
 *   - 机读按行 `JSON.parse` 即可。
 *
 * ## 两条设计要点
 *
 * **1. `result` 行是"这份文件写完了"的唯一凭据。** manifest 在第一行,写它的时候
 * 后面会不会失败还不知道 —— 所以完成情况只能记在**最后**。没有 `result` 行的文件
 * 就是半份,读的人一眼看得出,不会把截断的文件当成完整证据。
 *
 * **2. 某一页读失败不终止导出,但必须被数出来。** 那页照样出一行,`availability`
 * 标 `missing:read-failed`,并计入 `result.pageReadFailures`。**不能静默漏页** ——
 * 导出的价值全在"这就是当时的全貌",少一页而不说,比导出失败更坏。
 */

/** 失败发生在哪一步 —— 报错必须说得出阶段,不能只说"导出失败"。 */
export type ExportStage = 'prepare' | 'summary' | 'write-page' | 'finalize';

export class ExportStageError extends Error {
	readonly stage: ExportStage;
	constructor(stage: ExportStage, message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = 'ExportStageError';
		this.stage = stage;
		if (options && 'cause' in options) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

/** 只要能一行一行追加就行 —— 平台细节(IOUtils / 保存对话框)留给 P3。 */
export interface JsonlSink {
	append(line: string): Promise<void>;
}

/** 冻结时刻的一页(浅拷贝,不持有页内容)。 */
export interface PageScopeEntry {
	pageIndex: number;
	status: string;
	/** 完整内容已被 2.8.3 的冷页淘汰卸掉 —— 逐块明细走摘要。 */
	evicted?: boolean;
}

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

function line(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) {
		throw new ExportStageError('write-page', 'refusing to write a non-serialisable line');
	}
	// JSON.stringify 会把真实换行转义成 \n,所以一个对象恒为一行 —— 但这条不变量
	// 太关键(破了整份文件的按行解析就废了),值得在写出前实打实地查一次。
	if (text.includes('\n')) {
		throw new ExportStageError('write-page', 'a JSONL line must not contain a raw newline');
	}
	return text + '\n';
}

function statusTally(scope: PageScopeEntry[]): Record<string, number> {
	const tally: Record<string, number> = {};
	for (const page of scope) {
		tally[page.status] = (tally[page.status] ?? 0) + 1;
	}
	return tally;
}

/**
 * 写出整份诊断文件。**逐行 append,绝不把整份内容拼成一个字符串。**
 *
 * 失败一律抛 `ExportStageError`,带上阶段 —— 调用方据此提示"读取第 N 页失败"
 * 而不是笼统的"导出失败",更不能在失败后提示成功。
 */
export async function writeDiagnosticsJsonl(sink: JsonlSink, source: DiagnosticsExportSource): Promise<ExportResult> {
	const version = source.pluginVersion.trim();
	if (!version) {
		// 版本写错的诊断比没有诊断更坏 —— 它会把排障引到另一份代码上。
		throw new ExportStageError('prepare', 'plugin version is unavailable; refusing to write a diagnostics file');
	}
	const scope = [...source.scope].sort((a, b) => a.pageIndex - b.pageIndex);
	let linesWritten = 0;
	const write = async (stage: ExportStage, value: unknown): Promise<void> => {
		try {
			await sink.append(line(value));
			linesWritten++;
		}
		catch (e) {
			throw e instanceof ExportStageError ? e : new ExportStageError(stage, `failed to write the ${stage} line`, { cause: e });
		}
	};

	await write('prepare', {
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

	await write('summary', { kind: 'summary', ...(source.summary() as object ?? {}) });

	let pagesWritten = 0;
	let pageReadFailures = 0;
	for (const entry of scope) {
		let record: unknown;
		let failed = false;
		source.pin?.(entry.pageIndex);
		try {
			record = source.readPage(entry.pageIndex);
		}
		catch {
			// 原始异常消息可能带路径或内容 —— 只留"这页读失败了"这个事实。
			failed = true;
			pageReadFailures++;
		}
		finally {
			// 短时保护: 读完立刻释放,不在整个导出期间挂着 (方案 §4)。
			source.unpin?.(entry.pageIndex);
		}
		await write('write-page', failed
			? {
				kind: 'page',
				page: entry.pageIndex + 1,
				status: entry.status,
				availability: { pageRecord: 'missing:read-failed' }
			}
			: {
				kind: 'page',
				page: entry.pageIndex + 1,
				availability: { pageRecord: 'live' },
				record
			});
		pagesWritten++;
		source.onProgress?.(pagesWritten, scope.length);
	}

	await write('finalize', {
		kind: 'result',
		pagesWritten,
		pageReadFailures,
		complete: true
	});

	return { pagesWritten, pageReadFailures, linesWritten };
}
