/**
 * 表格边框 → 硬网格 (2.12.4)。
 *
 * ## 为什么需要它
 *
 * 在此之前,表格的行列**只有文字几何**一个证据来源(见 tableStructure.ts
 * 开头:"Pure geometry over plain boxes — no DOM, no PDF")。全项目唯一读
 * PDF 绘图指令的地方只用来找光栅图片矩形。表格线是矢量描边,从不进入结构识别。
 *
 * 这被真机数据证伪过一次:
 *
 *   Powers 2019 p4 (指南清单表) 的第一列是文献标题,每条 79~242 字符。
 *   文字几何这条路要把它收进表,就必须放宽"标签不超过 60 字"这道闸;而
 *   同一次放宽会让 wu2026-p6 的**正文栏**被吞进表格区域,断词不再重连,
 *   出现 "substantial" → "stantial" 这种把词切断的坏结果。
 *
 *   两页在每一个文字指标上都要求相反的答案:Powers 标题列的块间距中位数
 *   14.9,wu2026 正文栏 38.6 —— 连"表格行比正文行松"这个直觉都是反的。
 *
 * 结论:**纯文字几何分不开这两种情形,边框能**。Powers p4 画了 63 条水平边
 * 与 78 条垂直边,垂直线恰好落在 x = 46.2 / 399.4 / 450.4 / 537.8 —— 三列的
 * 四条边界;wu2026-p6 的正文栏周围没有任何这样的线。
 *
 * ## 这个模块做什么、不做什么
 *
 * 做:把绘图指令里的线段与矩形归一到页面坐标 → 按方向分类 → 合并共线片段 →
 * 聚类近似重复坐标 → 交出"这张表的列边界与行边界"。
 *
 * **不做**(brief 明令禁止,逐条对应):
 *   - 不把一条短横线无限延长到整张表(只按线段**实际覆盖区间**判交点);
 *   - 不把所有 x、y 做笛卡尔积强行生成完整网格(边界必须各自有线为证);
 *   - 不把缺失的分隔线自动补成硬边界(缺就是缺,交给文字几何兜);
 *   - 不把每个闭合矩形都当单元格(要求成网格:≥2 列且 ≥2 行);
 *   - 不把页眉横线、下划线、公式线、图表坐标轴当表格(孤立线段不成网格,
 *     自然被"≥2 列 ≥2 行 + 互相围合"挡掉)。
 *
 * 纯几何、无 DOM、无 PDF 依赖 —— 输入是已经归一好的线段数组,完全可单测。
 */

/** 页面 PDF 用户空间的线段: [x0, y0, x1, y1]。y 向上为正(PDF 原生方向)。 */
export type Segment = [number, number, number, number];

export interface BorderGrid {
	/** 列边界的 x 坐标,升序;n 条边界 = n-1 列。 */
	columns: number[];
	/** 行边界的 y 坐标(**已翻成 top-down**),升序;n 条边界 = n-1 行。 */
	rows: number[];
	/** 整张表的外框(top-down 像素/点坐标)。 */
	region: { left: number; top: number; width: number; height: number };
}

interface Line { pos: number; from: number; to: number }

/** 方向判据: 端点在另一轴上的偏差不超过 tol,且自身长度超过 minLen。 */
function classify(segments: Segment[], tol: number, minLen: number): { h: Line[]; v: Line[] } {
	const h: Line[] = [];
	const v: Line[] = [];
	for (const [x0, y0, x1, y1] of segments) {
		const dx = Math.abs(x1 - x0);
		const dy = Math.abs(y1 - y0);
		if (dy <= tol && dx > minLen) {
			h.push({ pos: (y0 + y1) / 2, from: Math.min(x0, x1), to: Math.max(x0, x1) });
		}
		else if (dx <= tol && dy > minLen) {
			v.push({ pos: (x0 + x1) / 2, from: Math.min(y0, y1), to: Math.max(y0, y1) });
		}
		// 斜线一律丢弃 —— 表格线不会是斜的,图表里的折线才是。
	}
	return { h, v };
}

/**
 * 合并**共线**片段。表格线常被拆成一段一段(Powers 2019 p4 的每条竖线都按行
 * 断开,78 段其实只是 4 条),不合并就没有"贯穿全表的列边界"可言。
 *
 * 只合并位置相同(±tol)且区间**重叠或间隔不超过 joinGap** 的片段 ——
 * 隔着老远的两截共线短线不是一条线(那可能是两张表各自的边)。
 */
function mergeCollinear(lines: Line[], tol: number, joinGap: number): Line[] {
	// 2.12.10:先按位置分桶,再在桶内按起点排序合并。以前直接按 (pos, from) 排序,
	// 同一条边界上 408.0 与 408.5 两个位置的段会分成前后两串,后一串的 from 比前一串
	// 的 to 小,"from <= last.to + joinGap" 一比就把隔着 12pt 的两张表连成了一根线。
	const byPos = [...lines].sort((a, b) => a.pos - b.pos);
	const buckets: Line[][] = [];
	for (const l of byPos) {
		const b = buckets[buckets.length - 1];
		if (b && l.pos - b[b.length - 1]!.pos <= tol) { b.push(l); }
		else { buckets.push([l]); }
	}
	const out: Line[] = [];
	for (const b of buckets) {
		const pos = b.reduce((acc, l) => acc + l.pos, 0) / b.length;
		const sorted = [...b].sort((a, c) => a.from - c.from);
		let cur: Line | null = null;
		for (const l of sorted) {
			if (cur && l.from <= cur.to + joinGap) {
				cur.to = Math.max(cur.to, l.to);
			}
			else {
				cur = { pos, from: l.from, to: l.to };
				out.push(cur);
			}
		}
	}
	return out;
}

/**
 * 2.12.10:原来这里有一个 `cluster()`,把同一位置(±tol)的多段线**只留最长的一段**。
 * 它的本意是防"页眉一小截 + 页脚一小截拼成贯穿全页的线"(2.12.7 的教训),
 * 但代价是一页三张表时,同一 x 上三张表各自的竖线只剩一张表的 —— Powers 2019 p43
 * 因此一张表都推不出来。现在 mergeCollinear 只合并**区间相连**的共线片段,
 * 隔得远的各自保留为独立的线,交给分组去归属;"两截短线拼成长线"的问题由
 * 围合判据(每条线按**实际覆盖区间**判)挡住。
 */

export interface BorderGridOptions {
	/** 页面高度,用于把 PDF 的 y(向上)翻成 top-down。 */
	pageHeight: number;
	/** 方向容差与聚类容差(点)。默认 1.5 —— 覆盖 0.5pt 线宽与取整抖动。 */
	tol?: number;
	/** 最短可用线段。默认 6 —— 比这更短的是勾号、脚注符,不是表格线。 */
	minLen?: number;
}

/**
 * 从线段推出一页上的**所有**硬网格 (2.12.10);推不出就返回空数组(**绝不猜**)。
 *
 * 判据("成网格"):至少 3 条列边界与 3 条行边界(= ≥2 列 ≥2 行),且它们**互相围合** ——
 * 每条采用的列边界都要纵向盖住大部分行区间,每条采用的行边界都要横向盖住
 * 大部分列区间。页眉横线只有一条、图表坐标轴只有两条且不互相围合,都进不来。
 *
 * **为什么是"所有"而不是"一张"**:Powers 2019 p43 一页叠着三张表(pdfplumber 独立
 * 切出 y 66..222 / 265..466 / 479..749,列边完全相同)。按"整页一张"算,每张表的
 * 竖线只盖住合并区间的 40%,围合判据把它们全否了 —— 一张也推不出来。
 * 先把竖线按 y 区间的连通性分组,每组各自围合,才是一页三张表。
 */
export function borderGrids(segments: Segment[], options: BorderGridOptions): BorderGrid[] {
	const tol = options.tol ?? 1.5;
	const minLen = options.minLen ?? 6;
	const { h, v } = classify(segments, tol, minLen);
	if (h.length < 3 || v.length < 3) {
		return [];
	}
	const hs = mergeCollinear(h, tol, tol * 2);
	const vs = mergeCollinear(v, tol, tol * 2);
	if (hs.length < 3 || vs.length < 3) {
		return [];
	}
	// 同一条边界上互不相连的几段(比如被一行合并单元格截断的列线)归成一个位置,
	// 覆盖长度**相加**:那几段都真实存在,加起来才是这条线实际盖住的长度。
	// 这不是"把短线延长"—— 没有线的那一段仍然没有线,只是判"够不够格当边界"时
	// 不再只看最长的一段。(Powers p43 第三张表的 313/359 两条列线各断成两截,
	// 单段 45~127pt 都不到表高 270 的 60%,加起来 172pt 才够。)
	const coverage = (lines: Line[], need: number): number[] => {
		const sorted = [...lines].sort((a, b) => a.pos - b.pos);
		const out: number[] = [];
		let i = 0;
		while (i < sorted.length) {
			let j = i, sum = 0, posSum = 0;
			while (j < sorted.length && sorted[j]!.pos - sorted[i]!.pos <= tol) {
				sum += sorted[j]!.to - sorted[j]!.from;
				posSum += sorted[j]!.pos;
				j++;
			}
			if (sum >= need) { out.push(posSum / (j - i)); }
			i = j;
		}
		return out;
	};
	// 竖线按 y 区间连通分组:区间重叠(或间隔不超过 joinGap)的竖线属于同一张表。
	// 不做笛卡尔积、不延长短线 —— 只按每条线**实际覆盖的区间**判连通。
	const byFrom = [...vs].sort((a, b) => a.from - b.from);
	const groups: { from: number; to: number; lines: typeof vs }[] = [];
	for (const l of byFrom) {
		const g = groups[groups.length - 1];
		if (g && l.from <= g.to + tol * 2) {
			g.lines.push(l);
			g.to = Math.max(g.to, l.to);
		}
		else {
			groups.push({ from: l.from, to: l.to, lines: [l] });
		}
	}
	const out: BorderGrid[] = [];
	for (const g of groups) {
		if (g.lines.length < 3) { continue; }
		// 这一组的横线:位置落在组的 y 区间内。
		const gh = hs.filter(l => l.pos >= g.from - tol && l.pos <= g.to + tol);
		if (gh.length < 3) { continue; }
		const xMin = Math.min(...g.lines.map(l => l.pos), ...gh.map(l => l.from));
		const xMax = Math.max(...g.lines.map(l => l.pos), ...gh.map(l => l.to));
		const yMin = Math.min(...gh.map(l => l.pos), ...g.lines.map(l => l.from));
		const yMax = Math.max(...gh.map(l => l.pos), ...g.lines.map(l => l.to));
		const spanX = xMax - xMin;
		const spanY = yMax - yMin;
		if (spanX <= 0 || spanY <= 0) { continue; }
		// 围合判据: 列边界要纵向盖住 ≥60% 表高,行边界要横向盖住 ≥60% 表宽。
		// 用**实际覆盖区间**,不把短线延长。
		const cols = coverage(g.lines, spanY * 0.6);
		const rowsUp = coverage(gh, spanX * 0.6);
		// ≥2 列且 ≥2 行 = 各至少 3 条边界。以前只要 2 条线,于是一个单列的框
		// (真机 p44 的 1×6)也成了"网格" —— 一个盒子不是需要分格归属的表。
		if (cols.length < 3 || rowsUp.length < 3) { continue; }
		// PDF 的 y 向上,页面坐标向下 —— 翻过来并重新升序。
		const rows = rowsUp.map(y => options.pageHeight - y).sort((a, b) => a - b);
		const left = cols[0]!;
		const right = cols[cols.length - 1]!;
		const top = rows[0]!;
		const bottom = rows[rows.length - 1]!;
		out.push({ columns: cols, rows, region: { left, top, width: right - left, height: bottom - top } });
	}
	return out.sort((a, b) => a.region.top - b.region.top);
}

/**
 * 一页只取**一张**网格的兼容入口:格数最多的那张。推不出就返回 null。
 *
 * 结构识别目前每页只接一张网格(观测模式),多表页先拿最大的那张;
 * 遥测另报 gridCount,让多表页在真机数据里看得见。
 */
export function borderGrid(segments: Segment[], options: BorderGridOptions): BorderGrid | null {
	const all = borderGrids(segments, options);
	if (all.length === 0) { return null; }
	let best = all[0]!;
	for (const g of all) {
		if ((g.columns.length - 1) * (g.rows.length - 1) > (best.columns.length - 1) * (best.rows.length - 1)) { best = g; }
	}
	return best;
}

/** 某个 x 落在第几列(0 起);不在任何列内返回 -1。 */
export function columnOfX(grid: BorderGrid, x: number, tol = 1): number {
	for (let i = 0; i + 1 < grid.columns.length; i++) {
		if (x >= grid.columns[i]! - tol && x < grid.columns[i + 1]! + tol) {
			return i;
		}
	}
	return -1;
}

/** 某个 top 落在第几行(0 起);不在任何行内返回 -1。 */
export function rowOfTop(grid: BorderGrid, top: number, tol = 1): number {
	for (let i = 0; i + 1 < grid.rows.length; i++) {
		if (top >= grid.rows[i]! - tol && top < grid.rows[i + 1]! + tol) {
			return i;
		}
	}
	return -1;
}

// ---- 从 PDF.js 绘图指令取线段 -------------------------------------------
//
// 与 imageObstacles.ts 的 imageRectsFromOperatorList 同一套路数(CTM 跟踪 +
// save/restore 栈),只是认的是路径而不是图片。纯函数,可用合成 op 列表单测;
// 真机那一半由 zoteroReaderAdapter.getPageEdgesPdf 负责取 fnArray/argsArray,
// 走的是插件里**已经跑通**的那个 getOperatorList 调用。

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** PDF.js 的操作符码(与 imageObstacles 同样内置一份默认值,窗口里有就用真的)。 */
export const DEFAULT_PATH_OPS = {
	save: 10, restore: 11, transform: 12,
	moveTo: 13, lineTo: 14, curveTo: 15, closePath: 18, rectangle: 19,
	// 收尾绘制码 (2.12.10):路径画不画、闭不闭合,全看它。
	stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25,
	closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28, clip: 29, eoClip: 30,
	constructPath: 91
};

/**
 * 收尾绘制码决定这条路径**画不画、开放子路径闭不闭合** (2.12.10)。
 *
 * - `endPath`(`n`):一个像素都不画。裁剪路径 `re W n` 就是它 —— 真机 2.12.9 三个
 *   插图页的"整页网格" `[0,0,595,794]` 全是整页裁剪矩形当了外框。
 * - fill 家族(`f f* B B* b b*`)与 `s`:PDF 规范规定绘制前把开放子路径闭合,
 *   所以色块单元格三条 lineTo 也是四条边。
 * - `S`:开放子路径就是开放的,不补。
 */
function paintKind(paint: number, OP: typeof DEFAULT_PATH_OPS): 'none' | 'open' | 'closed' {
	if (paint === OP.endPath) { return 'none'; }
	if (paint === OP.stroke) { return 'open'; }
	if (paint === OP.closeStroke || paint === OP.fill || paint === OP.eoFill || paint === OP.fillStroke
		|| paint === OP.eoFillStroke || paint === OP.closeFillStroke || paint === OP.closeEOFillStroke) {
		return 'closed';
	}
	// 不认识的收尾码:按"画、不补闭合边"处理 —— 少认一条边好过多编一条。
	return 'open';
}

/** 三次贝塞尔的紧包围盒:端点 + 导数为零处的极值。与 pdf.js 的 minMax 同一个定义。 */
function cubicExtent(
	x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
	box: [number, number, number, number]
): void {
	const take = (x: number, y: number): void => {
		if (x < box[0]) { box[0] = x; } if (x > box[2]) { box[2] = x; }
		if (y < box[1]) { box[1] = y; } if (y > box[3]) { box[3] = y; }
	};
	take(x0, y0); take(x3, y3);
	const at = (t: number): void => {
		if (t <= 0 || t >= 1) { return; }
		const mt = 1 - t;
		const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
		const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
		take(x, y);
	};
	// B'(t) = 3[(-p0+3p1-3p2+p3)t² + 2(p0-2p1+p2)t + (p1-p0)],按轴求根。
	for (const [p0, p1, p2, p3] of [[x0, x1, x2, x3], [y0, y1, y2, y3]] as const) {
		const a = -p0 + 3 * p1 - 3 * p2 + p3;
		const b = 2 * (p0 - 2 * p1 + p2);
		const c = p1 - p0;
		if (Math.abs(a) < 1e-12) {
			if (Math.abs(b) >= 1e-12) { at(-c / b); }
			continue;
		}
		const d = b * b - 4 * a * c;
		if (d < 0) { continue; }
		const q = Math.sqrt(d);
		at((-b + q) / (2 * a));
		at((-b - q) / (2 * a));
	}
}

function mul(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
	];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * 走一遍操作符列表,交出页面用户空间里的线段。矩形拆成四条边 —— 期刊表格
 * 两种画法都有(Powers 2019 p4 是 129 条 lineTo + 3 个矩形,Gulati 2021 p21
 * 是 43 条 + 5 个),不能只认一种。曲线跳过(表格线不会是曲的)。
 */
/** 取线段时顺手记下的取证计数 —— 用来回答"为什么一条都没取到"。 */
export interface SegmentScanStats {
	/** 操作符总数。 */
	ops: number;
	/** 按**操作符码**认出的 constructPath 数。 */
	byCode: number;
	/** 码认不出、靠**参数形状**认出来的 constructPath 数。 */
	byShape: number;
	/** 子操作码映射对不上(坐标数消耗不平、或包围盒与 minMax 对不上)而整条路径被跳过的数量。 */
	skipped: number;
	/** 调用方是否拿到了真实的 OPS 表(false = 用的是内置默认码)。 */
	realOps: boolean;
	/**
	 * 码对上了、可参数形状两种编码都不认识的条数 (2.12.9)。
	 *
	 * 这是 2.12.8 留下的遥测盲点:那时候「码对上但形状不认识」会在计数**之前**
	 * 被 continue 掉,于是真机上 `byCode` 恒为 0,看起来像「操作符码错了」,
	 * 实际是「参数形状换了」—— 方向完全反了,白查一轮。编码以后再变,
	 * 这个计数器会直接指出来。
	 */
	shapeUnknown: number;
	/** 用新版(扁平指令流)编码解出来的路径条数 (2.12.9)。 */
	newShape: number;
	/** 收尾是 endPath、一个像素都不画的路径条数(裁剪路径)(2.12.10)。 */
	unpainted: number;
}

/**
 * 这一条参数看起来像不像 constructPath (2.12.7)。
 *
 * **为什么需要形状判据**: 真机 2.12.6 的遥测显示每一页 `edgeSegments` 都是 0 ——
 * 一条线段都没认出来,而当时的遥测说不出是哪一层断的。
 *
 * **2.12.9 更正**: 上面这段当时给的解释("`win.pdfjsLib` 取不到、退回了内置码表、
 * 内置的 constructPath:91 与 Zotero 不一致")**是错的**,这里留着不删,因为
 * 它连着两版把我带偏了方向。2.12.8 的遥测把它逐条证伪:`edgeRealOps=true`
 * (真的拿到了 OPS 表)、`edgeOps` 400~1200(真的拿到了操作符列表)。
 * 2.12.6 那一版真正断的地方是 Xray waiver(2.12.8 修掉的),而这一版发现:
 * 码从来就没错过,**换的是参数形状**(见下面 looksLikeNewConstructPath)。
 *
 * 形状判据本身仍然值得留着 —— 它是码对不上时的兜底 —— 只是它当初的立论依据不成立。
 *
 * constructPath 的参数形状很独特: `[子操作码数组, 坐标数组, ...]` —— 两个都是
 * 数字型 ArrayLike。别的操作符没有这个形状(`transform` 是 6 个数的平坦数组,
 * `setLineDash` 是 `[数组, 数字]`,`paintImageXObject` 是 `[字符串, 数, 数]`)。
 * 所以码认不出时按形状认,版本再怎么变都不影响。
 */
function looksLikeConstructPath(args: unknown): args is [ArrayLike<number>, ArrayLike<number>] {
	if (!Array.isArray(args) || args.length < 2) {
		return false;
	}
	const [a, b] = args as [unknown, unknown];
	const arrayish = (v: unknown): boolean =>
		!!v && typeof v === 'object' && typeof (v as ArrayLike<number>).length === 'number'
		&& (v as ArrayLike<number>).length > 0
		&& typeof (v as ArrayLike<number>)[0] === 'number';
	return arrayish(a) && arrayish(b);
}

/** 一个子操作吃几个坐标;未知返回 -1。 */
function coordCost(sub: number, OP: typeof DEFAULT_PATH_OPS): number {
	if (sub === OP.moveTo || sub === OP.lineTo) { return 2; }
	if (sub === OP.curveTo) { return 6; }
	if (sub === OP.rectangle) { return 4; }
	if (sub === OP.closePath) { return 0; }
	return -1;
}

/* ────────────────────────────── 新版路径编码 (2.12.9) ────────────────────────────── */

/**
 * pdf.js 5.3+ 的路径子操作枚举。
 *
 * 取值不是猜的,是 pdf.js 自己的源码常量(`pdf.worker.mjs` 里
 * `{ moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 }`),
 * 并且由下面的 minMax 交叉验证在两份真实期刊 PDF、共 11630 条路径上逐条复核过
 * (包围盒全部零误差吻合)。
 *
 * 注意 `quadraticCurveTo` 吃 4 个坐标而不是 6 —— 三次曲线才是 6。
 */
const DRAW_OPS = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

function drawCost(sub: number): number {
	if (sub === DRAW_OPS.moveTo || sub === DRAW_OPS.lineTo) { return 2; }
	if (sub === DRAW_OPS.curveTo) { return 6; }
	if (sub === DRAW_OPS.quadraticCurveTo) { return 4; }
	if (sub === DRAW_OPS.closePath) { return 0; }
	return -1;
}

function numericArrayLike(v: unknown): v is ArrayLike<number> {
	return !!v && typeof v === 'object' && typeof (v as ArrayLike<number>).length === 'number'
		&& (v as ArrayLike<number>).length > 0 && typeof (v as ArrayLike<number>)[0] === 'number';
}

/**
 * 这一条参数是不是**新版** constructPath: `[收尾绘制码, [扁平指令流, ...], minMax]`。
 *
 * 与旧版的区别在第一个参数:旧版是子操作码**数组**,新版是一个**数字**
 * (收尾的绘制操作符,实测只见 stroke=20 / fill=22 / eoFill=28)。
 * 第二个参数是一组指令流,每条流把指令和坐标交错放在同一个数组里。
 */
function looksLikeNewConstructPath(args: unknown): args is [number, ArrayLike<ArrayLike<number>>, ArrayLike<number>?] {
	if (!Array.isArray(args) || args.length < 2) { return false; }
	const [paint, streams] = args as [unknown, unknown];
	if (typeof paint !== 'number') { return false; }
	if (!streams || typeof streams !== 'object') { return false; }
	const len = (streams as ArrayLike<unknown>).length;
	if (typeof len !== 'number' || len < 1) { return false; }
	return numericArrayLike((streams as ArrayLike<unknown>)[0]);
}

/**
 * 解一条新版 constructPath。**先自证再交货**:
 *
 *  1. 指令流必须按枚举**刚好消耗完** —— 不平就整条丢掉,绝不按猜出来的步长继续读;
 *  2. 解出来的包围盒必须与 pdf.js 自己算好的 `minMax` 吻合 —— 这一条是白送的交叉
 *     验证,`minMax` 与原始坐标同在路径空间(未过 CTM),对不上就说明我的解码跑偏了。
 *
 * 第 2 条是防「假网格」的关键:坐标错位的线段拼出来的网格看着像模像样,
 * 比没有网格更糟。宁可这一页没有边框证据,也不交一张编出来的表。
 *
 * 返回 null = 这条路径不可信,调用方计入 skipped。
 */
function decodeNewPath(
	paint: number,
	streams: ArrayLike<ArrayLike<number>>,
	minMax: ArrayLike<number> | undefined,
	ctm: Matrix,
	OP: typeof DEFAULT_PATH_OPS,
	out: Segment[]
): 'ok' | 'bad' | 'unpainted' {
	const kind = paintKind(paint, OP);
	if (kind === 'none') { return 'unpainted'; }
	const pending: Segment[] = [];
	const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
	const take = (x: number, y: number): void => {
		if (x < box[0]) { box[0] = x; } if (x > box[2]) { box[2] = x; }
		if (y < box[1]) { box[1] = y; } if (y > box[3]) { box[3] = y; }
	};
	let seen = 0;
	for (let si = 0; si < streams.length; si++) {
		const s = streams[si];
		if (!numericArrayLike(s)) { return 'bad'; }
		let k = 0;
		let cur: [number, number] | null = null;
		let start: [number, number] | null = null;
		// 原始坐标(未过 CTM)下的当前点 —— 曲线的紧包围盒要从它起算。
		let rawX = 0, rawY = 0;
		const closeSub = (): void => {
			if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) {
				pending.push([cur[0], cur[1], start[0], start[1]]);
			}
		};
		while (k < s.length) {
			const sub = s[k]!;
			const need = drawCost(sub);
			if (need < 0 || k + 1 + need > s.length) { return 'bad'; }
			if (sub === DRAW_OPS.moveTo) {
				// 新子路径开始:填充类绘制会把上一条开放子路径闭合。
				if (kind === 'closed') { closeSub(); }
				rawX = s[k + 1]!; rawY = s[k + 2]!;
				take(rawX, rawY); seen++;
				cur = apply(ctm, rawX, rawY);
				start = cur;
			}
			else if (sub === DRAW_OPS.lineTo) {
				rawX = s[k + 1]!; rawY = s[k + 2]!;
				take(rawX, rawY); seen++;
				const p = apply(ctm, rawX, rawY);
				if (cur) { pending.push([cur[0], cur[1], p[0], p[1]]); }
				cur = p;
			}
			else if (sub === DRAW_OPS.curveTo) {
				// 包围盒按曲线真实极值算 —— pdf.js 的 minMax 就是这么定义的,
				// 不是控制点(2.12.9 在这里说错了,插图页 45% 的路径因此被误判)。
				cubicExtent(rawX, rawY, s[k + 1]!, s[k + 2]!, s[k + 3]!, s[k + 4]!, s[k + 5]!, s[k + 6]!, box);
				rawX = s[k + 5]!; rawY = s[k + 6]!; seen++;
				// 弧本身不产出线段(不许把弧的两端连成假直线),但当前点要**跟到弧的终点**:
				// 圆角矩形的四条直边全在圆弧之后,置空就把圆角表格的边框整个丢了(2.12.9 的错)。
				cur = apply(ctm, rawX, rawY);
			}
			else if (sub === DRAW_OPS.quadraticCurveTo) {
				// 二次升三次:c1 = p0 + 2/3(q-p0),c2 = p3 + 2/3(q-p3)。
				const qx = s[k + 1]!, qy = s[k + 2]!, ex = s[k + 3]!, ey = s[k + 4]!;
				cubicExtent(rawX, rawY,
					rawX + 2 / 3 * (qx - rawX), rawY + 2 / 3 * (qy - rawY),
					ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey),
					ex, ey, box);
				rawX = ex; rawY = ey; seen++;
				cur = apply(ctm, rawX, rawY);
			}
			else if (sub === DRAW_OPS.closePath) {
				// 闭合边是**真的被画出来的**那一条:新编码里矩形就是
				// moveTo + 三条 lineTo + closePath,少了它每个矩形都缺一条边。
				closeSub();
				cur = start;
				if (start) { /* 回到起点:原始坐标同步 */ }
			}
			k += 1 + need;
		}
		if (kind === 'closed') { closeSub(); }
	}
	// minMax 交叉验证。Float32 的值在两边完全一致,容差只是防浮点噪声。
	if (minMax && minMax.length >= 4 && seen > 0) {
		const tol = 0.01;
		if (Math.abs(box[0] - minMax[0]!) > tol || Math.abs(box[1] - minMax[1]!) > tol
			|| Math.abs(box[2] - minMax[2]!) > tol || Math.abs(box[3] - minMax[3]!) > tol) {
			return 'bad';
		}
	}
	for (const seg of pending) { out.push(seg); }
	return 'ok';
}

/**
 * 走一遍操作符列表,交出页面用户空间里的线段。矩形拆成四条边 —— 期刊表格
 * 两种画法都有(Powers 2019 p4 是 129 条 lineTo + 3 个矩形,Gulati 2021 p21
 * 是 43 条 + 5 个),不能只认一种。曲线跳过(表格线不会是曲的)。
 *
 * 2.12.7: 子操作码映射先**自证**再用 —— 按映射把坐标消耗一遍,必须刚好用完
 * `coords.length`。不平就整条路径跳过并计数,而不是继续按错的步长读下去
 * (那样产出的线段坐标全是错位的,比没有更糟)。
 *
 * 2.12.9: 认**两种**编码。pdf.js 5.3+ 把 constructPath 的参数从
 * `[子操作码数组, 坐标数组, minMax]` 换成了 `[收尾绘制码, [扁平指令流, ...], minMax]`,
 * 指令与坐标交错在一个数组里,子操作码也换成了路径内部的小枚举。Zotero 用的就是
 * 新版 —— 真机 2.12.8 遥测每页 `edgeSegments=0`、`byCode=0`、`byShape=2`,
 * 与本地同一份 PDF 换到 5.7.284 跑出来的数字逐页吻合(46 页里 42 页分毫不差)。
 * 旧编码这一支照旧保留:不知道用户装的是哪个 Zotero,两边都得认。
 */
export function segmentsFromOperatorList(
	fnArray: ArrayLike<number>,
	argsArray: ArrayLike<unknown>,
	ops: Partial<typeof DEFAULT_PATH_OPS> = {},
	limit = 20000,
	stats?: SegmentScanStats
): Segment[] {
	const OP = { ...DEFAULT_PATH_OPS, ...ops };
	const out: Segment[] = [];
	if (stats) {
		stats.ops = fnArray.length;
		stats.byCode = 0;
		stats.byShape = 0;
		stats.skipped = 0;
		stats.realOps = Object.keys(ops).length > 0;
		stats.shapeUnknown = 0;
		stats.newShape = 0;
		stats.unpainted = 0;
	}
	try {
		let ctm: Matrix = IDENTITY;
		const stack: Matrix[] = [];
		for (let i = 0; i < fnArray.length && out.length < limit; i++) {
			const fn = fnArray[i]!;
			if (fn === OP.save) { stack.push(ctm); continue; }
			if (fn === OP.restore) { ctm = stack.pop() ?? IDENTITY; continue; }
			if (fn === OP.transform) {
				const a = argsArray[i] as number[] | undefined;
				if (a && a.length >= 6 && typeof a[0] === 'number') { ctm = mul(ctm, a as unknown as Matrix); }
				continue;
			}
			const isPath = fn === OP.constructPath;
			const args = argsArray[i];

			// 新编码优先判:它的第一个参数是数字,旧编码是数组,两者不会混淆。
			if (looksLikeNewConstructPath(args)) {
				if (stats) {
					if (isPath) { stats.byCode++; }
					else { stats.byShape++; }
					stats.newShape++;
				}
				const [paint, streams, minMax] = args;
				const r = decodeNewPath(paint, streams, minMax, ctm, OP, out);
				if (stats) {
					if (r === 'bad') { stats.skipped++; }
					else if (r === 'unpainted') { stats.unpainted++; }
				}
				continue;
			}

			if (!looksLikeConstructPath(args)) {
				// 码对上了、两种形状都不认识 —— 单独记一笔。2.12.8 就是缺了这一笔,
				// 才把「参数形状变了」误读成「操作符码错了」。
				if (isPath && stats) { stats.shapeUnknown++; }
				continue;
			}
			if (stats) {
				if (isPath) { stats.byCode++; }
				else { stats.byShape++; }
			}
			const [subOps, coords] = args;
			// 先自证:按映射消耗坐标,必须刚好用完。
			let need = 0;
			let ok = true;
			for (let s = 0; s < subOps.length; s++) {
				const cost = coordCost(subOps[s]!, OP);
				if (cost < 0) { ok = false; break; }
				need += cost;
			}
			if (!ok || need !== coords.length) {
				if (stats) { stats.skipped++; }
				continue;
			}
			// 旧编码的收尾绘制码是紧跟其后的操作符,中间可能夹着 clip / eoClip (2.12.10)。
			let j = i + 1;
			while (j < fnArray.length && (fnArray[j] === OP.clip || fnArray[j] === OP.eoClip)) { j++; }
			const kind = paintKind(j < fnArray.length ? fnArray[j]! : OP.stroke, OP);
			if (kind === 'none') {
				if (stats) { stats.unpainted++; }
				continue;
			}
			let k = 0;
			let cur: [number, number] | null = null;
			let start: [number, number] | null = null;
			const closeSub = (): void => {
				if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) {
					out.push([cur[0], cur[1], start[0], start[1]]);
				}
			};
			for (let s = 0; s < subOps.length; s++) {
				const sub = subOps[s]!;
				if (sub === OP.moveTo) {
					if (kind === 'closed') { closeSub(); }
					cur = apply(ctm, coords[k]!, coords[k + 1]!); k += 2;
					start = cur;
				}
				else if (sub === OP.lineTo) {
					const p = apply(ctm, coords[k]!, coords[k + 1]!); k += 2;
					if (cur) { out.push([cur[0], cur[1], p[0], p[1]]); }
					cur = p;
				}
				else if (sub === OP.curveTo) { cur = apply(ctm, coords[k + 4]!, coords[k + 5]!); k += 6; }
				else if (sub === OP.closePath) { closeSub(); cur = start; }
				else if (sub === OP.rectangle) {
					const x = coords[k]!, y = coords[k + 1]!, w = coords[k + 2]!, h = coords[k + 3]!;
					k += 4;
					const c = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
					for (let q = 0; q < 4; q++) {
						const a = c[q]!, b = c[(q + 1) % 4]!;
						out.push([a[0], a[1], b[0], b[1]]);
					}
					cur = null;
				}
			}
			if (kind === 'closed') { closeSub(); }
		}
	}
	catch {
		// 取证失败就当这一页没有边框证据 —— 绝不把阅读器带崩。
		return out;
	}
	return out;
}
