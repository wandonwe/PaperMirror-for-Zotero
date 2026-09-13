import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksTranslated } from '../../src/translation/translationManager';
import { isMetadataBlock } from '../../src/reader/metaFilter';
import { selectInkObstacleBlocks, selectGeometricBlocks } from '../../src/ui/strictPageReplacement';

/**
 * 内容保留规则审核 (2.12.12) —— 用户 2026-09-13 交来的审核里,七条发现在当前代码
 * 里全部成立(纯函数实测复现)。这一版先修前三条:短文本照抄被算成成功、
 * 说明类"元数据"整段丢弃、参考文献"允许翻译却不许显示"。
 */

// ---------------------------------------------------------------- 1. 短文本照抄

test('短自然语言原样返回不算翻译成功 —— 标题/表头/否定短句 (2.12.12)', () => {
	// 审核实测:这三条原文==返回,`looksTranslated` 以前因"散文词数 < 6"直接放行,
	// 被计作成功并写进缓存 —— 短标题、表头、重要短句就此永远留英文。
	for (const s of ['No evidence of benefit', 'Document Title', 'Year Published', 'Study design', 'Not recommended', 'Table 3']) {
		assert.equal(looksTranslated(s, s, 'zh-CN'), false, `照抄 "${s}" 不该通过`);
	}
});

test('数字、缩写、人名、单位原样返回可以通过 —— 不许把 CT/MRI 推进无效重试 (2.12.12)', () => {
	for (const s of ['CT', 'MRI', 'PCCT (n=30)', '2018', 'p < 0.05', 'Powers WJ', 'J. Smith', 'Zhang W, Li M', 'Mei Li, Jun Wang, Hua Chen and Wei Zhang', 'AHA/ASA', '95% CI', 'n = 1,234', 'mg/dL', 'COVID-19', 'IIa']) {
		assert.equal(looksTranslated(s, s, 'zh-CN'), true, `"${s}" 原样保留是正当的`);
	}
});

test('短文本的真实译文照常通过 (2.12.12)', () => {
	assert.equal(looksTranslated('No evidence of benefit', '无获益证据', 'zh-CN'), true);
	assert.equal(looksTranslated('Document Title', '文献标题', 'zh-CN'), true);
	assert.equal(looksTranslated('Year Published', '发表年份', 'zh-CN'), true);
});

test('照抄判定看的是内容相同,不是字节相同:改标点/大小写/空白仍算照抄 (2.12.12)', () => {
	assert.equal(looksTranslated('No evidence of benefit', 'No evidence of benefit.', 'zh-CN'), false);
	assert.equal(looksTranslated('Document Title', 'document  title', 'zh-CN'), false);
});

// ---------------------------------------------------------------- 2. 说明类"元数据"

test('缩写解释/伦理/知情同意/资助/数据可用性:有自然语言就该翻译,不是元数据 (2.12.12)', () => {
	// 审核实测:这些以前全部判为元数据、整段丢弃。它们不是 DOI、页码或水印,
	// 是读者要看的说明。
	for (const s of [
		'Abbreviations: CT, computed tomography; MRI, magnetic resonance imaging.',
		'Patient consent: Written informed consent was obtained.',
		'Ethics: The study was approved by the institutional review board.',
		'Funding: This work was supported by grant no. 12345 from NIH.',
		'Data availability: The data underlying this article will be shared on reasonable request.',
		'Author contributions: All authors contributed to the design of the study and approved the final manuscript.',
		'Conflicts of interest: The authors declare no competing interests.'
	]) {
		assert.equal(isMetadataBlock(s), false, `应翻译: "${s.slice(0, 40)}…"`);
	}
});

test('3.0.0 起只有日期行、DOI 行按精确规则保留;书目标签与版权行翻译', () => {
	assert.equal(isMetadataBlock('Received: 3 March 2024; Accepted: 5 May 2024'), true);
	assert.equal(isMetadataBlock('doi:10.1093/eurheartj/ehae177'), true);
	for (const s of [
		'Citation: Lu N, Di Y (2015) CT Perfusion in C6 Gliomas. PLoS ONE 10(3): e0121631.',
		'Academic Editor: Jonathan A Coles, Glasgow University, UNITED KINGDOM',
		'Published: March 17, 2015',
		'Copyright © 2024 The Authors.'
	]) {
		assert.equal(isMetadataBlock(s), false, `拿不准就翻译: "${s.slice(0, 40)}…"`);
	}
});


test('只有标识、没有自然语言的说明行仍可跳过:纯资助号/纯注册号 (2.12.12)', () => {
	assert.equal(isMetadataBlock('Funding: Grant No. 30970805, 81400428.'), true);
	assert.equal(isMetadataBlock('Trial registration: NCT01234567'), true);
});

// ---------------------------------------------------------------- 3. 参考文献:翻译了就要能显示

test('开了参考文献翻译的块进排版;仍保留的参考文献才是墨迹遮挡物 —— 两个集合严格互补 (2.12.12)', () => {
	const rects = [[0, 0, 10, 10]];
	const blocks = [
		{ id: 'ref-kept', isReference: true, translationMode: 'preserve' as const, type: 'paragraph', lineRectsPdf: rects },
		{ id: 'ref-translated', isReference: true, translationMode: undefined, type: 'paragraph', lineRectsPdf: rects },
		{ id: 'body', isReference: false, translationMode: undefined, type: 'paragraph', lineRectsPdf: rects },
		{ id: 'ref-no-geom', isReference: true, translationMode: undefined, type: 'paragraph', lineRectsPdf: [] }
	];
	const geo = selectGeometricBlocks(blocks).map(b => b.id);
	const ink = selectInkObstacleBlocks(blocks).map(b => b.id);
	assert.deepEqual(geo, ['ref-translated', 'body'], '允许翻译的参考文献必须进排版,否则"请求已经花钱,页面仍是英文"');
	assert.deepEqual(ink, ['ref-kept'], '只有仍保留原文的参考文献才是遮挡物');
	for (const b of blocks) {
		assert.ok(!(geo.includes(b.id) && ink.includes(b.id)), `${b.id} 不能既进排版又当遮挡物`);
	}
});

// ---------------------------------------------------------------- 5. 排版不再重判"值不值得翻"

import { readFileSync } from 'node:fs';

test('排版只在**没有译文**时才按元数据规则跳过 —— 上游决定翻译的块不许在显示阶段被二次过滤 (结构闸, 2.12.12)', () => {
	// 审核第 5 条:提取路径给标题/图注/表题的豁免,排版这一侧的 isMetadataBlock(纯文本)
	// 并不知道 —— 一个块通过提取、拿到了译文,显示时仍可能被这里丢掉。
	// 这一版只走第一步:有译文就不再重判。彻底统一(下游继承上游决策)留到下一步。
	const src = readFileSync('src/ui/strictPageReplacement.ts', 'utf8');
	const i = src.indexOf('for (const block of translatable)');
	const loop = src.slice(i, i + 1600);
	assert.ok(/if \(text === undefined && isMetadataBlock\(block\.sourceText\)\)/.test(loop),
		'排版侧的元数据判定必须以"没有译文"为前提');
	assert.ok(!/if \(isMetadataBlock\(block\.sourceText\)\) \{/.test(loop), '不许退回无条件重判');
});

// ================================================================ 2.12.13:译文侧默认全文翻译

/**
 * 原则(用户 2026-09-13):**原文侧负责忠实保留;译文侧负责完整理解。元素类别决定排版方式,
 * 不决定是否翻译。** 产品目标:译文侧默认全文翻译,允许标识原样保留,
 * 不允许自然语言内容因为元素分类而无提示缺失。
 */

import { classifyContent } from '../../src/reader/metaFilter';
import { protectFormulas, restoreFormulas } from '../../src/reader/formulaGuard';
import { buildBlocks } from '../../src/reader/blockBuilder';
import type { PdfChar } from '../../src/types/models';
import { digestRows, diagnosticRows } from '../../src/translation/pageBlockDigest';

test('classifyContent:自然语言一律翻译,标识保留并带原因,几何位置不决定翻不翻 (2.12.13)', () => {
	const T = (s: string, rect?: [number, number, number, number]) => classifyContent(s, rect, 600, { fontSize: 7, bodySize: 10 });
	// 翻译:说明、单位、通讯句、版权整句、资助句、作者贡献
	for (const s of [
		'Patient consent: Written informed consent was obtained.',
		'Department of Cardiology, University Hospital Zurich, Zurich, Switzerland',
		'Contact the corresponding author at name@example.com.',
		'This is an Open Access article distributed under the terms of the Creative Commons Attribution License.',
		'The funders had no role in study design, data collection and analysis, decision to publish, or preparation of the manuscript.',
		'Author contributions: Guarantors of integrity of entire study, all authors.'
	]) {
		assert.equal(T(s).decision, 'translate', `应翻译: "${s.slice(0, 50)}"`);
	}
	// 页边栏几何以前一票否决(<700 字符全跳过):现在几何不决定翻不翻。
	assert.equal(T('Funding: This work was supported by the Swiss National Science Foundation.', [10, 300, 120, 400]).decision, 'translate');
	// 保留(带原因):人名、日期、DOI/网址、水印、页码、书目标签、短版权行
	const P = (s: string, reason: string) => {
		const c = T(s);
		assert.equal(c.decision, 'preserve', `应保留: "${s.slice(0, 40)}"`);
		assert.equal(c.reason, reason, `"${s.slice(0, 40)}" 的原因应为 ${reason}`);
	};
	assert.equal(T('John A Smith, Mary Jones, Wei Zhang, and Li Wang').decision, 'translate', '3.0.0:名单不按形状保留,人名由提示词原样保留');
	P('Received: 3 March 2024; Accepted: 5 May 2024', 'dates');
	P('doi:10.1093/eurheartj/ehae177', 'identifier');
	P('https://doi.org/10.1093/eurheartj/ehae177', 'identifier');
	P('Downloaded from https://academic.oup.com/eurheartj by guest on 20 September 2024', 'watermark');
	P('1234', 'marks');
	P('Funding: Grant No. 30970805, 81400428.', 'identifier');
	for (const s of ['Citation: Lu N, Di Y (2015) CT Perfusion in C6 Gliomas. PLoS ONE 10(3): e0121631.', 'Copyright © 2024 The Authors.', 'RESEARCH ARTICLE']) {
		assert.equal(T(s).decision, 'translate', `3.0.0:拿不准就翻译 "${s.slice(0, 30)}"`);
	}
	// 每个 preserve 都必须带原因 —— "无提示缺失"是被禁止的。
	for (const s of ['1234', 'doi:10.1093/x']) { assert.ok(T(s).reason, '保留必须带原因'); }
});

test('片段保护:邮箱、网址、DOI、注册号被掩蔽后原样还原 (2.12.13)', () => {
	const src = 'Contact name@example.com or see https://example.org/x?y=1 (doi:10.1093/eurheartj/ehae177; NCT01234567).';
	const { text, placeholders } = protectFormulas(src);
	assert.ok(!/name@example\.com/.test(text), '邮箱必须被掩蔽');
	assert.ok(!/https:\/\/example\.org/.test(text), '网址必须被掩蔽');
	assert.ok(!/10\.1093\/eurheartj/.test(text), 'DOI 必须被掩蔽');
	assert.ok(!/NCT01234567/.test(text), '注册号必须被掩蔽');
	assert.equal(restoreFormulas(text, placeholders), src, '还原后逐字节相同');
});

test('提取阶段不再整块丢弃:不译的块以 preserve + preserveReason 保留 (2.12.13)', () => {
	const cs = charsFor([
		{ text: 'Body paragraph text that is long enough to be a paragraph here.', y: 700 },
		{ text: 'Department of Radiology, University Hospital, Zurich, Switzerland', y: 660 },
		{ text: 'Received: 3 March 2024; Accepted: 5 May 2024', y: 620 },
		{ text: 'doi:10.1093/eurheartj/ehae177', y: 580 }
	]);
	const result = buildBlocks(cs, { pageIndex: 0, pageWidth: 600, pageHeight: 800, includeReferences: false });
	const by = (frag: string) => result.blocks.find(b => b.sourceText.includes(frag));
	assert.ok(by('Department of Radiology'), '作者单位必须在 blocks 里');
	assert.notEqual(by('Department of Radiology')!.translationMode, 'preserve', '作者单位要翻译');
	const dates = by('Received');
	assert.ok(dates, '日期行不再丢弃');
	assert.equal(dates!.translationMode, 'preserve');
	assert.equal(dates!.preserveReason, 'dates');
	const doi = by('doi:10.1093');
	assert.ok(doi && doi.translationMode === 'preserve' && doi.preserveReason === 'identifier', 'DOI 行保留并带原因');
});

test('逐块摘要带 preserveReason (2.12.13)', () => {
	const rows = digestRows({
		blocks: [
			{ id: 'a', pageIndex: 0, order: 0, type: 'paragraph', sourceText: 'x', translationMode: 'preserve', preserveReason: 'dates' } as never,
			{ id: 'b', pageIndex: 0, order: 1, type: 'paragraph', sourceText: 'y' } as never
		],
		translations: new Map([['b', '译']])
	});
	assert.equal(rows[0]!.outcome, 'preserved');
	assert.equal((rows[0] as { preserveReason?: string }).preserveReason, 'dates');
	assert.equal(rows[1]!.outcome, 'translated');
	// 真机 2.12.13 的导出里 preserveReason 全空 —— 摘要有、导出行没接。
	const diag = diagnosticRows(rows);
	assert.equal(diag[0]!.preserveReason, 'dates', '诊断导出行必须带原因');
	assert.equal(diag[1]!.preserveReason, undefined);
});

function charsFor(lines: { text: string; y: number }[]) {
	const out: PdfChar[] = [];
	for (const l of lines) {
		const glyphs = [...l.text];
		glyphs.forEach((g, i) => {
			out.push({
				c: g, rect: [10 + i * 5, l.y, 15 + i * 5, l.y + 10], fontSize: 10, fontName: 'Body',
				spaceAfter: false, lineBreakAfter: false, paragraphBreakAfter: i === glyphs.length - 1
			} as PdfChar);
		});
	}
	return out;
}

// ================================================================ 3.0.0:拿不准就翻译

test('3.0.0:参考文献默认翻译(prefs.js 与运行时默认值一致)', () => {
	const prefs = readFileSync('prefs.js', 'utf8');
	assert.match(prefs, /translateReferences', true\)/, 'prefs.js 默认 true');
	const session = readFileSync('src/reader/readerSession.ts', 'utf8');
	assert.match(session, /getPref<boolean>\('translateReferences', true\)/, '运行时默认 true');
});

test('3.0.0:整列多数是数据,不再把有词的格一并保留', async () => {
	const { buildTableModel } = await import('../../src/reader/tableStructure');
	const cell = (id: string, left: number, top: number, width: number, height: number, text: string) =>
		({ id, box: { left, top, width, height }, text, fontSize: 8 });
	const members = [
		cell('h0', 40, 10, 80, 12, 'Outcome'), cell('h1', 150, 10, 80, 12, 'Value'),
		cell('r1-0', 40, 30, 80, 12, 'Mortality'), cell('r1-1', 150, 30, 80, 12, '12 ± 3'),
		cell('r2-0', 40, 50, 80, 12, 'Stroke'), cell('r2-1', 150, 50, 80, 12, '4 ± 1'),
		cell('r3-0', 40, 70, 80, 12, 'Bleeding'), cell('r3-1', 150, 70, 80, 12, '7 ± 2'),
		cell('r4-0', 40, 90, 80, 12, 'Any adverse event'), cell('r4-1', 150, 90, 80, 12, 'Not reported')
	];
	const model = buildTableModel(0, 0, { left: 40, top: 10, width: 200, height: 100 }, members);
	const notReported = model.cells.find(c => c.memberIds.includes('r4-1'));
	assert.ok(notReported, '格存在');
	assert.equal(notReported!.kind, 'text', '"Not reported" 有词就翻译 —— 同列邻居是数字证明不了它不用翻');
});
