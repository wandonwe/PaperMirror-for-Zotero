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
	streams: ArrayLike<ArrayLike<number>>,
	minMax: ArrayLike<number> | undefined,
	ctm: Matrix,
	out: Segment[]
): boolean {
	const pending: Segment[] = [];
	let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
	let seen = 0;
	for (let si = 0; si < streams.length; si++) {
		const s = streams[si];
		if (!numericArrayLike(s)) { return false; }
		let k = 0;
		let cur: [number, number] | null = null;
		let start: [number, number] | null = null;
		while (k < s.length) {
			const sub = s[k]!;
			const need = drawCost(sub);
			if (need < 0 || k + 1 + need > s.length) { return false; }
			// 包围盒按**原始坐标**累计(minMax 也在这个空间),曲线控制点一并计入 ——
			// 实测 pdf.js 的 minMax 就是这么算的。
			for (let j = 0; j < need; j += 2) {
				const x = s[k + 1 + j]!, y = s[k + 2 + j]!;
				if (x < minx) { minx = x; } if (x > maxx) { maxx = x; }
				if (y < miny) { miny = y; } if (y > maxy) { maxy = y; }
				seen++;
			}
			if (sub === DRAW_OPS.moveTo) {
				cur = apply(ctm, s[k + 1]!, s[k + 2]!);
				start = cur;
			}
			else if (sub === DRAW_OPS.lineTo) {
				const p = apply(ctm, s[k + 1]!, s[k + 2]!);
				if (cur) { pending.push([cur[0], cur[1], p[0], p[1]]); }
				cur = p;
			}
			else if (sub === DRAW_OPS.curveTo || sub === DRAW_OPS.quadraticCurveTo) {
				// 表格线不会是曲的;跳过并断开连线,免得把曲线两端连成一条假直线。
				cur = null;
			}
			else if (sub === DRAW_OPS.closePath) {
				// 闭合边是**真的被画出来的**那一条,不是补出来的:新编码里矩形就是
				// moveTo + 三条 lineTo + closePath,少了它每个矩形都缺一条边。
				// (旧编码有独立的 rectangle 子操作,四条边齐全,所以以前没暴露。)
				// 只在当前点与起点确实不同时才出线段;曲线之后 cur 为 null,不补。
				if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) {
					pending.push([cur[0], cur[1], start[0], start[1]]);
				}
				cur = start;
			}
			k += 1 + need;
		}
	}
	// minMax 交叉验证。Float32 的值在两边完全一致,容差只是防浮点噪声。
	if (minMax && minMax.length >= 4 && seen > 0) {
		const tol = 0.01;
		if (Math.abs(minx - minMax[0]!) > tol || Math.abs(miny - minMax[1]!) > tol
			|| Math.abs(maxx - minMax[2]!) > tol || Math.abs(maxy - minMax[3]!) > tol) {
			return false;
		}
	}
	for (const seg of pending) { out.push(seg); }
	return true;
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
				const [, streams, minMax] = args;
				if (!decodeNewPath(streams, minMax, ctm, out)) {
					if (stats) { stats.skipped++; }
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
			}
		}
	}
	catch {
		// 取证失败就当这一页没有边框证据 —— 绝不把阅读器带崩。
		return out;
	}
	return out;
}
