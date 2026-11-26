/**
 * 5.1: row and column headers as understanding-only context for table cells.
 *
 * A cell is translated as a few isolated words. With only the table caption to
 * go on, scanner models in a "CT system" column — "Alpha", "Force" (3023, r24)
 * — came back as 阿尔法 / 力. The header of the cell's column and row tells the
 * model what kind of thing the cell is.
 */
import type { SourceBlock } from '../types/models';

export interface TableHeaders { row?: string; column?: string }

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
const NAME_LIKE = /^(?=.*\p{L})[A-Z0-9][\p{L}\d+.\-]*(?:\s+[A-Z0-9][\p{L}\d+.\-]*){0,2}$/u;

/**
 * 5.1: cells that are product names. The model now copies "Alpha" as asked;
 * the validator used to reject that echo as untranslated and the plain-mode
 * recovery then forced 阿尔法 (3023, device check 11-26). For these cells an
 * echo is accepted.
 */
export function productNameCells(blocks: Cell[]): Set<string> {
	const out = new Set<string>();
	for (const [id, h] of tableHeadersByBlock(blocks)) {
		const text = blocks.find(b => b.id === id)?.sourceText.trim() ?? '';
		if (text.length <= 30 && NAME_LIKE.test(text) && (PRODUCT_HEADER.test(h.row ?? '') || PRODUCT_HEADER.test(h.column ?? ''))) out.add(id);
	}
	return out;
}
