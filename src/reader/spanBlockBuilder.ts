import { isFurnitureLine, type FurnitureLine } from './documentStyle';
import {
	looksLikeBibliographicFragment,
	looksLikeIndexPage,
	looksLikeReferencePage,
	looksLikeReferenceText,
	startsReferenceEntry,
	startsUnnumberedEntry
} from './referenceDetect';
import { extractPanelTitles } from './panelTitles';
import { removeCollapsedTextCopies } from './collapsedTextCopies';
import { extractTwoColumnTables } from './twoColumnTable';
import { extractDescriptiveTables } from './descriptiveTable';
import { separateDisplayFormulas } from './displayFormula';
import { captionOwnership } from './captionOwnership';
import { semanticBoundary } from './semanticBoundary';
import { extractAbbreviationTables } from './abbreviationTable';
import { columnOfX, rowOfTop } from './tableBorders';
import { imageCaptionRegions, withinCaption, markImageCaptions } from './imageCaption';
import { extractLegendItems } from './legendItems';
/**
 * Build SourceBlocks from positioned text items (the PDF.js text layer).
 *
 * This is the robust extraction path: the text layer is ordinary DOM in the
 * PDF iframe, so it is readable from the plugin sandbox without any Xray /
 * wrapper concerns, and it is exactly the text the user can select with the
 * mouse. It carries no paragraph-break flags, so structure is inferred from
 * geometry.
 *
 * Order of operations matters, and getting it wrong is what produced scrambled
 * text before:
 *
 *   1. rows   — items sharing a baseline, WITHOUT any horizontal constraint
 *   2. gutters— vertical whitespace channels, voted on across all wide rows
 *               (a full-width title covers the gutter, so no single row can
 *               reveal it; the body rows outvote the title)
 *   3. lines  — each row split at the gutters, so a left-column line is never
 *               concatenated with the right-column line beside it
 *   4. paragraphs — merged within a column, with a wrapped-line guard so a
 *               sentence is not cut where the text simply reached the margin
 *
 * Pure module — no DOM, no Zotero APIs.
 */

import type { SourceBlock } from '../types/models';
import { detectTableRegions } from './tableGuard';
import type { BorderGrid } from './tableBorders';
import { insideObstacle, obstacleBetween } from './figureBarriers';
import {
	isJournalFurniture,
	isIdentifierLabel,
	classifyContent,
	isRunningHeadOrFoot,
	isSectionHeadingName,
	type PreserveReason
} from './metaFilter';
import {
	columnOf,
	detectColumns,
	bandedColumnStamp,
	dominantFontSize,
	replacementFontSize,
	joinFragments,
	joinLines,
	linesShareColumn,
	planMerges,
	type Rect
} from './paragraphHeuristics';
import {
	ENTRY_LINES,
	type SpanItem,
	type SpanLine,
	decorativeTextRows,
	dropRotatedTableRemnants,
	fontSizeOf,
	groupIntoLines,
	groupIntoRows,
	lineIsBold,
	lineText,
	pageBodySize,
	rectOf,
	sizeOf,
	union
} from './spanLines';
import {
	classify,
	gridRowBarriers,
	gridRowBetween,
	groupIntoParagraphs,
	isBareFigureLabel,
	joinContactStacks,
	medianLineWidthOf,
	mergeGridCellStacks
} from './spanParagraphs';
export {
	ROTATED_TABLE_MIN_CHARS,
	crossesLineGutter,
	groupIntoLines,
	groupIntoRows,
	lineIsBold,
	lineText,
	pageBodySize,
	removeDecorativeTextRules,
	sidewaysBodyChars
} from './spanLines';
export type { SpanItem, SpanLine } from './spanLines';
export {
	entryNumberOf,
	gridRowBarriers,
	groupIntoParagraphs,
	isBareFigureLabel,
	medianLineWidthOf,
	mergeGridCellStacks
} from './spanParagraphs';
export type { GridRowBarriers, ParagraphContext } from './spanParagraphs';

// 字间空格标题 (2.7.2, 审核 C-2): jacc2020-p15 "R E F E R E N C E S" 排成字距体,
// 原正则不认,整段三栏参考文献被当正文切碎翻译。
/** A References heading anywhere in the raw page text, letter-spaced or not (5.0). */
const REFERENCES_HEADING_HINT = /(?:^|\s)(?:R\s?E\s?F\s?E\s?R\s?E\s?N\s?C\s?E\s?S|References|Bibliography|Literature\s+Cited|参考文献|參考文獻|引用文献)(?=\s|$)/;

const REFERENCES_HEADINGS = /^(r\s*e\s*f\s*e\s*r\s*e\s*n\s*c\s*e\s*s|bibliography|literature\s+cited|参考文献|參考文獻|引用文献)\s*$/i;

export interface SpanBuildOptions {
 /** Painted path evidence already collected for border detection. */
 legendSegmentsPdf?: Rect[];
 /** Internal drawing-rule barriers retained across recursive extraction. */
 textRuleRectsPdf?: Rect[];
 /** Internal recursion guard after source-region assignment. */
 regionsAssigned?: boolean;
 panelAnchors?: SourceBlock[];
	pageIndex: number;
	pageHeight: number;
	/** 边框硬屏障: figure rects — in-figure labels dropped, no merges across. */
	imageRectsPdf?: Rect[];
	pageWidth?: number;
	includeReferences?: boolean;
	referencesAlreadyStarted?: boolean;
	/** 5.0 全篇样式: gutter x positions the document's body pages agree on. */
	knownGutters?: number[];
	/** 5.0 全篇样式: whether a reference range starts on this page (undefined = unknown). */
	referencesStartHere?: boolean;
	/** 5.0 全篇样式: measured first-line indent (pt) and body size. */
	paragraphIndent?: number;
	bodyFontSize?: number;
	/** 5.0 全篇样式 (校验 r22): lines repeated at one position across the document. */
	furniture?: readonly FurnitureLine[];
	/**
	 * 边框网格 (2.12.15):行线是硬屏障 —— 两行之间隔着一条网格行线,不许合成一个段落。
	 * ESC p16 实证:灰色小节标题带与紧贴其下的格首行(间距 3.7pt、同一 x)被焊成一块,
	 * 横跨六列退回段落路径后溢出,那一格只剩下半截。行坐标是 top-down,这里换算成 PDF y。
	 */
	grid?: BorderGrid | null;
	grids?: BorderGrid[];
}

export interface SpanBuildResult {
	blocks: SourceBlock[];
	referencesStarted: boolean;
}

/**
 * Which line indices fall inside a detected table region (1.2.0). Runs the same
 * geometric table detector used downstream, but at the LINE level — before prose
 * paragraph grouping welds the grid — so those lines can be held out and gridded
 * cleanly. Conservative by construction: detectTableRegions needs ≥4 aligned
 * numeric-dense cells (or a Table caption), so a prose page yields an empty set
 * and the whole reorder is inert.
 */
export function detectTableLineIndices(lines: SpanLine[], pageHeight: number, em: number, obstaclesPdf: Rect[] = [], anchors:SourceBlock[]=[]): Set<number> {
	const out = new Set<number>();
	if (lines.length < 6) {
		return out;
	}
	const items = lines.map((l, i) => ({
		id: String(i),
		text: lineText(l),
		type: 'paragraph' as const,
		box: { left: l.rect[0], top: pageHeight - l.rect[3], width: l.rect[2] - l.rect[0], height: l.rect[3] - l.rect[1] },
		fontSize: l.fontSize
	}));
	// 图片矩形转 top-down 后作为列合并的硬屏障 (1.2.2): 两个数值簇之间隔着一张
	// 图,就绝不是同一张表的相邻列。
	const obstacleBoxes = obstaclesPdf.map(r => ({
		left: r[0], top: pageHeight - r[3], width: r[2] - r[0], height: r[3] - r[1]
	}));
	const guard = detectTableRegions([...items,...anchors.filter(b=>b.type==='table').map(b=>({id:b.id,text:b.sourceText,type:'table',box:{left:b.sourceRegion!.boundsPdf[0],top:pageHeight-b.sourceRegion!.boundsPdf[3],width:b.sourceRegion!.boundsPdf[2]-b.sourceRegion!.boundsPdf[0],height:b.sourceRegion!.boundsPdf[3]-b.sourceRegion!.boundsPdf[1]},fontSize:b.fontSize}))], em, obstacleBoxes);
	if (!guard.regions.length && !guard.textRegions.length) {
		return out;
	}
	for (const id of guard.excluded) {
		const n = Number(id);
		if (Number.isInteger(n)) {
			out.add(n);
		}
	}
	return out;
}

/**
 * Manuscript stamps ("ACCEPTED" / "MANUSCRIPT" at 77pt across a 10pt page,
 * 5.0 校验 2877): one item whose box spans several body rows. Grouped as text it
 * welded "Fuhua Yan, …" + "Funding:" + "The authors declare…" into one 86pt
 * "line". A single all-caps word at ≥4× the page's body size is a watermark:
 * it stays on the original page and is never part of a line.
 */
function dropWatermarkWords(items: SpanItem[]): SpanItem[] {
	if (items.length < 8) return items;
	// Body size = the size that carries most characters.
	const weight = new Map<number, number>();
	for (const i of items) { const f = Math.round((fontSizeOf(i) || 0) * 2) / 2; if (f > 0) weight.set(f, (weight.get(f) ?? 0) + i.text.length); }
	const body = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
	if (!(body > 0)) return items;
	const keep = items.filter(i => !((fontSizeOf(i) || 0) >= body * 4 && /^[A-Z][A-Z\- ]{3,24}$/.test(i.text.trim()) && !/\s{2,}/.test(i.text)));
	return keep.length === items.length ? items : keep;
}

export function buildBlocksFromSpans(items: SpanItem[], options: SpanBuildOptions): SpanBuildResult {
	items=removeCollapsedTextCopies(items);
	items=dropWatermarkWords(items);
	items=dropRotatedTableRemnants(items, options.pageWidth || 612);
	if (options.legendSegmentsPdf?.length) {
		const legends = extractLegendItems(items, { pageIndex: options.pageIndex,
			pageWidth: options.pageWidth || 612, pageHeight: options.pageHeight,
			segments: options.legendSegmentsPdf, obstacles: options.imageRectsPdf });
		if (legends.blocks.length) {
			const rest = buildBlocksFromSpans(legends.rest, { ...options, legendSegmentsPdf: undefined });
			return { ...rest, blocks: [...rest.blocks, ...legends.blocks] };
		}
	}
	const ruleRows=decorativeTextRows(items);
	const rules=new Set(ruleRows.flat());
	if (rules.size) {
		items=items.filter(i=>!rules.has(i));
		options={...options,textRuleRectsPdf:[...(options.textRuleRectsPdf??[]),...ruleRows.map(rectOf)]};
	}
 // A structured full-width abstract can outvote the two small columns below
 // it. Extract an isolated lower two-column band independently, including its
 // local font size, instead of interleaving affiliation and body lines.
 if(options.pageIndex===0) {
  const width=options.pageWidth||612;
  const wide=groupIntoLines(items,width,options.pageHeight).filter(i=>i.rect[2]-i.rect[0]>width*.62);
  let cut=wide.length?Math.min(...wide.map(i=>i.rect[1])):0;
  let previous=cut;
  for(const line of items.filter(l=>l.rect[3]<cut).sort((a,b)=>b.rect[3]-a.rect[3])) {
   if(previous-line.rect[3]>15){cut=previous;break;}
   previous=Math.min(previous,line.rect[1]);
  }
  const lower=items.filter(i=>i.rect[3]<cut);
  if(lower.length>=15 && cut>0 && cut<options.pageHeight*.45) {
   const rows=groupIntoLines(lower,width,options.pageHeight);
   const bands=detectColumns(rows.map(l=>l.rect),width,options.pageHeight);
   const top=Math.max(...lower.map(i=>i.rect[3]));
   const sizes=bands.map((_,col)=>dominantFontSize(lower.filter(i=>columnOf(i.rect,bands,width)===col).map(i=>i.fontSize||8)));
   if(bands.length===2 && Math.max(...sizes)/Math.min(...sizes)>=1.3 && cut-top>15 && bands.every(b=>rows.filter(l=>l.rect[0]>=b.left-2 && l.rect[2]<=b.right+2).length>=5)
    && lower.every(i=>columnOf(i.rect,bands,width)>=0)) {
    const rest=buildBlocksFromSpans(items.filter(i=>!lower.includes(i)),options);
    const blocks=bands.flatMap((_,col)=>buildBlocksFromSpans(lower.filter(i=>columnOf(i.rect,bands,width)===col),options).blocks.map(b=>({...b,column:col})));
    const all=[...rest.blocks,...blocks];
    return {...rest,blocks:all.map((b,i)=>({...b,id:`page-${options.pageIndex}-local-${i}`,order:i}))};
   }
  }
 }

 const panels=extractPanelTitles(items,options.pageIndex,options.pageHeight);
 if(panels.blocks.length){const rest=buildBlocksFromSpans(panels.rest,{...options,panelAnchors:[...(options.panelAnchors??[]),...panels.blocks]});return {...rest,blocks:[...rest.blocks,...panels.blocks]};}
	const formulas = separateDisplayFormulas(items, options.pageIndex, options.pageHeight);
	if (formulas.blocks.length) {
		const rest = buildBlocksFromSpans(formulas.rest, options);
		return { ...rest, blocks: [...rest.blocks, ...formulas.blocks] };
	}
	const pageWidth = options.pageWidth && options.pageWidth > 0 ? options.pageWidth : 612;
	const glossary = extractAbbreviationTables(items, options.pageIndex, pageWidth, options.pageHeight);
	if (glossary.cells.length) {
		const rest = buildBlocksFromSpans(glossary.rest, options);
		return { ...rest, blocks: [...rest.blocks, ...glossary.cells] };
	}
	// Label/value tables must claim source runs before prose grouping joins
	// descriptions across rows or a coarse outer frame obscures the two columns.
	const twoColumn = extractTwoColumnTables(items, options.pageIndex, options.pageHeight);
	if (twoColumn.blocks.length) {
		const rest = buildBlocksFromSpans(items.filter(i => !twoColumn.used.has(i)), options);
		return { ...rest, blocks: [...rest.blocks, ...twoColumn.blocks] };
	}
	const descriptive=extractDescriptiveTables(groupIntoLines(items,pageWidth,options.pageHeight),options.pageIndex,options.pageHeight);
 if(descriptive.blocks.length) {
  const rest=buildBlocksFromSpans(items.filter(i=>!descriptive.used.has(i)),options);
  return {...rest,blocks:[...rest.blocks,...descriptive.blocks]};
 }
	const obstacles = options.imageRectsPdf ?? [];
	const captionRegions = obstacles.length ? imageCaptionRegions(groupIntoLines(items,pageWidth,options.pageHeight).map(l=>({text:lineText(l),rect:l.rect,fontSize:l.fontSize})),obstacles) : [];
	const filteredItems = obstacles.length
		? items.filter(i => !insideObstacle(i.rect, obstacles) || withinCaption(i.rect,captionRegions))
		: items;
	if (!options.regionsAssigned) {
		const owned=captionOwnership(groupIntoRows(filteredItems),options.pageIndex,pageWidth);
		if(owned.length) {
			const claimed=new Set(owned.flatMap(c=>c.rows.flat()));
			const rest=buildBlocksFromSpans(filteredItems.filter(i=>!claimed.has(i)),{...options,regionsAssigned:true});
			const ownerBands=detectColumns(filteredItems.map(i=>i.rect),pageWidth,options.pageHeight);
			const captions:SourceBlock[]=owned.map(({region,rows},index)=>{
				const rect=region.boundsPdf;
				const lines=rows.map(items=>({items,rect:rectOf(items),fontSize:sizeOf(items)}));
				return {id:region.id,pageIndex:options.pageIndex,order:rest.blocks.length+index,type:'caption',
					sourceText:joinLines(lines.map(lineText)),lineRectsPdf:lines.map(l=>l.rect),fontSize:sizeOf(rows.flat()),
					boundingBox:{x:rect[0],y:options.pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},
					column:columnOf(rect,ownerBands,pageWidth),sourceRegion:region};
			});
			markImageCaptions(captions,captionRegions);
			return {...rest,blocks:[...rest.blocks,...captions]};
		}
	}
	// Grid columns separate source runs BEFORE line grouping can weld neighbouring cells.
	const gridList=options.grids ?? (options.grid ? [options.grid] : []);
	const buckets=new Map<string,SpanItem[]>();
	for(const item of filteredItems) {
		let key='prose';
		for(let gi=0;gi<gridList.length;gi++) {
			const grid=gridList[gi]!;
			const row=rowOfTop(grid,options.pageHeight-(item.rect[1]+item.rect[3])/2);
			const col=columnOfX(grid,(item.rect[0]+item.rect[2])/2);
			if(row>=0 && col>=0) {key=`${gi}:${row}:${col}`;break;}
		}
		const list=buckets.get(key) ?? [];list.push(item);buckets.set(key,list);
	}
	// 5.0: on a reference list, wide justified word gaps are not gutters (see groupIntoLines).
	// Only continuation pages: a page carrying its own References heading keeps
	// the heading-driven behaviour (body above, list below).
	const pageRawText = filteredItems.map(i => i.text).join(' ');
	const referenceText = !REFERENCES_HEADING_HINT.test(pageRawText) && looksLikeReferenceText(pageRawText);
	const lines=[...buckets.values()].flatMap(items=>groupIntoLines(items,pageWidth,options.pageHeight,referenceText,options.knownGutters ?? []));

	// 页面正文字号 = 行字号的众数,不是中位数 (1.2.5)。封面页的前置件
	// (7pt 作者单位 17 行 + 8.5pt 摘要 18 行) 在行数上压过 10pt 正文 (28 行),
	// 中位数落在 8.5 —— 于是每一行 10pt 正文 ratio=1.176 ≥ 1.1 全部被判成
	// heading,逐行走 heading 通道后大面积 unrecovered,译文页整栏保留英文。
	// 众数(0.5pt 桶、平票取大)正确取到 10。
	const bodySize = pageBodySize(lines);

	// 表格行先摘出去 (1.2.0): 数值表的行/列本是网格,但 groupIntoParagraphs 是给
	// 散文设计的 —— 它把标签列跨行黏成一堵墙、把数字列纵向并块,等 structureTableCells
	// 拿到时网格早已被毁 (NEJM「Clinical and Imaging Outcomes」的标签列坍成一块
	// 443 字符、数字列碎成两行小表)。所以先在「行」这一层探出表格区域,把落在表格
	// 里的行整条摘出散文分组,各自成一行块,交给下游 structureTableCells 重新组网格
	// (标签列作 tableCol=0)。非表格页探不到区域 → 摘出集为空 → 行为与从前逐字节
	// 一致,不影响任何非表格版面。
	// 5.0 (联网校验 3384 p10): a reference list is never a table. Justified
	// entries leave aligned word gaps that the table detector reads as columns
	// and split entry 36 into nine cells. The page is a reference list when an
	// earlier page started the references, or when its own lines say so.
	const lineTexts = lines.map(lineText);
	// 5.0 全篇样式 (校验 r22): lines repeated at one spot across the document.
	// A sidebar nav item "References" (3165, every page) is not this page's heading.
	const furnitureSet = new Set(options.furniture?.length ? lines.filter((l, i) => isFurnitureLine(options.furniture, lineTexts[i]!, l.rect)) : []);
	// 校验 r23 (3200): a book repeats "BIBLIOGRAPHY" as the running head of
	// every list page. Inside a reference range that started earlier, a heading
	// in the top margin is that running head, not a new list's heading.
	const runningListHead = (l: SpanLine): boolean => !!options.referencesAlreadyStarted
		&& options.pageHeight > 0 && l.rect[1] > options.pageHeight * 0.9;
	const referenceHeadingHere = lineTexts.some((t, i) => REFERENCES_HEADINGS.test(t.trim()) && !furnitureSet.has(lines[i]!) && !runningListHead(lines[i]!));
	// Line texts carry superscript labels ("⁷S. Rathee") that raw items do not ("7", "S. Rathee").
	const referenceListByContent = !referenceHeadingHere && !REFERENCES_HEADING_HINT.test(pageRawText)
		&& (referenceText || looksLikeReferenceText(lineTexts.join(' '))) && looksLikeReferencePage(lineTexts);
	// 5.0 全篇样式: referencesAlreadyStarted now comes from the document's
	// reference ranges and ENDS with them, so a continuation page can skip table
	// detection too — before, it never ended and every table page after the
	// references would have lost its tables. Journal lines ("Int J Stroke 2012;
	// 17:18-29") no longer split off as "cells" that are not references.
	// Only when the page's own lines are entries (≥1/4 start one): a real table
	// on a page inside the reference range keeps its table detection.
	const entryLineShare = lineTexts.length
		? lineTexts.filter(t => startsReferenceEntry(t) || startsUnnumberedEntry(t)).length / lineTexts.length : 0;
	const referencePageKnown = referenceListByContent
		|| (!!options.referencesAlreadyStarted && !referenceHeadingHere && entryLineShare >= 0.25);
	const indexPage = !referencePageKnown && looksLikeIndexPage(lineTexts);
	// 校验 r23 (3200, a 774-page book: no document style): a list page headed by
	// its "BIBLIOGRAPHY" at the top is a list from top to bottom — its entry tails
	// ("2(5):270–305, 1996.") are not table cells.
	const headedListPage = options.pageHeight > 0 && looksLikeReferencePage(lineTexts)
		&& lines.some((l, i) => REFERENCES_HEADINGS.test(lineTexts[i]!.trim()) && l.rect[1] > options.pageHeight * 0.85);
	const tableLineIdx = referencePageKnown || indexPage || headedListPage ? new Set<number>() : detectTableLineIndices(lines, options.pageHeight, Math.max(6, bodySize || 10), obstacles,options.panelAnchors);
	const proseLines = tableLineIdx.size ? lines.filter((_, i) => !tableLineIdx.has(i)) : lines;
 // After isolating numbered panels, order prose using prose columns, not
 // numeric table columns: a short paragraph tail must stay between its lines.
 if(options.panelAnchors?.length) {
  const proseBands=detectColumns(proseLines.map(l=>l.rect),pageWidth,options.pageHeight);
  proseLines.sort((a,b)=>columnOf(a.rect,proseBands,pageWidth)-columnOf(b.rect,proseBands,pageWidth)||b.rect[3]-a.rect[3]||a.rect[0]-b.rect[0]);
 }
	const gridRows = (options.grids ?? (options.grid ? [options.grid] : [])).map(g => gridRowBarriers(g, options.pageHeight));
	// 5.0 全篇样式 (校验 r22): page furniture is grouped on its own. Left in the
	// stream, a footer joined the column's last sentence (3036 "We compared the
	// Choi HK, Burns LC…"), the page number joined the first line (2852 "e345
	// when appropriate"), and a sidebar nav cut the body into line-long blocks
	// (3165 "Chapter Outline").
	const furnitureLines = furnitureSet.size ? proseLines.filter(l => furnitureSet.has(l)) : [];
	const streamLines = furnitureLines.length ? proseLines.filter(l => !furnitureSet.has(l)) : proseLines;
	const paragraphs = joinContactStacks(gridRows.reduce((groups, rows) => mergeGridCellStacks(groups, rows, gridRows),
		[...groupIntoParagraphs(streamLines, pageWidth, options.pageHeight, [...obstacles,...(options.textRuleRectsPdf??[])], gridRows,
			{
				referencePage: referencePageKnown || (!!options.referencesAlreadyStarted && !referenceHeadingHere),
				// The heading line itself; with the document style, only on a page where a
				// reference range really starts (3332 p1 has a lone "References" line).
				referenceHeadingRect: referenceHeadingHere && options.referencesStartHere !== false
					? lines.find(l => REFERENCES_HEADINGS.test(lineText(l).trim()) && !furnitureSet.has(l) && !runningListHead(l))?.rect : undefined,
				paragraphIndent: options.paragraphIndent,
				bodyFontSize: options.bodyFontSize,
				indexPage,
				...(furnitureLines.length ? { medianLineWidth: medianLineWidthOf(proseLines) } : {})
			}), ...groupIntoParagraphs(furnitureLines, pageWidth, options.pageHeight)]));

	// 5.0 第 5 步 (校验 r22, 2852 p50): a block inside a ruled table carries
	// that table's horizontal rules as layout barriers, so the region coalescer
	// never welds two cells of one column across a rule ("B-NR" + the knowledge
	// byte below it). Rules are given a 4pt band: a hairline would not count as
	// lying between two blocks.
	// Only the rules between rows, and only for a block wholly inside the table:
	// a caption or a table note beside a ruled frame is not cut by it.
	const gridRules: Rect[][] = gridRows.map(r => {
		const top = Math.max(...r.ys), bottom = Math.min(...r.ys);
		return r.ys.filter(y => y < top - 0.5 && y > bottom + 0.5).map(y => [r.left, y - 2, r.right, y + 2] as Rect);
	});
	const layoutBarriersFor = (rect: Rect): Pick<SourceBlock, 'layoutBarriersPdf'> => {
		const rules = gridRows.flatMap((r, i) => {
			const top = Math.max(...r.ys), bottom = Math.min(...r.ys);
			return rect[0] >= r.left - 1 && rect[2] <= r.right + 1 && rect[1] >= bottom - 1 && rect[3] <= top + 1 ? gridRules[i]! : [];
		});
		const all = [...(options.textRuleRectsPdf ?? []), ...rules];
		return all.length ? { layoutBarriersPdf: all.map(r => [...r] as Rect) } : {};
	};
	// Materialise, then repair anything still split mid-sentence.
	const bands = detectColumns(lines.map(l => l.rect), pageWidth, options.pageHeight);
	const draft = paragraphs.map((group) => {
		// joinLines de-hyphenates line-broken words (ional/est/sory residue) and
		// joins CJK without spaces, instead of the naive space-join that left the
		// broken-word fragments in the source text.
		const text = joinLines(group.map(lineText));
		let rect = group[0]!.rect;
		for (const l of group) {
			rect = union(rect, l.rect);
		}
		// Representative size = the MODE of the paragraph's line sizes, not the
		// first line's: line one may carry a drop cap, a superscript-heavy
		// span, or a heading-styled lead-in, and using it skewed the whole
		// block's translated type size.
		const repSize = dominantFontSize(group.map(l => l.fontSize)) || group[0]!.fontSize;
		const type = classify(text, repSize, bodySize, group.length, group.map(lineText), false, group.every(lineIsBold));
		// Body text is typeset at the MINIMUM of its own body cluster (drop
		// caps and superscripts excluded); headings keep the dominant size.
		const fontSize = (type === 'paragraph' || type === 'list' || type === 'caption')
			? (replacementFontSize(group.map(l => l.fontSize)) || repSize)
			: repSize;
		return {
			group,
			text,
			rect,
			column: columnOf(rect, bands, pageWidth),
			type,
			fontSize,
			gapAfter: undefined as number | undefined,
			isTableLine: false
		};
	}).filter(p => p.text.length >= 2 || (p.text.length === 1 && gridList.some(g=>columnOfX(g,(p.rect[0]+p.rect[2])/2)>=0 && rowOfTop(g,options.pageHeight-(p.rect[1]+p.rect[3])/2)>=0)));
	// 5.1: a bold heading that wraps after a function word ("Diseases of the" /
	// "Biliary Tract", 3165) arrives as two short lines; rejoin them.
	for (let i = draft.length - 1; i > 0; i--) {
		const p = draft[i]!, prev = draft[i - 1]!;
		if (prev.type !== 'heading' || p.type !== 'heading' || !prev.group.every(lineIsBold) || !p.group.every(lineIsBold)) continue;
		if (!/\b(?:of|the|and|for|in|to|with|on|a|an|or|by|from)$/i.test(prev.text.trim()) || !linesShareColumn(prev.rect, p.rect)) continue;
		const size = prev.fontSize > 0 ? prev.fontSize : 10;
		const gap = prev.rect[1] - p.rect[3];
		if (gap > size * 1.2 || gap < -size * 0.5) continue;
		prev.group = [...prev.group, ...p.group];
		prev.text = joinLines(prev.group.map(lineText));
		prev.rect = union(prev.rect, p.rect);
		draft.splice(i, 1);
	}
	for (let i = 0; i < draft.length - 1; i++) {
		draft[i]!.gapAfter = draft[i]!.rect[1] - draft[i + 1]!.rect[3];
	}
	// 5.1: a short bold line under a line that has not finished its sentence is
	// a bold word in running text ("…either Mono+ or" / "Conv. CT.", 3225), not a
	// subheading — it stays a paragraph so the merge below can rejoin it.
	for (let i = 1; i < draft.length; i++) {
		const p = draft[i]!, prev = draft[i - 1]!;
		if (p.type !== 'heading' || !p.group.every(lineIsBold) || prev.type !== 'paragraph' && prev.type !== 'list') continue;
		const size = prev.fontSize > 0 ? prev.fontSize : 10;
		if (!/[.:!?)\]]$/.test(prev.text.trim()) && linesShareColumn(prev.rect, p.rect)
			&& prev.gapAfter !== undefined && prev.gapAfter <= size * 1.2 && prev.gapAfter >= -size * 0.5) p.type = 'paragraph';
	}

	// An index page keeps its one-entry-per-line paragraphs (校验 r23, 3200).
	const entryParagraph = (i: number): boolean => indexPage || draft[i]!.group.some(l => ENTRY_LINES.has(l));
	const merged = planMerges(draft).flatMap(indexes => indexes.some(entryParagraph) ? indexes.map(i => [i]) : [indexes]).flatMap(indexes => {
  const groups: number[][] = [];
  for (const index of indexes) {
   const last = groups[groups.length - 1];
   const isPageNumber=(i:number):boolean=>draft[i]!.rect[3]<options.pageHeight*0.1 && /^\d{1,4}$/.test(draft[i]!.text.trim());
   if (!last || isPageNumber(last[last.length-1]!) || isPageNumber(index) || semanticBoundary(draft[last[last.length - 1]!]!.text, draft[index]!.text)
    || obstacleBetween(draft[last[last.length-1]!]!.rect,draft[index]!.rect,options.textRuleRectsPdf??[])
    // 5.0 第 5 步 (校验 r22, 2852 p50): a table rule is a hard edge for the
    // continuation repair too. Paragraph grouping already stops at it, but this
    // merge rejoined what grouping kept apart — the section heading, recommendation
    // 1, its knowledge byte and recommendation 2, four cells, became one block.
    || (gridRows.length > 0 && gridRowBetween(draft[last[last.length-1]!]!.rect,draft[index]!.rect,gridRows))) groups.push([index]);
   else last.push(index);
  }
  return groups;
 }).map((indexes) => {
		const members = indexes.map(i => draft[i]!);
		const head = members[0]!;
		let rect = head.rect;
		let text = '';
		const group: SpanLine[] = [];
		for (const p of members) {
			rect = union(rect, p.rect);
			text = joinFragments(text, p.text);
			group.push(...p.group);
		}
		// A merge must re-derive its representative size from ALL member lines
		// — inheriting the head's alone re-introduces the first-line skew.
		const sizes = group.map(l => l.fontSize);
		const fontSize = (head.type === 'paragraph' || head.type === 'list' || head.type === 'caption')
			? (replacementFontSize(sizes) || head.fontSize)
			: (dominantFontSize(sizes) || head.fontSize);
		return { ...head, rect, text, group, fontSize };
	});

	// Caption label reunification. PDF.js frequently tears "Figure 6:" off
	// its caption text: the label alone classifies as a caption, and the
	// description behind it degrades to ordinary body text (translated and
	// re-flowed away from its figure) while the tiny English label survives
	// untouched. A bare label merges with the block that follows it in the
	// same column, and the union is a caption.
	for (let i = merged.length - 2; i >= 0; i--) {
		const label = merged[i]!;
		const rest = merged[i + 1]!;
		if (!isBareFigureLabel(label.text)) {
			continue;
		}
		const vGap = label.rect[1] - rest.rect[3];
		const hOverlap = Math.min(label.rect[2], rest.rect[2]) - Math.max(label.rect[0], rest.rect[0]);
		const em = Math.max(label.fontSize, 6);
		if (vGap > em * 1.6 || vGap < -em * 1.2 || hOverlap < -em) {
			continue;
		}
		const rect = union(label.rect, rest.rect);
		const group = [...label.group, ...rest.group];
		merged.splice(i, 2, {
			...label,
			rect,
			text: joinFragments(label.text, rest.text),
			group,
			type: 'caption',
			fontSize: replacementFontSize(group.map(l => l.fontSize)) || rest.fontSize
		});
	}

	// 标题折行合并 (2.6.0, radiology2023-p1 / booz2019-p1 实证): 大标题折成
	// 多行时,窄行被 columnOf 判进第 0 栏、全宽行判 -1,阅读序把它们隔开,
	// 每行成了独立 title 块分开翻译 —— 上半句与下半句各自无语境,中文里连
	// 不成一句。按【几何】不按数组邻接: 全部 title 块按页面自上而下排,
	// 同字号 (±10%)、竖向紧邻 (≤1.3em) 的链合并为一个块,文本按视觉行序拼接。
	{
		const titles = merged.map((p, i) => ({ p, i })).filter(x => x.p.type === 'title');
		if (titles.length >= 2) {
			const sorted = [...titles].sort((x, y) => y.p.rect[3] - x.p.rect[3]);
			const chains: typeof sorted[] = [];
			let chain = [sorted[0]!];
			for (let k = 1; k < sorted.length; k++) {
				const prev = chain[chain.length - 1]!.p;
				const next = sorted[k]!.p;
				const em = Math.max(prev.fontSize, 6);
				const gap = prev.rect[1] - next.rect[3];
				const sizeClose = Math.abs(prev.fontSize - next.fontSize)
					<= Math.max(prev.fontSize, next.fontSize) * 0.1;
				// Wrapped titles need vertical stacking or adjacent fragments of one line.
				// Larger table labels are also classified as titles: allowing a
				// negative full-line gap welded adjacent cells on the same row.
				const horizontalOverlap = Math.min(prev.rect[2], next.rect[2])
					- Math.max(prev.rect[0], next.rect[0]);
				const stacked = next.rect[3] <= (prev.rect[1] + prev.rect[3]) / 2;
				const nextFirstLine = next.group.reduce((a, b) => a.rect[3] >= b.rect[3] ? a : b).rect;
				const sameLineAdjacent = prev.group.length === 1
					&& Math.abs(prev.rect[3] - nextFirstLine[3]) <= em * 0.2
					&& nextFirstLine[0] >= prev.rect[2] && nextFirstLine[0] - prev.rect[2] <= em * 0.75;
				if (sizeClose && (sameLineAdjacent
					|| (stacked && horizontalOverlap > 0 && gap >= -em * 0.25 && gap <= em * 1.3))) {
					chain.push(sorted[k]!);
				}
				else {
					chains.push(chain);
					chain = [sorted[k]!];
				}
			}
			chains.push(chain);
			const remove = new Set<number>();
			for (const c of chains) {
				if (c.length < 2) {
					continue;
				}
				const head = c.reduce((x, y) => (x.i < y.i ? x : y));
				let rect = c[0]!.p.rect;
				let text = '';
				const group: SpanLine[] = [];
				for (const part of c) {
					rect = union(rect, part.p.rect);
					text = joinFragments(text, part.p.text);
					group.push(...part.p.group);
				}
				merged[head.i] = { ...head.p, rect, text, group };
				for (const part of c) {
					if (part.i !== head.i) {
						remove.add(part.i);
					}
				}
			}
			for (const i of [...remove].sort((x, y) => y - x)) {
				merged.splice(i, 1);
			}
		}
	}

	// Table lines rejoin here as one-line blocks (never through prose grouping,
	// planMerges or caption reunification), so structureTableCells sees a clean
	// per-cell grid — labels included — instead of a collapsed wall.
	const tableParas = [...tableLineIdx].sort((a, b) => a - b).map((i) => {
		const line = lines[i]!;
		const text = joinLines([lineText(line)]);
		const type = classify(text, line.fontSize, bodySize, 1, [lineText(line)], true);
		const fontSize = (type === 'paragraph' || type === 'list' || type === 'caption')
			? (replacementFontSize([line.fontSize]) || line.fontSize)
			: line.fontSize;
		return {
			group: [line],
			text,
			rect: line.rect,
			column: columnOf(line.rect, bands, pageWidth),
			type,
			fontSize,
			gapAfter: undefined as number | undefined,
			isTableLine: true
		};
	}).filter(p => p.text.length >= 1);

	// Content-detected pages mark references block by block (below): Medical
	// Physics prints its references as column footnotes on body pages, and a
	// page-wide flag would turn the Conclusion into a bibliography entry.
	let referencesStarted = !!options.referencesAlreadyStarted;
	// 字距拉开的标题 (2.7.2, 审核 C-2, jacc2020-p15 实证): "R E F E R E N C E S"
	// 由单字母 span 拼成,字号与正文同,分类落成 paragraph —— 只认 heading/title
	// 就永远认不出它。整块只有一行、且整行就是这个词时,类型不再是门槛。
	const isReferencesHeadingBlock = (p: { type: string; text: string; group: unknown[] }): boolean =>
		(p.type === 'heading' || p.type === 'title' || p.group.length === 1) && REFERENCES_HEADINGS.test(p.text)
		&& !(p.group as SpanLine[]).every(l => furnitureSet.has(l));
	// 分带页的标题矩形预扫 (2.7.2): merged 序是按带/栏排的,文献三栏里排在标题
	// 之前的块若只看"序后即文献"就漏掉 —— 先找出本页的文献标题,几何判定不依赖序。
	const referencesHeadingRect: Rect | undefined = merged.find(p => isReferencesHeadingBlock(p))?.rect;
	const referenceByGeometry = (rect: Rect, heading: Rect, stamp: (r: Rect) => number): boolean => {
		const bandOf = (r: Rect) => Math.floor(stamp(r) / 100);
		const headingBand = bandOf(heading);
		const band = bandOf(rect);
		// 校验 r23 (2845 p9): a heading sitting in the gap between the two-column
		// body and the three-column list belongs to no band (stamp -1); every body
		// block then compared as "a later band" and the Conclusion became a reference.
		// Then position decides: below the heading's top is the list.
		if (headingBand < 0 && band >= 0) return rect[3] <= heading[3] + 1;
		if (band !== headingBand) {
			return band > headingBand;
		}
		// 同带: 顶边 (PDF y 向上) 不高于标题顶边 → 在标题下方。
		return rect[3] <= heading[3] + 1;
	};
	// Column stamp (was MISSING on this path): without it every text-layer
	// block defaulted to column 0 downstream, so semantic modules ran straight
	// through the gutter and the same PDF extracted differently depending on
	// which extraction path won.
	// LINE rects, not merged paragraph rects: a page yields only a handful of
	// paragraphs — too few for the anti-weld coverage vote — and one paragraph
	// whose union rect overhangs the gutter re-welds two columns at the stamping
	// step even after line-level detection got them right (三栏首页回归).
	const columnBands = detectColumns(lines.map(l => l.rect), pageWidth, options.pageHeight);
	// 分带栏归属 (2.5.10): non-null only when the column count changes down the
	// page (2-col body over 3-col references). On every uniform page it is null
	// and the detectColumns/columnOf path below is used unchanged. Fed with the
	// PRE-SPLIT rows (glyph rects per baseline) — the banded gutter vote needs
	// the full-width rows, which the already-column-split `lines` no longer are.
	const bandedStamp = bandedColumnStamp(
		groupIntoRows(filteredItems).map(row => row.map(i => i.rect)),
		pageWidth,
		options.pageHeight,
		// 2.6.0 第二触发: detectColumns 已在上一行算出,把它认出的显著带数
		// 递进去 —— 表格格子把 x 投影焊成假单带时只有分带检测能救。
		columnBands.length
	);
	const stampColumn = (rect: Rect, isTableLine: boolean): number =>
		bandedStamp && !isTableLine ? bandedStamp(rect) : columnOf(rect, columnBands, pageWidth);
	const blocks: SourceBlock[] = [];
	let order = 0;
	for (const p of [...merged, ...tableParas]) {
		let keepReason: PreserveReason | undefined;
		// Table-line blocks bypass the prose furniture filters: a detected table
		// cell is content, never a running head / metadata, and the numeric cells
		// that look furniture-ish must survive to be gridded. The REFERENCES
		// exclusion however applies to them too (1.2.2, 审核项): tableParas are
		// appended after the merged loop, so `referencesStarted` here is the
		// page's final state — on a references(-continuation) page the citation
		// years/numbers must not sneak back in as "table cells" when the user
		// excluded references. Edge case documented: a genuine table ABOVE a
		// same-page References heading is also skipped — it stays untranslated
		// in the original layout, which errs conservative.
		if (p.isTableLine) {
			if (referencesStarted && !options.includeReferences) {
				continue;
			}
		}
		else {
			// 图表说明豁免元数据过滤 (2.5.4, chen2023-p3 语料实证): 图 1 说明整段
			// 消失 —— 这篇的队列名就是医院名(「Huaian set = Affiliated Huaian
			// No. 1 People's Hospital of Nanjing Medical University set; PUMCH
			// set = Peking Union Medical College Hospital set」),looksLikeAffiliation
			// 数到 ≥2 个机构词 + ≥3 个逗号就判作者单位,连同全部缩写定义一起丢掉。
			// caption/table 这两个类型只由「Figure N/Table N」开头产生 —— 那是
			// 内容的自证,作者单位块永远不会这样起头,所以按 title/heading 一样豁免。
			const isFigureOrTableCaption = p.type === 'caption' || p.type === 'table';
			// 内容决策 (2.12.13):不再整块丢弃。标识保留并带原因,自然语言一律翻译。
			if (p.type !== 'title' && p.type !== 'heading' && !isFigureOrTableCaption) {
				const content = classifyContent(p.text, p.rect, pageWidth, { fontSize: p.fontSize, bodySize });
				if (content.decision === 'skip') {
					continue;
				}
				if (content.decision === 'preserve') {
					keepReason = content.reason;
				}
			}
			// Running heads and page-foot lines repeat the journal's furniture on
			// every page. Translating them is pure noise. `title` is exempt: on a
			// cover page with no masthead the paper's own title can sit inside the
			// band, and losing it is far worse than translating one running head.
			// 2.12.13:保留为 preserve('running-head') 而不是丢弃 —— 墨迹几何进遮挡物,摘要里看得见。
			if (isJournalFurniture(p.text, p.rect, options.pageHeight)
				|| p.type !== 'title' && !((p.type === 'heading' || /^\d/.test(p.text.trim())) && isSectionHeadingName(p.text)) && isRunningHeadOrFoot(p.rect, options.pageHeight, p.group.length, p.text)) {
				keepReason = keepReason ?? 'running-head';
			}
			// 字距拉开的标题 (2.7.2, 审核 C-2, jacc2020-p15 实证): "R E F E R E N C E S"
			// 由单字母 span 拼成,字号与正文同,分类落成 paragraph —— 只认
			// heading/title 就永远认不出它。整块文本只有这一个词、且只有一行时,
			// 类型不再是门槛。
			if (isReferencesHeadingBlock(p)) {
				referencesStarted = true;
			}
		}
		// 不译参考文献时保留为 preserve 块 (2.0.8, 审核 P2-5),与 blockBuilder
		// 同规则: 墨迹几何要进 inkObstacles,丢弃即失明。
		// 分带页几何门 (2.7.2): jacc2020-p15 正文双栏在上、文献三栏在下,标题
		// 落在第 0 栏底部;正文第 1 栏在 merged 序里排在标题之后,却在页面上位于
		// 标题上方 —— 按"序后即文献"会把整栏正文冻成 preserve。分带页上:标题所在
		// 带内只有顶边不高于标题顶边的块算文献,后面的带整体算文献。均匀页不变。
		// 5.0 (校验 3358 p12 / 2757 p8): on a page that carries the References
		// heading, entries sitting in a column read BEFORE the heading (Radiology
		// side columns, BMC declarations above the list) were missed and the
		// coalescer welded "9." … "14." into one 1413-character block. A block
		// that itself starts like a numbered entry and carries a year is one.
		const entryByContent = (!!referencesHeadingRect || referenceListByContent) && !p.isTableLine
			&& (startsReferenceEntry(p.text) && /\b(?:19|20)\d{2}\b/.test(p.text)
				|| referenceListByContent && looksLikeBibliographicFragment(p.text));
		const isRef = p.isTableLine ? false
			: entryByContent ? true
			: referencesHeadingRect && bandedStamp
				? referenceByGeometry(p.rect, referencesHeadingRect, bandedStamp)
				: referencesStarted;
		const preserveReference = isRef && !options.includeReferences && !REFERENCES_HEADINGS.test(p.text);
		blocks.push({
			id: `page-${options.pageIndex}-block-${order}`,
			pageIndex: options.pageIndex,
			order,
			type: p.type,
			sourceText: p.text,
			boundingBox: {
				x: p.rect[0],
				y: options.pageHeight - p.rect[3],
				width: p.rect[2] - p.rect[0],
				height: p.rect[3] - p.rect[1]
			},
			lineRectsPdf: p.group.map(l => [...l.rect] as Rect),
			...layoutBarriersFor(p.rect),
			fontSize: p.fontSize,
			column: stampColumn(p.rect, !!p.isTableLine),
			isReference: isRef,
			// 5.0 (校验 r22): owned as furniture, so no shard pass absorbs "e345"
			// into the paragraph beneath it.
			...(furnitureSet.size && p.group.every(l => furnitureSet.has(l))
				? { sourceRegion: { id: `page-${options.pageIndex}-furniture-${order}`, kind: 'page-furniture' as const, boundsPdf: [...p.rect] as Rect, evidence: 'document-repeat' as const } }
				// 校验 r23 (3200 index, 3276 abbreviations): each list entry owns its
				// region, so the coalescer does not weld a column of entries into one block.
				: (indexPage || p.group.some(l => ENTRY_LINES.has(l))) && !p.isTableLine
					? { sourceRegion: { id: `page-${options.pageIndex}-entry-${order}`, kind: 'list-entry' as const, boundsPdf: [...p.rect] as Rect, evidence: 'column-geometry' as const } }
					: {}),
			...(preserveReference
				? { translationMode: 'preserve' as const, preserveReason: 'reference' }
				: keepReason
					? { translationMode: 'preserve' as const, preserveReason: keepReason }
					: (isIdentifierLabel(p.text) ? { translationMode: 'translate' as const } : {}))
		});
		order++;
	}
	markImageCaptions(blocks, captionRegions);
	return { blocks, referencesStarted };
}
