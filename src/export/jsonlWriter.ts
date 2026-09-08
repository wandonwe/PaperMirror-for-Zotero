/**
 * JSONL 写出的公共骨架 (2.8.7, 导出方案 P1/P2 共用)。
 *
 * 诊断文件与语料文件是两份**内容完全不同**的东西,但"怎么写"是同一套:
 * 一行一个 JSON、逐行追加、首行 manifest、末行 result、失败带阶段。这套骨架
 * 抽在这里,两个导出器共用 —— 否则两份文件的 result 语义、换行处理、错误阶段
 * 迟早各长各的,而这些恰恰是读文件的人最依赖的部分。
 *
 * P1 已经钉住的两条不变量在这里生效,语料文件自动继承:
 *
 *   1. **`result` 行是"写完了"的唯一凭据** —— manifest 在第一行,写它的时候后面
 *      会不会失败还不知道;没有 result 行的文件就是半份,读的人一眼看得出。
 *   2. **一个对象恒为一行**。`JSON.stringify` 会把真实换行转义,但这条不变量太
 *      关键(破了整份文件的按行解析就废了),写出前实打实查一次。
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

export function jsonLine(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) {
		throw new ExportStageError('write-page', 'refusing to write a non-serialisable line');
	}
	if (text.includes('\n')) {
		throw new ExportStageError('write-page', 'a JSONL line must not contain a raw newline');
	}
	return text + '\n';
}

/** 逐行写,并把底层异常统一裹成带阶段的 `ExportStageError`。 */
export class LineWriter {
	linesWritten = 0;
	constructor(private readonly sink: JsonlSink) {}
	async write(stage: ExportStage, value: unknown): Promise<void> {
		try {
			await this.sink.append(jsonLine(value));
			this.linesWritten++;
		}
		catch (e) {
			throw e instanceof ExportStageError
				? e
				: new ExportStageError(stage, `failed to write the ${stage} line`, { cause: e });
		}
	}
}

/** 版本号必须来自运行中的插件 —— 拿不到就拒绝写文件。 */
export function requireVersion(pluginVersion: string): string {
	const version = pluginVersion.trim();
	if (!version) {
		// 版本写错的导出比没有导出更坏 —— 它会把排障引到另一份代码上。
		throw new ExportStageError('prepare', 'plugin version is unavailable; refusing to write an export file');
	}
	return version;
}

/** 页清单按页序排 —— 文件里的页顺序不该取决于内部 Map 的插入顺序。 */
export function sortedScope(scope: PageScopeEntry[]): PageScopeEntry[] {
	return [...scope].sort((a, b) => a.pageIndex - b.pageIndex);
}

export function statusTally(scope: PageScopeEntry[]): Record<string, number> {
	const tally: Record<string, number> = {};
	for (const page of scope) {
		tally[page.status] = (tally[page.status] ?? 0) + 1;
	}
	return tally;
}

/**
 * 逐页读 + 短时保护。读完(哪怕抛错)**立即释放** —— 不在整个导出期间挂着,
 * 那样长文档导出时内存会一路上涨,把 2.8.3 省下来的又吃回去。
 */
export async function readPinned<T>(
	pageIndex: number,
	source: { readPage(pageIndex: number): T | Promise<T>; pin?(p: number): void; unpin?(p: number): void }
): Promise<{ ok: true; record: T } | { ok: false }> {
	source.pin?.(pageIndex);
	try {
		// 语料要重新抽取(异步);诊断是同步取现成的。两边都走这里,pin 的释放
		// 时机才只有一处 —— finally 在 await 之后执行,保护覆盖整个读取过程。
		return { ok: true, record: await source.readPage(pageIndex) };
	}
	catch {
		// 原始异常消息可能带路径或内容 —— 只留"这页读失败了"这个事实。
		return { ok: false };
	}
	finally {
		source.unpin?.(pageIndex);
	}
}
