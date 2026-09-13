import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	borderGrid, borderGrids, segmentsFromOperatorList, DEFAULT_PATH_OPS, type Segment, type SegmentScanStats
} from '../../src/reader/tableBorders';

/**
 * PDF.js 路径编码取证 (2.12.9)
 *
 * 2.12.8 的真机遥测把问题钉死在了这一层:`edgeRealOps=true`(拿到了真的 OPS 表)、
 * `edgeOps` 400~1200(拿到了真的操作符列表)、`imageRects` 从 0 变正(waiver 确实生效),
 * 可 `edgeSegments` 仍然每页都是 0,`edgeByCode=0`、`edgeByShape=2`、`edgeSkipped=2`。
 *
 * 把真机 46 页的 `edgeOps` 与本地同一份 PDF 逐页对照后发现:**Zotero 那版 pdf.js 换了
 * 路径编码**。旧版(4.10.x)`constructPath` 的参数是 `[子操作码数组, 坐标数组, minMax]`
 * 两个并列数组;新版(5.3+)换成了 `[收尾绘制码, [扁平指令流, ...], minMax]` ——
 * 指令与坐标**交错在同一个数组里**,子操作码也不再是 OPS 里的 13/14/15/18,
 * 而是路径内部的小枚举 0=moveTo 1=lineTo 2=curveTo 4=closePath。
 *
 * 于是形状判据 `两个数组` 认不出它(每页只剩 paintFormXObjectBegin 那 2 条误命中,
 * 且都被坐标自证正确地拒掉 —— 自证是有效的,它没有造出假网格)。
 *
 * 这一组夹具由 scripts/dump-rawops.mjs 从用户提供的原始 PDF 转储:同一页、同一份
 * 文件,分别用 4.10.38 与 5.7.284 跑一遍 getOperatorList,只保留与路径有关的条目
 * (save/restore/transform/constructPath/paintFormXObjectBegin),其余参数一律置 null
 * —— 夹具里没有任何正文文字,只有几何。
 *
 * 核心断言:**同一页的两种编码必须解出同一张表**。这个断言不需要新的真值来源,
 * 旧编码那一侧已经被 pdfplumber 独立验证过(Powers p4 = 3 列 18 行)。
 */

interface RawOps {
	pdfjs: string;
	page: number;
	width: number;
	height: number;
	ops: Record<string, number>;
	fnArray: number[];
	argsArray: unknown[];
}

function rawops(name: string): RawOps {
	return JSON.parse(readFileSync(`tests/fixtures/layout/${name}.rawops.json`, 'utf8')) as RawOps;
}

function scan(r: RawOps, stats?: SegmentScanStats): Segment[] {
	return segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
}

function newStats(): SegmentScanStats {
	return { ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false, shapeUnknown: 0, newShape: 0, unpainted: 0 };
}

// ---------------------------------------------------------------- 旧编码不许回归

test('旧编码 (pdfjs 4.10.38) 仍然解得出 Powers p4 的 3 列 18 行 (2.12.9)', () => {
	const r = rawops('powers2019-p4-old');
	const segs = scan(r);
	assert.ok(segs.length > 100, `旧编码应解出上百条线段,实得 ${segs.length}`);
	const grid = borderGrid(segs, { pageHeight: r.height });
	assert.ok(grid, '这一页画着完整网格,必须推得出来');
	assert.equal(grid!.columns.length - 1, 3, `应为 3 列,实得 ${grid!.columns.length - 1}`);
	assert.equal(grid!.rows.length - 1, 18, `应为 18 行,实得 ${grid!.rows.length - 1}`);
});

// ---------------------------------------------------------------- 新编码必须读得懂

test('新编码 (pdfjs 5.7.284) 也要解出 Powers p4 的 3 列 18 行 (2.12.9)', () => {
	const r = rawops('powers2019-p4-new');
	const stats = newStats();
	const segs = scan(r, stats);
	assert.ok(segs.length > 100, `新编码应解出上百条线段,实得 ${segs.length}(真机 2.12.8 就是卡在这里,恒为 0)`);
	const grid = borderGrid(segs, { pageHeight: r.height });
	assert.ok(grid, '同一页、同一份 PDF,换个 pdfjs 版本不该就认不出表了');
	assert.equal(grid!.columns.length - 1, 3, `应为 3 列,实得 ${grid!.columns.length - 1}`);
	assert.equal(grid!.rows.length - 1, 18, `应为 18 行,实得 ${grid!.rows.length - 1}`);
});

test('同一页的新旧两种编码必须解出同一张网格 —— Powers p4 (2.12.9)', () => {
	const a = rawops('powers2019-p4-old');
	const b = rawops('powers2019-p4-new');
	const ga = borderGrid(scan(a), { pageHeight: a.height });
	const gb = borderGrid(scan(b), { pageHeight: b.height });
	assert.ok(ga && gb, '两侧都得有网格');
	assert.equal(gb!.columns.length, ga!.columns.length, '列数必须一致');
	assert.equal(gb!.rows.length, ga!.rows.length, '行数必须一致');
	ga!.columns.forEach((x, i) => {
		assert.ok(Math.abs(x - gb!.columns[i]!) < 0.5, `第 ${i} 条列线:旧 ${x.toFixed(2)} vs 新 ${gb!.columns[i]!.toFixed(2)}`);
	});
	ga!.rows.forEach((y, i) => {
		assert.ok(Math.abs(y - gb!.rows[i]!) < 0.5, `第 ${i} 条行线:旧 ${y.toFixed(2)} vs 新 ${gb!.rows[i]!.toFixed(2)}`);
	});
});

test('同一页的新旧两种编码必须解出同一张网格 —— Gulati p21 (2.12.9)', () => {
	const a = rawops('gulati2021-p21-old');
	const b = rawops('gulati2021-p21-new');
	const ga = borderGrid(scan(a), { pageHeight: a.height });
	const gb = borderGrid(scan(b), { pageHeight: b.height });
	assert.ok(ga && gb, '两侧都得有网格');
	assert.equal(gb!.columns.length, ga!.columns.length, '列数必须一致');
	assert.equal(gb!.rows.length, ga!.rows.length, '行数必须一致');
	ga!.columns.forEach((x, i) => {
		assert.ok(Math.abs(x - gb!.columns[i]!) < 0.5, `第 ${i} 条列线:旧 ${x.toFixed(2)} vs 新 ${gb!.columns[i]!.toFixed(2)}`);
	});
});

// ---------------------------------------------------------------- 遥测得能分辨编码

test('遥测要能区分“按码认出”“按新形状认出”“形状不认识” (2.12.9)', () => {
	const oldR = rawops('powers2019-p4-old');
	const newR = rawops('powers2019-p4-new');
	const so = newStats(); scan(oldR, so);
	const sn = newStats(); scan(newR, sn);

	assert.ok(so.byCode > 100, `旧编码应按码认出上百条,实得 ${so.byCode}`);
	assert.ok(sn.byCode > 100, `新编码同样按码认得出(码没变,变的是参数),实得 ${sn.byCode}`);

	// 2.12.8 的遥测盲点:码对上了、形状不认识,会在计数之前被 continue 掉,
	// 于是真机上 byCode 恒为 0,看起来像“码错了”,实际是“参数形状变了”。
	// 计数器必须把这种情况单独记下来,否则下次编码再变还是查不出来。
	assert.ok('shapeUnknown' in sn, '统计里必须有 shapeUnknown 这一项');
	assert.equal(sn.shapeUnknown, 0, '新编码已经认识了,不该再记成“形状不认识”');
});

// ---------------------------------------------------------------- 反向锁:不许猜

test('反向锁:子操作码不认识时整条路径跳过,绝不按猜出来的步长继续读 (2.12.9)', () => {
	const r = rawops('powers2019-p4-new');
	// 往指令流里塞一个未定义的子操作码 7 —— 真实文档里没出现过 3/5/6/7,
	// 我不知道它吃几个坐标,那就必须拒绝整条路径,而不是假设一个数继续往下读。
	const mutated: RawOps = JSON.parse(JSON.stringify(r));
	let touched = 0;
	for (let i = 0; i < mutated.fnArray.length; i++) {
		if (mutated.fnArray[i] !== mutated.ops.constructPath) { continue; }
		const a = mutated.argsArray[i] as [number, number[][], number[]];
		if (!Array.isArray(a) || !Array.isArray(a[1])) { continue; }
		for (const stream of a[1]) { if (stream.length > 0) { stream[0] = 7; touched++; } }
		if (touched >= 5) { break; }
	}
	assert.ok(touched > 0, '夹具里得真的有路径可改');
	const stats = newStats();
	const segs = scan(mutated, stats);
	assert.ok(stats.skipped >= touched, `被污染的 ${touched} 条路径必须全部跳过并计数,实得 skipped=${stats.skipped}`);
	// 其余没被污染的路径照常解出来 —— 跳过的是路径,不是整页。
	assert.ok(segs.length > 0, '污染几条路径不该让整页失效');
});

test('反向锁:解出来的包围盒必须与 pdf.js 自带的 minMax 对得上,对不上就丢弃 (2.12.9)', () => {
	const r = rawops('powers2019-p4-new');
	// 把 minMax 改成一个与实际路径不符的值。这模拟“我的解码跑偏了”:
	// 若代码不做这一层交叉验证,它会照样吐出坐标错位的线段 —— 那比没有线段更糟,
	// 因为错位的线段会拼出一张**看起来像模像样的假网格**。
	const mutated: RawOps = JSON.parse(JSON.stringify(r));
	let touched = 0;
	for (let i = 0; i < mutated.fnArray.length; i++) {
		if (mutated.fnArray[i] !== mutated.ops.constructPath) { continue; }
		const a = mutated.argsArray[i] as [number, number[][], number[]];
		if (!Array.isArray(a) || !Array.isArray(a[2]) || a[2].length < 4) { continue; }
		a[2] = [a[2][0]! + 137, a[2][1]! + 137, a[2][2]! + 137, a[2][3]! + 137];
		touched++;
		if (touched >= 8) { break; }
	}
	assert.ok(touched > 0, '夹具里得真的有 minMax 可改');
	const stats = newStats();
	scan(mutated, stats);
	assert.ok(stats.skipped >= touched, `minMax 对不上的 ${touched} 条路径必须被丢弃,实得 skipped=${stats.skipped}`);
});

test('反向锁:包围盒全部对不上时,产出必须是 0 条线段 —— 不许"先交货再否决" (2.12.9)', () => {
	const r = rawops('powers2019-p4-new');
	// 把**每一条**路径的 minMax 都改错。全部被否决,产出就必须是空的。
	//
	// 为什么要有这一条:只断言 `skipped` 计数的锁挡不住"先把线段推进结果、
	// 再回头记一笔 skipped"的写法 —— 变异验证实测它能保持绿,而它恰恰就是
	// 产出假网格的路径。断言"一条都没有"才是真的闸门。
	const mutated: RawOps = JSON.parse(JSON.stringify(r));
	let touched = 0;
	for (let i = 0; i < mutated.fnArray.length; i++) {
		if (mutated.fnArray[i] !== mutated.ops.constructPath) { continue; }
		const a = mutated.argsArray[i] as [number, number[][], number[]];
		if (!Array.isArray(a) || !Array.isArray(a[2]) || a[2].length < 4) { continue; }
		a[2] = [a[2][0]! + 137, a[2][1]! + 137, a[2][2]! + 137, a[2][3]! + 137];
		touched++;
	}
	assert.ok(touched > 100, `应当污染了上百条路径,实得 ${touched}`);
	const stats = newStats();
	const segs = scan(mutated, stats);
	assert.equal(segs.length, 0, `全部否决就该一条不剩,实得 ${segs.length} 条`);
	// ≥ 而非 = :这一页还有 paintFormXObjectBegin 这类"形状误命中"也计入 skipped。
	assert.ok(stats.skipped >= touched, `${touched} 条全部计入 skipped,实得 ${stats.skipped}`);
	assert.equal(borderGrid(segs, { pageHeight: r.height }), null, '没有线段就不该有网格');
});

test('反向锁:非路径操作符不许被当成路径吃进去 (2.12.9)', () => {
	const r = rawops('powers2019-p4-new');
	const stats = newStats();
	scan(r, stats);
	// paintFormXObjectBegin 的参数是 [matrix, bbox] 两个数字数组,旧的形状判据会误命中它。
	// 它不是路径,吐不出线段,必须被自证拦下 —— 计数可见,但不产出。
	assert.ok(stats.byCode > 100, '真路径要认出来');
	const cp = r.fnArray.filter((f) => f === r.ops.constructPath).length;
	assert.equal(stats.byCode, cp, `按码认出的数量应等于页面上 constructPath 的真实条数 ${cp},实得 ${stats.byCode}`);
});

test('反向锁:空的/残缺的指令流不产出线段也不抛 (2.12.9)', () => {
	const r = rawops('powers2019-p4-new');
	const mutated: RawOps = JSON.parse(JSON.stringify(r));
	for (let i = 0; i < mutated.fnArray.length; i++) {
		if (mutated.fnArray[i] !== mutated.ops.constructPath) { continue; }
		const a = mutated.argsArray[i] as [number, number[][], number[]];
		if (!Array.isArray(a) || !Array.isArray(a[1])) { continue; }
		// 指令流被截断:声明了 lineTo 却只剩一个坐标。
		a[1] = [[0, 10, 10, 1, 20]];
		a[2] = [10, 10, 20, 20];
	}
	const stats = newStats();
	const segs = scan(mutated, stats);
	assert.equal(segs.length, 0, '残缺的流一条线段都不该产出');
	assert.ok(stats.skipped > 0, '而且要计数,不能静默');
});

test('二次贝塞尔 (子操作 3) 吃 4 个坐标而不是 6 (2.12.9)', () => {
	// 两份真实期刊 PDF 的 11630 条路径里一次都没出现过子操作 3,所以真值不是实测来的,
	// 是 pdf.js 源码里的常量表(quadraticCurveTo: 3)。这里用一条**自洽的合成路径**
	// 把它锁住:moveTo(0,0) → 二次曲线(控制点 5,10;终点 10,0) → closePath。
	// 若把开销写成 6,这条流就消耗不平,会被自证拦下 —— 断言里的 skipped=0 就会变红。
	const r: RawOps = {
		pdfjs: 'synthetic', page: 1, width: 100, height: 100,
		ops: { ...DEFAULT_PATH_OPS },
		fnArray: [DEFAULT_PATH_OPS.constructPath],
		// minMax 是**紧**包围盒:二次曲线 (0,0)→控制 (5,10)→(10,0) 的最高点是 5,不是 10。
		argsArray: [[20, [[0, 0, 0, 3, 5, 10, 10, 0, 4]], [0, 0, 10, 5]]]
	};
	const stats = newStats();
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
	assert.equal(stats.skipped, 0, '开销写对了就该整条消耗干净');
	assert.equal(stats.byCode, 1, '这一条要认出来');
	// 曲线本身不产出线段;closePath 从曲线终点 (10,0) 画回起点 (0,0) 那条**是**直线,要交。
	assert.equal(segs.length, 1, '曲线不当作表格线,闭合弦是直线');
});

test('遥测:码对上、两种形状都不认识,必须计入 shapeUnknown 而不是静默丢弃 (2.12.9)', () => {
	// 这一条锁的是 2.12.8 那个真正让我查错方向的盲点。当时"码对上但形状不认识"
	// 在计数**之前**就被 continue 掉,真机遥测里 byCode 恒为 0 ——
	// 读起来像"操作符码错了",于是我下一版去重做码识别,全白费。
	// 真相是"参数形状换了"。这个计数器就是用来把这两件事分开的。
	const r: RawOps = {
		pdfjs: 'synthetic', page: 1, width: 100, height: 100,
		ops: { ...DEFAULT_PATH_OPS },
		fnArray: [DEFAULT_PATH_OPS.constructPath, DEFAULT_PATH_OPS.constructPath],
		// 两种都不是:一个只有单个数字,一个是字符串对。
		argsArray: [[42], ['a', 'b']]
	};
	const stats = newStats();
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
	assert.equal(segs.length, 0, '认不出来就不该产出');
	assert.equal(stats.byCode, 0, '没解出来就不算"按码认出"');
	assert.equal(stats.shapeUnknown, 2, `两条都该记进 shapeUnknown,实得 ${stats.shapeUnknown}`);
});

test('反向锁:指令流被截断时不许读出 NaN 坐标 (2.12.9)', () => {
	// 关键在于这条合成流的 minMax 是**自洽**的:moveTo(10,10) 之后 lineTo 只剩一个
	// 坐标,可已读到的 x 范围 10..20、y 范围 10..10 恰好等于 [10,10,20,10]。
	// 于是 minMax 交叉验证这道闸拦不住它 —— 必须靠"流长度够不够"那道闸。
	// 少了它就会 apply(ctm, 20, undefined),吐出一条含 NaN 的线段。
	const r: RawOps = {
		pdfjs: 'synthetic', page: 1, width: 100, height: 100,
		ops: { ...DEFAULT_PATH_OPS },
		fnArray: [DEFAULT_PATH_OPS.constructPath],
		argsArray: [[20, [[0, 10, 10, 1, 20]], [10, 10, 20, 10]]]
	};
	const stats = newStats();
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
	for (const s of segs) {
		for (const v of s) { assert.ok(Number.isFinite(v), `线段坐标必须是有限数,实得 ${v}`); }
	}
	assert.equal(segs.length, 0, '残缺的流一条线段都不该产出');
	assert.equal(stats.skipped, 1, `要计数,实得 ${stats.skipped}`);
});

test('同一页两种编码要解出**同一组线段**,不只是同一张网格 (2.12.9)', () => {
	// 比"网格一致"强得多的等价判据:网格只看几条贯穿线,少认几条短边也可能照样成立。
	// 逐条比线段才能暴露"新编码把矩形的闭合边丢了"这类沉默的损失
	// (实测就丢过:Powers 141→138、Gulati 60→55,而两边网格完全一样,看不出来)。
	// 比的是**无向线段**、且允许 Float32 级别的误差,这两点都是真实差异而非缺陷:
	//   - 新编码的坐标存在 Float32Array 里,146.78 会变成 146.77x —— 差 0.01pt,
	//     远小于 borderGrid 用的 1.5pt 容差;
	//   - 旧编码的 rectangle 子操作按固定顺序吐四条边,新编码按 PDF 自己的绘制顺序走,
	//     于是同一条边的两个端点可能反过来。方向对表格线没有意义。
	const canon = (s: Segment): [number, number, number, number] =>
		(s[0] < s[2] || (s[0] === s[2] && s[1] <= s[3])) ? [s[0], s[1], s[2], s[3]] : [s[2], s[3], s[0], s[1]];
	for (const [oldName, newName] of [
		['powers2019-p4-old', 'powers2019-p4-new'],
		['gulati2021-p21-old', 'gulati2021-p21-new']
	] as const) {
		const a = scan(rawops(oldName)).map(canon);
		const b = scan(rawops(newName)).map(canon);
		assert.equal(b.length, a.length, `${newName} 的线段条数应与 ${oldName} 一致:${a.length} vs ${b.length}`);
		const taken = new Array<boolean>(b.length).fill(false);
		for (const s of a) {
			const j = b.findIndex((t, i) => !taken[i]
				&& Math.abs(t[0] - s[0]) < 0.05 && Math.abs(t[1] - s[1]) < 0.05
				&& Math.abs(t[2] - s[2]) < 0.05 && Math.abs(t[3] - s[3]) < 0.05);
			assert.ok(j >= 0, `${newName} 里找不到与 [${s.map((v) => v.toFixed(2)).join(',')}] 对应的线段`);
			taken[j] = true;
		}
	}
});

test('闭合路径的那条边要出线段 —— 新编码的矩形就靠它 (2.12.9)', () => {
	// 新编码里没有独立的 rectangle 子操作,矩形被摊成 moveTo + 三条 lineTo + closePath。
	// 不认 closePath,每个矩形就少一条边。
	const r: RawOps = {
		pdfjs: 'synthetic', page: 1, width: 100, height: 100,
		ops: { ...DEFAULT_PATH_OPS },
		fnArray: [DEFAULT_PATH_OPS.constructPath],
		// (0,0) → (10,0) → (10,5) → (0,5) → 闭合回 (0,0)
		argsArray: [[20, [[0, 0, 0, 1, 10, 0, 1, 10, 5, 1, 0, 5, 4]], [0, 0, 10, 5]]]
	};
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000);
	assert.equal(segs.length, 4, `矩形应有四条边,实得 ${segs.length}`);
	const closing = segs.find((s) => s[0] === 0 && s[1] === 5 && s[2] === 0 && s[3] === 0);
	assert.ok(closing, '闭合的那条边必须在');
});

test('曲线本身不出线段,但曲线之后的直线和闭合弦要出 —— 圆角表格全靠它 (2.12.10)', () => {
	// 2.12.9 在曲线之后把当前点置空,连带丢掉了曲线**之后**的 lineTo 与闭合弦。
	// 那是错的:圆角矩形的四条直边全在圆弧之后,置空等于把圆角表格的边框整个丢掉。
	// 正确的边界是:曲线**本身**不产出线段(不许把弧的两端连成假直线),
	// 但从弧的终点出发的 lineTo / closePath 画的是真直线。
	const r: RawOps = {
		pdfjs: 'synthetic', page: 1, width: 100, height: 100,
		ops: { ...DEFAULT_PATH_OPS },
		fnArray: [DEFAULT_PATH_OPS.constructPath],
		// moveTo(0,0) → 三次曲线到 (10,0)(控制点 (3,6)/(7,6),紧包围盒最高 4.5) → closePath
		argsArray: [[20, [[0, 0, 0, 2, 3, 6, 7, 6, 10, 0, 4]], [0, 0, 10, 4.5]]]
	};
	const stats = newStats();
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
	assert.equal(stats.skipped, 0);
	assert.equal(segs.length, 1, `只有闭合弦这一条直线,实得 ${segs.length} 条`);
	assert.deepEqual(segs[0], [10, 0, 0, 0], '弦从弧的终点画回起点;弧本身没有线段');
});

// ---------------------------------------------------------------- 2.12.10:裁剪路径不画东西

/**
 * 真机 2.12.9 的第一份读数里,三页(p25/p44/p80,全是插图页)的网格区域恰好等于
 * 整页 `[0,0,595,794]`。本地用 Powers p43(整页裁剪矩形)与 Gulati p4(图片裁剪框)
 * 复现了同一现象,**新旧编码都一样** —— 这不是 2.12.9 引入的,旧路径本来就有。
 *
 * 根源:`re W n`(裁剪)也走 constructPath,但收尾是 endPath,**一个像素都不画**。
 * 把它的四条边当表格线,整页裁剪就成了"整页表格"的外框。收尾绘制码新编码在
 * `args[0]`,旧编码是紧跟其后的那个操作符(中间可能夹着 clip)。
 */
test('裁剪路径 (endPath) 不产出线段 —— Powers p43 不许变成整页一张表 (2.12.10)', () => {
	for (const n of ['powers2019-p43-old', 'powers2019-p43-new']) {
		const r = rawops(n);
		const stats = newStats();
		const segs = scan(r, stats);
		assert.ok(stats.unpainted >= 1, `${n}: 整页裁剪那条路径必须计入 unpainted,实得 ${stats.unpainted}`);
		for (const s of segs) {
			const onEdge = [s[0], s[2]].some((x) => Math.abs(x) < 0.5 || Math.abs(x - r.width) < 0.5)
				&& [s[1], s[3]].some((y) => Math.abs(y) < 0.5 || Math.abs(y - r.height) < 0.5);
			assert.ok(!onEdge, `${n}: 不该有贴着页边的线段 [${s.map((v) => v.toFixed(1)).join(',')}]`);
		}
		const gs = borderGrids(segs, { pageHeight: r.height });
		// 独立真值(pdfplumber 按边框切表):三张表,列边 47.2/313.4/359.2/408.2/538.8,
		// 行边分别 [66.2,81.6,136.9,221.8] / [265.1,280.4,354.9,409.5,466.4] /
		// [478.7,494.0,570.9,605.5,660.1,704.7,749.4]。整页裁剪一旦混进来,左右边就成了 0/585。
		assert.equal(gs.length, 3, `${n}: 应为 3 张表,实得 ${gs.length}`);
		const truthRows = [
			[66.2, 81.6, 136.9, 221.8],
			[265.1, 280.4, 354.9, 409.5, 466.4],
			[478.7, 494.0, 570.9, 605.5, 660.1, 704.7, 749.4]
		];
		gs.forEach((g, ti) => {
			assert.ok(Math.abs(g.region.left - 47.2) < 1.5, `${n} 表${ti + 1}: 左边界应≈47.2,实得 ${g.region.left.toFixed(1)}`);
			assert.ok(Math.abs(g.region.left + g.region.width - 538.8) < 1.5, `${n} 表${ti + 1}: 右边界应≈538.8`);
			assert.equal(g.rows.length, truthRows[ti]!.length, `${n} 表${ti + 1}: 行边数应为 ${truthRows[ti]!.length},实得 ${g.rows.length}`);
			g.rows.forEach((y, i) => assert.ok(Math.abs(y - truthRows[ti]![i]!) < 1.5, `${n} 表${ti + 1} 行边 ${i}: 应≈${truthRows[ti]![i]},实得 ${y.toFixed(1)}`));
		});
		// 表 2、表 3 四列齐全。表 1 只有 2 列:313/359 两条列线在那张表里只盖住 46% 的高度
		// (有一整行是合并单元格),按"不把短线延长成边界"的规矩不算列边 ——
		// 均匀网格表达不了合并单元格,这是已知局限,不是把它猜成 4 列来掩盖。
		for (const ti of [1, 2]) {
			const cols = gs[ti]!.columns;
			const truth = [47.2, 313.4, 359.2, 408.2, 538.8];
			assert.equal(cols.length, 5, `${n} 表${ti + 1}: 应为 4 列,实得 ${cols.length - 1}`);
			cols.forEach((x, i) => assert.ok(Math.abs(x - truth[i]!) < 1.5, `${n} 表${ti + 1} 列边 ${i}: 应≈${truth[i]},实得 ${x.toFixed(1)}`));
		}
		assert.ok(gs[0]!.columns.length >= 3, `${n} 表1: 至少 2 列`);
	}
});

test('图片裁剪框不是表格 —— Gulati p4 不该有网格 (2.12.10)', () => {
	for (const n of ['gulati2021-p4-old', 'gulati2021-p4-new']) {
		const r = rawops(n);
		const stats = newStats();
		const segs = scan(r, stats);
		assert.ok(stats.unpainted >= 1, `${n}: 图片裁剪框必须计入 unpainted`);
		const g = borderGrid(segs, { pageHeight: r.height });
		assert.equal(g, null, `${n}: 插图页不该推出网格,实得 ${g ? `${g.columns.length - 1}×${g.rows.length - 1}` : 'null'}`);
	}
});

function synth(paint: number, stream: number[], minMax: number[]): RawOps {
	return {
		pdfjs: 'synthetic', page: 1, width: 100, height: 100, ops: { ...DEFAULT_PATH_OPS },
		fnArray: [DEFAULT_PATH_OPS.constructPath],
		argsArray: [[paint, [stream], minMax]]
	};
}
const OPEN3 = [0, 0, 0, 1, 10, 0, 1, 10, 5, 1, 0, 5]; // 三条边,没有 closePath
const MM3 = [0, 0, 10, 5];

test('填充会隐式闭合子路径:三条 lineTo + fill 画出的是四条边 (2.12.10)', () => {
	// PDF 规范:f / f* / B / b 在填充前把开放子路径闭合。填充出来的色块四边都在,
	// 期刊表格里最常见的"色块单元格"就是这样画的。
	for (const paint of [22, 23, 24, 25, 26, 27]) {
		const r = synth(paint, OPEN3, MM3);
		const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000);
		assert.equal(segs.length, 4, `paint=${paint}: 填充应为四条边,实得 ${segs.length}`);
	}
});

test('描边不闭合:三条 lineTo + stroke 只有三条边;closeStroke 才有四条 (2.12.10)', () => {
	assert.equal(segmentsFromOperatorList(synth(20, OPEN3, MM3).fnArray, synth(20, OPEN3, MM3).argsArray, DEFAULT_PATH_OPS, 20000).length, 3, 'S 不闭合');
	assert.equal(segmentsFromOperatorList(synth(21, OPEN3, MM3).fnArray, synth(21, OPEN3, MM3).argsArray, DEFAULT_PATH_OPS, 20000).length, 4, 's 闭合');
});

test('endPath (n) 一个像素都不画:路径整条跳过并计入 unpainted (2.12.10)', () => {
	const r = synth(28, [0, 0, 0, 1, 100, 0, 1, 100, 100, 1, 0, 100, 4], [0, 0, 100, 100]);
	const stats = newStats();
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
	assert.equal(segs.length, 0, '裁剪矩形不该产出任何线段');
	assert.equal(stats.unpainted, 1);
	assert.equal(stats.skipped, 0, '这不是"解不出来",不许混进 skipped');
});

test('旧编码同样认收尾绘制码 —— 中间夹着 clip 也要看穿 (2.12.10)', () => {
	const O = DEFAULT_PATH_OPS;
	const r: RawOps = {
		pdfjs: 'synthetic', page: 1, width: 100, height: 100, ops: { ...O },
		// constructPath, clip, endPath  → 裁剪,不画
		// constructPath, fill           → 画,且隐式闭合
		fnArray: [O.constructPath, 29, 28, O.constructPath, 22],
		argsArray: [
			[[O.moveTo, O.lineTo, O.lineTo, O.lineTo], [0, 0, 100, 0, 100, 100, 0, 100]], null, null,
			[[O.moveTo, O.lineTo, O.lineTo, O.lineTo], [0, 0, 10, 0, 10, 5, 0, 5]], null
		]
	};
	const stats = newStats();
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
	assert.equal(stats.unpainted, 1, '裁剪那条要计入 unpainted');
	assert.equal(segs.length, 4, `只剩填充那条的四条边,实得 ${segs.length}`);
});

// ---------------------------------------------------------------- 2.12.10:曲线包围盒要算紧的

test('曲线的 minMax 是 pdf.js 按曲线真实极值算的,不是控制点 (2.12.10)', () => {
	// 2.12.9 的注释说"控制点一并计入,实测 pdf.js 就是这么算的" —— **错了**。
	// 源码里 curveTo 走的是 bezierBoundingBox(求导取极值)。之前 11630 条路径零误差,
	// 只因为那两篇的曲线全是圆角矩形的四分之一弧,控制点恰好落在紧包围盒的边上。
	// 真机 2.12.9 插图页 p44 有 36/80 条路径被 skipped,就是这个原因。
	//
	// 真值不抄 pdf.js:用 1000 点密采样独立算出极值,再与解码器的判断对照。
	const x0 = 0, y0 = 0, x1 = 0, y1 = 100, x2 = 100, y2 = 100, x3 = 100, y3 = 0;
	let maxy = -Infinity;
	for (let i = 0; i <= 1000; i++) {
		const t = i / 1000, mt = 1 - t;
		maxy = Math.max(maxy, mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3);
	}
	assert.ok(Math.abs(maxy - 75) < 1e-3, `采样极值应为 75,实得 ${maxy}`);
	const r = synth(20, [0, x0, y0, 2, x1, y1, x2, y2, x3, y3, 1, 200, 0], [0, 0, 200, 75]);
	const stats = newStats();
	const segs = segmentsFromOperatorList(r.fnArray, r.argsArray, r.ops, 20000, stats);
	assert.equal(stats.skipped, 0, '紧包围盒与 minMax 吻合,不该被否决');
	assert.equal(segs.length, 1, '曲线之后那条 lineTo 要交出来');
});

// ---------------------------------------------------------------- 2.12.10:至少 2 列 2 行

test('一列 N 行的框不是表格 —— 与文档注释"≥2 列且 ≥2 行"对齐 (2.12.10)', () => {
	// 真机 p44 报了 1×6 的"网格"。模块注释一直写着"要求成网格:≥2 列且 ≥2 行",
	// 代码却只要求 2 条线(= 1 列)。单列的框是一个盒子,不是需要分格归属的表。
	const segs: Segment[] = [];
	for (const y of [100, 120, 140, 160, 180, 200, 220]) { segs.push([50, y, 300, y]); }
	segs.push([50, 100, 50, 220], [300, 100, 300, 220]);
	assert.equal(borderGrid(segs, { pageHeight: 800 }), null, '1 列不成表');
	segs.push([175, 100, 175, 220]);
	const g = borderGrid(segs, { pageHeight: 800 });
	assert.ok(g && g.columns.length - 1 === 2 && g.rows.length - 1 === 6, '加一条中线就是 2 列 6 行');
});

test('同一位置的几段覆盖长度相加,但绝不把没有线的那一段补出来 (2.12.10)', () => {
	// 一条列线被合并单元格那一行截成两截:上 45、下 127(表高 270)。
	// 单段都不到 60%,加起来 172 才够 —— 这条线该算列边。
	const segs: Segment[] = [
		[100, 100, 100, 370], [300, 100, 300, 370], [200, 100, 200, 370],
		[100, 100, 300, 100], [100, 150, 300, 150], [100, 250, 300, 250], [100, 370, 300, 370],
		[150, 100, 150, 145], [150, 243, 150, 370]
	];
	const g = borderGrid(segs, { pageHeight: 500 })!;
	assert.ok(g && g.columns.some((x) => Math.abs(x - 150) < 1), '两截相加够 60% 的列线要算');
	// 反向:两截加起来也只有 20%,不算。
	const weak = segs.filter((s) => s[0] !== 150).concat([[150, 100, 150, 125], [150, 345, 150, 370]]);
	const g2 = borderGrid(weak, { pageHeight: 500 })!;
	assert.ok(!g2.columns.some((x) => Math.abs(x - 150) < 1), '两截加起来 20% 的不算列边');
});

test('多表页:同一 x 上几张表各自的竖线不许连成一根 (2.12.10)', () => {
	// 两张表上下叠放,列边完全相同,中间隔 40pt 的正文。以前 (pos, from) 排序在
	// 位置有 0.5pt 漂移时会把两张表的竖线串成一根,再被"整页一张表"吞成一个网格。
	const segs: Segment[] = [];
	for (const [y0, y1] of [[100, 200], [240, 340]] as const) {
		for (const x of [100, 200, 300]) { segs.push([x, y0, x, y1]); }
		for (const y of [y0, (y0 + y1) / 2, y1]) { segs.push([100, y, 300, y]); }
	}
	// 第二张表的竖线位置漂 0.5pt。
	for (const s of segs) { if (s[1] >= 240 && s[0] === s[2]) { s[0] += 0.5; s[2] += 0.5; } }
	const gs = borderGrids(segs, { pageHeight: 500 });
	assert.equal(gs.length, 2, `应为两张表,实得 ${gs.length}`);
	assert.ok(gs.every((g) => g.rows.length === 3 && g.columns.length === 3), '每张 2×2');
});
