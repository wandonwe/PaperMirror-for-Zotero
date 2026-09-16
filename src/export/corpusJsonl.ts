/**
 * 翻译语料的写出 (2.8.7, 导出方案 P2)。
 *
 * 语料**含原文与译文** —— 与诊断文件是两回事,入口、确认与自我声明都分开:
 * 首行 manifest 的第一个字段就是 `CONTAINS_SOURCE_TEXT: true`,拿到文件的人
 * 打开第一眼就知道手里是什么。
 *
 * ## 这份文件的诚实边界(方案 §0/§1)
 *
 * **spans 没有被留存**,只能在导出时重新解析。所以每一页的 `availability.spans`
 * **恒为 `re-extracted`,不因为结构比对通过就升格** —— "用同样的流水线重建出了
 * 同样的结构"与"这就是当时那份 spans"是两句话。
 *
 * ## 写出器自己把关的一条硬规则
 *
 * `structureMatch !== 'matched'` 时,**这里就地丢掉调用方给的译文**,那一页的
 * `translations` 记 `missing:structure-mismatch`。块 id 形如 `page-N-region-M`,
 * 是按位置生成的 —— 重建后的 `region-3` 可能根本不是当初那个 `region-3`,照 id 贴
 * 译文会产出一份"看起来对齐、其实错位"的语料,**比缺失更糟**:缺失看得出来,
 * 错位看不出来。把这条闸放在写出器里(而不是交给数据源自觉),是因为它是这份
 * 文件唯一不能出错的地方。
 */

import {
	LineWriter, readPinned, requireVersion, sortedScope, statusTally,
	type JsonlSink, type PageScopeEntry
} from './jsonlWriter';
import { mayAttachTranslations, type StructureCheckResult, type StructureMatch } from './structureMatch';

export { ExportStageError, type ExportStage, type JsonlSink, type PageScopeEntry } from './jsonlWriter';

/** 译文的来路 —— 内存里还在,还是从页缓存复原的。 */
export type TranslationSource = 'live' | 'restored-from-cache' | 'archived';

/** 缺译文的原因枚举。 */
export type TranslationMissing =
	| 'missing:structure-mismatch'
	| 'missing:cache-miss'
	| 'missing:never-processed'
	| 'missing:evicted';

export interface CorpusPageRecord {
	/** 重新解析出的 spans(夹具同格式)。恒标 re-extracted。 */
	spans: unknown;
	/** 这一页的结构块 —— 来路见 `blocksSource`。 */
	blocks: unknown[];
	/**
	 * 结构块从哪儿来 (2.8.12 真机修正):
	 *
	 *   `live` —— **内存里那份原件**,就是翻译当时用的结构。译文与它同源同 id,
	 *             对齐是定义上成立的,不需要核对,也不该被"结构不匹配"扣下;
	 *   `re-extracted` —— 页已被淘汰,只能重新解析。这份是重建的近似,译文能不能贴
     *             取决于 `check`。
	 */
	blocksSource: 'live' | 're-extracted' | 'archived';
	/**
	 * 一块都没有的原因。**空数组不许标成 `re-extracted`** —— 那等于说"重解析过了,
	 * 这页就是没内容",而真相往往是"这页没渲染过,文本层根本不在,重解析拿不到"。
	 */
	blocksMissing?: 'missing:not-rendered';
	/** 结构一致性三态 + 分类计数。 */
	check: StructureCheckResult;
	/** 译文。结构不匹配时**会被写出器丢掉**,不写进文件。 */
	translations?: { id: string; translatedText: string }[] | null;
	translationSource?: TranslationSource;
	/** 拿不到译文的原因(与 translations 互斥)。 */
	translationsMissing?: TranslationMissing;
	/** 排版探针: 只有调试日志开着才采样。 */
	probe?: unknown;
 /** Placement from the same immutable page snapshot. */
 placement?: unknown;
 diagnostics?: Record<string, unknown>;
	/**
	 * spans 拿不到时的原因。**永远只能比 `re-extracted` 更差,不能更好** ——
	 * 非当前页没渲染过就没有文本层,这时如实说拿不到,不拿重建的结构冒充 spans。
	 */
	spansMissing?: 'missing:not-rendered';
}

export interface CorpusExportSource {
	pluginVersion: string;
	generatedAt: Date;
	scope: PageScopeEntry[];
	summary(): unknown;
	/** 读一页语料。重新抽取 + 读页缓存,**不发任何翻译请求**。 */
	readPage(pageIndex: number): CorpusPageRecord | Promise<CorpusPageRecord>;
	pin?(pageIndex: number): void;
	unpin?(pageIndex: number): void;
	onProgress?(done: number, total: number): void;
}

export interface CorpusExportResult {
	pagesWritten: number;
	pageReadFailures: number;
	linesWritten: number;
	structureMatch: Record<StructureMatch, number>;
	/** 真的带上译文的页数。 */
	translationsAttached: number;
	/** 有译文但因结构不匹配被扣下的页数 —— 必须能数出来。 */
	translationsWithheld: number;
	/** 结构块的来路分布 —— 一眼看出这份语料有多少是原件、多少是重建、多少压根没有。 */
	blocksBySource: { live: number; 're-extracted': number; archived: number; missing: number };
}

export async function writeCorpusJsonl(sink: JsonlSink, source: CorpusExportSource): Promise<CorpusExportResult> {
	const version = requireVersion(source.pluginVersion);
	const scope = sortedScope(source.scope);
	const writer = new LineWriter(sink);

	await writer.write('prepare', {
		// 自我声明放在第一个字段: 打开文件第一眼就知道手里是什么。
		CONTAINS_SOURCE_TEXT: true,
		kind: 'manifest',
		plugin: 'PaperMirror',
		pluginVersion: version,
		content: 'corpus',
		generatedAt: source.generatedAt.toISOString(),
		snapshotPolicy: 'page-at-a-time',
		// spans 不留存,导出时重解析 —— 写进文件,读的人才知道这份 spans 的性质。
		spansPolicy: 're-extracted-at-export',
		note: 'structureMatch=matched 只说明用同样的流水线重建出了同样的结构,不等于这就是翻译当时的 spans;as-translated 表示当次翻译使用的结构（内存或会话存档）。'
			+ ' spans 与重解析都依赖 PDF.js 的文本层,而文本层只对当前渲染着的页存在 —— 已翻过去的页会标 missing:not-rendered。',
		scope: {
			pagesTotal: scope.length,
			byStatus: statusTally(scope),
			evicted: scope.filter(p => p.evicted === true).length,
			pages: scope.map(p => p.pageIndex + 1)
		}
	});

	await writer.write('summary', { kind: 'summary', ...(source.summary() as object ?? {}) });

	const structureMatch: Record<StructureMatch, number> = {
		'as-translated': 0, matched: 0, mismatched: 0, unverifiable: 0
	};
	let pagesWritten = 0;
	let pageReadFailures = 0;
	let translationsAttached = 0;
	let translationsWithheld = 0;
	const blocksBySource = { live: 0, 're-extracted': 0, archived: 0, missing: 0 };

	for (const entry of scope) {
		const read = await readPinned(entry.pageIndex, source);
		if (!read.ok) {
			pageReadFailures++;
			await writer.write('write-page', {
				kind: 'page',
				page: entry.pageIndex + 1,
				status: entry.status,
				availability: { spans: 'missing:read-failed', blocks: 'missing:read-failed', translations: 'missing:read-failed' },
				// 2.8.15: 只是异常的**种类**(枚举 code / 类名),不含任何消息内容。
				readFailureKind: read.kind
			});
			pagesWritten++;
			source.onProgress?.(pagesWritten, scope.length);
			continue;
		}
		const record = read.record;
		structureMatch[record.check.structureMatch]++;
		if (record.blocksMissing) {
			blocksBySource.missing++;
		}
		else {
			blocksBySource[record.blocksSource]++;
		}

		// —— 唯一不能出错的地方: 结构不匹配就不贴译文,哪怕数据源给了。
		const allowed = mayAttachTranslations(record.check);
		const hasTranslations = Array.isArray(record.translations) && record.translations.length > 0;
		if (!allowed && hasTranslations) {
			translationsWithheld++;
		}
		const attach = allowed && hasTranslations;
		if (attach) {
			translationsAttached++;
		}

		await writer.write('write-page', {
			kind: 'page',
			page: entry.pageIndex + 1,
			status: entry.status,
			availability: {
				// 最好也只到 re-extracted —— 匹配也不升格 (方案 §1.2)。
				spans: record.spansMissing ?? 're-extracted',
				// 结构块**如实报来路**: 内存原件 / 重解析 / 压根没拿到。
				// 空数组配 're-extracted' 是在说谎 —— 那会让人以为"这页真的没内容"。
				blocks: record.blocksMissing ?? record.blocksSource,
				// `missing:structure-mismatch` **只在真有译文却被扣下时**才说得出口 ——
				// 本来就没有译文的页(被卸了、缓存里也没有)报成"结构不匹配"是栽赃,
				// 会把排查引到结构上去。
				translations: attach
					? (record.translationSource ?? 'live')
					: (hasTranslations
						? 'missing:structure-mismatch'
						: (record.translationsMissing ?? 'missing:cache-miss')),
				probe: record.probe === undefined ? 'missing:not-sampled' : record.blocksSource === 'archived' ? 'archived' : 'live'
			},
			structureMatch: record.check.structureMatch,
			...(record.check.mismatchKinds ? { mismatchKinds: record.check.mismatchKinds } : {}),
			...(record.check.unverifiableReasons ? { unverifiableReasons: record.check.unverifiableReasons } : {}),
			...(typeof record.check.boxTolerancePx === 'number' ? { boxTolerancePx: record.check.boxTolerancePx } : {}),
			blocksCompared: record.check.blocksCompared,
			// 结构与 spans 本身是真实的,不匹配时照样给 —— 缺的只有译文。
			spans: record.spans,
			blocks: record.blocks,
			...(attach ? { translations: record.translations } : {}),
			...(record.probe === undefined ? {} : { probe: record.probe }),
   ...(record.placement === undefined ? {} : { placement: record.placement })
		});
		pagesWritten++;
		source.onProgress?.(pagesWritten, scope.length);
	}

	await writer.write('finalize', {
		kind: 'result',
		pagesWritten,
		pageReadFailures,
		structureMatch,
		blocksBySource,
		translationsAttached,
		translationsWithheld,
		complete: true
	});

	return {
		pagesWritten, pageReadFailures, linesWritten: writer.linesWritten,
		structureMatch, blocksBySource, translationsAttached, translationsWithheld
	};
}
