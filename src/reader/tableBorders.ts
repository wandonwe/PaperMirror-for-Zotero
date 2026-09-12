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
	const sorted = [...lines].sort((a, b) => a.pos - b.pos || a.from - b.from);
	const out: Line[] = [];
	for (const l of sorted) {
		const last = out[out.length - 1];
		if (last && Math.abs(last.pos - l.pos) <= tol && l.from <= last.to + joinGap) {
			last.to = Math.max(last.to, l.to);
			last.from = Math.min(last.from, l.from);
			// 位置取两者均值,吸收 0.1pt 级的取整抖动。
			last.pos = (last.pos + l.pos) / 2;
		}
		else {
			out.push({ ...l });
		}
	}
	return out;
}

/**
 * 位置聚类:把 ±tol 内的**已合并线段**归成一条边界。
 *
 * 关键:跨度取同位置各段里**最长的那一段**,而不是把 from/to 取并集。
 * 取并集会把 mergeCollinear 的"隔太远不算一条线"直接架空 —— 页面顶端一小截
 * 与底端一小截共线短线会被拼成一条"贯穿全页的线",再被围合判据当成列边界。
 */
function cluster(lines: Line[], tol: number): { pos: number; from: number; to: number }[] {
	const sorted = [...lines].sort((a, b) => a.pos - b.pos);
	const out: { pos: number; from: number; to: number }[] = [];
	for (const l of sorted) {
		const last = out[out.length - 1];
		if (last && l.pos - last.pos <= tol) {
			// 同一条边界上的多个互不相连的段:留最长的那一段作为它的实际跨度。
			if (l.to - l.from > last.to - last.from) {
				last.from = l.from;
				last.to = l.to;
			}
		}
		else {
			out.push({ pos: l.pos, from: l.from, to: l.to });
		}
	}
	return out;
}

export interface BorderGridOptions {
	/** 页面高度,用于把 PDF 的 y(向上)翻成 top-down。 */
	pageHeight: number;
	/** 方向容差与聚类容差(点)。默认 1.5 —— 覆盖 0.5pt 线宽与取整抖动。 */
	tol?: number;
	/** 最短可用线段。默认 6 —— 比这更短的是勾号、脚注符,不是表格线。 */
	minLen?: number;
}

/**
 * 从线段推出一张表的硬网格;推不出就返回 null(**绝不猜**)。
 *
 * 判据("成网格"):至少 2 条列边界与 2 条行边界,且它们**互相围合** ——
 * 每条采用的列边界都要纵向盖住大部分行区间,每条采用的行边界都要横向盖住
 * 大部分列区间。页眉横线只有一条、图表坐标轴只有两条且不互相围合,都进不来。
 */
export function borderGrid(segments: Segment[], options: BorderGridOptions): BorderGrid | null {
	const tol = options.tol ?? 1.5;
	const minLen = options.minLen ?? 6;
	const { h, v } = classify(segments, tol, minLen);
	if (h.length < 2 || v.length < 2) {
		return null;
	}
	const hs = cluster(mergeCollinear(h, tol, tol * 2), tol);
	const vs = cluster(mergeCollinear(v, tol, tol * 2), tol);
	if (hs.length < 2 || vs.length < 2) {
		return null;
	}
	// 候选表体:所有线共同覆盖的范围。
	const xMin = Math.min(...vs.map(l => l.pos), ...hs.map(l => l.from));
	const xMax = Math.max(...vs.map(l => l.pos), ...hs.map(l => l.to));
	const yMin = Math.min(...hs.map(l => l.pos), ...vs.map(l => l.from));
	const yMax = Math.max(...hs.map(l => l.pos), ...vs.map(l => l.to));
	const spanX = xMax - xMin;
	const spanY = yMax - yMin;
	if (spanX <= 0 || spanY <= 0) {
		return null;
	}
	// 围合判据: 列边界要纵向盖住 ≥60% 表高,行边界要横向盖住 ≥60% 表宽。
	// 用**实际覆盖区间**,不把短线延长。
	const cols = vs.filter(l => (l.to - l.from) >= spanY * 0.6).map(l => l.pos).sort((a, b) => a - b);
	const rowsUp = hs.filter(l => (l.to - l.from) >= spanX * 0.6).map(l => l.pos).sort((a, b) => a - b);
	if (cols.length < 2 || rowsUp.length < 2) {
		return null;
	}
	// PDF 的 y 向上,页面坐标向下 —— 翻过来并重新升序。
	const rows = rowsUp.map(y => options.pageHeight - y).sort((a, b) => a - b);
	const left = cols[0]!;
	const right = cols[cols.length - 1]!;
	const top = rows[0]!;
	const bottom = rows[rows.length - 1]!;
	return {
		columns: cols,
		rows,
		region: { left, top, width: right - left, height: bottom - top }
	};
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
	constructPath: 91
};

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
export function segmentsFromOperatorList(
	fnArray: ArrayLike<number>,
	argsArray: ArrayLike<unknown>,
	ops: Partial<typeof DEFAULT_PATH_OPS> = {},
	limit = 20000
): Segment[] {
	const OP = { ...DEFAULT_PATH_OPS, ...ops };
	const out: Segment[] = [];
	try {
		let ctm: Matrix = IDENTITY;
		const stack: Matrix[] = [];
		for (let i = 0; i < fnArray.length && out.length < limit; i++) {
			const fn = fnArray[i]!;
			if (fn === OP.save) { stack.push(ctm); continue; }
			if (fn === OP.restore) { ctm = stack.pop() ?? IDENTITY; continue; }
			if (fn === OP.transform) {
				const a = argsArray[i] as number[] | undefined;
				if (a && a.length >= 6) { ctm = mul(ctm, a as unknown as Matrix); }
				continue;
			}
			if (fn !== OP.constructPath) { continue; }
			const args = argsArray[i] as [ArrayLike<number>, ArrayLike<number>] | undefined;
			if (!args) { continue; }
			const [subOps, coords] = args;
			if (!subOps || !coords) { continue; }
			let k = 0;
			let cur: [number, number] | null = null;
			for (let s = 0; s < subOps.length; s++) {
				const sub = subOps[s]!;
				if (sub === OP.moveTo) {
					cur = apply(ctm, coords[k]!, coords[k + 1]!); k += 2;
				}
				else if (sub === OP.lineTo) {
					const p = apply(ctm, coords[k]!, coords[k + 1]!); k += 2;
					if (cur) { out.push([cur[0], cur[1], p[0], p[1]]); }
					cur = p;
				}
				else if (sub === OP.curveTo) { k += 6; cur = null; }
				else if (sub === OP.closePath) { /* 无坐标 */ }
				else if (sub === OP.rectangle) {
					const x = coords[k]!, y = coords[k + 1]!, w = coords[k + 2]!, h = coords[k + 3]!;
					k += 4;
					const c = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
					for (let j = 0; j < 4; j++) {
						const a = c[j]!, b = c[(j + 1) % 4]!;
						out.push([a[0], a[1], b[0], b[1]]);
					}
					cur = null;
				}
				else { k += 2; }
			}
		}
	}
	catch {
		// 取证失败就当这一页没有边框证据 —— 绝不把阅读器带崩。
		return out;
	}
	return out;
}
