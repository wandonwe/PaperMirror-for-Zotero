/**
 * 导出文件的命名 (2.8.6, 导出方案 P1)。
 *
 * 一次导出 = **一个纯文本文件**,不打包。名字要能一眼看出"哪个版本、什么内容、
 * 什么时候导的",同时**绝不泄露论文标题** —— 用户把文件拖进 issue 或聊天窗口时,
 * 文件名是第一个被别人看到的东西。
 *
 *     PaperMirror_v2.8.6_diagnostics_20260908_153042_287+0800.jsonl
 *
 * 三条硬规则:
 *   1. 版本从**运行中的插件**取(`startup(params).version`),不读常量、不硬编码 ——
 *      写错版本的诊断文件比没有更坏,它会把排障引到另一份代码上;
 *   2. 时间带毫秒与时区偏移: 跨时区提 issue 时,"下午三点半"没有意义;
 *   3. 重名**追加序号**,绝不覆盖 —— 用户连点两次导出,不该把上一份冲掉。
 */

/** 导出的两种内容。语料含原文,诊断不含 —— 名字里就分开。 */
export type ExportKind = 'diagnostics' | 'corpus';

/**
 * 本地时间戳: `20260908_153042_287+0800`。
 *
 * 偏移取 `Date.getTimezoneOffset()`(分钟,西正东负),按 `±HHMM` 写出。
 */
export function formatExportStamp(at: Date): string {
	const p = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');
	const offsetMin = -at.getTimezoneOffset();
	const sign = offsetMin < 0 ? '-' : '+';
	return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
		+ `_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
		+ `_${p(at.getMilliseconds(), 3)}`
		+ `${sign}${p(Math.trunc(offsetMin / 60))}${p(offsetMin % 60)}`;
}

export interface ExportNameInput {
	kind: ExportKind;
	/** 运行中的插件版本(`params.version`)。 */
	version: string;
	at: Date;
	/** 该目录下已存在的文件名 —— 用来避让,不是用来覆盖。 */
	taken?: ReadonlySet<string> | ((name: string) => boolean);
}

/** 版本号里只允许出现这些字符,其余(路径分隔符、空格……)一律换成 `-`。 */
function safeVersion(version: string): string {
	const cleaned = version.trim().replace(/[^0-9A-Za-z.+-]/g, '-');
	return cleaned || 'unknown';
}

/**
 * 算出不与 `taken` 冲突的文件名。重名时在扩展名**之前**追加 `_2`、`_3`……
 *
 * 返回的名字里没有论文标题,也没有任何用户内容 —— 这一条由单测钉住。
 */
export function exportFileName(input: ExportNameInput): string {
	const stem = `PaperMirror_v${safeVersion(input.version)}_${input.kind}_${formatExportStamp(input.at)}`;
	const isTaken = typeof input.taken === 'function'
		? input.taken
		: (name: string): boolean => input.taken instanceof Set && input.taken.has(name);
	let name = `${stem}.jsonl`;
	// 同一毫秒内连点两次导出确实会撞名 —— 撞了就换序号,绝不覆盖。
	for (let n = 2; isTaken(name); n++) {
		name = `${stem}_${n}.jsonl`;
	}
	return name;
}
