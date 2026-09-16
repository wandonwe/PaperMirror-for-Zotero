/**
 * 逐块诊断摘要 (2.8.5, 导出方案 P0)。
 *
 * 页级诊断里的逐块明细一直是**现算**的:遍历 `state.blocks`,配上
 * `translations` / `keepOrigin` / `rejectReasons` 得出每块的最终状态。2.8.3 的内存
 * 淘汰把 `blocks` 与那两个 Map 一起卸掉之后,这份明细就没了依据 —— 导出诊断时
 * 只能看到一页空块表,分不清"这页没有可译内容"和"这页的明细被省内存省掉了"。
 *
 * 这里把明细做成一份**定长、无文本**的摘要:块 id、类型、字符数、最终状态、
 * keepOrigin 原因枚举、最后一次拒绝原因枚举。约 60–80 字节/块。
 *
 * 两条设计要点:
 *
 *   1. **活块与摘要走同一个函数**(`digestRows` → `diagnosticRows`)。逐块状态的
 *      判定规则只有一份,不会出现"内存里算一套、摘要里算另一套"的漂移。
 *   2. **只留枚举,不留文本**。原文、译文、异常原始消息一律不进来 —— 摘要要能
 *      随诊断包导出,口径必须与 diagnosticsPrivacy 一致。
 *
 * `runId` / `revision` 是防混入的审计位:重新翻译会换一个全新的页状态对象,摘要
 * 随之重建;两个字段让审阅者能确认手上这份明细属于哪一轮。
 */

import type { SourceBlock } from '../types/models';

/** 块的最终去向。keepOrigin 的**原因**单独一栏,不挤在状态里。 */
export type BlockOutcome = 'translated' | 'preserved' | 'untranslated';

export interface BlockDigestRow {
	id: string;
	type: SourceBlock['type'];
	chars: number;
	outcome: BlockOutcome;
	/** 为什么保留不译 (2.12.13):names / dates / identifier / reference / data / structure-ambiguous … */
	preserveReason?: string;
	tableStructureIssue?: string;
	/** keep-origin 原因枚举('unrecovered' | 'repeated-failure' 等)。 */
	keepOrigin?: string;
	/** 最后一次验收拒绝的原因枚举(validator / placeholder / plain-* 等)。 */
	lastReject?: string;
	rejectHistory?: string[];
}

export interface PageBlockDigest {
	/** 产出这份摘要的运行序号 —— 重新翻译后能一眼看出是不是上一轮的。 */
	runId: number;
	/** 译文修订号,与页状态对齐。 */
	revision: number;
	blocks: BlockDigestRow[];
}

export interface DigestSource {
	blocks: SourceBlock[];
	translations: Map<string, string>;
	keepOrigin?: Map<string, string>;
	rejectReasons?: Map<string, string>;
	rejectHistory?: Map<string, string[]>;
}

/** 从活着的页内容算出逐块摘要 —— 纯函数,不碰任何文本内容。 */
export function digestRows(state: DigestSource): BlockDigestRow[] {
	return state.blocks.map(block => {
		const translated = state.translations.has(block.id);
		const outcome: BlockOutcome = translated
			? 'translated'
			: block.translationMode === 'preserve' ? 'preserved' : 'untranslated';
		const keepOrigin = translated ? undefined : state.keepOrigin?.get(block.id);
		const lastReject = translated ? undefined : state.rejectReasons?.get(block.id);
		return {
			id: block.id,
			type: block.type,
			chars: block.sourceText.length,
			outcome,
			...(block.tableStructureIssue ? { tableStructureIssue: block.tableStructureIssue } : {}),
			...(outcome === 'preserved' && block.preserveReason ? { preserveReason: block.preserveReason } : {}),
			...(keepOrigin ? { keepOrigin } : {}),
			...(lastReject ? { lastReject } : {}),
			...(!translated && state.rejectHistory?.has(block.id) ? { rejectHistory: [...state.rejectHistory.get(block.id)!] } : {})
		};
	});
}

export function buildPageDigest(state: DigestSource, runId: number, revision: number): PageBlockDigest {
	return { runId, revision, blocks: digestRows(state) };
}

/** 诊断导出里的一行(保持 2.3.7 起的既有形状,下游报表不受影响)。 */
export interface DiagnosticBlockRow {
	id: string;
	/** 为什么保留不译(枚举,2.12.14 起导出)。 */
	preserveReason?: string;
	tableStructureIssue?: string;
	type: SourceBlock['type'];
	chars: number;
	state: string;
	lastReject?: string;
	rejectHistory?: string[];
	keepOrigin?: string;
}

/**
 * 摘要 → 诊断行。
 *
 * `state` 保持既有口径(2.3.7):translated / preserved / **keepOrigin 原因** /
 * untranslated —— `joinPlacementOutcome` 与 baseline-report 都按这个口径读,不能改。
 * 新增的 `keepOrigin` 是把原因**另外**显式列一栏,便于机读,不替换 `state`。
 */
export function diagnosticRows(rows: BlockDigestRow[]): DiagnosticBlockRow[] {
	return rows.map(row => ({
		id: row.id,
		type: row.type,
		chars: row.chars,
		state: row.outcome === 'untranslated' ? (row.keepOrigin ?? 'untranslated') : row.outcome,
		// 2.12.13 加进摘要、2.12.14 才接到导出 —— 真机 2.12.13 的导出里 preserveReason 是空的。
		...(row.tableStructureIssue ? { tableStructureIssue: row.tableStructureIssue } : {}),
		...(row.preserveReason ? { preserveReason: row.preserveReason } : {}),
		...(row.keepOrigin ? { keepOrigin: row.keepOrigin } : {}),
		...(row.lastReject ? { lastReject: row.lastReject } : {}),
		...(row.rejectHistory ? { rejectHistory: row.rejectHistory } : {})
	}));
}
