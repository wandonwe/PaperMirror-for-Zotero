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
