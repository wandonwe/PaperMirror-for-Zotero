/**
 * 一页 span → 最终结构块的**唯一纯函数入口** (5.0 结构层重构第 0 步)。
 *
 * 此前这四步(建块 → 阅读序 → 表格结构化 → 区域合并)写在 TextExtractor 的
 * 私有方法里,只能在 Zotero 里跑。抽成纯函数后,插件与离线语料工具
 * (`scripts/corpus/`)跑的是**同一份代码**:重构结构层时,每改一步都能拿本机
 * 全部真实文献逐页比对,而不是只靠 42 个快照和逐篇真机。
 *
 * 不碰 DOM、不碰 Zotero;所有跨页 / 跨文档的事实都从 `context` 传入。
 */
import type { SourceBlock } from '../types/models';
import type { FurnitureLine } from './documentStyle';
import { finalizePageRegions } from './pageRegions';
import { orderBlocksForReading } from './readingOrder';
import { buildBlocksFromSpans, type SpanItem } from './spanBlockBuilder';
import { structureTableCells } from './tableStructure';
import type { BorderGrid } from './tableBorders';

type Rect = [number, number, number, number];

export interface SpanPage {
	items: SpanItem[];
	pageWidth: number;
	pageHeight: number;
}

/** 一页之外、结构识别需要知道的事实。 */
export interface PageContext {
	pageIndex: number;
	includeReferences: boolean;
	/** 本页之前是否已进入参考文献(全篇样式给出时与翻页顺序无关)。 */
	referencesAlreadyStarted: boolean;
	/** 文档级正文字号;0 表示未知。 */
	bodyFontSize: number;
	/** 全篇样式给出的栏沟 x(没有则空)。 */
	knownGutters?: number[];
	/** 全篇样式:本页是否开始一段参考文献(未知则不填)。 */
	referencesStartHere?: boolean;
	/** 全篇样式:实测的段首缩进(pt,0/不填 = 未知)。 */
	paragraphIndent?: number;
	/** 全篇样式:页面固定元素(页眉页脚、侧栏导航)。 */
	furniture?: readonly FurnitureLine[];
	/** 不翻译的原文(用户设置),表格结构化用。 */
	noTranslate?: string[];
	obstacles?: Rect[];
	grid?: BorderGrid | null;
	grids?: BorderGrid[];
	legendSegmentsPdf?: Parameters<typeof buildBlocksFromSpans>[1]['legendSegmentsPdf'];
}

export interface PageStructure {
	blocks: SourceBlock[];
	/** 建块阶段(合并之前)的碎片数 —— 分组指标用。 */
	sourceBlockCount: number;
	/** 本页是否进入了参考文献。 */
	referencesStarted: boolean;
}

export function structureSpanPage(page: SpanPage, context: PageContext): PageStructure {
	const obstacles = context.obstacles ?? [];
	const result = buildBlocksFromSpans(page.items, {
		pageIndex: context.pageIndex,
		pageHeight: page.pageHeight,
		pageWidth: page.pageWidth,
		includeReferences: context.includeReferences,
		referencesAlreadyStarted: context.referencesAlreadyStarted,
		knownGutters: context.knownGutters,
		referencesStartHere: context.referencesStartHere,
		paragraphIndent: context.paragraphIndent,
		furniture: context.furniture,
		bodyFontSize: context.bodyFontSize,
		imageRectsPdf: obstacles,
		grid: context.grid ?? null,
		grids: context.grids,
		legendSegmentsPdf: context.legendSegmentsPdf
	});
	const sourceBlockCount = result.blocks.length;
	// Canonical reading order BEFORE coalescing: row-wise streams interleave
	// the columns, and the coalescer only merges adjacent blocks.
	const structured = structureTableCells(orderBlocksForReading(result.blocks), context.pageIndex,
		context.bodyFontSize || 10, context.noTranslate ?? [], context.grids ?? context.grid ?? null, true, page.pageHeight);
	return {
		blocks: finalizePageRegions(structured, page.pageHeight, obstacles),
		sourceBlockCount,
		referencesStarted: result.referencesStarted
	};
}
