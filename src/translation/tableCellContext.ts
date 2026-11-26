/**
 * 5.1: row and column headers as understanding-only context for table cells.
 *
 * A cell is translated as a few isolated words. With only the table caption to
 * go on, scanner models in a "CT system" column — "Alpha", "Force" (3023, r24)
 * — came back as 阿尔法 / 力. The header of the cell's column and row tells the
 * model what kind of thing the cell is.
 */
import type { SourceBlock } from '../types/models';

export interface TableHeaders { row?: string; column?: string; productName?: true }

type Cell = Pick<SourceBlock, 'id' | 'sourceText'> & Partial<Pick<SourceBlock, 'tableId' | 'tableRow' | 'tableCol' | 'tableRowSpan' | 'tableColSpan' | 'translationMode'>>;

const MAX_HEADER_CHARS = 120;

const isCell = (b: Cell): b is Cell & { tableId: string; tableRow: number; tableCol: number } =>
	typeof b.tableId === 'string' && typeof b.tableRow === 'number' && typeof b.tableCol === 'number';

/** Does a cell cover the given row / column (spans included)? */
const coversCol = (b: Cell & { tableCol: number }, col: number): boolean => col >= b.tableCol && col < b.tableCol + (b.tableColSpan ?? 1);
const coversRow = (b: Cell & { tableRow: number }, row: number): boolean => row >= b.tableRow && row < b.tableRow + (b.tableRowSpan ?? 1);

const clean = (text: string | undefined): string | undefined => {
	const t = text?.replace(/\s+/g, ' ').trim();
	return t && t.length <= MAX_HEADER_CHARS && /\p{L}/u.test(t) ? t : undefined;
};

/**
 * Headers for every cell of every structured table on the page: the header-row
 * (row 0) cell above it and the first-column cell beside it. The header row gets
 * nothing; a first-column cell gets its column header only.
 */
export function tableHeadersByBlock(blocks: Cell[]): Map<string, TableHeaders> {
	const out = new Map<string, TableHeaders>();
	const byTable = new Map<string, Array<Cell & { tableId: string; tableRow: number; tableCol: number }>>();
	for (const b of blocks) if (isCell(b)) (byTable.get(b.tableId) ?? byTable.set(b.tableId, []).get(b.tableId)!).push(b);
	for (const cells of byTable.values()) {
		if (cells.length < 4) continue;
		for (const cell of cells) {
			const column = cell.tableRow > 0 ? clean(cells.find(c => c.tableRow === 0 && coversCol(c, cell.tableCol))?.sourceText) : undefined;
			const row = cell.tableCol > 0 && cell.tableRow > 0 ? clean(cells.find(c => c.tableCol === 0 && coversRow(c, cell.tableRow))?.sourceText) : undefined;
			const own = clean(cell.sourceText);
			const headers: TableHeaders = {
				...(column && column !== own ? { column } : {}),
				...(row && row !== own ? { row } : {})
			};
			if (headers.column || headers.row) out.set(cell.id, headers);
		}
	}
	return out;
}

/** Header words that say the column / row lists products: scanners, systems, software. */
const PRODUCT_HEADER = /\b(?:scanners?|systems?|models?|devices?|vendors?|manufacturers?|software|platforms?|products?|machines?|equipment|kernels?|algorithms?)\b/i;
/** One to three capitalised or alphanumeric words: "Alpha", "Naeotom Alpha", "SOMATOM Force", "Revolution CT". */
const NAME_LIKE = /^(?=.*\p{L})[A-Z0-9][\p{L}\d+./\-]*(?:\s+[A-Z0-9][\p{L}\d+./\-]*){0,2}$/u;

/** A short label naming a product category — not a prose row that mentions "food manufacturers" (3064) or "Devices to …" (2852). */
const productHeader = (header: string | undefined): boolean => !!header && header.length <= 40 && PRODUCT_HEADER.test(header);

/** A cell listing names: "Alpha", "Edge/Edge+, Force", "Revolution CT and Force". */
const nameParts = (text: string): string[] | null => {
	const t = text.replace(/\s+/g, ' ').trim();
	if (!t || t.length > 60) return null;
	const parts = t.split(/\s*,\s*|\s+and\s+/).filter(Boolean);
	return parts.length > 0 && parts.length <= 4 && parts.every(p => p.length <= 30 && NAME_LIKE.test(p)) ? parts : null;
};

/**
 * 5.1: cells that are product names. The model now copies "Alpha" as asked;
 * the validator used to reject that echo as untranslated and the plain-mode
 * recovery then forced 阿尔法 (3023, device check 11-26). For these cells an
 * echo is accepted.
 *
 * A name listed in a product row is also a name where it comes back elsewhere
 * in the same table: 3023 lists "Edge/Edge+, Force" as the EID CT scanners,
 * then uses "Edge/Edge+" and "Force" as sub-row labels under Collimation, where
 * the only header is "Parameter" (device check 11-26: Force → 力).
 */
export function productNameCells(blocks: Cell[]): Set<string> {
	const out = new Set<string>();
	const namesByTable = new Map<string, Set<string>>();
	for (const [id, h] of tableHeadersByBlock(blocks)) {
		const block = blocks.find(b => b.id === id);
		const parts = nameParts(block?.sourceText ?? '');
		if (!block || !parts || !(productHeader(h.row) || productHeader(h.column))) continue;
		out.add(id);
		const names = namesByTable.get(block.tableId!) ?? namesByTable.set(block.tableId!, new Set()).get(block.tableId!)!;
		for (const part of parts) names.add(part.toLowerCase());
	}
	for (const b of blocks) {
		if (!isCell(b) || out.has(b.id)) continue;
		const text = b.sourceText.replace(/\s+/g, ' ').trim().replace(/:$/, '');
		if (NAME_LIKE.test(text) && namesByTable.get(b.tableId)?.has(text.toLowerCase())) out.add(b.id);
	}
	return out;
}
