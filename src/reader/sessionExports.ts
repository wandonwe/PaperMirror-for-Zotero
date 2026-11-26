/**
 * The reader session's export features: the corpus and diagnostics export
 * sources, copying diagnostics and the layout corpus, the corpus privacy
 * confirmation, the engine self-check, and choosing where a file is saved.
 *
 * Moved out of readerSession.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, reading the session through a
 * read-only SessionExportView.
 */
import { contextualSourceText } from '../translation/sourceContinuity';
import { pageContentKey } from '../export/pageArchive';
import * as cacheManager from '../cache/cacheManager';
import { getProvider } from '../translation/providers/registry';
import { type PageTranslationState } from '../translation/translationManager';
import { joinPlacementOutcome } from './diagnosticsJoin';
import { engineExportRow, type EngineExportRow } from '../export/endpointKind';
import type { DiagnosticsExportSource } from '../export/diagnosticsJsonl';
import type { CorpusExportSource, CorpusPageRecord, TranslationSource, TranslationMissing } from '../export/corpusJsonl';
import { checkStructure, changedExtractInputs } from '../export/structureMatch';
import { writeCorpusJsonl, type CorpusExportResult } from '../export/corpusJsonl';
import { writeDiagnosticsJsonl, ExportStageError } from '../export/diagnosticsJsonl';
import { exportFileName, type ExportKind } from '../export/exportNaming';
import { pluginVersion } from '../export/pluginVersion';
import {
	FileJsonlSink,
	pickSavePath,
	prepareTarget,
	ensureNoOverwrite,
	uniquePathIn,
	revealFile,
	stageLabel,
	pickerPath,
	MODE_SAVE,
	RETURN_OK,
	RETURN_REPLACE,
	type PickerHandle
} from '../export/fileSink';
import type { SourceBlock } from '../types/models';
import { PaperMirrorError } from '../types/models';
import * as logger from '../utils/logger';
import { getPref } from '../utils/prefs';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderSession } from './readerSession';

const MODULE = 'readerSession';

/** What these functions read of the ReaderSession (5.1: read-only view, see ReaderSession.exportView). */
export interface SessionExportView {
	readonly abandonedBlocks: ReaderSession['abandonedBlocks'];
	readonly cacheKey: ReaderSession['cacheKey'];
	readonly exportPins: ReaderSession['exportPins'];
	readonly extractor: ReaderSession['extractor'];
	readonly flashNotice: ReaderSession['flashNotice'];
	readonly geometryAudits: ReaderSession['geometryAudits'];
	readonly layoutCorpus: ReaderSession['layoutCorpus'];
	readonly manager: ReaderSession['manager'];
	readonly pageArchive: ReaderSession['pageArchive'];
	readonly pageProviderOffset: ReaderSession['pageProviderOffset'];
	readonly pane: ReaderSession['pane'];
	readonly placementProbe: ReaderSession['placementProbe'];
	readonly placementStats: ReaderSession['placementStats'];
	readonly pool: ReaderSession['pool'];
	readonly providerSettingsFor: ReaderSession['providerSettingsFor'];
	readonly reader: ReaderSession['reader'];
	readonly revealFn: ReaderSession['revealFn'];
	readonly viewMode: ReaderSession['viewMode'];
	readonly corpusExportSource: ReaderSession['corpusExportSource'];
	readonly diagnosticsExportSource: ReaderSession['diagnosticsExportSource'];
	readonly copyDiagnostics: ReaderSession['copyDiagnostics'];
	readonly corpusTranslations: ReaderSession['corpusTranslations'];
	readonly pageSpans: ReaderSession['pageSpans'];
	readonly copyLayoutCorpus: ReaderSession['copyLayoutCorpus'];
	readonly runExportInner: ReaderSession['runExportInner'];
	readonly resolveSavePath: ReaderSession['resolveSavePath'];
	readonly createSavePicker: ReaderSession['createSavePicker'];
	readonly confirmCorpusPrivacy: ReaderSession['confirmCorpusPrivacy'];
	readonly engineSelfCheck: ReaderSession['engineSelfCheck'];
}

/**
 * 引擎自检 (2.3.0, 第四批 item2 · WF-2): 每个已启用引擎的配置健康度 ——
 * 纯本地检查(密钥配没配、端点类别、模型),**不发任何网络请求**。
 *
 * 2.8.6 (导出方案 P1) 起端点只报枚举: 此前报的是真实主机名,于是一份
 * "可以放心贴进 issue"的诊断会顺带公开用户自建网关的域名或公司内网主机名。
 * 自检异常也只报一个布尔 —— 异常消息里常带着端点 URL。
 */
export async function engineSelfCheck(ctx: SessionExportView): Promise<EngineExportRow[]> {
	const engines: EngineExportRow[] = [];
	const ids = ctx.pool.length ? ctx.pool : [getPref<string>('provider', 'bing-free')];
	for (const id of ids) {
		const provider = getProvider(id);
		try {
			const s = await ctx.providerSettingsFor(id);
			engines.push(engineExportRow(id, s, {
				defaultBaseURL: provider?.defaultBaseURL,
				keyConfigured: !!s.apiKey,
				requiresKey: !!provider?.requiresApiKey
			}));
		}
		catch {
			engines.push(engineExportRow(id, null, {
				keyConfigured: false,
				requiresKey: !!provider?.requiresApiKey
			}));
		}
	}
	return engines;
}

/**
 * 诊断导出的数据源 (2.8.6, 导出方案 P1)。
 *
 * 把"从哪儿取数"与"怎么写文件"分开: 写出逻辑(JSONL 逐行追加、缺失计数、
 * 阶段化报错)在 `src/export/diagnosticsJsonl.ts` 里,是纯函数式的、可单测的;
 * 这里只负责把会话里的各处数据接上去。保存对话框与 `Zotero.File.reveal`
 * 属于平台交互,留给 P3。
 *
 * **逐页读**: `readPage` 每次只取一页,读之前 pin、读完立即释放 ——
 * 导出不把整篇文档拉进内存,也不在整个导出期间挂着淘汰。
 */
export async function diagnosticsExportSource(ctx: SessionExportView, pluginVersion: string): Promise<DiagnosticsExportSource> {
	const manager = ctx.manager;
	if (!manager) {
		throw new PaperMirrorError('UNKNOWN', 'No translation session to export.', { retryable: false });
	}
	const engines = await ctx.engineSelfCheck();
	return {
		pluginVersion,
		generatedAt: new Date(),
		// 冻结的页清单: 导出期间新完成的页不混进来。
		scope: manager.exportScope(),
		summary: () => ({
			engines,
			// 3.1.5: 排版相关偏好进导出 —— 字号/行距倍率直接改变每个盒的容量,
			// 没有它们,no-room/height 的读数解释不了(CAD-RADS p13:164 字译文在
			// 130pt 高的盒里按算放得下却放弃)。全是无隐私的版式数值。
			layoutPrefs: {
				fontSizeFactor: getPref('fontSizeFactor', '1'),
				lineHeightFactor: getPref('lineHeightFactor', '1'),
				viewMode: ctx.viewMode,
				paneView: ctx.pane?.getViewKind() ?? null,
				paneWidthPx: ctx.pane?.paneWidthPx() ?? null
			},
			engineRotations: ctx.pageProviderOffset.size,
			// 2.12.0: 加权分页必须可审计 —— 权重是从哪些测量算出来的、
			// 算成了多少,都要能在导出里对上,否则"自调"就是黑箱。
			providerThroughput: ctx.manager?.providerThroughput() ?? {},
			providerWeights: ctx.manager?.providerWeights() ?? {},
			poolSize: ctx.pool.length,
			...((): Record<string, unknown> => {
				const diag = manager.exportDiagnostics() as Record<string, unknown>;
				// 逐页数据单独成行,这里只留会话级汇总 —— 否则整份文档的页数据
				// 会在 summary 行里再出现一遍,文件大一倍且两处口径可能不一致。
				const { pages: _pages, ...session } = diag;
				return session;
			})(),
			render: ctx.pane?.renderMetrics() ?? null,
			// 2.9.5: 路径 1(不依赖渲染的 char 流)每页的结局分布。
			// `charsPathMs` 约 1 ms/页 说明它是立刻失败或立刻返回空 —— 到底是
			// 哪一种,这里回答。它若能修好,整条"等文本层渲染"的时序难题就绕过去了。
			charsPath: ctx.extractor.charsPathOutcomes(),
			// 2.9.9: 路径 1.5 每页的结局 —— 2.9.7 一页都没走通,而日志里一个字都没有。
			textContentPath: ctx.extractor.textContentOutcomes(),
			// 2.9.6: 出路探针 —— 标准 PDF.js 的 getTextContent 在不在。
			// 它不依赖页面渲染,可用就意味着那个绕了六个版本的难题有了根治办法。
			textContentApi: ctx.extractor.textContentApiState(),
			cacheWrites: cacheManager.cacheWriteStats()
		}),
		readPage: async (pageIndex: number) => {
    const state=manager.getPageState(pageIndex);
    const archived=await ctx.pageArchive.get(pageIndex,state?.blocks.length?pageContentKey(state.blocks,state.translations):undefined);
    if(archived?.diagnostics) {
     const placement=archived.placement as {stats?:unknown;geometryAudit?:unknown}|undefined;
     return {...archived.diagnostics,snapshotSource:'archived',currentLifecycle:state?.status??'released',geometryAudit:placement?.geometryAudit??null,placement:placement?.stats??null,placementProbe:archived.probe??'not-sampled'};
    }
			const row = manager.exportPageDiagnostics(pageIndex);
			if (!row) {
				throw new PaperMirrorError('UNKNOWN', 'page state is gone', { retryable: false });
			}
			// 块级口径联表 (2.7.0, 审核 B-1): 排版放弃的块 state → 'unplaced'
			// + abandonReason —— 与一次性诊断走同一个 joinPlacementOutcome。
			const joined = joinPlacementOutcome(
				[row] as Parameters<typeof joinPlacementOutcome>[0], ctx.abandonedBlocks)[0] ?? row;
			return {
				...joined,
				geometryAudit: ctx.geometryAudits.get(pageIndex) ?? null,
				placement: ctx.placementStats.get(pageIndex) ?? null,
				// 探针只在调试日志开启时采样 —— 没采到就如实说,不冒充"没问题"。
				placementProbe: ctx.placementProbe.get(pageIndex) ?? 'not-sampled'
			};
		},
		pin: (pageIndex: number) => { ctx.exportPins.add(pageIndex); },
		unpin: (pageIndex: number) => { ctx.exportPins.delete(pageIndex); }
	};
}

export async function runExportInner(ctx: SessionExportView, kind: ExportKind): Promise<void> {
	if (!ctx.manager) {
		return;
	}
	const version = pluginVersion();
	if (kind === 'corpus' && !ctx.confirmCorpusPrivacy()) {
		return;
	}
	let source: DiagnosticsExportSource | CorpusExportSource;
	try {
		source = kind === 'corpus'
			? await ctx.corpusExportSource(version)
			: await ctx.diagnosticsExportSource(version);
	}
	catch (e) {
		logger.warn(MODULE, 'export could not be prepared', e);
		ctx.flashNotice('导出失败(准备阶段):没有可导出的翻译会话');
		return;
	}
	const fileName = exportFileName({ kind, version, at: source.generatedAt });
	const target = await ctx.resolveSavePath(fileName, kind);
	if (!target) {
		return; // 取消,或用户不同意写备用目录 —— 已各自提示过
	}

	const total = source.scope.length;
	ctx.flashNotice(`正在导出${total} 页…`);
	source.onProgress = (done, all) => {
		// 每页都刷会把提示刷成噪音;整十页与最后一页足够看出在动。
		if (done === all || done % 10 === 0) {
			ctx.flashNotice(`正在导出:第 ${done} / ${all} 页`);
		}
	};
	const sink = new FileJsonlSink(target);
	try {
		await prepareTarget(target);
		const result = kind === 'corpus'
			? await writeCorpusJsonl(sink, source as CorpusExportSource)
			: await writeDiagnosticsJsonl(sink, source as DiagnosticsExportSource);
		const missing = result.pageReadFailures
			? `,其中 ${result.pageReadFailures} 页读取失败(文件里已逐页标注)`
			: '';
		const withheld = kind === 'corpus' && (result as CorpusExportResult).translationsWithheld
			? `,${(result as CorpusExportResult).translationsWithheld} 页因结构不匹配未附译文`
			: '';
		const shown = revealFile(target, ctx.revealFn());
		ctx.flashNotice(`已导出 ${result.pagesWritten} 页${missing}${withheld}`
			+ (shown ? '' : ` —— ${target}`)
			+ (kind === 'corpus' ? ';文件含原文与译文,分享前请确认可公开' : ''));
		logger.info(MODULE, `export written: ${result.linesWritten} lines`);
	}
	catch (e) {
		// 失败绝不提示成功,并且必须说得出卡在哪一步。
		const stage = e instanceof ExportStageError ? stageLabel(e.stage) : '未知阶段';
		await sink.discardPartial();
		logger.warn(MODULE, `export failed at ${stage}`, e);
		ctx.flashNotice(`导出失败(${stage})—— 未生成完整文件`);
	}
}

/** 语料的隐私确认。**弹不出对话框就不导出** —— 含全文的文件不能默默写出去。 */
export function confirmCorpusPrivacy(ctx: SessionExportView): boolean {
	const prompt = (Services as unknown as {
		prompt?: { confirm(parent: unknown, title: string, text: string): boolean };
	}).prompt;
	const win = (Zotero as unknown as { getMainWindow?(): unknown }).getMainWindow?.() ?? null;
	if (!prompt?.confirm) {
		ctx.flashNotice('无法弹出确认对话框,已取消语料导出(该文件含原文与译文)');
		return false;
	}
	try {
		return prompt.confirm(win, '导出翻译语料',
			'文件包含当前文档已处理页面的原文、译文和布局数据。分享前请确认你有权提供这些内容;不会导出 API 密钥。');
	}
	catch {
		return false;
	}
}

/**
 * 选保存位置。返回 null = 结束(用户取消,或不同意写备用目录)。
 *
 * 对话框拉不起来时**弹一次询问**再写备用目录 —— 绝不自动把含全文的语料
 * 写到用户没点头的地方。
 */
export async function resolveSavePath(ctx: SessionExportView, fileName: string, kind: ExportKind): Promise<string | null> {
	const win = (Zotero as unknown as { getMainWindow?(): unknown }).getMainWindow?.() ?? null;
	const fallbackDir = ((): string | null => {
		try {
			return (Zotero as unknown as { DataDirectory?: { dir: string } }).DataDirectory?.dir ?? null;
		}
		catch {
			return null;
		}
	})();
	const target = await pickSavePath(fileName, {
		defaultDir: fallbackDir,
		createPicker: (name) => ctx.createSavePicker(name,
			kind === 'corpus' ? '保存翻译语料' : '保存诊断文件', win)
	});
	if (target.kind === 'cancelled') {
		ctx.flashNotice('已取消');
		return null;
	}
	if (target.kind === 'picked') {
		return ensureNoOverwrite(target.path);
	}
	if (target.kind === 'no-path') {
		// 对话框开出来过 —— 不能再问"无法打开保存对话框",也不能说"用户取消了"。
		logger.warn(MODULE, `save dialog gave no path: ${target.reason ?? 'unknown'}`);
		ctx.flashNotice('没有拿到保存位置,已取消');
		return null;
	}
	// —— 对话框不可用: 先问,同意才写。
	logger.warn(MODULE, `save dialog unavailable: ${target.reason ?? 'unknown'}`);
	if (!target.suggestedDir) {
		ctx.flashNotice('无法打开保存对话框,且没有可用的备用目录 —— 已取消');
		return null;
	}
	const prompt = (Services as unknown as {
		prompt?: { confirm(parent: unknown, title: string, text: string): boolean };
	}).prompt;
	const agreed = ((): boolean => {
		try {
			return prompt?.confirm(win, '无法打开保存对话框',
				`是否改为保存到 ${target.suggestedDir}?`) === true;
		}
		catch {
			return false;
		}
	})();
	if (!agreed) {
		ctx.flashNotice('已取消');
		return null;
	}
	return uniquePathIn(target.suggestedDir, fileName);
}

/**
 * 拉起保存对话框的三级尝试 (2.8.8 真机修正)。
 *
 * 2.8.8 首版只走裸 `nsIFilePicker.init(window, …)`,在真机上直接落到了"无法打开
 * 保存对话框"的回落分支 —— **Firefox 111+ 起 `init()` 的第一个参数是
 * BrowsingContext,不是 window**,传错就抛。Zotero 7 自带的 `FilePicker` 包装
 * 正是为了抹平这件事,所以把它放在第一位:
 *
 *   1. `chrome://zotero/content/modules/filePicker.mjs` 的 `FilePicker`
 *      (`show()` 返回 Promise;`file` 直接就是路径字符串);
 *   2. 裸 `nsIFilePicker` + **BrowsingContext**;
 *   3. 裸 `nsIFilePicker` + window(更老的 Zotero)。
 *
 * 三条都不成才回落到"询问备用目录" —— 那条分支仍然保留,平台再变也不会变成
 * "默默写到某个地方"。
 */
export function createSavePicker(ctx: SessionExportView, fileName: string, title: string, win: unknown): PickerHandle | null {
	const zoteroPicker = ((): PickerHandle | null => {
		try {
			const mod = (ChromeUtils as unknown as { importESModule(url: string): Record<string, unknown> })
				.importESModule('chrome://zotero/content/modules/filePicker.mjs');
			const Ctor = mod.FilePicker as (new () => {
				init(win: unknown, title: string, mode: number): void;
				appendFilter(title: string, filter: string): void;
				defaultString: string;
				show(): Promise<number>;
				file: unknown;
				modeSave?: number;
				returnOK?: number;
				returnReplace?: number;
			}) | undefined;
			if (!Ctor) {
				return null;
			}
			const fp = new Ctor();
			fp.init(win, title, fp.modeSave ?? MODE_SAVE);
			fp.appendFilter('JSON Lines', '*.jsonl');
			fp.defaultString = fileName;
			return {
				// 判"成功"而不是判"取消": 常量取不到时(包装没暴露 returnCancel
				// 就是这种情况)未知取值会被当成 ok,于是取消也走进了后面的读路径,
				// 而那一步一抛就被算成"没有对话框" —— 2.8.9 真机上的原样。
				show: async () => {
					const result = await fp.show();
					return result === (fp.returnOK ?? RETURN_OK) || result === (fp.returnReplace ?? RETURN_REPLACE)
						? 'ok'
						: 'cancel';
				},
				path: () => pickerPath(fp.file)
			};
		}
		catch (e) {
			logger.debug(MODULE, 'Zotero FilePicker unavailable', e);
			return null;
		}
	})();
	if (zoteroPicker) {
		return zoteroPicker;
	}

	const raw = Components.classes['@mozilla.org/filepicker;1']
		?.createInstance(Components.interfaces.nsIFilePicker) as {
			init(parent: unknown, title: string, mode: number): void;
			appendFilter(title: string, filter: string): void;
			defaultString: string;
			open(cb: (result: number) => void): void;
			file: unknown;
			modeSave?: number;
			returnOK?: number;
			returnReplace?: number;
		} | undefined;
	if (!raw) {
		return null;
	}
	// Firefox 111+ 要 BrowsingContext;更老的要 window。两个都试,谁不抛用谁。
	const parents = [(win as { browsingContext?: unknown } | null)?.browsingContext, win]
		.filter(p => p !== undefined && p !== null);
	let initialised = false;
	for (const parent of parents) {
		try {
			raw.init(parent, title, raw.modeSave ?? MODE_SAVE);
			initialised = true;
			break;
		}
		catch (e) {
			logger.debug(MODULE, 'nsIFilePicker.init rejected this parent', e);
		}
	}
	if (!initialised) {
		return null;
	}
	raw.appendFilter('JSON Lines', '*.jsonl');
	raw.defaultString = fileName;
	return {
		show: async () => {
			const result = await new Promise<number>(resolve => raw.open(resolve));
			return result === (raw.returnOK ?? RETURN_OK) || result === (raw.returnReplace ?? RETURN_REPLACE)
				? 'ok'
				: 'cancel';
		},
		path: () => pickerPath(raw.file)
	};
}

/**
 * 语料导出的数据源 (2.8.7, 导出方案 P2)。
 *
 * 每一页做三件事,**都不发任何翻译请求**:
 *
 *   1. **重新解析**结构 —— 直接调 `extractor.extractPage`,那就是翻译当初走的
 *      同一条流水线(方案 §1.1 要求"喂同样的 opts",共用同一个函数是最彻底的
 *      做法,不会有"检查用的链和真链慢慢分叉"这种事);
 *   2. **核对**留存结构与重建结构,并先查四项可变输入有没有变 —— 变了就直接
 *      `unverifiable`,不拿"碰巧相等"当证据;
 *   3. **取译文**: 内存里还在就用内存的,已被淘汰则读页缓存复原。
 *      结构不匹配时照样把译文交给写出器 —— 由写出器统一扣下并计数,
 *      这条闸只有一处,不靠这里自觉。
 *
 * spans 只有渲染过的页才拿得到(文本层来自 DOM),拿不到就标 `missing:not-rendered`
 * —— **不拿重建的结构冒充 spans**。
 */
export async function corpusExportSource(ctx: SessionExportView, pluginVersion: string): Promise<CorpusExportSource> {
	const manager = ctx.manager;
	if (!manager) {
		throw new PaperMirrorError('UNKNOWN', 'No translation session to export.', { retryable: false });
	}
	const engines = await ctx.engineSelfCheck();
	return {
		pluginVersion,
		generatedAt: new Date(),
		scope: manager.exportScope(),
		summary: () => ({
			engines,
			engineRotations: ctx.pageProviderOffset.size,
			// 2.12.0: 加权分页必须可审计 —— 权重是从哪些测量算出来的、
			// 算成了多少,都要能在导出里对上,否则"自调"就是黑箱。
			providerThroughput: ctx.manager?.providerThroughput() ?? {},
			providerWeights: ctx.manager?.providerWeights() ?? {},
			poolSize: ctx.pool.length,
			...((): Record<string, unknown> => {
				const diag = manager.exportDiagnostics() as Record<string, unknown>;
				const { pages: _pages, ...session } = diag;
				return session;
			})()
		}),
		readPage: async (pageIndex: number): Promise<CorpusPageRecord> => {
			const state = manager.getPageState(pageIndex);
			const spans = ctx.pageSpans(pageIndex);
    const key = state?.blocks.length ? pageContentKey(state.blocks,state.translations) : undefined;
    const archived = await ctx.pageArchive.get(pageIndex,key);
    if (archived) return archived;

			// —— 内存里还有原件就用原件 (2.8.12 真机修正)。
			//
			// 原方案假定"结构只能重新解析",漏了最短的一条: 没被淘汰的页,
			// `state.blocks` 就是翻译当时用的那份结构本身。它比任何重建都硬,
			// 译文按 id 对齐是定义上成立的。而重解析在这个文档上根本走不通 ——
			// 它的抽取路径是 text-layer,而**文本层只对当前渲染着的那几页存在**,
			// 导出时早翻过去了,于是 39 页全都重解析出 0 块。
			if (state && state.blocks.length) {
				return {
					spans: spans ?? null,
					...(spans ? {} : { spansMissing: 'missing:not-rendered' as const }),
					blocks: JSON.parse(JSON.stringify(state.blocks)) as SourceBlock[],
					blocksSource: 'live',
					check: { structureMatch: 'as-translated', blocksCompared: state.blocks.length },
					translations: [...state.translations].map(([id, translatedText]) => ({ id, translatedText })),
					translationSource: 'live',
				};
			}
			// —— 原件已被淘汰: 只能重解析,而且必须如实标注它的可信度。
			const before = ctx.extractor.extractInputsFor(pageIndex);
			// 与翻译当时**同一条**流水线,不是"另写一份检查用的解析"。
			const rebuilt = await ctx.extractor.extractPage(pageIndex);
			const after = ctx.extractor.extractPathFor(pageIndex);
			const inputsChanged = changedExtractInputs(before, {
				...ctx.extractor.currentExtractInputs(pageIndex),
				...(after ? { path: after } : {})
			});
			// 一块都没重建出来 ≠ 这页没内容 —— 多半是文本层不在。如实说。
			if (!rebuilt.length) {
				return {
					spans: spans ?? null,
					...(spans ? {} : { spansMissing: 'missing:not-rendered' as const }),
					blocks: [],
					blocksSource: 're-extracted',
					blocksMissing: 'missing:not-rendered',
					check: {
						structureMatch: 'unverifiable',
						blocksCompared: 0,
						unverifiableReasons: ['re-extraction-unavailable']
					},
					translations: null,
					translationsMissing: state?.evicted ? 'missing:evicted' : 'missing:never-processed',
				};
			}
			// 被卸过的页没有留存结构可比 —— checkStructure 如实报 no-stored-structure,
			// 不是"比过了且相等";这时缓存里的译文按块 id 贴过来会错位,不贴。
			const check = checkStructure(null, rebuilt, { inputsChanged });
			const { translations, translationSource, translationsMissing } =
				await ctx.corpusTranslations(pageIndex, state, rebuilt);
			return {
				spans: spans ?? null,
				...(spans ? {} : { spansMissing: 'missing:not-rendered' as const }),
				blocks: rebuilt,
				blocksSource: 're-extracted',
				check,
				translations,
				...(translationSource ? { translationSource } : {}),
				...(translationsMissing ? { translationsMissing } : {}),
			};
		},
		pin: (pageIndex: number) => { ctx.exportPins.add(pageIndex); },
		unpin: (pageIndex: number) => { ctx.exportPins.delete(pageIndex); }
	};
}

/** 这一页的译文: 内存 → 页缓存 → 说不出来就如实标缺失。**不发请求。** */
export async function corpusTranslations(ctx: SessionExportView, 
	pageIndex: number,
	state: PageTranslationState | undefined,
	rebuilt: SourceBlock[]
): Promise<{
	translations: { id: string; translatedText: string }[] | null;
	translationSource?: TranslationSource;
	translationsMissing?: TranslationMissing;
}> {
	if (state && state.translations.size) {
		return {
			translations: [...state.translations].map(([id, translatedText]) => ({ id, translatedText })),
			translationSource: 'live'
		};
	}
	if (!state) {
		return { translations: null, translationsMissing: 'missing:never-processed' };
	}
	try {
   // Rebuilt display text alone cannot identify a translated continuation.
   // Recover the same source-only evidence as the normal cache read path.
   if (!ctx.manager) return {translations:null, translationsMissing:'missing:cache-miss'};
   const contextual = await ctx.manager.contextualizeSource(pageIndex, rebuilt);
		const parts = await ctx.cacheKey(pageIndex, contextual.map(contextualSourceText), undefined, rebuilt.map(b=>b.sourceText).join('\n').slice(0,2000));
		const hit = parts ? await cacheManager.readPage(parts) : null;
		if (hit && hit.length) {
			return { translations: hit, translationSource: 'restored-from-cache' };
		}
	}
	catch (e) {
		logger.debug(MODULE, `corpus: cache restore failed for page ${pageIndex + 1}`, e);
	}
	// 被卸过、缓存也没有 —— 两种缺失分开说,后者不冒充前者。
	return {
		translations: null,
		translationsMissing: state.evicted ? 'missing:evicted' : 'missing:cache-miss'
	};
}

/** 这一页的文本层 spans(夹具同格式);没渲染过就拿不到,返回 null。 */
export function pageSpans(ctx: SessionExportView, pageIndex: number): unknown | null {
	try {
		const page = adapter.getTextLayerItems(ctx.reader, pageIndex);
		if (!page || !page.items.length) {
			return null;
		}
		return {
			source: 'document',
			page: pageIndex + 1,
			pageWidth: page.pageWidth,
			pageHeight: page.pageHeight,
			items: page.items.map(i => ({ text: i.text, rect: i.rect, ...(i.fontSize ? { fontSize: i.fontSize } : {}) }))
		};
	}
	catch {
		return null;
	}
}

/**
 * 诊断导出: sanitized per-page diagnostics (statuses, request/retry/429
 * counts, keep-origin reasons) → clipboard as JSON.
 *
 * 硬性不变量: NO source text, NO translations, NO keys (审核 P0-2)。
 * 1.1.7 曾把「语料」并进这个按钮,于是一个叫「诊断」的动作会把整页原文
 * 放进剪贴板 —— 用户在「提交诊断」的心智下不会预期这一点,粘进 issue 就
 * 等于公开了未发表稿件。语料已拆回独立的「语料」按钮 (copyLayoutCorpus),
 * 那个按钮的名字与提示都明说含原文,导出动作本身即知情授权。
 */
export async function copyDiagnostics(ctx: SessionExportView): Promise<void> {
	if (!ctx.manager) {
		return;
	}
	try {
		// 引擎自检 (2.3.0, 第四批 item2 · WF-2): 随诊断产出每个已启用引擎的
		// 配置健康度 —— 纯本地检查(密钥是否已配、端点主机、模型、熔断轮换
		// 次数),**不发任何网络请求**,也绝不含密钥本体。
		const engines = await ctx.engineSelfCheck();
		const payload = {
			plugin: 'PaperMirror',
			generatedAt: new Date().toISOString(),
			engines,
			// 会话内熔断/手动轮换过的页数(>0 说明有引擎不稳被换过)。
			engineRotations: ctx.pageProviderOffset.size,
			// 2.12.0: 加权分页必须可审计 —— 权重是从哪些测量算出来的、
			// 算成了多少,都要能在导出里对上,否则"自调"就是黑箱。
			providerThroughput: ctx.manager?.providerThroughput() ?? {},
			providerWeights: ctx.manager?.providerWeights() ?? {},
			poolSize: ctx.pool.length,
			...((): Record<string, unknown> => {
				const diag = ctx.manager.exportDiagnostics() as Record<string, unknown>;
				// 块级口径联表 (2.7.0, 审核 B-1): 排版放弃的块 state → 'unplaced'
				// + abandonReason,不再报成 translated。
				const pages = diag.pages;
				return Array.isArray(pages)
					? { ...diag, pages: joinPlacementOutcome(pages as Parameters<typeof joinPlacementOutcome>[0], ctx.abandonedBlocks) }
					: diag;
			})(),
			// 几何安全复核结果 (1.1.2 诊断闭环): 页号 → 违例/调整/保留计数。
			geometryAudits: [...ctx.geometryAudits.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([page, r]) => ({ page: page + 1, ...r })),
			// 放置统计全类目 (P3, 2.0.10): committed 之外的「有意保留」口径
			// (imageExcluded/tooSmall/tableIntentional) 显式可见 —— 图像准入
			// 阈值收紧 (P2-15) 后误拒面变大能在这里被发现。纯计数,无文本。
			placement: [...ctx.placementStats.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([page, p]) => ({ page: page + 1, ...p })),
			// Placement 探针 (审核: 封面标题空洞): 每块 base 位图/遮罩取样。
			// baseInk=false → 底图就没画这些字 (独立 page.render 的字形/时序缺口,
			// 放弃兜底无原文可露); baseInk=true & maskOpaque 且非 committed →
			// 遮罩误盖真原文。只几何+布尔,无文本。
			placementProbe: [...ctx.placementProbe.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([page, rows]) => ({ page: page + 1, blocks: rows })),
			// 2.8.4 (性能第五批: 先量再改): 渲染与缓存写盘的计量。纯计数与
			// 毫秒,不含路径、不含内容。第五批**只加计量、不改行为** ——
			// 分片与补译尾部的改动要等这几个数字在真实长文档上说话。
			render: ctx.pane?.renderMetrics() ?? null,
			cacheWrites: cacheManager.cacheWriteStats()
		};
		Components.classes['@mozilla.org/widget/clipboardhelper;1']
			.getService(Components.interfaces.nsIClipboardHelper)
			.copyString(JSON.stringify(payload, null, 2));
		ctx.flashNotice('诊断已复制(仅脱敏指标;不含原文、译文与密钥)');
	}
	catch (e) {
		logger.warn(MODULE, 'diagnostics copy failed', e);
	}
}

/**
 * 布局语料导出 (独立动作, 审核 P0-2): 当前页文本层 span → dump-spans 同格式
 * JSON 进剪贴板,供回归测试语料与版面排障使用。
 *
 * 与「诊断」的区别必须对用户可见: 这份 JSON **含本页原文文本与坐标**,
 * 所以按钮叫「语料」、提示明说含原文、复制后的 toast 再提醒一次。
 * 仍然不含译文,也不含密钥。
 */
export function copyLayoutCorpus(ctx: SessionExportView): void {
	try {
		const corpus = ctx.layoutCorpus();
		if (!corpus) {
			ctx.flashNotice('当前页没有可导出的文本层语料');
			return;
		}
		const payload = {
			plugin: 'PaperMirror',
			generatedAt: new Date().toISOString(),
			note: 'CONTAINS SOURCE TEXT of the current page (layout corpus for regression tests).',
			currentPageCorpus: corpus
		};
		Components.classes['@mozilla.org/widget/clipboardhelper;1']
			.getService(Components.interfaces.nsIClipboardHelper)
			.copyString(JSON.stringify(payload, null, 2));
		ctx.flashNotice('语料已复制 —— 含本页原文,分享前请确认可公开');
	}
	catch (e) {
		logger.warn(MODULE, 'corpus copy failed', e);
	}
}
