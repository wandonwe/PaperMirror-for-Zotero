/**
 * 跨页重复内容登记表 (2.4.5, MinerU 页眉页脚去重)。
 *
 * 单页形状判据 (isRunningHeadOrFoot) 的结构性盲区是「落在 8% 带之外、或超过
 * 2 行 / 140 字」的版式家具 —— 它们每页都被当正文翻一遍。登记表用「在多少个
 * 不同页上出现过」这个更强的信号补上,代价是阈值要到第 N 页才跨过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	RepeatRegistry,
	inMarginBand,
	normalizeBoilerplate
} from '../../src/reader/repeatRegistry';
import { buildBlocksFromSpans, type SpanItem } from '../../src/reader/spanBlockBuilder';

const PAGE_HEIGHT = 792;
/** PDF 坐标: y 向上,rect = [x1, y1, x2, y2]。 */
function span(text: string, x: number, baselineTop: number, width: number, size = 10): SpanItem {
	return { text, rect: [x, baselineTop - size, x + width, baselineTop], fontSize: size };
}

// ---- 归一化 -----------------------------------------------------------------

test('归一化: 大小写/空白折叠, 数字整段变 # —— 逐页变化的刊脚收敛成同一条', () => {
	assert.equal(normalizeBoilerplate('  J Med Phys   2024;51:88  '), 'j med phys #;#:#');
	// 卷期页码逐页不同,归一后是同一条 —— 这正是要认出来的东西。
	assert.equal(
		normalizeBoilerplate('J Med Phys 2024;51:88'),
		normalizeBoilerplate('J Med Phys 2024;52:97')
	);
	// 内容不同的两条不会被并到一起。
	assert.notEqual(normalizeBoilerplate('Methods and Materials'), normalizeBoilerplate('Results'));
});

test('页边带: 沿用 PDF y 轴向上的坐标约定, 页心不算', () => {
	assert.equal(inMarginBand([50, 730, 300, 780], PAGE_HEIGHT, 0.12), true, '顶部带内');
	assert.equal(inMarginBand([50, 20, 300, 90], PAGE_HEIGHT, 0.12), true, '底部带内');
	assert.equal(inMarginBand([50, 380, 300, 420], PAGE_HEIGHT, 0.12), false, '页心不算');
	// 正文首段常落在顶部 15% 里 —— 带宽收到 12% 正是为了不误吞它。
	assert.equal(inMarginBand([50, 690, 300, 700], PAGE_HEIGHT, 0.12), false, '偏高的正文首段在带外');
});

// ---- 阈值与计数口径 ---------------------------------------------------------

const FOOT: [number, number, number, number] = [50, 82, 300, 90]; // 8% 带之外、12% 带之内
const TEXT = 'Journal of Spectral Imaging 2024;51:88';

test('阈值: 两页不够, 第三个不同页确认', () => {
	const reg = new RepeatRegistry(3);
	reg.observe(0, TEXT, FOOT, PAGE_HEIGHT, 'paragraph');
	assert.equal(reg.isRepeated(TEXT), false, '一页不算重复');
	reg.observe(1, TEXT, FOOT, PAGE_HEIGHT, 'paragraph');
	assert.equal(reg.isRepeated(TEXT), false, '两页仍不算');
	reg.observe(2, TEXT, FOOT, PAGE_HEIGHT, 'paragraph');
	assert.equal(reg.isRepeated(TEXT), true, '三个不同页 → 确认为版式家具');
	assert.equal(reg.confirmedCount(), 1);
});

test('计数按页去重: 同一页反复重排不得把计数灌大', () => {
	const reg = new RepeatRegistry(3);
	for (let i = 0; i < 10; i++) {
		reg.observe(0, TEXT, FOOT, PAGE_HEIGHT, 'paragraph'); // 同一页重排 10 次
	}
	assert.equal(reg.isRepeated(TEXT), false, '单页文档不能自己凑够阈值');
});

// ---- 两道防误伤的闸 ---------------------------------------------------------

test('闸一: 归一后过短不进登记 —— 「Table 1/2/3」不会被当成家具丢掉', () => {
	const reg = new RepeatRegistry(3);
	// 数字归一会把三条题注编号并成 "table #",三页一凑正好够阈值 —— 长度闸挡住它。
	for (const [page, text] of [[0, 'Table 1'], [1, 'Table 2'], [2, 'Table 3']] as const) {
		reg.observe(page, text, FOOT, PAGE_HEIGHT, 'paragraph');
	}
	assert.equal(reg.isRepeated('Table 4'), false);
	assert.equal(reg.confirmedCount(), 0);
});

test('闸二: 题注/表格/标题类型一律不进登记', () => {
	const reg = new RepeatRegistry(3);
	for (const type of ['caption', 'table', 'title']) {
		const r = new RepeatRegistry(3);
		r.observe(0, TEXT, FOOT, PAGE_HEIGHT, type);
		r.observe(1, TEXT, FOOT, PAGE_HEIGHT, type);
		r.observe(2, TEXT, FOOT, PAGE_HEIGHT, type);
		assert.equal(r.isRepeated(TEXT), false, `${type} 不进登记`);
	}
	// 页心的正文即使逐页重复也不进登记(带外)。
	reg.observe(0, TEXT, [50, 380, 300, 420], PAGE_HEIGHT, 'paragraph');
	reg.observe(1, TEXT, [50, 380, 300, 420], PAGE_HEIGHT, 'paragraph');
	reg.observe(2, TEXT, [50, 380, 300, 420], PAGE_HEIGHT, 'paragraph');
	assert.equal(reg.isRepeated(TEXT), false, '页心重复不算版式家具');
});

// ---- 端到端: 补上单页判据的盲区 ---------------------------------------------

test('端到端: 8% 形状带之外的重复页脚, 单页判据放行, 登记表在第三页丢掉', () => {
	// 页脚放在 y≈90: 8% 带 (63.4) 之外 —— isRunningHeadOrFoot 必然放行;
	// 12% 带 (95.0) 之内 —— 登记表看得见。这就是那个结构性盲区。
	// 正文三页逐字相同却在带外,必须活下来 —— 这一条同时验证了带宽收窄。
	const footer = 'Journal of Spectral Imaging 2024;51:88';
	const build = (pageIndex: number, registry: RepeatRegistry) => {
		const items: SpanItem[] = [
			span('Photon-counting detector CT enables spectral separation of', 50, 700, 300),
			span('materials without the dose penalty of a dual-source system', 50, 688, 300),
			span(footer, 50, 90, 260, 8)
		];
		return buildBlocksFromSpans(items, {
			pageIndex, pageHeight: PAGE_HEIGHT, pageWidth: 612,
			includeReferences: false, referencesAlreadyStarted: false,
			imageRectsPdf: [], repeats: registry
		}).blocks.map(b => b.sourceText);
	};

	const reg = new RepeatRegistry(3);
	const p0 = build(0, reg);
	const p1 = build(1, reg);
	const p2 = build(2, reg);
	assert.ok(p0.some(t => t.includes('Spectral Imaging')), '第 1 页: 阈值未到, 页脚仍在(已知代价)');
	assert.ok(p1.some(t => t.includes('Spectral Imaging')), '第 2 页: 阈值未到, 页脚仍在');
	assert.ok(!p2.some(t => t.includes('Spectral Imaging')), '第 3 页: 阈值跨过 → 页脚被丢掉');
	assert.ok(p2.some(t => t.includes('Photon-counting')), '正文一个都不能少');
});

test('端到端: 不传登记表时行为与从前逐字节一致', () => {
	const items: SpanItem[] = [
		span('Photon-counting detector CT enables spectral separation of', 50, 700, 300),
		span('Journal of Spectral Imaging 2024;51:88', 50, 90, 260, 8)
	];
	const opts = {
		pageHeight: PAGE_HEIGHT, pageWidth: 612,
		includeReferences: false, referencesAlreadyStarted: false, imageRectsPdf: []
	};
	const without = buildBlocksFromSpans(items, { ...opts, pageIndex: 0 }).blocks.map(b => b.sourceText);
	assert.ok(without.some(t => t.includes('Spectral Imaging')), '无登记表 → 页脚照旧保留');
});
