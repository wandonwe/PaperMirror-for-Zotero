/**
 * 导出的落盘与保存位置 (2.8.8, 导出方案 P3)。
 *
 * P1/P2 的写出内核是纯函数,只要求一个 `append(line)`。这里是它唯一的平台实现,
 * 以及"文件存到哪"这件事的全部规矩。
 *
 * ## 三条不肯让步的规矩
 *
 * **1. 保存对话框取消 = 直接结束。** 不写任何文件、不回落到别的目录、不提示成功,
 * 只给一句"已取消"。用户点"取消"表达的是"我不要这个文件",而不是"你随便找个
 * 地方放吧" —— 语料里可是整篇未发表稿件的原文。
 *
 * **2. 对话框不可用时,弹一次询问再写。** 2.8.8 的真机验证印证了这条不是纸上谈兵:
 * 裸的 `nsIFilePicker.init()` 在 Firefox 111+ 起要的是 BrowsingContext 而不是 window,
 * 传错就直接抛。这时**不能**自动挑个目录写下去,而要明确告诉用户"要不要存到
 * <备用目录>",用户同意才写。
 *
 * **3. 重名绝不覆盖。** 落盘前逐个探测,撞了就 `_2`、`_3`。
 *
 * ## 追加写
 *
 * `IOUtils.write(path, bytes, { mode: 'append' })` —— 与 cacheManager 用的是同一套
 * 平台 API。逐行追加,整份文件从头到尾不必同时在内存里(几百页的语料可以很大)。
 * 第一行之前先建目录并**确认目标文件不存在**,之后每行只管追加。
 */

import * as logger from '../utils/logger';
import { ExportStageError, type JsonlSink } from './jsonlWriter';

declare const IOUtils: {
	write(path: string, data: Uint8Array, options?: { mode?: string }): Promise<number>;
	exists(path: string): Promise<boolean>;
	makeDirectory(path: string, options?: { createAncestors?: boolean; ignoreExisting?: boolean }): Promise<void>;
	remove(path: string, options?: { ignoreAbsent?: boolean }): Promise<void>;
};
declare const PathUtils: { join(...parts: string[]): string; parent(path: string): string | null };

const MODULE = 'exportFileSink';

/**
 * 往一个文件里逐行追加的 sink。
 *
 * 失败**不吞**: 抛出去让写出内核裹成带阶段的 `ExportStageError` —— 磁盘满了却
 * 提示导出成功,比导出失败坏得多。
 */
export class FileJsonlSink implements JsonlSink {
	private readonly encoder = new TextEncoder();
	/** 已经写过至少一行 —— 用来判断出错时留下的是不是半份文件。 */
	started = false;

	constructor(readonly path: string) {}

	/**
	 * 写一行。
	 *
	 * **第一行用 `create`,其后才用 `append`** —— Gecko 的 `IOUtils` 里 `'append'`
	 * **不会建文件**(所以才另外有 `'appendOrCreate'`),对着不存在的文件写直接抛。
	 * 而我们又刻意保证目标文件不存在(`prepareTarget`,免得追加到旧文件上拼出
	 * 两份)。2.8.10 在真机上正是撞了这一对: 选好位置点 Save,第一行就写不进去,
	 * 磁盘上一个文件都没有。
	 */
	async append(line: string): Promise<void> {
		await IOUtils.write(this.path, this.encoder.encode(line),
			{ mode: this.started ? 'append' : 'create' });
		this.started = true;
	}

	/**
	 * 写失败后清理半份文件。**best-effort**: 删不掉也不要紧,文件里没有 result 行,
	 * 读的人一眼看得出它是半份。
	 */
	async discardPartial(): Promise<void> {
		if (!this.started) {
			return;
		}
		try {
			await IOUtils.remove(this.path, { ignoreAbsent: true });
		}
		catch (e) {
			logger.debug(MODULE, 'could not remove the partial export file', e);
		}
	}
}

/** 保存目标的三种结局 —— "取消"是一等结局,不是一种失败。 */
export type SaveTarget =
	| { kind: 'picked'; path: string }
	| { kind: 'cancelled' }
	| { kind: 'no-picker'; suggestedDir: string | null; reason?: string }
	/**
	 * 对话框**开出来了**,但没能拿到路径 —— 既不是"没有对话框"(不该再问备用
	 * 目录),也不能说成"用户取消了"(他没有)。单独一档,如实说。
	 */
	| { kind: 'no-path'; reason?: string };

/**
 * 一个"能问用户要保存路径"的东西。
 *
 * 2.8.8 真机验证发现平台侧至少有三种形态(Zotero 7 的 FilePicker 包装、
 * Firefox 111+ 要 BrowsingContext 的 `nsIFilePicker`、更老的要 window 的那种),
 * 于是这里只定义**结果**,具体怎么拉起来由宿主按顺序尝试 —— 决策逻辑(取消即
 * 结束、拉不起来就交回调用方去问)留在这里,平台差异不污染它。
 */
/**
 * `nsIFilePicker` 的三个返回值与 modeSave —— **写死数值**。
 *
 * 2.8.9 真机教训: 这些常量在不同包装上不一定读得到(`fp.returnCancel` 是
 * undefined),而拿 undefined 去比较,任何取值都成了"不是取消",于是**取消被当成
 * 选好了**。数值是 XPCOM 接口的稳定契约,直接写死比读一个可能不存在的属性可靠。
 */
export const RETURN_OK = 0;
export const RETURN_CANCEL = 1;
export const RETURN_REPLACE = 2;
export const MODE_SAVE = 1;

/**
 * 从 picker 的 `file` 里安全地取出路径。
 *
 * 三种形态都认: Zotero 包装给的是**路径字符串**,裸 XPCOM 给的是 nsIFile(取
 * `.path`),取消后可能是 null、空串,**也可能一读就抛**(2.8.9 真机上就是它把
 * "用户取消"变成了"没有对话框")。任何情况下都不抛。
 */
export function pickerPath(file: unknown): string | null {
	try {
		if (typeof file === 'string') {
			return file || null;
		}
		const path = (file as { path?: unknown } | null | undefined)?.path;
		return typeof path === 'string' && path ? path : null;
	}
	catch {
		return null;
	}
}

export interface PickerHandle {
	/** 拉起对话框并等用户选完。 */
	show(): Promise<'ok' | 'cancel'>;
	/** 用户选定的路径;取消或没选时为 null。 */
	path(): string | null;
}

/**
 * 拉起保存对话框。**拉不起来时返回 `no-picker`,绝不自己挑地方写。**
 *
 * `reason` 只进日志与排障,不进任何导出文件。
 */
export async function pickSavePath(
	fileName: string,
	deps: {
		createPicker(fileName: string): PickerHandle | null;
		defaultDir?: string | null;
	}
): Promise<SaveTarget> {
	let picker: PickerHandle | null = null;
	let reason = 'no picker implementation available';
	try {
		picker = deps.createPicker(fileName);
	}
	catch (e) {
		reason = e instanceof Error ? e.message : String(e);
		logger.warn(MODULE, 'file picker unavailable', e);
		picker = null;
	}
	if (!picker) {
		return { kind: 'no-picker', suggestedDir: deps.defaultDir ?? null, reason };
	}
	let shown: 'ok' | 'cancel';
	try {
		shown = await picker.show();
	}
	catch (e) {
		logger.warn(MODULE, 'file picker failed to open', e);
		return {
			kind: 'no-picker',
			suggestedDir: deps.defaultDir ?? null,
			reason: e instanceof Error ? e.message : String(e)
		};
	}
	// —— 到这里对话框**确实开出来过**。此后无论出什么岔子,都不能再回头问
	// "无法打开保存对话框" —— 2.8.9 真机上正是这样: 取消之后读路径抛了异常,
	// 被当成"没有对话框",于是用户点了取消却又被追问要不要存到别处。
	if (shown === 'cancel') {
		// 取消即结束 —— 不写、不回落、不提示成功。
		return { kind: 'cancelled' };
	}
	let path: string | null = null;
	try {
		path = picker.path();
	}
	catch (e) {
		logger.warn(MODULE, 'file picker returned no usable path', e);
		return { kind: 'no-path', reason: e instanceof Error ? e.message : String(e) };
	}
	return path
		? { kind: 'picked', path }
		: { kind: 'no-path', reason: 'the picker reported success but gave no path' };
}

/**
 * 目录里不与现有文件冲突的路径。撞了就在扩展名前追加 `_2`、`_3`…… **绝不覆盖**。
 *
 * 探测次数有上限: 目录里真有几百个同名文件时不该在这儿转到天荒地老 ——
 * 到上限就带上时间戳后缀,仍然不覆盖。
 */
export async function uniquePathIn(dir: string, fileName: string, limit = 50): Promise<string> {
	const dot = fileName.lastIndexOf('.');
	const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
	const ext = dot > 0 ? fileName.slice(dot) : '';
	for (let n = 1; n <= limit; n++) {
		const candidate = PathUtils.join(dir, n === 1 ? fileName : `${stem}_${n}${ext}`);
		if (!(await IOUtils.exists(candidate))) {
			return candidate;
		}
	}
	return PathUtils.join(dir, `${stem}_${Date.now()}${ext}`);
}

/**
 * 用户在对话框里选定的路径也要避让重名: 有些平台的保存对话框会替用户确认覆盖,
 * 但**我们的语义是绝不覆盖** —— 覆盖掉的可能是上一次导出的唯一一份证据。
 */
export async function ensureNoOverwrite(path: string): Promise<string> {
	if (!(await IOUtils.exists(path))) {
		return path;
	}
	const dir = PathUtils.parent(path);
	const name = path.slice((dir?.length ?? -1) + 1);
	return dir ? uniquePathIn(dir, name) : path;
}

/** 落盘前把目录建出来。目标文件必须**不存在** —— 追加写到旧文件上会拼出两份。 */
export async function prepareTarget(path: string): Promise<void> {
	const dir = PathUtils.parent(path);
	if (dir) {
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
	}
	if (await IOUtils.exists(path)) {
		// 走到这里说明避让逻辑被绕过了 —— 宁可不导出,也不把两份内容拼在一个文件里。
		throw new ExportStageError('prepare', 'refusing to append to an existing export file');
	}
}

/** 「显示文件」。不可用时返回 false —— 调用方把路径写进提示与日志,不假装成功。 */
export function revealFile(path: string, reveal?: (p: string) => void): boolean {
	try {
		if (!reveal) {
			return false;
		}
		reveal(path);
		return true;
	}
	catch (e) {
		logger.debug(MODULE, 'reveal failed', e);
		return false;
	}
}

/** 失败提示里给用户看的阶段名 —— 报错必须说得出卡在哪一步。 */
export function stageLabel(stage: string): string {
	switch (stage) {
		case 'prepare': return '准备';
		case 'summary': return '写入汇总';
		case 'write-page': return '写入页面数据';
		case 'finalize': return '收尾';
		default: return stage;
	}
}
