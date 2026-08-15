/**
 * Document IR — 显式化的中间表示契约层 (1.1.0 目标架构第 1 步)。
 *
 * 设计立场(方案审核结论,参照 BabelDOC document_il 的"阶段化流水线"思想而
 * 非其数据形状):PaperMirror 的 IR 是**现有结构之上的类型形式化**,不是
 * il_version_1 式的完整层级重建。SourceBlock 已经承载了
 * column/tableCol/tableRow/readingIndex/formulaRuns/placeholders/
 * translationMode/memberIds——层级事实上存在,本模块补上的是:
 *
 *  1. `PageParser` — 解析器接口(目标架构第 6 步的"快速/深度双路径"插槽:
 *     fast = 现有 TextExtractor 链;deep = 将来的 loopback 本地解析后端,
 *     仅 127.0.0.1、显式 opt-in、超时回落 fast——安全基线见方案审核)。
 *  2. `PageIR` — 一页解析产物的显式形状。
 *  3. `validatePageIR` — 阶段边界的不变量契约(纯函数,单测 + 运行期
 *     log-only 审计)。这些不变量此前散落在各修复的隐式假设里
 *     (1.0.2/1.0.3 的字段回归全都是"某个隐式不变量被搬丢了");显式化后,
 *     任何"把 X 挪出 Y"的重构都能用同一张清单回归。
 *
 * Pure types + pure checker — no DOM, no Zotero.
 */

import type { SourceBlock } from '../types/models';

/**
 * 解析器接口:一页 PDF → 语义块序列(已聚段、已建表、已排阅读序)。
 *
 * `TextExtractor` 是 fast 实现;deep 实现(MinerU loopback 等)必须满足同一
 * 契约并额外遵守:失败/超时静默回落 fast,绝不阻塞普通页面。
 */
export interface PageParser {
	/** 空数组/抛错语义与 fast 实现(TextExtractor)一致:无文本层与提取失败
	 * 以 PaperMirrorError code 区分,不引入第二套错误形状。 */
	extractPage(pageIndex: number): Promise<SourceBlock[]>;
}

/** 一页的显式 IR:解析阶段的输出、翻译计划阶段的输入。 */
export interface PageIR {
	pageIndex: number;
	/** 阅读序排列的语义块(readingIndex 与数组下标一致)。 */
	blocks: SourceBlock[];
}

export interface IRViolation {
	invariant: string;
	blockId?: string;
	detail: string;
}

/**
 * 阶段边界不变量。每条都对应一次真实修过的回归或一个显式设计决定:
 *
 *  - id 唯一(修复链/缓存/占位符全部以 id 为键);
 *  - pageIndex 一致(跨页续接与页缓存的前提);
 *  - readingIndex 稠密且与数组序一致(1.0.6 起显式打点;翻译计划按它分段);
 *  - 表格单元格 tableRow/tableCol 成对存在,且 column 是页栏不是表列
 *    (1.0.2 审核 P1:表列写进 column 曾打乱整页阅读序);
 *  - preserve 块不携带占位符(它们从不进翻译请求);
 *  - memberIds 非空数组(空组曾表示"合并丢了来源");
 *  - boundingBox 尺寸为正(0/负宽高会让像素换算与表格聚类静默出错)。
 */
export function validatePageIR(ir: PageIR): IRViolation[] {
	const out: IRViolation[] = [];
	const seen = new Set<string>();
	ir.blocks.forEach((b, i) => {
		if (seen.has(b.id)) {
			out.push({ invariant: 'unique-id', blockId: b.id, detail: `duplicate id at index ${i}` });
		}
		seen.add(b.id);
		if (b.pageIndex !== ir.pageIndex) {
			out.push({ invariant: 'page-index', blockId: b.id, detail: `block.pageIndex ${b.pageIndex} ≠ page ${ir.pageIndex}` });
		}
		if (b.readingIndex !== i) {
			out.push({ invariant: 'reading-index', blockId: b.id, detail: `readingIndex ${b.readingIndex} at array index ${i}` });
		}
		const isCell = typeof b.tableCol === 'number' || typeof b.tableRow === 'number';
		if (isCell && (typeof b.tableCol !== 'number' || typeof b.tableRow !== 'number')) {
			out.push({ invariant: 'table-cell-pair', blockId: b.id, detail: `tableRow=${b.tableRow} tableCol=${b.tableCol} must both be set` });
		}
		if (isCell && typeof b.column === 'number' && typeof b.tableCol === 'number'
			&& b.column === b.tableCol && b.column > 0 && !b.id.includes('-table-')) {
			// 弱信号,只在非合成 id 上报——真正的硬约束由 tableStructure 测试守。
			out.push({ invariant: 'page-column-not-table-column', blockId: b.id, detail: `column ${b.column} suspicious` });
		}
		if (b.translationMode === 'preserve' && b.placeholders?.length) {
			out.push({ invariant: 'preserve-no-placeholders', blockId: b.id, detail: `${b.placeholders.length} placeholder(s) on a preserve block` });
		}
		if (b.memberIds && !b.memberIds.length) {
			out.push({ invariant: 'member-ids-nonempty', blockId: b.id, detail: 'memberIds is an empty array' });
		}
		if (b.boundingBox && (b.boundingBox.width <= 0 || b.boundingBox.height <= 0)) {
			out.push({ invariant: 'positive-box', blockId: b.id, detail: `box ${b.boundingBox.width}×${b.boundingBox.height}` });
		}
	});
	return out;
}
