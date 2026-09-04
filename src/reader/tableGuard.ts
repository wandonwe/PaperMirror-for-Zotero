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
	// Symbol-dense short fragments: "3.4 ± 1.2 (n=52)" etc. Must contain a DIGIT
	// (1.2.0 fix): an author-initial list ("A.H., H.P., C.J.W., J.K., S.L.") is
	// just as period/comma-dense but is prose, not a cell — without the digit
	// gate it seeded false table clusters in journal author-contribution boxes.
	if (t.length <= 80 && /[0-9]/.test(t) && digitsAndSymbols >= Math.max(3, t.length * 0.3)) {
		return true;
	}
	// Very short label-ish fragments count when they carry a digit OR a
	// measurement symbol ("LVEF, %", "n (%)", "HR ±") — but never plain
	// words, or headings and keywords would be swallowed.
	return words.length <= 3 && /[\d%±<>=/]/.test(t) && t.length <= 40;
}

/**
 * 种子判定 = looksTabular + 散文词闸 (2.5.11, wu2026-p5 实证)。
 *
 * 窄双栏期刊的统计段落几乎每行都长成 "overall image quality (ICC=0.934;
 * 95% CI: 0.898–0.957)" —— 行宽只有 50–60 字符,数字符号密度轻松过 30%,
 * 于是 Results 整段被逐行判成单元格种子,聚成横跨左右两个正文栏的伪表格:
 * 数字行按数据格 preserve 永久留英文,其余行逐格无语境翻译,连字符断词处
 * ("quanti-"/"tatively") 被拦腰切开。
 *
 * 判据: 一行里有 ≥3 个带小写字母的 ≥3 字母普通词,它就是句子,不能当
 * 聚类【种子】。真表格不受影响 —— 数值格零普通词(纯数字规则),而标签格
 * ("Overall image quality") 本来就不靠种子进表,聚类成形后由区域扫掠按行
 * 对齐收进来。
 *
 * 只收窄【种子】: `structureTableCells` 判定格子数据/文本仍用 looksTabular
 * 本体,真表格里 "Significant stenosis present 2.0 (1.17, 3.42) .011" 这类
 * 标签+数值复合行的 preserve 语义逐字节不变 (chen2023-p10 快照零改动)。
 */
export function looksTabularSeed(text: string): boolean {
	if (!looksTabular(text)) {
		return false;
	}
	const proseWords = (text.match(/[A-Za-z]{3,}/g) ?? []).filter(w => /[a-z]/.test(w)).length;
	return proseWords < 3;
}

/**
 * 标题锚判据 (2.6.0): 明确的表标题形态 —— "Table 2:", "Table 4.", "表 3:",
 * 或已被分类为 table 类型的 "Table N …" 标题行。正文里 "Table 3 lists …"
 * 这类【指代】在行级 (type 还是 paragraph) 不带标点,不作锚;块级它可能被
 * classify 误标 table,但锚定后还有网格验收兜底 —— 标题下是正文就一个块
 * 也不收。
 */
export function isTableCaptionAnchor(text: string, type?: string): boolean {
	const t = text.trim();
	if (/^(table|表)\s*(\d+|[IVXLC]+)\s*[.:：]/i.test(t)) {
		return true;
	}
	return type === 'table' && /^(table|表)\s*(\d+|[IVXLC]+)\b/i.test(t) && t.length <= 160;
}

/**
 * 文本表网格验收 (2.6.0): 锚定扫掠收进来的块必须自己长成网格,否则一个也
 * 不收 (悬空标题下的正文绝不能被吞)。三条都要过:
 *  - ≥2 个左缘列簇 (每簇 ≥2 块): 表格列左对齐;
 *  - 存在【标签列】—— 某个 ≥3 块的列簇里最宽的块也不超过区宽的 35%。
 *    这是表格与"标题悬空、下方是双栏正文"最硬的区别: 正文栏的行宽
 *    ≈ 半区宽 (~50%),表格的词条/缩写列天然窄 (radiology2023 实测
 *    9%–28%)。行组间隙判据在紧排表格上不可用 (行距 4pt < 任何 em 阈),
 *    这条不依赖行距;
 *  - ≥3 个跨列【基线级】对齐的行顶 (不同列簇的块顶边差 ≤ em*0.3):
 *    表格行顶对齐是排版硬几何,精确到基线。
 */
function textGridValid(members: GuardItem[], em: number): boolean {
	// 左缘列簇。
	const sorted = [...members].sort((a, b) => a.box.left - b.box.left);
	const clusters: GuardItem[][] = [];
	for (const m of sorted) {
		const last = clusters[clusters.length - 1];
		if (last && m.box.left - last[0]!.box.left <= em * 1.2) {
			last.push(m);
		}
		else {
			clusters.push([m]);
		}
	}
	const cols = clusters.filter(c => c.length >= 2);
	if (cols.length < 2) {
		return false;
	}
	const zoneLeft = Math.min(...members.map(m => m.box.left));
	const zoneRight = Math.max(...members.map(m => m.box.left + m.box.width));
	const zoneWidth = zoneRight - zoneLeft;
	if (zoneWidth <= 0) {
		return false;
	}
	const hasLabelCol = cols.some(c =>
		c.length >= 3 && Math.max(...c.map(m => m.box.width)) <= zoneWidth * 0.35);
	if (!hasLabelCol) {
		return false;
	}
	// 跨列基线对齐的行顶。
	const tol = Math.max(1.5, em * 0.3);
	let aligned = 0;
	const [first, ...rest] = cols;
	for (const m of first!) {
		if (rest.some(col => col.some(n => Math.abs(n.box.top - m.box.top) <= tol))) {
			aligned++;
		}
	}
	return aligned >= 3;
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

/** Row centres (y) of a set of cells, ascending. */
function rowCentres(members: GuardItem[]): number[] {
	return members.map(m => m.box.top + m.box.height / 2).sort((a, b) => a - b);
}

/** Distinct row bands of a set of cells: y-centres deduped within tol. */
function distinctRows(members: GuardItem[], tol: number): number[] {
	const out: number[] = [];
	for (const y of rowCentres(members)) {
		if (!out.length || y > out[out.length - 1]! + tol) {
			out.push(y);
		}
	}
	return out;
}

/** How many DISTINCT rows of A line up (within tol) with a row of B (1.2.2:
 *  dedup 修复 — 旧实现按成员多重计数,同一行的 4 个单元格数成 4,一个单行
 *  碎片就能凑满 ≥3,靠事故桥接两块区域). Two side-by-side COLUMNS of one
 *  table share the same rows even across a wide gutter. */
function sharedRowCount(a: GuardItem[], b: GuardItem[], tol: number): number {
	const cb = distinctRows(b, tol);
	let n = 0;
	for (const y of distinctRows(a, tol)) {
		if (cb.some(z => Math.abs(z - y) <= tol)) {
			n++;
		}
	}
	return n;
}

/** Distinct column bands of a set of cells (x-centres deduped within tol). */
function distinctCols(members: GuardItem[], tol: number): number {
	const centres = members.map(m => m.box.left + m.box.width / 2).sort((x, y) => x - y);
	let n = 0;
	let last = -Infinity;
	for (const x of centres) {
		if (x > last + tol) {
			n++;
			last = x;
		}
	}
	return n;
}

/** Horizontal gap between two regions (negative when they overlap). */
function hGapBetween(a: TableRegion, b: TableRegion): number {
	return Math.max(a.left - (b.left + b.width), b.left - (a.left + a.width));
}

/** Is there an obstacle (figure/image box, top-down coords) standing in the
 *  gutter BETWEEN two horizontally separated regions, within their shared
 *  vertical span? A figure between two aligned numeric clusters means they are
 *  the columns of two different things, never one table. */
function obstacleBetweenRegions(a: TableRegion, b: TableRegion, obstacles: GuardItem['box'][]): boolean {
	if (!obstacles.length || hGapBetween(a, b) <= 0) {
		return false;
	}
	const gutterLeft = Math.min(a.left + a.width, b.left + b.width);
	const gutterRight = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const bottom = Math.min(a.top + a.height, b.top + b.height);
	if (bottom <= top) {
		return false;
	}
	return obstacles.some(o =>
		o.left < gutterRight && (o.left + o.width) > gutterLeft
		&& o.top < bottom && (o.top + o.height) > top);
}

/** Vertical gap between two regions (0 when they intersect vertically). */
function verticalGap(a: TableRegion, b: TableRegion): number {
	if (b.top >= a.top + a.height) {
		return b.top - (a.top + a.height);
	}
	if (a.top >= b.top + b.height) {
		return a.top - (b.top + b.height);
	}
	return 0;
}

/** Horizontal overlap as a fraction of the NARROWER region's width. */
function mutualHOverlapRatio(a: TableRegion, b: TableRegion): number {
	const overlap = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
	const narrower = Math.min(a.width, b.width);
	return narrower > 0 ? overlap / narrower : 0;
}

/** Is the gutter between two horizontally separated regions occupied by OTHER
 *  tabular cells within their (slightly expanded) shared vertical span? A
 *  populated gutter means the pair are non-adjacent columns of one table; an
 *  empty gutter is what two independent side-by-side tables look like. */
function gutterPopulated(a: TableRegion, b: TableRegion, cells: GuardItem[], em: number): boolean {
	if (hGapBetween(a, b) <= 0) {
		return false;
	}
	const gutterLeft = Math.min(a.left + a.width, b.left + b.width);
	const gutterRight = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top) - em;
	const bottom = Math.min(a.top + a.height, b.top + b.height) + em;
	if (bottom <= top) {
		return false;
	}
	return cells.some((c) => {
		const cx = c.box.left + c.box.width / 2;
		const cy = c.box.top + c.box.height / 2;
		return cx > gutterLeft && cx < gutterRight && cy > top && cy < bottom;
	});
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
	emPx: number,
	obstacles: GuardItem['box'][] = []
): { excluded: Set<string>; regions: TableRegion[]; textRegions: TableRegion[] } {
	const em = Math.max(6, emPx);
	const cells = items.filter(i => looksTabularSeed(i.text));
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

	// Merge adjacent clusters transitively until a joint fixed point. Two rules,
	// both needed for a wide grid:
	//   • vertical-overlap: clusters that horizontally overlap and sit within a
	//     row gap are the same column split by a big gap, or stacked row groups.
	//   • column merge (1.2.0): clusters sharing ≥3 aligned row centres are the
	//     side-by-side COLUMNS of one table however wide the gutter — the wide
	//     NEJM "Clinical and Imaging Outcomes" table (a prose label column plus
	//     several far-apart numeric columns) shattered into one-column fragments
	//     under the first rule alone, and its labels collapsed. The ≥3 threshold
	//     keeps two unrelated numeric blobs from fusing.
	// Running both in one loop lets a column merge make strips full-width, after
	// which the vertical rule joins the full-width top and bottom row groups.
	for (let pass = 0; pass < 8; pass++) {
		let mergedAny = false;
		for (let i = 0; i < clusters.length; i++) {
			for (let j = clusters.length - 1; j > i; j--) {
				const a = clusters[i]!;
				const b = clusters[j]!;
				const vAdjacent = a.region.top <= b.region.top + b.region.height + em * 2.2
					&& b.region.top <= a.region.top + a.region.height + em * 2.2;
				// Column merge is bounded (1.2.2, 审核项): shared DISTINCT rows alone
				// let two UNRELATED aligned clusters fuse across arbitrary width. The
				// gutter between them must be table-scale (≤ em*8) — UNLESS the
				// gutter itself is populated by other tabular cells, which is what a
				// non-adjacent column pair of ONE table looks like (merge order is
				// arbitrary: NEJM's count column legitimately merges the P-value
				// column at 203px because two more columns sit in between). An image
				// obstacle in the gutter always separates.
				const columnMerge = sharedRowCount(a.members, b.members, em) >= 3
					&& !obstacleBetweenRegions(a.region, b.region, obstacles)
					&& (hGapBetween(a.region, b.region) <= em * 8
						|| gutterPopulated(a.region, b.region, cells, em));
				// Row-group merge (1.2.2): a table's HEADER rows share no data rows
				// with the body, and their vertical gap (a rule line + padding) can
				// exceed the plain-adjacency tolerance. Two stacked clusters that
				// strongly overlap horizontally, each with ≥2 distinct columns, at a
				// moderate gap (≤ em*4) are row groups of one table. Single-column
				// stacks (figure axis ticks, lists) never qualify.
				const rowGroupMerge = !vAdjacent
					&& verticalGap(a.region, b.region) <= em * 4
					&& mutualHOverlapRatio(a.region, b.region) >= 0.7
					&& distinctCols(a.members, em * 2) >= 2
					&& distinctCols(b.members, em * 2) >= 2
					&& !obstacleBetweenRegions(a.region, b.region, obstacles);
				const merge = (vAdjacent && hOverlaps(a.region, b.region as unknown as GuardItem['box'], em * 3))
					|| columnMerge || rowGroupMerge;
				if (merge) {
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
		// The numeric cells' row centres — the anchors a label column lines up
		// with. Fixed from the seed cells, so growing the region leftward can't
		// drift the anchor set.
		const numericRowCentres = rowCentres(cluster.members);
		// 向上生长的天花板 (2.7.2, wu2026-p6 实证): 表头扫掠 (d) 逐轮把区域顶边
		// 抬高,没有上限就会顺着上一张表的脚注 ("Data are means±SDs")、图注一路
		// 爬到上一张表里。表标题是硬天花板: 种子区域上方、横向相交的最近一条
		// "Table N" 标题,其底边以上的块一律不收;没有标题时上限为种子顶边上方 6em。
		const seedTop = region.top;
		let ceiling = seedTop - em * 6;
		for (const item of items) {
			const bottom = item.box.top + item.box.height;
			const hOverlap = Math.min(item.box.left + item.box.width, region.left + region.width)
				- Math.max(item.box.left, region.left);
			if (bottom <= seedTop + em * 0.3 && hOverlap > 0
				&& isTableCaptionAnchor(item.text.trim(), item.type)) {
				ceiling = Math.max(ceiling, bottom - em * 0.2);
			}
		}
		// 同一基线上的"行伴": 表头行只由短格组成;若同行还有句子续行/长行/标题
		// (标题第二行被表格分栏切出的孤词 "size"),这一行是标题续行,不是表头。
		const isLongOrContinuation = (t: string): boolean => {
			const trimmedT = t.trim();
			const cont = (/^[a-z]/.test(trimmedT) || /-$/.test(trimmedT))
				&& (trimmedT.match(/[A-Za-z]{3,}/g) ?? []).filter(w => /[a-z]/.test(w)).length >= 3;
			return cont || trimmedT.length > 60;
		};
		// Sweep in the rest of the table the cell test misses: (a) anything
		// substantially INSIDE the region; (b) short row labels/header cells
		// BESIDE it — vertically aligned with the region's rows, horizontally
		// within a couple of ems; (c) a left-gutter LABEL that lines up with an
		// actual numeric row, however wide the gutter (a wide table's label
		// column sits far left of its first numeric column — the ≤2em rule (b)
		// never reached it, which is why those labels collapsed). Long prose
		// stays out even when adjacent, so a body paragraph in the neighbouring
		// column is never swallowed. Growing the region can pull in more blocks;
		// iterate (bounded).
		for (let pass = 0; pass < 4; pass++) {
			let grew = false;
			for (const item of items) {
				if (excluded.has(item.id) || item.type === 'table') {
					continue;
				}
				const inside = containedRatio(item.box, region) >= 0.6;
				let rowAligned = false;
				// 续行不当行标签 (2.5.11, wu2026-p5 实证): 相邻正文栏的两端对齐
				// 行,行尾天然贴到栏沟边 (gap ≈ 1–2em),又与表行同高,规则 (b)
				// 把它当"表侧行标签"整行收走、随表冻结为原文。判别: ≥3 个带
				// 小写的普通词,且【小写开头】(接续上一行的句子) 或【连字符
				// 结尾】(折行进下一行) —— 那是句子的续行,不是标签。真标签
				// ("Left ventricular ejection fraction"、"Median infarct volume
				// at 24 hr") 一律大写开头、不以连字符收尾,不受影响 (1.2.0 的
				// NEJM 行标签用例仍然全绿)。
				const trimmed = item.text.trim();
				const sweepContinuation = (/^[a-z]/.test(trimmed) || /-$/.test(trimmed))
					&& (trimmed.match(/[A-Za-z]{3,}/g) ?? []).filter(w => /[a-z]/.test(w)).length >= 3;
				if (!inside && !sweepContinuation && trimmed.length <= 60) {
					const vOverlap = Math.min(item.box.top + item.box.height, region.top + region.height)
						- Math.max(item.box.top, region.top);
					if (vOverlap >= item.box.height * 0.6) {
						const gapLeft = region.left - (item.box.left + item.box.width);
						const gapRight = item.box.left - (region.left + region.width);
						const nearSide = Math.max(gapLeft, gapRight) <= em * 2 || (gapLeft < 0 && gapRight < 0);
						// (c): sits in the LEFT gutter (right edge not crossing into
						// the numeric columns) AND its centre matches a real numeric
						// row. Far-left labels of a wide table qualify; a neighbouring
						// body line does not — it won't line up with a numeric row.
						const centre = item.box.top + item.box.height / 2;
						const inLeftGutter = (item.box.left + item.box.width) <= region.left + em && gapLeft >= -em;
						const alignsNumericRow = numericRowCentres.some(y => Math.abs(y - centre) <= em * 0.6);
						rowAligned = nearSide || (inLeftGutter && alignsNumericRow);
					}
				}
				// (d) 表头向上扫掠 (2.7.2, 审核 C-1): 数值表的列头是多行堆叠的短文本
				// ("Detector Type"、"No. of Energy Thresholds"),无数字、在区域【上方】、
				// 与数据行不同高 —— (a)(b)(c) 三条都不沾,于是逃出网格成孤立单词块
				// 无语境翻译 (radiology2023-p3 一页 11 个)。判据: 紧贴区域顶边之上
				// (≤2.5em),x 中心落在区域横向范围内,≤6 词/≤60 字符,不以句末标点
				// 收尾 (正文段落的末行会),不是表标题。逐轮生长把堆叠的上一行也收进来。
				let headerAbove = false;
				if (!inside && !rowAligned && !sweepContinuation && trimmed.length <= 60
					&& !isTableCaptionAnchor(trimmed, item.type)
					&& !/[.!?。]$/.test(trimmed)
					&& (trimmed.match(/\S+/g) ?? []).length <= 6) {
					const gapAbove = region.top - (item.box.top + item.box.height);
					const centreX = item.box.left + item.box.width / 2;
					const rowMateBlocks = items.some(o => o !== item && !excluded.has(o.id)
						&& Math.abs(o.box.top - item.box.top) <= em * 0.3
						&& (isLongOrContinuation(o.text) || isTableCaptionAnchor(o.text.trim(), o.type)));
					headerAbove = gapAbove >= -em * 0.3 && gapAbove <= em * 2.5
						&& centreX >= region.left - em && centreX <= region.left + region.width + em
						&& !rowMateBlocks;
				}
				if ((rowAligned || headerAbove) && item.box.top < ceiling) {
					rowAligned = false;
					headerAbove = false;
				}
				if (inside || rowAligned || headerAbove) {
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

	// 标题锚定文本表 (2.6.0, radiology2023 Table 2/4 实证): 定义/综述表的格子
	// 是整句散文,一个数字种子都没有,种子聚类永远探不到 —— 整张表被当散文
	// 逐行切碎、跨列交错翻译。但它们有两样铁证: 顶上一条 "Table N:" 标题,
	// 和标题下方按列带+行带对齐的窄块阵。锚定扫掠: 从标题往下收集横向落在
	// 生长区域内的块,遇到"墙"(≥15 个普通词的全宽行 —— Note.— 脚注或正文
	// 段落)、另一条表标题、或已有的种子表区域即止;收完用 textGridValid
	// 验收 —— 不过就一个块也不收,页面与从前逐字节一致。
	const textRegions: TableRegion[] = [];
	const anchors = items.filter(i => isTableCaptionAnchor(i.text, i.type));
	for (const cap of anchors) {
		if (excluded.has(cap.id)) {
			continue;
		}
		// 数值种子路径已在这条标题旁接手 → 不重复建区。
		if (regions.some(r => vGap(r, cap.box) <= em * 3 && hOverlaps(r, cap.box, em * 2.5))) {
			continue;
		}
		const capBottom = cap.box.top + cap.box.height;
		// 硬墙: 下方的其他表标题与种子表区域顶边。
		const hardWall = Math.min(
			Infinity,
			...anchors.filter(a => a !== cap && a.box.top > capBottom).map(a => a.box.top),
			...regions.filter(r => r.top > capBottom).map(r => r.top)
		);
		let zone: TableRegion = { ...cap.box };
		const members: GuardItem[] = [];
		const below = items
			.filter(i => i.id !== cap.id && !excluded.has(i.id) && !isTableCaptionAnchor(i.text, i.type))
			.filter(i => i.box.top >= capBottom - em * 0.5 && i.box.top < hardWall)
			.sort((a, b) => a.box.top - b.box.top);
		for (const it of below) {
			if (vGap(zone, it.box) > em * 2.8 || !hOverlaps(zone, it.box, em * 2.5)) {
				continue;
			}
			const proseWords = (it.text.match(/[A-Za-z一-鿿]{2,}/g) ?? []).length;
			// 墙: 全宽长散文行 (正文段落),或表尾脚注 ("Note.— CNR = …"/"注:") ——
			// 脚注逐【行】进扫掠时每行词数常不足长散文阈值 (radiology2023-p11
			// 实证: "Note.CNR = contrast-to-noise ratio, FDA = …" 只有 ~10 词),
			// 全宽的它一旦入格,列带推断整个被焊死,按标记词单独判墙。
			const isFootnote = /^(note|notes)\s*[.:—–-]/i.test(it.text.trim()) || /^注[.:：]/.test(it.text.trim());
			if (isFootnote || (it.box.width >= zone.width * 0.7 && proseWords >= 15)) {
				break;
			}
			members.push(it);
			zone = grow(zone, it.box);
		}
		if (members.length < 6 || !textGridValid(members, em)) {
			continue;
		}
		// 标题本身不入格 —— 仍作 caption 块按图表说明翻译。
		let region: TableRegion | null = null;
		for (const m of members) {
			excluded.add(m.id);
			region = region ? grow(region, m.box) : { ...m.box };
		}
		textRegions.push(region!);
	}
	return { excluded, regions, textRegions };
}
