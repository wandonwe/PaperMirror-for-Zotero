/**
 * Exporting the translated PDF: translating every page first (the built-in
 * export) and writing the bilingual or translated-only file.
 *
 * Moved out of readerSession.ts in 5.1 without changing behaviour: each
 * function is the former method, verbatim, using the session through a view
 * over the instance (only the members listed as writable are assigned).
 */
import { PaperMirrorError } from '../types/models';
import { buildTranslatedPdf, type PageTranslationData } from '../pdfgen/translatedPdfBuilder';
import { getString } from '../utils/l10n';
import * as logger from '../utils/logger';
import * as adapter from './zoteroReaderAdapter';
import type { ReaderSession } from './readerSession';

const MODULE = 'readerSession';

/** What these functions use of the ReaderSession (5.1: a view over the instance, see ReaderSession.pdfExportView; only the non-readonly members are written). */
export interface SessionPdfExportView {
	exportingPdf: ReaderSession['exportingPdf'];
	readonly flashNotice: ReaderSession['flashNotice'];
	readonly manager: ReaderSession['manager'];
	readonly pushExport: ReaderSession['pushExport'];
	readonly reader: ReaderSession['reader'];
	readonly setCapsuleCollapsed: ReaderSession['setCapsuleCollapsed'];
	readonly startTranslating: ReaderSession['startTranslating'];
	readonly waitForPage: ReaderSession['waitForPage'];
	readonly exportTranslatedPdf: ReaderSession['exportTranslatedPdf'];
	readonly exportBuiltin: ReaderSession['exportBuiltin'];
}

/**
 * Build translated/bilingual PDFs locally and import them as attachments.
 * The current reader stays available while export runs.
 */
export async function exportTranslatedPdf(ctx: SessionPdfExportView): Promise<void> {
	// 点击必须立刻可见 (2.3.8, 修「点击后没反应」): 状态胶囊在每页翻完后会
	// 自动折叠成 56px 圆环,而胶囊尊重折叠状态 —— 导出进度乃至失败信息全部
	// 渲染进一个折叠的小环里,用户看起来就是「没反应」。导出是用户显式点击
	// 的动作,启动时强制展开胶囊,并在任何 await 之前先推一条 0% 进度。
	ctx.setCapsuleCollapsed(false);
	if (ctx.exportingPdf) {
		ctx.pushExport('translating', { message: getString('papermirror-export-running').replace('%n%', '…') });
		return;
	}
	ctx.exportingPdf = true;
	ctx.pushExport('translating', { pct: 0, message: getString('papermirror-export-running').replace('%n%', '0') });
	const report = (pct: number): void => {
		ctx.pushExport('translating', {
			pct,
			message: getString('papermirror-export-running').replace('%n%', String(Math.round(pct)))
		});
	};
	try {
		// 条目/路径解析也在 try 里 (2.3.8): 旧版这两个 await 在 try 之外,
		// 一旦抛错整个 void 调用被静默吞掉 —— 正是「点击后没反应」的另一个洞。
		const item = adapter.getReaderItem(ctx.reader);
		const filePath = item ? await (item as unknown as { getFilePathAsync(): Promise<string | false> }).getFilePathAsync() : null;
		if (!item || !filePath) {
			ctx.pushExport('failed', { message: `${getString('papermirror-export-failed')}: 找不到 PDF 附件文件` });
			return;
		}
		const bytes = new Uint8Array(await IOUtils.read(String(filePath)));
		// 导出恒走内置生成 (2.1.6): 零配置、无外部依赖、无网络面。此前的
		// 「完整 PDF 服务模式」(BabelDOC 本地 HTTP 桥接)连同其令牌/握手安全面
		// 一并移除 —— 无界面、少人用,且带来一整套本地服务攻击面。
		const { monoBytes, dualBytes } = await ctx.exportBuiltin(bytes, report);
		const parentID = (item as unknown as { parentItemID?: number }).parentItemID ?? undefined;
		const stem = (String(filePath).split(/[\\/]/).pop() || 'paper').replace(/\.pdf$/i, '');
		const saveOne = async (data: Uint8Array | null, suffix: string): Promise<void> => {
			if (!data) {
				return;
			}
			// 临时文件加固 (2.0.6, 审核 P3): 旧路径 `${stem}.${suffix}.pdf` 在
			// 共享 /tmp 里完全可预测 —— 共享主机上他人可预先占位/符号链接,
			// 或在删除前的窗口读取。文件名混入密码学随机成分;写入后立即
			// 收紧权限到 0600(尽力而为: 平台不支持时忽略,随机名仍是主防线)。
			const rand = (() => {
				try {
					const buf = new Uint8Array(12);
					(globalThis as { crypto?: { getRandomValues(b: Uint8Array): Uint8Array } }).crypto!.getRandomValues(buf);
					return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
				}
				catch {
					// crypto 不可用的兜底: 仍强于旧的完全固定名。
					return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
				}
			})();
			const tmp = PathUtils.join((PathUtils as unknown as { tempDir: string }).tempDir, `${stem}.${suffix}.${rand}.pdf`);
			try {
				await IOUtils.write(tmp, data);
				try {
					await (IOUtils as unknown as { setPermissions?(path: string, permissions: number): Promise<void> }).setPermissions?.(tmp, 0o600);
				}
				catch { /* 权限收紧尽力而为 */ }
				await (Zotero as unknown as {
					Attachments: { importFromFile(options: { file: string; parentItemID?: number; title?: string }): Promise<unknown> };
				}).Attachments.importFromFile({
					file: tmp,
					parentItemID: parentID,
					title: suffix === 'mono' ? `${stem} (译文)` : `${stem} (双语对照)`
				});
			}
			finally {
				// A failed write/import can still leave a complete private PDF.
				// Clean it on every outcome, including attachment import failure.
				try { await IOUtils.remove(tmp, { ignoreAbsent: true }); }
				catch { /* temp cleanup is best-effort */ }
			}
		};
		await saveOne(monoBytes, 'mono');
		await saveOne(dualBytes, 'dual');
		// Export completion is shown ONCE, in the capsule — no extra toast.
		ctx.pushExport('done', { message: getString('papermirror-export-done') });
	}
	catch (e) {
		const message = e instanceof PaperMirrorError ? e.message : String(e);
		logger.warn(MODULE, 'exportTranslatedPdf failed', e);
		ctx.setCapsuleCollapsed(false); // 失败必须可见,即使用户中途又把胶囊折叠了
		ctx.pushExport('failed', { message: `${getString('papermirror-export-failed')}: ${message}` });
	}
	finally {
		ctx.exportingPdf = false;
	}
}

/**
 * 内置生成 (default): translate every page through the normal pipeline
 * (cache-aware), then write the translations back into a real PDF with the
 * bundled builder. No external service, no Python.
 */
export async function exportBuiltin(ctx: SessionPdfExportView, 
	sourceBytes: Uint8Array,
	report: (pct: number) => void
): Promise<{ monoBytes: Uint8Array | null; dualBytes: Uint8Array | null }> {
	if (!ctx.manager) {
		ctx.startTranslating();
	}
	const count = adapter.getPageCount(ctx.reader);
	if (count <= 0) {
		throw new PaperMirrorError('EXTRACTION_FAILED', '无法确定页数。', { retryable: false });
	}
	const pages = new Map<number, PageTranslationData>();
	for (let p = 0; p < count; p++) {
		await ctx.waitForPage(p);
		const state = ctx.manager?.getPageState(p);
		if (state && state.status === 'done' && state.blocks.length) {
			pages.set(p, { blocks: state.blocks, translations: state.translations });
		}
		report((p + 1) / count * 70);
	}
	if (!pages.size) {
		throw new PaperMirrorError('EXTRACTION_FAILED', '没有任何页面翻译成功。', { retryable: true });
	}
	const built = await buildTranslatedPdf(sourceBytes, pages, {
		dual: true,
		onProgress: (done, total) => report(70 + (done / total) * 28)
	});
	if (built.keptOriginal > 0) {
		// LO-1 (2.2.8): 放不下的块保留原文,不再涂白截断丢正文。
		logger.info(MODULE, `${built.keptOriginal} block(s) kept original in exported PDF (translation would not fit)`);
		ctx.flashNotice(`导出完成:${built.keptOriginal} 段译文放不下原区域,已保留原文(内容零丢失)`);
	}
	return { monoBytes: built.monoBytes, dualBytes: built.dualBytes };
}
