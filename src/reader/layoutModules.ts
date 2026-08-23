/**
 * Semantic layout modules (spec: "以小标题为语义模块锚点，以原始段落为最小排版
 * 替换单元").
 *
 * A module groups a heading (or another anchor) with the body blocks that
 * follow it, so the whole module can be sent to the model TOGETHER for context.
 * It is a grouping over existing SourceBlocks — it does NOT merge them: every
 * block keeps its own id, rect, font size and translation and is replaced in
 * place independently. A module is never allowed to cross a column, and hard
 * anchors (figures, tables, the references heading) break the running body.
 *
 * Anchors:
 *   - heading / title            → 'heading'            (start of a section)
 *   - caption (Figure/Fig.)      → 'figure'  HARD anchor
 *   - table                      → 'table'   HARD anchor
 *   - references heading         → 'references'         (rest of the doc, by column order)
 *   - body with no heading above → 'column-continuation'(virtual anchor: e.g. the
 *                                   top of the right column continuing a section)
 *
 * Pure module — no DOM, no Zotero APIs, unit-tested.
 */

import type { SourceBlock } from '../types/models';

export type ModuleAnchorType =
	| 'heading'
	| 'column-continuation'
	| 'figure'
	| 'table'
	| 'references';

export interface LayoutModule {
	id: string;
	/** Column this module lives in (-1 = full-width). */
	column: number;
	/** The block id that anchors the module (heading / caption / first body block). */
	anchorId: string;
	anchorType: ModuleAnchorType;
	/** Member block ids in reading order — the anchor is always first. */
	memberIds: string[];
}

const REFERENCES_HEADINGS = /^(references|bibliography|literature\s+cited|参考文献|參考文獻|引用文献)\s*$/i;

const isHeadingType = (b: SourceBlock): boolean => b.type === 'heading' || b.type === 'title';
const isReferencesHeading = (b: SourceBlock): boolean => isHeadingType(b) && REFERENCES_HEADINGS.test(b.sourceText.trim());

/** The anchor type a block would take if it STARTS a module. */
function anchorTypeForStart(b: SourceBlock): ModuleAnchorType {
	if (isReferencesHeading(b)) {
		return 'references';
	}
	if (isHeadingType(b)) {
		return 'heading';
	}
	if (b.type === 'caption') {
		return 'figure';
	}
	if (b.type === 'table') {
		return 'table';
	}
	return 'column-continuation';
}

/**
 * Group a page's ordered blocks into semantic modules. Also stamps each block's
 * `moduleId` so downstream consumers (chunking, overlay, diagnostics) can find
 * a block's module without a second pass.
 */
export function buildLayoutModules(blocks: SourceBlock[]): LayoutModule[] {
	const modules: LayoutModule[] = [];
	let current: LayoutModule | null = null;
	let referencesMode = false;
	const pageIndex = blocks[0]?.pageIndex ?? 0;

	const startModule = (b: SourceBlock, anchorType: ModuleAnchorType): LayoutModule => {
		const m: LayoutModule = {
			id: `page-${pageIndex}-mod-${modules.length}`,
			column: b.column ?? 0,
			anchorId: b.id,
			anchorType,
			memberIds: [b.id]
		};
		modules.push(m);
		b.moduleId = m.id;
		return m;
	};

	const appendTo = (m: LayoutModule, b: SourceBlock): void => {
		m.memberIds.push(b.id);
		b.moduleId = m.id;
	};

	for (const block of blocks) {
		// Once References starts, every following entry joins that module in
		// reading order regardless of column (spec §8).
		if (referencesMode && current) {
			appendTo(current, block);
			continue;
		}

		if (!current) {
			const anchorType = anchorTypeForStart(block);
			current = startModule(block, anchorType);
			referencesMode = anchorType === 'references';
			continue;
		}

		const startsRefs = isReferencesHeading(block);
		const isHeading = isHeadingType(block);
		const isFigure = block.type === 'caption';
		const isTable = block.type === 'table';
		const col = block.column ?? 0;

		let startNew: boolean;
		if (startsRefs || isHeading || isFigure || isTable) {
			// Hard/section anchors start a new module — except consecutive
			// same-kind hard anchors (a multi-part caption, stacked table rows)
			// stay in one module.
			if (current.anchorType === 'figure' && isFigure && !startsRefs) {
				startNew = false;
			}
			else if (current.anchorType === 'table' && isTable && !startsRefs) {
				startNew = false;
			}
			else {
				startNew = true;
			}
		}
		else {
			// A plain body block continues the current module only when that
			// module accepts body AND they share a column. A column change with
			// no heading opens a virtual 'column-continuation' anchor (spec §6).
			const accepts = current.anchorType === 'heading' || current.anchorType === 'column-continuation';
			const sameColumn = current.column === col || col === -1 || current.column === -1;
			startNew = !accepts || !sameColumn;
		}

		if (startNew) {
			const anchorType = anchorTypeForStart(block);
			current = startModule(block, anchorType);
			referencesMode = anchorType === 'references';
		}
		else {
			appendTo(current, block);
		}
	}

	return modules;
}
