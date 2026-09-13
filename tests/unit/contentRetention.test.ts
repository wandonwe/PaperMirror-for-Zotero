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

test('书目类标签仍是元数据:Citation/Editor/Received/Published/Copyright/DOI (2.12.12)', () => {
	for (const s of [
		'Citation: Lu N, Di Y (2015) CT Perfusion in C6 Gliomas. PLoS ONE 10(3): e0121631.',
		'Academic Editor: Jonathan A Coles, Glasgow University, UNITED KINGDOM',
		'Published: March 17, 2015',
		'Received: 3 March 2024; Accepted: 5 May 2024',
		'Copyright © 2024 The Authors.',
		'doi:10.1093/eurheartj/ehae177'
	]) {
		assert.equal(isMetadataBlock(s), true, `仍是元数据: "${s.slice(0, 40)}…"`);
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
