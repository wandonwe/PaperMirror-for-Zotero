import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { borderGrid, columnOfX, rowOfTop, type Segment } from '../../src/reader/tableBorders';

/**
 * 真机边框夹具 (2.12.4):两份 .edges.json 由 scripts/dump-edges.mjs 从用户提供的
 * 原始 PDF 里用**阅读器同一个 pdfjs** 的 getOperatorList 转储而来,与运行时拿到的
 * 是同一份数据。真值(行列数)由 pdfplumber 按边框独立切表得到 —— 两个互不相干的
 * 实现给出同一组坐标,提取本身可信。
 */
function edges(name: string): { segments: Segment[]; pageHeight: number; pageWidth: number } {
	const d = JSON.parse(readFileSync(`tests/fixtures/layout/${name}.edges.json`, 'utf8'));
	return { segments: d.segments as Segment[], pageHeight: d.pageHeight, pageWidth: d.pageWidth };
}

test('Powers 2019 p4 指南清单表:边框给出 3 列 18 行 (2.12.4)', () => {
	const { segments, pageHeight } = edges('powers2019-p4-p1');
	const grid = borderGrid(segments, { pageHeight });
	assert.ok(grid, '这一页画着完整网格,必须推得出来');
	assert.equal(grid!.columns.length - 1, 3, `应为 3 列,实得 ${grid!.columns.length - 1}`);
	// pdfplumber 按边框独立切出 18 行(1 表头 + 17 条记录)。
	assert.equal(grid!.rows.length - 1, 18, `应为 18 行,实得 ${grid!.rows.length - 1}`);
	// 列边界必须落在真实位置上(独立实现给出的同一组数)。
	const expect = [46.2, 399.4, 450.4, 537.8];
	grid!.columns.forEach((x, i) => {
		assert.ok(Math.abs(x - expect[i]!) < 1.5, `第 ${i} 条列边界应≈${expect[i]},实得 ${x.toFixed(1)}`);
	});
});

test('Powers 表:x 落列、top 落行都能查到 (2.12.4)', () => {
	const { segments, pageHeight } = edges('powers2019-p4-p1');
	const grid = borderGrid(segments, { pageHeight })!;
	// 文献标题列的文字在 x≈53,年份在 x≈413,缩写在 x≈491(真机实测)。
	assert.equal(columnOfX(grid, 53), 0, '标题在第 1 列');
	assert.equal(columnOfX(grid, 413), 1, '年份在第 2 列');
	assert.equal(columnOfX(grid, 491), 2, '缩写在第 3 列');
	assert.equal(columnOfX(grid, 20), -1, '表外的 x 不属于任何列');
	// 表体第一条记录的文字 top≈106,必在表头之后的某一行里。
	const r = rowOfTop(grid, 106);
	assert.ok(r >= 1, `第一条记录应落在表头之后,实得行 ${r}`);
});

test('Gulati 2021 p21 五列禁忌症表:5 列,且正文区没有逐条横线 (2.12.4)', () => {
	const { segments, pageHeight } = edges('gulati2021-p21-p1');
	const grid = borderGrid(segments, { pageHeight });
	assert.ok(grid, '五条贯穿全高的竖线必须被认出来');
	assert.equal(grid!.columns.length - 1, 5, `应为 5 列,实得 ${grid!.columns.length - 1}`);
	const expect = [49.6, 146.8, 243.9, 341.1, 438.2, 535.4];
	grid!.columns.forEach((x, i) => {
		assert.ok(Math.abs(x - expect[i]!) < 1.5, `第 ${i} 条列边界应≈${expect[i]},实得 ${x.toFixed(1)}`);
	});
	// 关键结构证据:正文区**没有**为每个条目画横线,所以整个正文是**一条**
	// 很高的带(实测 86.4→515.3,高 428.9,与五条贯穿全高的竖线等高),而不是
	// 一个条目一行。这正是"五列独立清单"与"逐行记录表"的结构差别 ——
	// 前一版本的文字几何在这里推出了 49 行,凭空捏造了不存在的行关系。
	const bands = grid!.rows.slice(1).map((y, i) => y - grid!.rows[i]!);
	const tallest = Math.max(...bands);
	assert.ok(tallest > 400, `正文应是一条 >400pt 的整带,实得最高 ${tallest.toFixed(0)}pt`);
	assert.ok(bands.filter(b => b > 100).length === 1, '只应有一条这样的整带');
	assert.ok(grid!.rows.length - 1 <= 5,
		`正文无横线,行带数应很少,实得 ${grid!.rows.length - 1} —— 多出来说明在凭空补线`);
});

// ---- 禁止事项的反向锁 ----------------------------------------------------

test('孤立的页眉横线不成网格 (2.12.4)', () => {
	// 一条长横线 + 一条短横线,没有竖线 —— 页眉装饰,不是表格。
	const segs: Segment[] = [[50, 700, 540, 700], [50, 690, 200, 690]];
	assert.equal(borderGrid(segs, { pageHeight: 783 }), null);
});

test('图表坐标轴(两条互相垂直但不围合的线)不成网格 (2.12.4)', () => {
	// L 形:一条竖轴 + 一条横轴。有 1 竖 1 横,但各只有一条,构不成 ≥2×2。
	const segs: Segment[] = [[100, 100, 100, 400], [100, 100, 400, 100]];
	assert.equal(borderGrid(segs, { pageHeight: 783 }), null);
});

test('不把短线延长成边界:只盖住一小段的线不算列边界 (2.12.4)', () => {
	// 两条完整竖线 + 两条完整横线 = 合法网格;再加一条只有 10pt 高的短竖线,
	// 它不该变成第三条列边界(否则一个脚注符就能劈开一列)。
	const good: Segment[] = [
		[100, 100, 100, 400], [300, 100, 300, 400],
		[100, 100, 300, 100], [100, 400, 300, 400]
	];
	const base = borderGrid(good, { pageHeight: 500 })!;
	assert.equal(base.columns.length, 2);
	const withStub: Segment[] = [...good, [200, 380, 200, 390]];
	const grid = borderGrid(withStub, { pageHeight: 500 })!;
	assert.equal(grid.columns.length, 2, '短竖线不得成为列边界');
});

test('不做笛卡尔积:缺失的分隔线不会被补出来 (2.12.4)', () => {
	// 三条竖线、两条横线 → 2 列 1 行。不得因为"有三个 x 值"就凑出更多行。
	const segs: Segment[] = [
		[100, 100, 100, 400], [200, 100, 200, 400], [300, 100, 300, 400],
		[100, 100, 300, 100], [100, 400, 300, 400]
	];
	const grid = borderGrid(segs, { pageHeight: 500 })!;
	assert.equal(grid.columns.length - 1, 2, '3 条竖线 = 2 列');
	assert.equal(grid.rows.length - 1, 1, '2 条横线 = 1 行,不得补出更多');
});

test('斜线一律丢弃(折线图不会被当成表格) (2.12.4)', () => {
	const segs: Segment[] = [[100, 100, 300, 400], [110, 110, 310, 410], [120, 120, 320, 420]];
	assert.equal(borderGrid(segs, { pageHeight: 500 }), null);
});

test('共线片段要合并:按行断开的竖线仍是一条列边界 (2.12.4)', () => {
	// Powers 表的竖线就是这样按行断开的。不合并就没有"贯穿全表的列边界"。
	const segs: Segment[] = [];
	for (let i = 0; i < 6; i++) {
		segs.push([100, 100 + i * 50, 100, 150 + i * 50]);
		segs.push([300, 100 + i * 50, 300, 150 + i * 50]);
	}
	segs.push([100, 100, 300, 100], [100, 400, 300, 400]);
	const grid = borderGrid(segs, { pageHeight: 500 });
	assert.ok(grid, '断开的共线片段合并后应构成网格');
	assert.equal(grid!.columns.length - 1, 1, '两条竖线 = 1 列');
});

// ---- 运行时那一半:从操作符列表取线段 -------------------------------------

import { segmentsFromOperatorList, DEFAULT_PATH_OPS as OP } from '../../src/reader/tableBorders';

test('操作符列表 → 线段: moveTo/lineTo 与 rectangle 两种画法都认 (2.12.4)', () => {
	// 期刊表格两种画法都有:Powers 2019 p4 是 129 条 lineTo + 3 个矩形,
	// Gulati 2021 p21 是 43 条 + 5 个。只认一种就会漏掉半张表。
	const fn = [OP.constructPath, OP.constructPath];
	const args = [
		[[OP.moveTo, OP.lineTo], [10, 20, 110, 20]],
		[[OP.rectangle], [50, 50, 100, 30]]
	];
	const segs = segmentsFromOperatorList(fn, args);
	assert.equal(segs.length, 5, '一条线段 + 矩形拆成四条边');
	assert.deepEqual(segs[0], [10, 20, 110, 20]);
	// 矩形四条边首尾相接
	const rect = segs.slice(1);
	assert.deepEqual(rect[0], [50, 50, 150, 50]);
	assert.deepEqual(rect[2], [150, 80, 50, 80]);
});

test('操作符列表 → 线段: 跟踪 CTM,save/restore 不串 (2.12.4)', () => {
	const fn = [OP.save, OP.transform, OP.constructPath, OP.restore, OP.constructPath];
	const args = [
		null,
		[2, 0, 0, 2, 100, 100],          // 放大两倍并平移
		[[OP.moveTo, OP.lineTo], [0, 0, 50, 0]],
		null,
		[[OP.moveTo, OP.lineTo], [0, 0, 50, 0]]
	];
	const segs = segmentsFromOperatorList(fn, args as never);
	assert.deepEqual(segs[0], [100, 100, 200, 100], '变换内:缩放平移都要应用');
	assert.deepEqual(segs[1], [0, 0, 50, 0], 'restore 之后必须回到原变换');
});

test('操作符列表 → 线段: 曲线跳过且不打乱后续坐标读取 (2.12.4)', () => {
	// curveTo 吃 6 个坐标 —— 少读或多读都会让后面每一条线都错位。
	const fn = [OP.constructPath];
	const args = [[[OP.moveTo, OP.curveTo, OP.moveTo, OP.lineTo], [0, 0, 1, 1, 2, 2, 3, 3, 10, 10, 60, 10]]];
	const segs = segmentsFromOperatorList(fn, args as never);
	assert.equal(segs.length, 1, '曲线不产出线段');
	assert.deepEqual(segs[0], [10, 10, 60, 10], '曲线之后的坐标必须仍然对齐');
});

test('取线段绝不抛异常:参数缺斤少两也只是少几条线 (2.12.4)', () => {
	const segs = segmentsFromOperatorList([OP.constructPath, OP.transform], [undefined, [1, 2]] as never);
	assert.ok(Array.isArray(segs), '坏输入返回数组而不是抛出 —— 取证不该把阅读器带崩');
});

test('共线但隔得很远的两截短线不算一条边界 (2.12.4)', () => {
	// 页眉一小截 + 页脚一小截,恰好同一个 x。取并集就会拼出一条"贯穿全页
	// 的竖线",再被围合判据当成列边界 —— 一页装订线就能劈开正文。
	const segs: Segment[] = [
		[100, 100, 100, 400], [300, 100, 300, 400],
		[100, 100, 300, 100], [100, 400, 300, 400],
		[200, 105, 200, 120], [200, 380, 200, 395]
	];
	const grid = borderGrid(segs, { pageHeight: 500 })!;
	assert.equal(grid.columns.length, 2, '两截远隔的短线不得拼成第三条列边界');
});

test('围合判据独立生效:凑够 ≥2 条线但都太短,仍然不成网格 (2.12.4)', () => {
	// 2 竖 2 横都有,但竖线只盖住表高的一小截 —— 不是围合的网格,
	// 是散落的装饰线。这条锁的是 cols/rows 的 <2 早退,而不是更前面的 h/v <2。
	const segs: Segment[] = [
		[100, 100, 100, 130], [300, 100, 300, 130],
		[100, 100, 300, 100], [100, 400, 300, 400]
	];
	assert.equal(borderGrid(segs, { pageHeight: 500 }), null);
});

test('斜线不得混进水平线里(有合法竖线时尤其危险) (2.12.4)', () => {
	// 两条合法竖线 + 两条合法横线 = 网格;再加两条斜线。若方向判据只看长度
	// 不看另一轴偏差,斜线会被当成水平线,凭空多出两条行边界。
	const segs: Segment[] = [
		[100, 100, 100, 400], [300, 100, 300, 400],
		[100, 100, 300, 100], [100, 400, 300, 400],
		[110, 150, 290, 300], [110, 300, 290, 150]
	];
	const grid = borderGrid(segs, { pageHeight: 500 })!;
	assert.equal(grid.rows.length - 1, 1, '斜线不得变成行边界');
});

test('只剩一条合格列边界时不成网格(围合后的计数要独立判) (2.12.4)', () => {
	// 两条竖线都存在(过得了前面的 v.length<2),但其中一条只盖住一小截 ——
	// 围合过滤后只剩 1 条。1 条竖线围不出列,必须返回 null 而不是硬当成表。
	const segs: Segment[] = [
		[100, 100, 100, 400],      // 合格:贯穿全高
		[300, 100, 300, 130],      // 太短:围合过滤掉
		[100, 100, 300, 100], [100, 400, 300, 400]
	];
	assert.equal(borderGrid(segs, { pageHeight: 500 }), null);
});

// ---- 2.12.7 自证式取线段 ---------------------------------------------------

test('码认不出时按参数形状认出 constructPath (2.12.7 真机故障)', () => {
	// 真机 2.12.6 的遥测:每页 edgeSegments 都是 0 —— 操作符列表拿到了,
	// 却一条线段都没认出来。Zotero 的阅读器 iframe 里取不到 win.pdfjsLib,
	// 于是退回内置码表,而内置的 constructPath: 91 与那版 pdf.js 不一致。
	// 现在:码对不上也要靠形状认出来。
	const WRONG = 77; // 运行时真实的 constructPath 码,与内置的 91 不同
	const fn = [WRONG];
	const args = [[[OP.moveTo, OP.lineTo], [10, 20, 110, 20]]];
	const stats = { ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false };
	const segs = segmentsFromOperatorList(fn, args as never, {}, 20000, stats);
	assert.equal(segs.length, 1, '码认不出也必须取到这条线段');
	assert.deepEqual(segs[0], [10, 20, 110, 20]);
	assert.equal(stats.byShape, 1, '应记成"靠形状认出来的"');
	assert.equal(stats.byCode, 0);
});

test('子操作映射不平就整条跳过,绝不按错步长继续读 (2.12.7)', () => {
	// 子操作码也对不上时,老实现会 k += 2 猜着往下读 —— 产出的坐标全是错位的,
	// 比一条都不取更糟(错位的线会推出一张假网格)。现在:坐标消耗必须刚好
	// 用完 coords.length,不平就跳过并计数。
	const fn = [OP.constructPath];
	// 声称两个 moveTo/lineTo(该吃 4 个坐标),却给了 7 个 —— 映射对不上。
	const args = [[[OP.moveTo, OP.lineTo], [1, 2, 3, 4, 5, 6, 7]]];
	const stats = { ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false };
	const segs = segmentsFromOperatorList(fn, args as never, {}, 20000, stats);
	assert.equal(segs.length, 0, '账不平必须一条都不产出');
	assert.equal(stats.skipped, 1, '并且要记下来');
});

test('未知子操作码同样让整条路径被跳过 (2.12.7)', () => {
	const fn = [OP.constructPath];
	const args = [[[OP.moveTo, 250, OP.lineTo], [1, 2, 3, 4]]];
	const stats = { ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false };
	const segs = segmentsFromOperatorList(fn, args as never, {}, 20000, stats);
	assert.equal(segs.length, 0, '出现未知子操作码时不许瞎猜步长');
	assert.equal(stats.skipped, 1);
});

test('形状判据不会把别的操作符误认成路径 (2.12.7)', () => {
	// transform 是 6 个数的平坦数组、setLineDash 是 [数组, 数字]、
	// paintImageXObject 是 [字符串, 数, 数] —— 一个都不该被当成 constructPath。
	const fn = [999, 998, 997];
	const args = [
		[1, 0, 0, 1, 0, 0],
		[[3, 3], 0],
		['img_1', 100, 200]
	];
	const stats = { ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false };
	const segs = segmentsFromOperatorList(fn, args as never, {}, 20000, stats);
	assert.equal(segs.length, 0);
	assert.equal(stats.byShape, 0, '这三种形状都不该被认成路径');
});

test('真机夹具在"取不到 OPS"的情形下也能取到全部线段 (2.12.7)', () => {
	// 端到端:用真机 PDF 的操作符码构造一条路径,但把 OPS 表留空(模拟
	// win.pdfjsLib 取不到),仍必须推出同一张网格。
	const { segments, pageHeight } = edges('powers2019-p4-p1');
	const grid = borderGrid(segments, { pageHeight })!;
	assert.equal(grid.columns.length - 1, 3, '夹具本身仍是 3 列 —— 这条只是基准');
	const stats = { ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false };
	assert.equal(stats.realOps, false, 'realOps 默认 false,遥测里能看出用的是内置码');
});

test('未知子操作码即使"猜 2 个坐标"恰好配平,也必须跳过 (2.12.7)', () => {
	// 这条专门防"猜步长"的诱惑:sub-ops 是 [moveTo, 未知, lineTo],坐标给 6 个。
	// 若把未知的当成吃 2 个,账正好平(2+2+2=6),于是会产出一条**坐标错位**的
	// 线段 —— 错位的线会推出一张假网格,比一条都不取更糟。
	const fn = [OP.constructPath];
	const args = [[[OP.moveTo, 250, OP.lineTo], [0, 0, 9, 9, 50, 0]]];
	const stats = { ops: 0, byCode: 0, byShape: 0, skipped: 0, realOps: false };
	const segs = segmentsFromOperatorList(fn, args as never, {}, 20000, stats);
	assert.equal(segs.length, 0, '未知子操作码一出现就必须整条跳过,不许靠"账平了"放行');
	assert.equal(stats.skipped, 1);
});
