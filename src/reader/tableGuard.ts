/**
 * Table protection for the rebuilt page.
 *
 * Extraction shreds a data table into dozens of tiny "paragraphs" — numbers,
 * units, row labels. Translating those cell fragments and re-flowing them
 * produced translated text stamped across the table (the worst-looking failure
 * the reader sees). Until real Table→Row→Cell re-layout exists, the safe
 * behaviour is: detect the table's rectangle, keep the ENTIRE original table
 * untouched, and forbid the flow from parking anything on it.
 *
 * Detection is geometric + textual, not just the "Table N" prefix:
 *  - cell-like blocks: short, numeric/symbol-dense fragments;
 *  - clusters of them (vertically adjacent, horizontally overlapping) form a
 *    candidate region;
 *  - a cluster counts as a table when it is dense enough on its own, or when
 *    a `Table N`-typed caption sits directly above/below it;
 *  - every block substantially inside the final rectangle is excluded from
 *    translation — including prose-looking row labels the text test misses.
 *
 * Pure geometry over plain boxes — fully unit-testable.
 */

export interface GuardItem {
	id: string;
	text: string;
	type: string;
	box: { left: number; top: number; width: number; height: number };
	fontSize?: number;
}

export interface TableRegion {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Cell-like: short and dominated by digits/symbols rather than prose. */
export function looksTabular(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 160) {
		return false;
	}
	const letters = (t.match(/[A-Za-z一-鿿]/g) ?? []).length;
	const digitsAndSymbols = (t.match(/[0-9±%±.,;:()/<>=+\-·—–]/g) ?? []).length;
	const words = t.split(/\s+/).filter(Boolean);
	// Pure numbers / value±sd / ranges — the classic cell.
	if (letters === 0 && digitsAndSymbols > 0) {
		return true;
	}
	// Symbol-dense short fragments: "3.4 ± 1.2 (n=52)" etc.
	if (t.length <= 80 && digitsAndSymbols >= Math.max(3, t.length * 0.3)) {
		return true;
	}
	// Very short label-ish fragments count when they carry a digit OR a
	// measurement symbol ("LVEF, %", "n (%)", "HR ±") — but never plain
	// words, or headings and keywords would be swallowed.
	return words.length <= 3 && /[\d%±<>=/]/.test(t) && t.length <= 40;
}

function vGap(a: TableRegion, b: GuardItem['box']): number {
	if (b.top >= a.top + a.height) {
		return b.top - (a.top + a.height);
	}
	if (b.top + b.height <= a.top) {
		return a.top - (b.top + b.height);
	}
	return 0; // vertically intersecting
}

function hOverlaps(a: TableRegion, b: GuardItem['box'], slack: number): boolean {
	return Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left) > -slack;
}

function grow(region: TableRegion, box: GuardItem['box']): TableRegion {
	const left = Math.min(region.left, box.left);
	const top = Math.min(region.top, box.top);
	return {
		left,
		top,
		width: Math.max(region.left + region.width, box.left + box.width) - left,
		height: Math.max(region.top + region.height, box.top + box.height) - top
	};
}

function containedRatio(box: GuardItem['box'], region: TableRegion): number {
	const w = Math.min(box.left + box.width, region.left + region.width) - Math.max(box.left, region.left);
	const h = Math.min(box.top + box.height, region.top + region.height) - Math.max(box.top, region.top);
	if (w <= 0 || h <= 0 || box.width <= 0 || box.height <= 0) {
		return 0;
	}
	return (w * h) / (box.width * box.height);
}

/**
 * Detect table regions and the blocks to exclude from translation.
 *
 * `emPx` is the body size in page pixels — it scales the clustering gaps.
 */
export function detectTableRegions(
	items: GuardItem[],
	emPx: number
): { excluded: Set<string>; regions: TableRegion[] } {
	const em = Math.max(6, emPx);
	const cells = items.filter(i => looksTabular(i.text));
	const captions = items.filter(i => i.type === 'table');

	// Greedy clustering of cell-like boxes, in reading order.
	let clusters: { region: TableRegion; members: GuardItem[] }[] = [];
	for (const cell of [...cells].sort((a, b) => a.box.top - b.box.top)) {
		let joined = false;
		for (const cluster of clusters) {
			if (vGap(cluster.region, cell.box) <= em * 2.2 && hOverlaps(cluster.region, cell.box, em * 2.5)) {
				cluster.region = grow(cluster.region, cell.box);
				cluster.members.push(cell);
				joined = true;
				break;
			}
		}
		if (!joined) {
			clusters.push({ region: { ...cell.box }, members: [cell] });
		}
	}

	// Merge adjacent clusters transitively: greedy growth splits a table into
	// per-column strips when the column gap sits at the join threshold, and a
	// table is exactly a grid of such strips. Bounded fixed-point.
	for (let pass = 0; pass < 5; pass++) {
		let mergedAny = false;
		for (let i = 0; i < clusters.length; i++) {
			for (let j = clusters.length - 1; j > i; j--) {
				const a = clusters[i]!;
				const b = clusters[j]!;
				const vAdjacent = a.region.top <= b.region.top + b.region.height + em * 2.2
					&& b.region.top <= a.region.top + a.region.height + em * 2.2;
				if (vAdjacent && hOverlaps(a.region, b.region as unknown as GuardItem['box'], em * 3)) {
					a.region = grow(a.region, b.region as unknown as GuardItem['box']);
					a.members.push(...b.members);
					clusters.splice(j, 1);
					mergedAny = true;
				}
			}
		}
		if (!mergedAny) {
			break;
		}
	}

	const excluded = new Set<string>();
	const regions: TableRegion[] = [];
	for (const cluster of clusters) {
		const nearCaption = captions.some(c =>
			vGap(cluster.region, c.box) <= em * 3 && hOverlaps(cluster.region, c.box, em * 2.5));
		// Dense enough on its own, or anchored by a Table caption.
		if (cluster.members.length < 4 && !(cluster.members.length >= 2 && nearCaption)) {
			continue;
		}
		let region = cluster.region;
		// Sweep in the rest of the table the cell test misses: (a) anything
		// substantially INSIDE the region; (b) short row labels/header cells
		// BESIDE it — vertically aligned with the region's rows, horizontally
		// within a couple of ems. Long prose stays out even when adjacent, so
		// a body paragraph in the neighbouring column is never swallowed.
		// Growing the region can pull in more blocks; iterate (bounded).
		for (let pass = 0; pass < 4; pass++) {
			let grew = false;
			for (const item of items) {
				if (excluded.has(item.id) || item.type === 'table') {
					continue;
				}
				const inside = containedRatio(item.box, region) >= 0.6;
				let rowAligned = false;
				if (!inside && item.text.trim().length <= 60) {
					const vOverlap = Math.min(item.box.top + item.box.height, region.top + region.height)
						- Math.max(item.box.top, region.top);
					if (vOverlap >= item.box.height * 0.6) {
						const gapLeft = region.left - (item.box.left + item.box.width);
						const gapRight = item.box.left - (region.left + region.width);
						rowAligned = Math.max(gapLeft, gapRight) <= em * 2 || (gapLeft < 0 && gapRight < 0);
					}
				}
				if (inside || rowAligned) {
					excluded.add(item.id);
					const next = grow(region, item.box);
					if (next.width !== region.width || next.height !== region.height) {
						region = next;
						grew = true;
					}
				}
			}
			if (!grew) {
				break;
			}
		}
		for (const member of cluster.members) {
			excluded.add(member.id);
		}
		regions.push(region);
	}
	return { excluded, regions };
}
