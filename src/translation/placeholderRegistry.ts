/**
 * 占位符注册表 — 请求级的 token→原文→校验状态 记录(1.1.0 目标架构第 3 步)。
 *
 * 此前 translationManager 里 protect/verify/restore 以 `{ text, placeholders }`
 * 散装三元组出现在 4 个 protect 点与 7 个校验/还原点;注册表把它们收敛成
 * 单一边界对象:掩蔽在构造时完成,校验与还原只能通过同一个实例走——
 * 一个块的占位符清单从签发到还原不可能再被拿错(串块拿错清单正是
 * 散装三元组允许而注册表禁止的错误类别)。
 *
 * 校验/还原语义原样委托 formulaGuard(碰撞规避、幻觉变体归一、(?!\d) 边界
 * 都在那一层,1.0.6);本类新增的只有状态记录:verify 的通过/拒绝计数与
 * 最近一次报告,供诊断导出汇总(不含任何文本内容——遵守日志卫生基线)。
 *
 * Pure module — no DOM, unit-tested.
 */

import { protectFormulas, restoreFormulas, verifyPlaceholders, type PlaceholderReport } from '../reader/formulaGuard';
import { finalizeStyleMarkers, insertStyleMarkers, type StyleRun } from '../reader/styleRuns';
import type { PlaceholderEntry } from '../types/models';

export class PlaceholderRegistry {
	/** 掩蔽后的请求文本。 */
	readonly text: string;
	/** 签发的占位符清单(token → 原文)。 */
	readonly entries: PlaceholderEntry[];
	private accepted = 0;
	private rejected = 0;
	private last: PlaceholderReport | null = null;

	private constructor(text: string, entries: PlaceholderEntry[]) {
		this.text = text;
		this.entries = entries;
	}

	/**
	 * styleRuns (可选): 段内粗/斜体跨度,先包成对样式标记再做公式掩蔽——
	 * 掩蔽可能临时拆散一对(公式 RUN 吞掉半个标记),restore 会原样放回,
	 * 所以配对校验在 restore 尾部做 (finalizeStyleMarkers),破对一律降级
	 * 剥标记,绝不因样式拒绝译文。参照 BabelDOC RichTextPlaceholder。
	 */
	static protect(sourceText: string, extraLiterals: string[] = [], styleRuns?: StyleRun[]): PlaceholderRegistry {
		const marked = insertStyleMarkers(sourceText, styleRuns);
		const { text, placeholders } = protectFormulas(marked, extraLiterals);
		return new PlaceholderRegistry(text, placeholders);
	}

	get count(): number {
		return this.entries.length;
	}

	/** 清单校验(计数进注册表状态)。 */
	verify(translated: string): PlaceholderReport {
		const report = verifyPlaceholders(translated, this.entries);
		this.last = report;
		if (report.ok) {
			this.accepted++;
		}
		else {
			this.rejected++;
		}
		return report;
	}

	/** 候选过滤用的布尔形态:无占位符恒 true。 */
	ok(translated: string): boolean {
		return !this.entries.length || this.verify(translated).ok;
	}

	restore(translated: string): string {
		return finalizeStyleMarkers(restoreFormulas(translated, this.entries));
	}

	/** 诊断状态:校验通过/拒绝次数与最近一次报告(token 名,无文本)。 */
	get status(): { count: number; accepted: number; rejected: number; last: PlaceholderReport | null } {
		return { count: this.count, accepted: this.accepted, rejected: this.rejected, last: this.last };
	}
}
