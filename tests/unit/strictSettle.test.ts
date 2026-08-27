/**
 * 长文本稳定性 — settleStrictPage's final-measure contract and the
 * last-resort shrink hand-off.
 *
 * The "译文显示后又消失" bug: settle used to fire its callback identically
 * 2–3 times per render (initial + fonts.ready + a second load wave), the
 * session counted a compress round on EVERY firing, so one render burned the
 * whole budget and long blocks reverted to English. The contract now is:
 * any number of provisional calls (final=false), then EXACTLY ONE final call
 * (final=true) once fonts have settled — consequential action happens only
 * on that one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleStrictPage, shrinkStrictBlocks, applyCompressedStrict, planStrictRetry, allowsFontShrink, type UnfitBlock } from '../../src/ui/strictPageReplacement';
import { supportsCharBudget } from '../../src/translation/providers/types';
import { getProvider } from '../../src/translation/providers/registry';

interface FakeFonts {
	status?: string;
	ready?: Promise<unknown>;
}

function fakeElement(fonts: FakeFonts | undefined, unfit: UnfitBlock[] = []): {
	el: HTMLElement;
	calls: { unfit: UnfitBlock[]; final: boolean }[];
} {
	const calls: { unfit: UnfitBlock[]; final: boolean }[] = [];
	const el = {
		isConnected: true,
		ownerDocument: { fonts },
		pmSettleStrict: () => unfit
	} as unknown as HTMLElement;
	return { el, calls };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

test('no font API → a single, final measure', async () => {
	const { el, calls } = fakeElement(undefined);
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	await flush();
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.final, true);
});

test('fonts already loaded → one provisional then exactly one final', async () => {
	const { el, calls } = fakeElement({ status: 'loaded', ready: Promise.resolve() });
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	await flush();
	assert.deepEqual(calls.map(c => c.final), [false, true]);
});

test('second font-load wave → two provisionals, still exactly one final', async () => {
	const { el, calls } = fakeElement({ status: 'loading', ready: Promise.resolve() });
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	await flush();
	assert.deepEqual(calls.map(c => c.final), [false, false, true]);
	assert.equal(calls.filter(c => c.final).length, 1, 'never more than one final measure');
});

test('a disconnected element gets no late measures', async () => {
	const { calls } = fakeElement({ status: 'loaded', ready: Promise.resolve() });
	const el = {
		isConnected: true,
		ownerDocument: { fonts: { status: 'loaded', ready: Promise.resolve() } },
		pmSettleStrict: () => []
	} as unknown as HTMLElement;
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }));
	(el as unknown as { isConnected: boolean }).isConnected = false; // slot re-rendered
	await flush();
	assert.deepEqual(calls.map(c => c.final), [false], 'stale element must not act');
});

test('the final measure reports unfit blocks with a budget', async () => {
	const unfit: UnfitBlock[] = [{ id: 'page-0-block-3', maxChars: 120 }];
	const { el, calls } = fakeElement({ status: 'loaded', ready: Promise.resolve() }, unfit);
	settleStrictPage(el, (u, final) => calls.push({ unfit: u, final }));
	await flush();
	const final = calls.find(c => c.final)!;
	assert.deepEqual(final.unfit, unfit);
});

test('shrinkStrictBlocks delegates to pmShrinkFit and returns the leftovers', () => {
	const el = {
		pmShrinkFit: (ids: string[]) => ids.filter(id => id.endsWith('stubborn'))
	} as unknown as HTMLElement;
	assert.deepEqual(
		shrinkStrictBlocks(el, ['a', 'b-stubborn']),
		['b-stubborn'],
		'only blocks that fail even the shrink stage remain revert candidates'
	);
});

test('allowsFontShrink: 正文不缩字(按页统一), 独立元素可缩字 (item7b LO-3)', () => {
	// 正文 paragraph/list 绝不单独缩字致发花 —— 页内统一字号,放不下保留原文。
	assert.equal(allowsFontShrink('paragraph'), false, '正文段落不单独缩字');
	assert.equal(allowsFontShrink('list'), false, '列表项同为正文流');
	// 独立元素缩它自己不会与正文比出大小差,仍可末位缩字保住译文。
	assert.equal(allowsFontShrink('caption'), true, '图题可缩字');
	assert.equal(allowsFontShrink('heading'), true, '小标题可缩字');
	assert.equal(allowsFontShrink('title'), true, '大标题可缩字');
	assert.equal(allowsFontShrink(''), true, '未知类型保守放行缩字(不误伤正文)');
	// 2.3.7 豁免(基线 doc3 实证): 表格单元格与微小单行块是孤立小盒,缩字不发花,
	// 禁缩只会让它们整行放弃(一篇文档 abandoned 曾涨到 56)。
	assert.equal(allowsFontShrink('paragraph', { isTableCell: true }), true, '表格单元格可缩字');
	assert.equal(allowsFontShrink('paragraph', { tinyLine: true }), true, '微小单行块可缩字');
	assert.equal(allowsFontShrink('paragraph', {}), false, '普通正文段仍不缩字');
	assert.equal(allowsFontShrink('list', { isTableCell: false, tinyLine: false }), false, '列表正文仍不缩字');
});

test('shrinkStrictBlocks without the hook falls back to reverting everything', () => {
	const el = {} as HTMLElement;
	assert.deepEqual(shrinkStrictBlocks(el, ['a', 'b']), ['a', 'b']);
});

test('planStrictRetry routes budget-capable, in-budget blocks to compress', () => {
	const unfit: UnfitBlock[] = [
		{ id: 'a', maxChars: 40 },
		{ id: 'b', maxChars: 40 },
		{ id: 'c', maxChars: 40 }
	];
	const rounds = new Map<string, number>([['a', 0], ['b', 2], ['c', 1]]);
	const plan = planStrictRetry(unfit, {
		roundsFor: id => rounds.get(id) ?? 0,
		maxRounds: 2,
		budgetCapable: true
	});
	assert.deepEqual(plan.compress.sort(), ['a', 'c'], 'b has spent its 2 rounds → shrink');
	assert.deepEqual(plan.shrink, ['b']);
});

test('planStrictRetry sends everything to shrink when the engine ignores budgets', () => {
	const unfit: UnfitBlock[] = [{ id: 'a', maxChars: 40 }, { id: 'b', maxChars: 40 }];
	const plan = planStrictRetry(unfit, { roundsFor: () => 0, maxRounds: 2, budgetCapable: false });
	assert.deepEqual(plan.compress, []);
	assert.deepEqual(plan.shrink, ['a', 'b']);
});

test('applyCompressedStrict delegates to pmApplyCompressed', () => {
	const seen: Map<string, string>[] = [];
	const el = {
		pmApplyCompressed: (m: Map<string, string>) => { seen.push(m); return [{ id: 'x', maxChars: 20 }]; }
	} as unknown as HTMLElement;
	const still = applyCompressedStrict(el, new Map([['x', '短']]));
	assert.equal(seen.length, 1);
	assert.deepEqual(still, [{ id: 'x', maxChars: 20 }]);
});

test('applyCompressedStrict without the hook is a no-op', () => {
	assert.deepEqual(applyCompressedStrict({} as HTMLElement, new Map([['x', 'y']])), []);
});

test('supportsCharBudget is explicit per provider, not tied to explain', () => {
	// LLM/prompt-driven engines honour the budget…
	assert.equal(supportsCharBudget(getProvider('anthropic')), true);
	assert.equal(supportsCharBudget(getProvider('openai')), true);
	assert.equal(supportsCharBudget(getProvider('deepseek')), true);
	// …fixed MT services do not, so the renderer must not waste rounds on them.
	assert.equal(supportsCharBudget(getProvider('bing-free')), false);
	assert.equal(supportsCharBudget(getProvider('google-free')), false);
	assert.equal(supportsCharBudget(getProvider('deepl')), false);
});

test('ladderFor never crushes lines below the source leading', async () => {
	const { ladderFor } = await import('../../src/ui/strictPageReplacement');
	// A body paragraph set at 1.3 leading: no ladder step tightens below 1.3.
	const body = ladderFor(1.3);
	assert.ok(body.every(s => s.lineHeight >= 1.3), 'body lines never below source leading');
	assert.ok(body[0]!.lineHeight >= body[body.length - 1]!.lineHeight, 'loose → tight order');
	// A tight one-line heading (natural ~1.0) gets a 1.0 step it can pass —
	// the fixed 1.14 floor used to make short headings fail outright.
	const heading = ladderFor(1.0);
	assert.ok(heading.some(s => Math.abs(s.lineHeight - 1.0) < 1e-9), 'heading gets a 1.0 step');
	// Absurd inputs are clamped into [1.0, 1.42].
	assert.ok(ladderFor(5).every(s => s.lineHeight <= 1.42));
	assert.ok(ladderFor(0).every(s => s.lineHeight >= 1.0));
});

// ---------------------------------------------------------------------------
// 1.0.5 批次2: BabelDOC 算法3 —— 缩字前先扩边界(空白测量,纯函数)
// ---------------------------------------------------------------------------

import { computeExpansionAllowance, estimateCjkCapacity } from '../../src/ui/strictPageReplacement';

// 2.2.2, 第三批 item3 · 「压缩预算计入可用空白」的方向不变量: budgetFor 把
// (原盒 + expansionAllowance) 交给 estimateCjkCapacity,因此更大的框 → 更宽的
// 预算 → 模型不会一上来就过度缩写。这里锁住容量随框单调增长的纯函数性质。
test('estimateCjkCapacity grows when whitespace is folded into the box (item3 预算含空白)', () => {
	const base = estimateCjkCapacity(200, 100, 12);
	const withRight = estimateCjkCapacity(200 + 60, 100, 12);
	const withBoth = estimateCjkCapacity(200 + 60, 100 + 30, 12);
	assert.ok(withRight > base, `右扩后预算应更大: ${withRight} > ${base}`);
	assert.ok(withBoth > withRight, `双向扩后预算应更大: ${withBoth} > ${withRight}`);
	// 退化护栏:非法尺寸仍给最小 8,不会把预算算成 0/负。
	assert.equal(estimateCjkCapacity(0, 100, 12), 8);
});

test('expansion is clipped by the nearest right/below blocker with margin (算法3)', () => {
	const box = { left: 100, top: 100, width: 100, height: 40 };
	const blockers = [
		{ left: 260, top: 90, width: 50, height: 60 },  // right neighbour, 60px gap
		{ left: 100, top: 180, width: 100, height: 30 } // below neighbour, 40px gap
	];
	const { right, down } = computeExpansionAllowance(box, blockers, 612, 792, 12);
	assert.equal(right, 57, 'right = 260 − 200 − 3');
	// cap = max(2.8×字号=33.6, 0.5×高=20) → min(37px 间隙−边距, 33.6) = 33.6
	assert.ok(Math.abs(down - 33.6) < 0.01, `down=${down}`);
});

test('expansion respects the 90% page-width / caps and never goes negative', () => {
	const box = { left: 500, top: 700, width: 80, height: 40 };
	const free = computeExpansionAllowance(box, [], 612, 792, 12);
	// 612×0.9 = 550.8 → right allowance = 0 (box already past the limit is clamped ≥0)
	assert.equal(free.right, 0);
	assert.ok(free.down > 0 && free.down <= Math.max(12 * 2.8, 20));
	const tight = computeExpansionAllowance(box, [{ left: 500, top: 741, width: 80, height: 20 }], 612, 792, 12);
	assert.equal(tight.down, 0, 'blocker 1px below → clamp to 0, not negative');
});

// ---------------------------------------------------------------------------

test('auditStrictGeometry: null on a non-strict element, passthrough on the hook (1.1.0)', async () => {
	const { auditStrictGeometry } = await import('../../src/ui/strictPageReplacement');
	assert.equal(auditStrictGeometry({} as unknown as HTMLElement), null);
	const el = {
		pmGeometryAudit: () => ({ violations: 2, adjusted: 1, reverted: 1 })
	} as unknown as HTMLElement;
	assert.deepEqual(auditStrictGeometry(el), { violations: 2, adjusted: 1, reverted: 1 });
});

test('splitRegionForPlacement: splits translation across paragraph groups, falls back on mismatch (审核 摘要塌顶)', async () => {
	const { splitRegionForPlacement } = await import('../../src/ui/strictPageReplacement');
	const region = {
		id: 'page-0-region-13',
		pageIndex: 0,
		order: 0,
		type: 'paragraph' as const,
		sourceText: 'A.\n\nB.\n\nC.',
		lineRectsPdf: [[0, 90, 100, 100], [0, 70, 100, 80], [0, 50, 100, 60]] as [number, number, number, number][],
		regionParagraphs: [
			{ lineRectsPdf: [[0, 90, 100, 100]] as [number, number, number, number][], fontSize: 8 },
			{ lineRectsPdf: [[0, 70, 100, 80]] as [number, number, number, number][], fontSize: 8 },
			{ lineRectsPdf: [[0, 50, 100, 60]] as [number, number, number, number][], fontSize: 8 }
		]
	};
	// Aligned: 3 groups, translation splits on blank lines into 3 → one block each.
	const ok = splitRegionForPlacement(region, '甲。\n\n乙。\n\n丙。');
	assert.ok(ok, 'aligned translation splits');
	assert.equal(ok!.length, 3);
	assert.deepEqual(ok!.map(p => p.id), ['page-0-region-13::p0', 'page-0-region-13::p1', 'page-0-region-13::p2']);
	assert.deepEqual(ok!.map(p => p.text), ['甲。', '乙。', '丙。']);
	assert.deepEqual(ok![1]!.lineRectsPdf, [[0, 70, 100, 80]], 'paragraph placed in its OWN group box');
	// Extra blank lines are tolerated (engines vary): still 3 parts.
	assert.equal(splitRegionForPlacement(region, '甲。\n\n\n乙。\n\n丙。')?.length, 3);
	// SINGLE newlines are the common engine output — must also split (2.1.4).
	const single = splitRegionForPlacement(region, '甲。\n乙。\n丙。');
	assert.equal(single?.length, 3, 'single-newline separators split too');
	assert.deepEqual(single!.map(p => p.text), ['甲。', '乙。', '丙。']);
	// 一坨(全部分段被合成一段,无换行)→ null: 无从拆,回退整块(与旧行为一致)。
	assert.equal(splitRegionForPlacement(region, '甲。乙。丙。'), null, 'engine dropped ALL breaks → fall back');
	// 尽力对齐 (2.2.6, item7): 段数不等不再回退塌顶 ------------------------------
	// P<G: 2 段 / 3 组 → 合并组盒到 2 个(前两组并成一盒),每段落地、顺序不变。
	const fewer = splitRegionForPlacement(region, '甲。\n\n乙。');
	assert.ok(fewer, '2 段 3 组不再回退,尽力对齐');
	assert.equal(fewer!.length, 2);
	assert.deepEqual(fewer!.map(p => p.text), ['甲。', '乙。']);
	assert.deepEqual(fewer![0]!.lineRectsPdf, [[0, 90, 100, 100], [0, 70, 100, 80]], '前两组盒并集承载第一段');
	assert.deepEqual(fewer![1]!.lineRectsPdf, [[0, 50, 100, 60]], '第三组盒承载第二段');
	// P>G: 4 段 / 3 组 → 盒子仍是 3 个组(几何不变),4 段按序均匀并入(桶 2/1/1)。
	const more = splitRegionForPlacement(region, '甲。\n乙。\n丙。\n丁。');
	assert.ok(more, '4 段 3 组不再回退,尽力对齐');
	assert.equal(more!.length, 3);
	assert.deepEqual(more!.map(p => p.text), ['甲。 乙。', '丙。', '丁。'], '多出的段并入首桶');
	assert.deepEqual(more![0]!.lineRectsPdf, [[0, 90, 100, 100]], '组盒几何不变');
	// A single-group (or no) region never splits.
	assert.equal(splitRegionForPlacement({ ...region, regionParagraphs: [region.regionParagraphs[0]!] }, '甲。'), null);
	assert.equal(splitRegionForPlacement({ ...region, regionParagraphs: undefined }, '甲。\n\n乙。'), null);
});

test('probeStrictPlacement: null on a non-strict element, passthrough on the hook (审核 标题空洞)', async () => {
	const { probeStrictPlacement } = await import('../../src/ui/strictPageReplacement');
	assert.equal(probeStrictPlacement({} as unknown as HTMLElement), null);
	const rows = [
		{ id: 'page-0-region-0', type: 'heading', state: 'abandoned' as const, left: 217, top: 60, width: 300, height: 26, baseInk: false, maskOpaque: false },
		{ id: 'page-0-region-13', type: 'paragraph', state: 'committed' as const, left: 302, top: 90, width: 231, height: 400, baseInk: true, maskOpaque: true }
	];
	const el = { pmProbe: () => rows } as unknown as HTMLElement;
	assert.deepEqual(probeStrictPlacement(el), rows);
});

// ---- 1.2.2 审核项: fonts.ready 永不 resolve 时的超时保险 --------------------

test('fonts.ready 永不 resolve → 超时后仍有且只有一次 final 测量', async () => {
	const never = new Promise<unknown>(() => { /* 挂起: 字体源永不就绪 */ });
	const { el, calls } = fakeElement({ status: 'loading', ready: never });
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }), 30);
	await new Promise(r => setTimeout(r, 90));
	assert.deepEqual(calls.map(c => c.final), [false, true], '一次 provisional + 超时兜底的一次 final');
	assert.equal(calls.filter(c => c.final).length, 1);
});

test('超时先到、ready 后到 → final 仍然只有一次 (闸生效)', async () => {
	let release: (v?: unknown) => void = () => {};
	const slow = new Promise<unknown>(r => { release = r; });
	const { el, calls } = fakeElement({ status: 'loaded', ready: slow });
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }), 30);
	await new Promise(r => setTimeout(r, 90)); // 超时先触发 final
	release();                                  // ready 迟到
	await new Promise(r => setTimeout(r, 20));
	assert.equal(calls.filter(c => c.final).length, 1, '迟到的 ready 不得再发第二次 final');
});

test('元素已断开 → 超时不再执行测量 (无泄漏测量)', async () => {
	const never = new Promise<unknown>(() => {});
	const { el, calls } = fakeElement({ status: 'loaded', ready: never });
	settleStrictPage(el, (unfit, final) => calls.push({ unfit, final }), 30);
	(el as unknown as { isConnected: boolean }).isConnected = false;
	await new Promise(r => setTimeout(r, 90));
	assert.deepEqual(calls.map(c => c.final), [false], '断开后 final 测量不发生');
});

// ---- LO-7 (2.4.0): 大标题「整体另置」候选位置 — pure ----------------------

test('annexCandidateBoxes: 正下方优先、正上方次之,left/width 沿用原盒', async () => {
	const { annexCandidateBoxes } = await import('../../src/ui/strictPageReplacement');
	const ob = { left: 50, top: 100, width: 500, height: 60 };
	const boxes = annexCandidateBoxes(ob, 40, 800, 6);
	assert.equal(boxes.length, 2);
	assert.deepEqual(boxes[0], { left: 50, top: 166, width: 500, height: 40 }, '首选正下方 (top+height+gap)');
	assert.deepEqual(boxes[1], { left: 50, top: 54, width: 500, height: 40 }, '次选正上方 (top-gap-natural)');
});

test('annexCandidateBoxes: 越出页面安全边 (2%/98%) 的候选不产出', async () => {
	const { annexCandidateBoxes } = await import('../../src/ui/strictPageReplacement');
	// 标题贴近页顶: 上方候选 top < 2% 页高 → 只剩下方。
	const nearTop = annexCandidateBoxes({ left: 0, top: 20, width: 400, height: 50 }, 40, 800, 6);
	assert.equal(nearTop.length, 1);
	assert.ok(nearTop[0]!.top > 20, '仅剩下方候选');
	// 标题贴近页底: 下方候选超 98% 页高 → 只剩上方。
	const nearBottom = annexCandidateBoxes({ left: 0, top: 740, width: 400, height: 50 }, 40, 800, 6);
	assert.equal(nearBottom.length, 1);
	assert.ok(nearBottom[0]!.top < 740, '仅剩上方候选');
	// 两头都放不下 (页面极矮) → 空数组,调用方落回放弃流程。
	assert.equal(annexCandidateBoxes({ left: 0, top: 10, width: 400, height: 30 }, 40, 60, 6).length, 0);
});

// ---- LO-10 (2.4.6): 扩展新占的条带 — pure --------------------------------

test('expansionStrips: 只产出新增部分,原盒不采样(原盒底下是本块自己的原文)', async () => {
	const { expansionStrips } = await import('../../src/ui/strictPageReplacement');
	const ob = { left: 100, top: 200, width: 300, height: 60 };
	// 只向右长: 一条右条,原高。
	assert.deepEqual(expansionStrips(ob, { ...ob, width: 340 }), [
		{ left: 400, top: 200, width: 40, height: 60 }
	]);
	// 只向下长: 一条下条,原宽。
	assert.deepEqual(expansionStrips(ob, { ...ob, height: 90 }), [
		{ left: 100, top: 260, width: 300, height: 30 }
	]);
	// 没长 → 不产出,连采样都不必做。
	assert.deepEqual(expansionStrips(ob, { ...ob }), []);
});

test('expansionStrips: 双向长时两条不重叠, 合起来正好覆盖 L 形(含拐角)', async () => {
	const { expansionStrips } = await import('../../src/ui/strictPageReplacement');
	const ob = { left: 100, top: 200, width: 300, height: 60 };
	const strips = expansionStrips(ob, { ...ob, width: 340, height: 90 });
	assert.equal(strips.length, 2);
	const [right, down] = strips as [typeof ob, typeof ob];
	// 右条只占原高范围 —— 与下条不重叠。
	assert.deepEqual(right, { left: 400, top: 200, width: 40, height: 60 });
	// 下条取**扩展后全宽**,才能盖住 L 形右下的拐角。
	assert.deepEqual(down, { left: 100, top: 260, width: 340, height: 30 });
	assert.equal(right.top + right.height, down.top, '两条首尾相接,无缝无叠');
	// 面积之和 = 扩展后面积 − 原面积。
	const added = right.width * right.height + down.width * down.height;
	assert.equal(added, 340 * 90 - 300 * 60);
});

test('expansionStrips: 亚像素级增长按 minSize 忽略,不为半个像素做采样', async () => {
	const { expansionStrips } = await import('../../src/ui/strictPageReplacement');
	const ob = { left: 0, top: 0, width: 100, height: 20 };
	assert.deepEqual(expansionStrips(ob, { ...ob, width: 100.4 }, 1), []);
	assert.equal(expansionStrips(ob, { ...ob, width: 102 }, 1).length, 1);
});

// ---- LO-10 (2.4.6): 墨迹阈值 —— 为什么扩边不能用另置那 2% 的口径 -----------

const WHITE: [number, number, number] = [255, 255, 255];
/** 造一张纯白条带,可选在某一列画一条 1px 竖线(分栏线的形状)。 */
function strip(width: number, height: number, lineAtX?: number): Uint8ClampedArray {
	const data = new Uint8ClampedArray(width * height * 4).fill(255);
	if (lineAtX !== undefined) {
		for (let y = 0; y < height; y++) {
			const o = (y * width + lineAtX) * 4;
			data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
		}
	}
	return data;
}

test('墨迹阈值: 1px 分栏竖线 —— 另置口径 (2%) 漏掉, 扩边口径 (0.5%) 抓到', async () => {
	const { bitmapHasInk } = await import('../../src/ui/strictPageReplacement');
	// 100×30 的条带里一条 1px 竖线 ≈ 1% 面积 —— 正好卡在两档口径之间。
	const data = strip(100, 30, 50);
	assert.equal(
		bitmapHasInk(data, 100, 30, WHITE, { minShare: 0.02, minPoints: 1 }), false,
		'2% 口径漏掉细线 —— 这正是 LO-10 说的失明'
	);
	assert.equal(
		bitmapHasInk(data, 100, 30, WHITE, { minShare: 0.005, minPoints: 3 }), true,
		'0.5% 口径抓到 → 该次扩展被拒,译文不会叠印在分栏线上'
	);
});

test('墨迹阈值: 纯白条带两档都放行 —— 真空白处照常扩边', async () => {
	const { bitmapHasInk } = await import('../../src/ui/strictPageReplacement');
	const blank = strip(100, 30);
	assert.equal(bitmapHasInk(blank, 100, 30, WHITE, { minShare: 0.005, minPoints: 3 }), false);
	assert.equal(bitmapHasInk(blank, 100, 30, WHITE, { minShare: 0.02, minPoints: 1 }), false);
});

test('墨迹阈值: minPoints 挡住单点噪声, 不让反锯齿把扩边判死', async () => {
	const { bitmapHasInk } = await import('../../src/ui/strictPageReplacement');
	const data = strip(60, 20);
	// 单个孤立黑点(反锯齿残留/压缩噪声)不该否决整次扩展。
	data[(10 * 60 + 30) * 4] = 0; data[(10 * 60 + 30) * 4 + 1] = 0; data[(10 * 60 + 30) * 4 + 2] = 0;
	assert.equal(bitmapHasInk(data, 60, 20, WHITE, { minShare: 0.005, minPoints: 3 }), false, '单点不算墨迹');
});

test('墨迹阈值: 空区域安全返回 false, 不抛', async () => {
	const { bitmapHasInk } = await import('../../src/ui/strictPageReplacement');
	assert.equal(bitmapHasInk(new Uint8ClampedArray(0), 0, 0, WHITE, { minShare: 0.005, minPoints: 3 }), false);
});
