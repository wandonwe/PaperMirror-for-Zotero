/**
 * Table Row/Cell model for in-place cell translation.
 *
 * tableGuard finds a table's RECTANGLE and, until now, kept the whole thing in
 * the original language. That is safe but leaves text tables (a column of
 * "Section title" labels beside a column of prose recommendations) entirely in
 * English. This module infers the grid INSIDE a detected region so each cell
 * can be handled on its own:
 *
 *   - text cells (prose: labels, recommendations) → translated + replaced in
 *     place, confined to the cell's own rectangle;
 *   - data cells (numbers, value±sd, ranges, symbols) → kept original, so a
 *     numeric table's alignment and figures are never disturbed;
 *   - a fragment the extractor stitched ACROSS columns → kept original, so it
 *     can never be stamped in translation over the table.
 *
 * Pure geometry over plain boxes — fully unit-testable, no DOM, no PDF.
 */

import { detectTableRegions, looksTabular } from './tableGuard';
import { columnOfX, rowOfTop, type BorderGrid } from './tableBorders';
import type { SourceBlock } from '../types/models';

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface CellMember {
	id: string;
	box: Box;
	text: string;
	fontSize?: number;
}

export interface TableCell {
	/** Synthetic stable id: page-<p>-table-<t>-r<row>-c<col>. */
	id: string;
	/** Source block ids composing this cell, in reading order. */
	memberIds: string[];
	box: Box;
	text: string;
	row: number;
	col: number;
	/** text → translate & replace; data → keep original. */
	kind: 'text' | 'data';
	/** 2.7.8: 新增三类"明确不译证据"命中时记下原因,便于诊断审计;老规则不记。 */
	preserveReason?: PreserveReason;
}

// ---- 短格的明确"不译"证据 (2.7.8, 外部审核 第三批·6) ------------------------
//
// 表格短格 60% 是 ≤2 词 (34 页语料 314 个可译格里 189 个),其中缩写与引用标签
// 单独送去无语境翻译只会出 "SECT → 教派"、"Kim et al → 金等人"。但**不**把任意
// 全大写短词判成 preserve —— "YES"/"NO"/"TOTAL" 仍要翻译。只认三种硬证据:
//   glossary             用户不译词表里的原词 (逐字匹配)
//   defined-abbreviation 本页正文/脚注里定义过的缩写: "photon-counting detector
//                        (PCD)"、"AS = aortic stenosis"、"CT, computed tomography"
//   citation-label       "Kim et al,19 2022"、"Nacif et al. (2012)"
// 尾部脚注符 (*†‡§¶) 与上标引用数字不影响匹配。

export type PreserveReason = 'glossary' | 'defined-abbreviation' | 'citation-label';

export interface CellPreserveEvidence {
	noTranslate: Set<string>;
	definedAbbreviations: Set<string>;
}

const ABBR = /^[A-Z][A-Z0-9]{1,7}(?:[-/][A-Z0-9]{1,7})?$/;
const CITATION_LABEL = /^(?:(?:van|von|de|der|den|da|del|di) )*[A-Z][\p{L}'’-]+(?: [A-Z][\p{L}'’-]+)?(?: (?:van|von|de|der|den|da|del|di) [\p{L}'’-]+)? et al[.,]?(?:[ ,]*\d{1,3}(?:[,–-]\d{1,3})*)?(?:[ ,]*\(?(?:19|20)\d{2}\)?)?$/u;

/** 从本页文本里收集"已定义的缩写";noTranslate 是用户词表。pure。 */
export function cellPreserveEvidence(pageTexts: string[], noTranslate: string[] = []): CellPreserveEvidence {
	const defined = new Set<string>();
	for (const t of pageTexts) {
		// "… detector (PCD)" / "(PCD-CT)" —— 括号里独立的大写缩写,前面紧跟词。
		for (const m of t.matchAll(/[A-Za-z\u00C0-\u024F)-]\s*\(([A-Z][A-Z0-9]{1,7}(?:[-/][A-Z0-9]{1,7})?)\)/g)) {
			defined.add(m[1]!);
		}
		// 脚注定义 "AS = aortic stenosis; CMP = cardiomyopathy" / "CT, computed tomography"
		for (const m of t.matchAll(/(?:^|[;,.(\s])([A-Z][A-Z0-9]{1,7}(?:[-/][A-Z0-9]{1,7})?)\s*(?:=|:|,)\s*[a-z]/g)) {
			defined.add(m[1]!);
		}
	}
	return { noTranslate: new Set(noTranslate.map(w => w.trim()).filter(Boolean)), definedAbbreviations: defined };
}

/** 去掉尾部脚注符与上标引用数字: "HR*" → "HR", "Kim et al,19 2022" 不动 (数字在中间)。 */
function stripCellMarks(text: string): string {
	return text.trim().replace(/[*†‡§¶]+$/u, '').replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]+$/u, '').trim();
}

export function preserveReasonFor(text: string, evidence: CellPreserveEvidence | undefined): PreserveReason | undefined {
	const core = stripCellMarks(text);
	if (!core) {
		return undefined;
	}
	if (evidence?.noTranslate.has(core) || evidence?.noTranslate.has(text.trim())) {
		return 'glossary';
	}
	if (ABBR.test(core)) {
		const parts = core.split(/[-/]/);
		const defined = evidence?.definedAbbreviations;
		if (defined && (defined.has(core) || parts.every(p => defined.has(p)))) {
			return 'defined-abbreviation';
		}
	}
	if (CITATION_LABEL.test(core)) {
		return 'citation-label';
	}
	return undefined;
}

export interface TableModel {
	region: Box;
	rowCount: number;
	colCount: number;
	cells: TableCell[];
}

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
	return Math.min(a1, b1) - Math.max(a0, b0);
}

function unionBox(boxes: Box[]): Box {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const b of boxes) {
		left = Math.min(left, b.left);
		top = Math.min(top, b.top);
		right = Math.max(right, b.left + b.width);
		bottom = Math.max(bottom, b.top + b.height);
	}
	return { left, top, width: right - left, height: bottom - top };
}

interface Band { start: number; end: number }

/**
 * Cluster 1-D intervals into bands (columns from x, rows from y). Seeds bands
 * from the NARROW members first so a wide cell that straddles two real columns
 * doesn't fuse them; then every member joins the band it overlaps most.
 */
function inferBands(
	intervals: { start: number; end: number }[],
	joinRatio: number
): Band[] {
	const seeds = [...intervals]
		.map((v, i) => ({ v, i }))
		.sort((a, b) => (a.v.end - a.v.start) - (b.v.end - b.v.start));
	const bands: Band[] = [];
	for (const { v } of seeds) {
		let joined = false;
		for (const band of bands) {
			const ov = overlap1D(band.start, band.end, v.start, v.end);
			const minW = Math.min(band.end - band.start, v.end - v.start);
			if (minW > 0 && ov > joinRatio * minW) {
				// 带只在不吞并邻带时才扩张 (2.7.2, wu2026-p3 实证): 表头扫掠把
				// 跨两列的 "NAEOTOM Alpha IQon Spectral" 收进表后,它并入左列带并
				// 把带拉宽到盖住右列,右列的每个数字格都被分到左带 —— 两列熔成
				// 一列。跨列成员照旧算"已落座"(不另开带),但扩张后若会盖住别的
				// 带 (重叠超过该带宽的 joinRatio) 就保持原宽,由 assignBand 判 straddles。
				const start = Math.min(band.start, v.start);
				const end = Math.max(band.end, v.end);
				const swallows = bands.some(other => other !== band
					&& overlap1D(start, end, other.start, other.end) > joinRatio * (other.end - other.start));
				if (!swallows) {
					band.start = start;
					band.end = end;
				}
				joined = true;
				break;
			}
		}
		if (!joined) {
			bands.push({ start: v.start, end: v.end });
		}
	}
	return bands.sort((a, b) => a.start - b.start);
}

/**
 * The band a member's interval overlaps most, and whether it truly straddles
 * ≥2 columns. "Straddles" means the cell COVERS most of two or more bands —
 * only a full-width fragment stitched across columns does that. A merely wide
 * legitimate column (e.g. "Key results") fills its own band and just clips a
 * neighbour, which must NOT count, or whole text tables get flagged as data
 * and left in English.
 */
function assignBand(start: number, end: number, bands: Band[]): { index: number; straddles: boolean } {
	let best = -1;
	let bestOv = 0;
	let covered = 0;
	for (let i = 0; i < bands.length; i++) {
		const ov = overlap1D(bands[i]!.start, bands[i]!.end, start, end);
		if (ov > bestOv) {
			bestOv = ov;
			best = i;
		}
		const bandW = bands[i]!.end - bands[i]!.start;
		if (bandW > 0 && ov > 0.5 * bandW) {
			covered++;
		}
	}
	return { index: best < 0 ? 0 : best, straddles: covered >= 2 };
}

/**
 * Build the Row/Cell model for one detected table region.
 *
 * `members` are the source blocks the guard assigned to this region (in pixel
 * space). `emPx` scales nothing here directly but is accepted for symmetry with
 * the guard; callers pass the body size.
 */
export function buildTableModel(
	pageIndex: number,
	tableIndex: number,
	region: Box,
	members: CellMember[],
	evidence?: CellPreserveEvidence
): TableModel {
	if (!members.length) {
		return { region, rowCount: 0, colCount: 0, cells: [] };
	}

	// Columns from every member's x-extent. inferBands seeds from the NARROWEST
	// first, so real (narrow) column cells establish the bands before a wide
	// cross-column fragment can fuse them; a straddling cell is caught at
	// assignment instead.
	const colBands = inferBands(members.map(m => ({ start: m.box.left, end: m.box.left + m.box.width })), 0.4);
	// Rows from every member's vertical extent.
	const rowBands = inferBands(members.map(m => ({ start: m.box.top, end: m.box.top + m.box.height })), 0.4);

	interface Slot { members: CellMember[]; straddles: boolean }
	const slots = new Map<string, Slot>();
	for (const m of members) {
		const col = assignBand(m.box.left, m.box.left + m.box.width, colBands);
		const row = assignBand(m.box.top, m.box.top + m.box.height, rowBands);
		const key = `${row.index}:${col.index}`;
		const slot = slots.get(key) ?? { members: [], straddles: false };
		slot.members.push(m);
		slot.straddles = slot.straddles || col.straddles;
		slots.set(key, slot);
	}
	// 2.12.3: 数值路径也要并折行。行带来自 Y 区间聚类,一条多行标题的第二行
	// 与第一行**不重叠**,天生自成一带 → 自成一行,年份/缩写却还留在第一行上。
	// 文本表路径早有 mergeContinuationRows,数值路径一直没接 —— 而"一列年份"
	// 足以让指南清单表被判成数值表(用户截图 2 正是这条路径)。同一套判据,
	// 不另立规则。
	{
		// em 由成员自己给出,不加参数 —— buildTableModel 有抽取期与排版期两个
		// 调用点,这个仓库为"两端参数漂移"付过代价 (格 id 必须逐字一致)。
		// 字号缺失时退回行高中位数。
		const sizes = members.map(m => m.fontSize ?? 0).filter(n => n > 0).sort((a, b) => a - b);
		const heights = members.map(m => m.box.height).filter(n => n > 0).sort((a, b) => a - b);
		const pick = sizes.length ? sizes : heights;
		const em = pick.length ? pick[Math.floor(pick.length / 2)]! : 10;
		const drafts = [...slots].map(([key, slot]) => {
			const [row, col] = key.split(':').map(Number) as [number, number];
			return { members: slot.members, straddles: slot.straddles, row, col };
		});
		mergeContinuationRows(drafts, rowBands.length, em);
		slots.clear();
		for (const d of drafts) {
			slots.set(`${d.row}:${d.col}`, { members: d.members, straddles: d.straddles });
		}
	}

	const cells: TableCell[] = [];
	// 表级 email 探测 (2.5.13): 纯人名格保留规则的前提 —— 见下方 nameOnly。
	const tableHasEmail = [...slots.values()].some(sl =>
		sl.members.some(m => /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/.test(m.text)));
	// 表头深度 (2.7.2, chen2023-p5/p8 实证): 表头向上扫掠后表头常有两三行
	// ("All Patients" / "(n = 708)"),只把 row 0 当表头会让第二行表头
	// "(n = 708)"、"P Value" 落成 preserve。表头 = 首个含纯数字格的行之前的
	// 全部行 (上限 3 行);没有数字行时沿用 row 0。
	const headerDepth = (() => {
		const pureNumeric = /^[\d\s.,%±()/<>=+\-·—–]+$/;
		let first = -1;
		for (const [key, slot] of slots) {
			const row = Number(key.split(':')[0]);
			const numeric = slot.members.some(m => {
				const t = m.text.trim();
				return t.length > 0 && pureNumeric.test(t) && /\d/.test(t);
			});
			if (numeric && (first < 0 || row < first)) {
				first = row;
			}
		}
		return first < 0 ? 1 : Math.max(1, Math.min(3, first));
	})();
	for (const [key, slot] of slots) {
		const [row, col] = key.split(':').map(Number) as [number, number];
		const ordered = [...slot.members].sort((a, b) =>
			a.box.top - b.box.top || a.box.left - b.box.left);
		const text = ordered.map(m => m.text.trim()).filter(Boolean).join(' ');
		const box = unionBox(ordered.map(m => m.box));
		// A header-row cell that carries any actual word is a label to translate
		// (e.g. "2025 Recommendation"), not a data cell — looksTabular would
		// otherwise flag it just for containing a year.
		const hasWord = /[A-Za-z一-鿿]/.test(text);
		const isPureNumeric = /^[\d\s.,%±()/<>=+\-·—–]+$/.test(text);
		// 微小符号格 (2.3.7, 基线 doc1 实证): ≤4 字符且不含 2+ 连续字母/汉字的格
		// ("R²"、"n=5"、"±SD")翻译无意义 —— 送去只会被验收拒掉再计入 tableFailed,
		// 白费请求。直接归 data/preserve。
		const tinySymbol = text.length <= 4 && !/[A-Za-z一-鿿]{2,}/.test(text);
		// 联系人格保留 (2.5.13, wu2026-p1 实证): 含 email 的格是通讯信息
		// ("Weifeng Han hanweifeng1981@163.com"),翻译只会把人名猜成汉字、
		// 邮箱被改写 —— 按数据格 preserve,原样保留。同一张表里的纯人名格
		// ("Weifeng Han" 单独一格、email 在下一格) 一并保留: 判据是【表内
		// 存在 email 格】+ 该格全部 token 是 TitleCase 名形态 —— 数据表没有
		// email,不受影响。
		const hasEmail = /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/.test(text);
		const nameOnly = tableHasEmail && text.length <= 40
			&& text.split(/\s+/).filter(Boolean).length >= 2
			&& text.split(/\s+/).filter(Boolean).every(w => /^[A-Z][a-zA-Z'’.-]*$/.test(w));
		const preserveReason = preserveReasonFor(text, evidence);
		const kind: TableCell['kind'] =
			slot.straddles || !text || hasEmail || nameOnly || preserveReason ? 'data'
				: row < headerDepth && hasWord && !isPureNumeric ? 'text'
					: looksTabular(text) || text.length < 3 || tinySymbol ? 'data' : 'text';
		cells.push({
			id: `page-${pageIndex}-table-${tableIndex}-r${row}-c${col}`,
			memberIds: ordered.map(m => m.id),
			box, text, row, col, kind,
			...(preserveReason ? { preserveReason } : {})
		});
	}

	coerceNumericColumns(cells, colBands.length, headerDepth);

	cells.sort((a, b) => a.row - b.row || a.col - b.col);
	return { region, rowCount: rowBands.length, colCount: colBands.length, cells };
}

/** 连字符续拼: 文本格由多行拼成,"quanti-"/"tatively" 要接回一个词。 */
function joinCellText(parts: string[]): string {
	let out = '';
	for (const p of parts) {
		const t = p.trim();
		if (!t) {
			continue;
		}
		if (!out) {
			out = t;
		}
		else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) {
			out = out.slice(0, -1) + t;
		}
		else {
			out += ' ' + t;
		}
	}
	return out;
}

/**
 * 文本表 Row/Cell 模型 (2.6.0, radiology2023 Table 2/4 实证)。
 *
 * 定义/综述表的格子是多行整句散文,buildTableModel 的行带推断按【行】分带,
 * 一个三行的描述格会碎成三行三格,逐格无语境翻译。这里按文本表的几何组格:
 *  - 列带同 inferBands (窄格先落座);
 *  - 每列内部先把竖向间隙 ≤ em*0.8 的块并成【格组】(格内行距远小于行距);
 *  - 行起点 = 全部格组顶边聚类 (表格行顶对齐是硬几何),组按顶边归行;
 *  - 跨列带的全宽块 (小节子标题) 单独成行,有词就翻译;
 *  - 格 kind: 有词的散文格 text,数字/符号格沿用 looksTabular → data。
 */
export function buildTextTableModel(
	pageIndex: number,
	tableIndex: number,
	region: Box,
	members: CellMember[],
	em: number,
	evidence?: CellPreserveEvidence
): TableModel {
	if (!members.length) {
		return { region, rowCount: 0, colCount: 0, cells: [] };
	}
	// 列带只由【窄】成员推断 (2.6.0, radiology2023-p11 实证): 一个全宽成员
	// (漏网脚注行/跨列子标题) 参与推断会把首列带撑到全区宽,后续所有成员
	// 与它的重叠都不小于与本列带的重叠,整张表焊进 c0。宽成员仍参与归格
	// (assignBand 判 straddle → 独立全宽行)。
	const narrow = members.filter(m => m.box.width <= region.width * 0.5);
	const bandSource = narrow.length >= 2 ? narrow : members;
	const colBands = inferBands(bandSource.map(m => ({ start: m.box.left, end: m.box.left + m.box.width })), 0.4);
	interface Group { members: CellMember[]; top: number; col: number; straddles: boolean }
	const byCol: CellMember[][] = colBands.map(() => []);
	const groups: Group[] = [];
	for (const m of members) {
		const a = assignBand(m.box.left, m.box.left + m.box.width, colBands);
		if (a.straddles) {
			groups.push({ members: [m], top: m.box.top, col: a.index, straddles: true });
		}
		else {
			byCol[a.index]!.push(m);
		}
	}
	// 2.12.3 分组阈值改用**表格自己的**行内行距,不是绝对的 em*0.8。
	//
	// 只占一列的**小节子标题行**("Imaging outcomes")产生不了跨列行起点,
	// 全靠列内分组把它断出来;而紧排期刊表格的行间隙常只有 0.6~0.7 个字号,
	// 够不着 em*0.8,于是子标题从一开始就被分进了上一行(nejm-defuse3-p7
	// 实测: 折行间隙 1.0,真行间隙 5.8,阈值 8.0 —— 两者都不断)。
	// 本表最紧的那种间隙就是行内行距,超过它就是换行不是折行。取 min 保证
	// 永远不比原来更迟钝。
	const tightSplit = (() => {
		const gaps: number[] = [];
		for (const colMembers of byCol) {
			const s = [...colMembers].sort((x, y) => x.box.top - y.box.top);
			for (let i = 1; i < s.length; i++) {
				gaps.push(Math.max(0, s[i]!.box.top - (s[i - 1]!.box.top + s[i - 1]!.box.height)));
			}
		}
		return Math.min(em * 0.8, (gaps.length ? Math.min(...gaps) : 0) + em * 0.25);
	})();
	byCol.forEach((colMembers, col) => {
		const sorted = [...colMembers].sort((x, y) => x.box.top - y.box.top);
		let cur: CellMember[] = [];
		let bottom = -Infinity;
		const flush = (): void => {
			if (cur.length) {
				groups.push({ members: cur, top: cur[0]!.box.top, col, straddles: false });
				cur = [];
			}
		};
		for (const m of sorted) {
			if (cur.length && m.box.top - bottom > tightSplit) {
				flush();
			}
			cur.push(m);
			bottom = Math.max(bottom, m.box.top + m.box.height);
		}
		flush();
	});
	// 行起点聚类 (顶对齐)。组只用来【发现】行起点 —— 短内容列 (标签列) 的
	// 行距大、分组干净,给出可靠起点;长内容列 (整句描述列) 的格子上下顶着,
	// 常并成一个纵贯多行的大组,行归属绝不能跟着组走。
	// 跨列顶对齐行起点 (2.7.2, radiology2023-p11 Table 4 实证): 表头行与首个
	// 数据行只隔 0.55em,每一列的表头都和首行并成一组,组顶给不出首行起点,
	// 整张表的表头和第一行熔成一格。补一类起点: ≥3 个成员顶边对齐 (±0.3em)、
	// 且各自贴着所在列带左沿 (悬挂缩进的折行不算) —— 那是行首的硬几何。
	// 2.12.3: 行首的硬几何是"**≥2 个不同列**在同一顶边开始",不是"≥3 个成员"。
	//
	// 原来的 ≥3 个成员是个代理判据,在 2~3 列的表上永远凑不够 —— 而紧排表格
	// 恰恰全靠它兜底:列内分组的断点阈值 em*0.8 是**绝对**值,期刊表格的记录
	// 间隙常只有 0.6~0.7 个字号,一个断点都产生不出来。两条一起失效的后果不是
	// 错一行,是**整张表塌成一行**:三条各自带年份的记录会被焊成
	// r1-c0="标题一 标题二 标题三"、r1-c1="2019 2020 2021"(见
	// tests/unit/tableRowFidelity.test.ts 的反向锁夹具)。用户截图 2 里
	// "第一列多个标题连续堆到上方、下面全是空白格"就是这个形状。
	//
	// 换成列数判据后对宽表反而更严(5 列表仍要 3 个成员,且必须跨 ≥2 列),
	// 只对 2~3 列的表放开它本来就够不到的那道门。
	const alignedStarts: number[] = [];
	{
		const flush = members
			.filter(m => !groups.some(g => g.straddles && g.members[0] === m))
			.map(m => {
				const col = assignBand(m.box.left, m.box.left + m.box.width, colBands).index;
				return { top: m.box.top, col, atStart: m.box.left <= colBands[col]!.start + em * 0.5 };
			})
			.filter(m => m.atStart)
			.sort((a, b) => a.top - b.top);
		const quorum = Math.min(3, colBands.length);
		let run: { top: number; col: number }[] = [];
		const commit = (): void => {
			const cols = new Set(run.map(r => r.col));
			if (run.length >= quorum && cols.size >= 2) {
				alignedStarts.push(Math.min(...run.map(r => r.top)));
			}
			run = [];
		};
		for (const m of flush) {
			if (run.length && m.top - run[0]!.top > em * 0.3) {
				commit();
			}
			run.push({ top: m.top, col: m.col });
		}
		commit();
	}
	const rowStarts: number[] = [];
	for (const t of [...groups.map(g => g.top), ...alignedStarts].sort((a, b) => a - b)) {
		if (!rowStarts.length || t > rowStarts[rowStarts.length - 1]! + em * 0.8) {
			rowStarts.push(t);
		}
	}
	const rowOf = (top: number): number => {
		let r = 0;
		for (let i = 0; i < rowStarts.length; i++) {
			if (top >= rowStarts[i]! - em * 0.8) {
				r = i;
			}
		}
		return r;
	};
	// 行归属按【成员】逐个判 (2.6.0): 大组里第 k 行的行首行落在 rowStarts[k]
	// 上,后续折行落在 k 与 k+1 之间 → 同归 k;到 k+1 行首自然切换。这样
	// 标签列发现的行界把邻列的长文格也切对。
	const slots = new Map<string, { members: CellMember[]; straddles: boolean }>();
	for (const g of groups) {
		for (const m of g.members) {
			const key = `${rowOf(m.box.top)}:${g.col}`;
			const slot = slots.get(key) ?? { members: [], straddles: false };
			slot.members.push(m);
			slot.straddles = slot.straddles || g.straddles;
			slots.set(key, slot);
		}
	}
	interface Draft { members: CellMember[]; straddles: boolean; row: number; col: number }
	const drafts: Draft[] = [];
	for (const [key, slot] of slots) {
		const [row, col] = key.split(':').map(Number) as [number, number];
		drafts.push({ members: slot.members, straddles: slot.straddles, row, col });
	}
	const rowCount = mergeContinuationRows(drafts, rowStarts.length, em);
	const cells: TableCell[] = [];
	for (const d of drafts) {
		const ordered = [...d.members].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
		const text = joinCellText(ordered.map(m => m.text));
		const hasWord = /[A-Za-z一-鿿]{2,}/.test(text);
		const tinySymbol = text.length <= 4 && !hasWord;
		const preserveReason = preserveReasonFor(text, evidence);
		const kind: TableCell['kind'] =
			!text || !hasWord || tinySymbol || preserveReason ? 'data'
				: !d.straddles && (looksTabular(text) || text.length < 3) ? 'data' : 'text';
		cells.push({
			id: `page-${pageIndex}-table-${tableIndex}-r${d.row}-c${d.col}`,
			memberIds: ordered.map(m => m.id),
			box: unionBox(ordered.map(m => m.box)),
			text, row: d.row, col: d.col, kind,
			...(preserveReason ? { preserveReason } : {})
		});
	}
	cells.sort((a, b) => a.row - b.row || a.col - b.col);
	return { region, rowCount, colCount: colBands.length, cells };
}

/**
 * 折行续行并回上一行 (2.7.8, 外部审核 第三批·5, radiology2023-p11 Table 4 实证):
 * 三列长文格在同一视觉行一起折行时,三个折行的行首顶对齐又都贴列带左沿,
 * 与 alignedStarts 的"行首硬几何"无法区分,"Gold / nanoparticles"、
 * "Extensive preclinical / use, synthetic control …" 被切成两行六格。几何
 * 分不开的只能靠文本: 一行若**每一格**都 (a) 上一行同列有格、(b) 以小写字母或
 * 续行标点开头、(c) 与上一行同列格的竖向间隙 ≤ 0.8em (与格内折行同一阈值),
 * 且上一行不是单个跨列格的子标题行 —— 它就是续行,逐格并回。数字/大写开头的格是"新行证据",
 * 一格命中就整行不并。原地改 drafts,返回并行后的行数。
 */
function mergeContinuationRows(
	drafts: { members: CellMember[]; straddles: boolean; row: number; col: number }[],
	rowCount: number,
	em: number
): number {
	const CONTINUATION_START = /^[a-z\u00DF-\u00FF,;:)\]]/;
	const bottomOf = (d: { members: CellMember[] }): number => Math.max(...d.members.map(m => m.box.top + m.box.height));
	const topOf = (d: { members: CellMember[] }): number => Math.min(...d.members.map(m => m.box.top));
	const firstText = (d: { members: CellMember[] }): string =>
		[...d.members].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left).map(m => m.text.trim()).find(Boolean) ?? '';
	// 表内"最紧的一种竖向间隙" = 行内折行的行距 (2.12.3)。逐列取纵向相邻草稿
	// 的间隙,取全表最小的正值;负值(框重叠)按 0 计。加 em*0.25 的容差吸收
	// 取整误差。表格若通篇只有一种间隙,这把尺就分不开折行与新行 —— 那正是
	// 纯文字几何的极限,只有边框线能判(见模块顶部说明)。
	const tightLimit = (() => {
		const gaps: number[] = [];
		const cols = new Set(drafts.map(d => d.col));
		for (const c of cols) {
			// 量【成员】之间的间隙,不是草稿之间的 —— 文本表路径里折行常常已经
			// 被 rowOf 并进同一个草稿,草稿之间就只剩行间距,尺子会失去分辨力
			// (本文件的"小节子标题"夹具正是这样红的)。
			const ms = drafts.filter(d => d.col === c).flatMap(d => d.members)
				.sort((a, b) => a.box.top - b.box.top);
			for (let i = 1; i < ms.length; i++) {
				gaps.push(Math.max(0, ms[i]!.box.top - (ms[i - 1]!.box.top + ms[i - 1]!.box.height)));
			}
		}
		return (gaps.length ? Math.min(...gaps) : 0) + em * 0.25;
	})();
	let removed = 0;
	for (let row = 1; row < rowCount; row++) {
		const cur = drafts.filter(d => d.row === row);
		if (!cur.length) {
			continue;
		}
		type Draft = (typeof drafts)[number];
		// 上一行若只有一个跨列格 (小节子标题行),不是可续的正文行;上一行里
		// 溢进空邻列的宽格 (radiology2023-p11 "Potentially high cost; …" 占 c4+c5)
		// 仍是普通格,可续。
		const prevRow = drafts.filter(d => d.row === row - 1);
		if (prevRow.length < 2) {
			continue;
		}
		const prevOf = (col: number): Draft | undefined => prevRow.find(d => d.col === col);
		// 2.12.3 列覆盖证据: CONTINUATION_START(以小写字母/续行标点开头)对散文
		// 成立,对**文献标题**完全失效 —— 标题是 Title Case,"Cardiovascular
		// Disease"、"Acute Ischemic Stroke" 条条大写开头,于是指南清单表里每条
		// 多行标题的折行都被判成新记录,标题与年份、缩写整体错位(用户截图 2)。
		//
		// 补一条不依赖大小写的几何证据:**真正的新记录会填上一行填过的那些列**
		// (那正是它成为一条记录的原因),而折行只延长它自己那一列。所以"本行的
		// 列集合是上一行列集合的真子集"就是续行 —— 列数相同的行永远不并
		// (反向锁夹具: 三条各自带年份的记录必须留成三行)。
		//
		// 光有列覆盖还不够: 表内的**小节子标题行**("Imaging outcomes**"、
		// "Safety outcomes — no. (%)")同样只占第一列,列覆盖分不开它和折行。
		// 加一把行距的尺 —— 而且是**表格自己的**尺,不是又一个绝对常数:
		// nejm-defuse3-p7 实测,折行与上一行的间隙是 **1.0**,而每一条真行
		// (含那两个子标题)都是 **5.8**,差 6 倍;但两者都远小于 em*0.8=8.0,
		// 固定阈值永远分不开。表内最紧的那种间隙就是行内行距,续行必须贴着它。
		const curCols = new Set(cur.map(d => d.col));
		const prevCols = new Set(prevRow.map(d => d.col));
		const fewerColumns = curCols.size < prevCols.size && [...curCols].every(c => prevCols.has(c));
		const continuation = cur.every(d => {
			const prev = prevOf(d.col);
			const gap = prev ? topOf(d) - bottomOf(prev) : Infinity;
			return !d.straddles && !!prev
				&& (CONTINUATION_START.test(firstText(d)) || (fewerColumns && gap <= tightLimit))
				&& gap <= em * 0.8;
		});
		if (!continuation) {
			continue;
		}
		for (const d of cur) {
			const prev = prevOf(d.col)!;
			prev.members = [...prev.members, ...d.members];
			drafts.splice(drafts.indexOf(d), 1);
		}
		for (const d of drafts) {
			if (d.row > row) {
				d.row -= 1;
			}
		}
		removed += 1;
		row -= 1; // 并回后原来的下一行可能也是续行 (三行折行)
	}
	return rowCount - removed;
}

/**
 * If a column is overwhelmingly data (a numbers column with one stray word),
 * keep the whole column original so its alignment is never broken. The header
 * row (row 0) is left as classified — a numeric column can still have a prose
 * heading that should translate.
 */
function coerceNumericColumns(cells: TableCell[], colCount: number, headerDepth = 1): void {
	for (let c = 0; c < colCount; c++) {
		const body = cells.filter(cell => cell.col === c && cell.row >= headerDepth);
		if (body.length < 3) {
			continue;
		}
		const data = body.filter(cell => cell.kind === 'data').length;
		if (data / body.length >= 0.7) {
			for (const cell of body) {
				cell.kind = 'data';
			}
		}
	}
}

function contained(box: Box, region: Box): number {
	const w = Math.min(box.left + box.width, region.left + region.width) - Math.max(box.left, region.left);
	const h = Math.min(box.top + box.height, region.top + region.height) - Math.max(box.top, region.top);
	return w > 0 && h > 0 && box.width > 0 && box.height > 0 ? (w * h) / (box.width * box.height) : 0;
}

/**
 * Extraction-stage table normalization. This runs before prose coalescing so a
 * row or column can never be welded into a body paragraph. Text cells receive
 * stable ids and become provider request units; numeric/data cells remain in
 * the page model but are explicitly marked preserve.
 */
export function structureTableCells(
	blocks: SourceBlock[],
	pageIndex: number,
	em: number,
	noTranslate: string[] = [],
	grid?: BorderGrid | null,
	/**
	 * 2.12.6: 网格默认**只观测、不建格**。
	 *
	 * 2.12.5 把它接进了建格,但真机上 Gulati p21(五列禁忌症表)只剩 3 个格、
	 * 全挤在 c0 —— 而同一份 PDF 离线推出的网格是 5 列 4 行。运行时算出了什么,
	 * 当时**一个字节的遥测都没有**,我只能猜。
	 *
	 * 所以先把这条路降回观测:网格照常计算并随诊断导出(ExtractPhases 的
	 * edgeSegments/gridCols/gridRows/gridRegion/gridInside),等真机数据证明
	 * 运行时的网格与离线一致,再把 useGrid 打开。**不拿用户的阅读体验去试。**
	 */
	useGrid = false
): SourceBlock[] {
	const originalById = new Map(blocks.map(block => [block.id, block]));
	const geometric = blocks.filter((b): b is SourceBlock & { boundingBox: NonNullable<SourceBlock['boundingBox']> } => !!b.boundingBox);
	if (geometric.length < 2) {
		return blocks;
	}
	// 2.12.5 边框优先: 这一页画着网格时,行列不必再从文字几何去猜。
	//
	// 真机证据 (Powers 2019 p4,用户截图 2 的原表): 文字几何只认出 2 列,
	// **整个 Document Title 列在表外** —— 那一列的文献标题每条 79~242 字符,
	// 被"标签不超过 60 字"那道闸挡在外面,随后当普通段落各自摆放,与自己那
	// 一行的年份、缩写再无关系。而这一页画了 63 条水平边与 78 条垂直边,
	// 边框给出的是 3 列 x 18 行。
	//
	// 边框拿不到就走原路(borderGrid 推不出网格时返回 null),行为与 2.12.4
	// 逐字节一致 —— 绝大多数页面本来就没有表格线。
	const gridConsumed = new Set<string>();
	const gridCells: SourceBlock[] = [];
	if (grid && useGrid) {
		const inGrid = geometric.filter(b => {
			const cx = b.boundingBox.x + b.boundingBox.width / 2;
			const cy = b.boundingBox.y + b.boundingBox.height / 2;
			return columnOfX(grid, cx) >= 0 && rowOfTop(grid, cy) >= 0;
		});
		// 网格里没几个块就不算数 —— 一条装饰线框住半句话不是表格。
		if (inGrid.length >= 6) {
			const ev = cellPreserveEvidence(blocks.map(b => b.sourceText), noTranslate);
			const model = buildGridTableModel(pageIndex, 0, grid, inGrid.map(b => ({
				id: b.id,
				box: { left: b.boundingBox.x, top: b.boundingBox.y, width: b.boundingBox.width, height: b.boundingBox.height },
				text: b.sourceText,
				fontSize: b.fontSize
			})), ev);
			if (model) {
				for (const cell of model.cells) {
					const originals = cell.memberIds.map(id => originalById.get(id)).filter((b): b is SourceBlock => !!b);
					if (!originals.length) {
						continue;
					}
					for (const o of originals) {
						gridConsumed.add(o.id);
					}
					const sizes = originals.map(b => b.fontSize ?? 0).filter(Boolean).sort((a, b) => a - b);
					const memberColumns = originals.map(b => b.column).filter((c): c is number => typeof c === 'number');
					const pageColumn = memberColumns.length
						? (memberColumns.every(c => c === memberColumns[0]) ? memberColumns[0]! : -1)
						: undefined;
					gridCells.push({
						id: cell.id,
						pageIndex,
						order: originals[0]!.order,
						type: 'paragraph',
						sourceText: cell.text,
						boundingBox: { x: cell.box.left, y: cell.box.top, width: cell.box.width, height: cell.box.height },
						lineRectsPdf: originals.flatMap(o => o.lineRectsPdf ?? []),
						...(sizes.length ? { fontSize: sizes[Math.floor(sizes.length / 2)] } : {}),
						...(pageColumn !== undefined ? { column: pageColumn } : {}),
						tableRow: cell.row,
						tableCol: cell.col,
						memberIds: cell.memberIds,
						translationMode: cell.kind === 'data' ? 'preserve' : 'translate',
						...(cell.preserveReason ? { preserveReason: cell.preserveReason } : {})
					} as SourceBlock);
				}
			}
		}
	}
	if (gridCells.length) {
		// 网格已经把这些块处理掉了;剩下的块照旧走文字几何那条路。
		const rest = blocks.filter(b => !gridConsumed.has(b.id));
		const restStructured = rest.length >= 2 ? structureTableCells(rest, pageIndex, em, noTranslate) : rest;
		return [...restStructured, ...gridCells];
	}
	const guard = detectTableRegions(geometric.map(b => ({
		id: b.id,
		text: b.sourceText,
		type: b.type,
		box: { left: b.boundingBox.x, top: b.boundingBox.y, width: b.boundingBox.width, height: b.boundingBox.height },
		fontSize: b.fontSize,
		column: b.column
	})), Math.max(6, em));
	if (!guard.regions.length && !guard.textRegions.length) {
		return blocks;
	}

	// 2.7.8: 短格不译证据取自【整页】文本 —— 缩写定义通常在表注或正文里,
	// 不在表格区域内。
	const evidence = cellPreserveEvidence(blocks.map(b => b.sourceText), noTranslate);
	const consumed = new Set<string>();
	const cells: SourceBlock[] = [];
	// 文本表区域接在种子区域之后编号 (2.6.0) —— 渲染端按同样顺序重建,格 id
	// 两端必须一致。
	const allRegions = [
		...guard.regions.map(region => ({ region, text: false })),
		...guard.textRegions.map(region => ({ region, text: true }))
	];
	allRegions.forEach(({ region, text: isTextTable }, tableIndex) => {
		const members = geometric.filter(b => contained({
			left: b.boundingBox.x, top: b.boundingBox.y,
			width: b.boundingBox.width, height: b.boundingBox.height
		}, region) >= 0.5).map(b => ({
			id: b.id,
			box: { left: b.boundingBox.x, top: b.boundingBox.y, width: b.boundingBox.width, height: b.boundingBox.height },
			text: b.sourceText,
			fontSize: b.fontSize
		}));
		const model = isTextTable
			? buildTextTableModel(pageIndex, tableIndex, region, members, Math.max(6, em), evidence)
			: buildTableModel(pageIndex, tableIndex, region, members, evidence);
		for (const cell of model.cells) {
			const originals = cell.memberIds.map(id => originalById.get(id)).filter((b): b is SourceBlock => !!b);
			if (!originals.length) continue;
			for (const original of originals) consumed.add(original.id);
			const sizes = originals.map(b => b.fontSize ?? 0).filter(Boolean).sort((a, b) => a - b);
			// PAGE column, not table column (审核 P1): `column` drives the page
			// reading order — a 3-column table must not turn a 1-column page into
			// a fake 3-column layout. The cell inherits the page column of its
			// member fragments (unanimous → that column, mixed → -1 full-width);
			// the table-internal column index lives in `tableCol`.
			const memberColumns = originals
				.map(b => b.column)
				.filter((c): c is number => typeof c === 'number');
			const pageColumn = memberColumns.length
				? (memberColumns.every(c => c === memberColumns[0]) ? memberColumns[0]! : -1)
				: undefined;
			cells.push({
				id: cell.id,
				pageIndex,
				order: Math.min(...originals.map(b => b.order)),
				type: 'paragraph',
				sourceText: cell.text,
				boundingBox: { x: cell.box.left, y: cell.box.top, width: cell.box.width, height: cell.box.height },
				lineRectsPdf: originals.flatMap(b => b.lineRectsPdf ?? []),
				fontSize: sizes.length ? sizes[Math.floor(sizes.length / 2)] : undefined,
				column: pageColumn,
				tableCol: cell.col,
				tableRow: cell.row,
				...((): { formulaRuns?: string[] } => {
					const runs = [...new Set(originals.flatMap(b => b.formulaRuns ?? []))];
					return runs.length ? { formulaRuns: runs } : {};
				})(),
				memberIds: cell.memberIds,
				isReference: originals.some(b => b.isReference),
				translationMode: cell.kind === 'data' ? 'preserve' : 'translate'
			});
		}
	});
	const out = [...blocks.filter(b => !consumed.has(b.id)), ...cells]
		.sort((a, b) => a.order - b.order || (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0));
	return out.map((b, order) => ({ ...b, order }));
}

/**
 * 按**边框硬网格**建格 (2.12.4)。
 *
 * 边框在的时候,行列不必再从文字几何去猜:线段直接给出列边界与行边界。
 * 这条路解决的是文字几何**证明分不开**的那一类 —— Powers 2019 p4 的文献
 * 标题列(每条 79~242 字符)与 wu2026-p6 的正文栏,在每一个文字指标上都要求
 * 相反的答案,而边框对它们的回答是绝对的:前者被 63 条水平边与 78 条垂直边
 * 围着,后者周围一条都没有。
 *
 * 抽取期与排版期**共用这一个函数**,格 id 才能逐字节一致(这个仓库为
 * "两端不一致"付过代价)。网格拿不到就返回 null,调用方退回原有路径。
 */
export function buildGridTableModel(
	pageIndex: number,
	tableIndex: number,
	grid: BorderGrid,
	members: CellMember[],
	evidence?: CellPreserveEvidence
): TableModel | null {
	if (grid.columns.length < 2 || grid.rows.length < 2) {
		return null;
	}
	const slots = new Map<string, CellMember[]>();
	for (const m of members) {
		// 归属按**文字框中心**判 —— 用左上角会让贴着边界的字跑到邻格。
		const cx = m.box.left + m.box.width / 2;
		const cy = m.box.top + m.box.height / 2;
		const col = columnOfX(grid, cx);
		const row = rowOfTop(grid, cy);
		if (col < 0 || row < 0) {
			continue; // 落在网格外的不强行塞进来
		}
		const key = `${row}:${col}`;
		const list = slots.get(key) ?? [];
		list.push(m);
		slots.set(key, list);
	}
	if (!slots.size) {
		return null;
	}
	const cells: TableCell[] = [];
	for (const [key, list] of slots) {
		const [row, col] = key.split(':').map(Number) as [number, number];
		const ordered = [...list].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
		const text = joinCellText(ordered.map(m => m.text));
		const hasWord = /[A-Za-z一-鿿]{2,}/.test(text);
		const tinySymbol = text.length <= 4 && !hasWord;
		const preserveReason = preserveReasonFor(text, evidence);
		const kind: TableCell['kind'] =
			!text || !hasWord || tinySymbol || preserveReason ? 'data'
				: looksTabular(text) || text.length < 3 ? 'data' : 'text';
		cells.push({
			id: `page-${pageIndex}-table-${tableIndex}-r${row}-c${col}`,
			memberIds: ordered.map(m => m.id),
			// 盒子用**格线**围出来的那一格,不是文字的外接框 —— 译文就该排在
			// 格子里,而不是排在"原文恰好占了多大"里。
			box: {
				left: grid.columns[col]!,
				top: grid.rows[row]!,
				width: grid.columns[col + 1]! - grid.columns[col]!,
				height: grid.rows[row + 1]! - grid.rows[row]!
			},
			text, row, col, kind,
			...(preserveReason ? { preserveReason } : {})
		});
	}
	cells.sort((a, b) => a.row - b.row || a.col - b.col);
	return { region: grid.region, rowCount: grid.rows.length - 1, colCount: grid.columns.length - 1, cells };
}
