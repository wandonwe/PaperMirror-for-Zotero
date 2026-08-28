import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMarginSidebar, isMetadataBlock, isRunningHeadOrFoot, isVerticalSliver, type Rect } from '../../src/reader/metaFilter';

// ---- the exact failure cases from the ESC review paper ----------------------

test('the author list that garbled the abstract is filtered', () => {
	assert.equal(isMetadataBlock(
		'Alexios S. Antonopoulos 1,2*, Andreas Angelopoulos1, Konstantinos Tsioufis1, Charalambos Antoniades 2, and Dimitris Tousoulis 1'
	), true);
});

test('affiliation lines are filtered', () => {
	assert.equal(isMetadataBlock(
		'1st Department of Cardiology, Hippokration Hospital, National and Kapodistrian University of Athens, 114 Vas. Sofias Avenue, 11527, Athens, Greece'
	), true);
	assert.equal(isMetadataBlock(
		'2RDM Division of Cardiovascular Medicine, Oxford Academic CT Programme, University of Oxford, John Radcliffe Hospital, Headley Way, OX3 9DU Oxford, UK'
	), true);
});

test('received/accepted dates are filtered', () => {
	assert.equal(isMetadataBlock(
		'Received 19 January 2021; revised 25 March 2021; accepted 7 April 2021; online publish-ahead-of-print 30 April 2021'
	), true);
});

test('correspondence and email lines are filtered', () => {
	assert.equal(isMetadataBlock(
		'* Corresponding author. Tel: +30 6947607442, Email: alexios.antonopoulos@cardiov.ox.ac.uk; antonopoulosal@yahoo.gr'
	), true);
});

test('copyright and licence boilerplate is filtered', () => {
	assert.equal(isMetadataBlock(
		'© The Author(s) 2021. Published by Oxford University Press on behalf of the European Society of Cardiology.'
	), true);
	assert.equal(isMetadataBlock(
		'This is an Open Access article distributed under the terms of the Creative Commons Attribution License (https://creativecommons.org/licenses/by/4.0/), which permits unrestricted reuse, distribution, and reproduction in any medium, provided the original work is properly cited.'
	), true);
});

test('the download watermark is filtered by text and by shape', () => {
	assert.equal(isMetadataBlock(
		'Downloaded from https://academic.oup.com/eurjpc/article/29/4/608/6261148 by guest on 26 March 2026'
	), true);
	// Rotated 90° along the page edge: tall, extremely narrow.
	const sliver: Rect = [598, 300, 610, 640];
	assert.equal(isVerticalSliver(sliver), true);
	assert.equal(isMetadataBlock('any text at all', sliver), true);
});

test('a DOI line is filtered, a paragraph citing a URL is not', () => {
	assert.equal(isMetadataBlock('European Journal of Preventive Cardiology (2022) 29, 608–624 doi:10.1093/eurjpc/zwab067'), true);
	const bodyWithURL = 'The CONFIRM registry data are publicly documented at https://example.org/confirm and have been analysed in several follow-up studies. '
		+ 'In these analyses, the five-year prognostic value of the CT-adapted Leiman score remained significant in patients without obstructive stenosis, and the Leiden group subsequently modified the score by adding the subcategory of mixed plaque.';
	assert.equal(isMetadataBlock(bodyWithURL), false);
});

// ---- content that must NEVER be filtered ------------------------------------

test('body prose survives, even with names, commas and digits', () => {
	assert.equal(isMetadataBlock(
		'In recent large randomized clinical trials, such as the PROMISE (Prospective Multicenter Imaging Study for Evaluation of Chest Pain) and SCOT-HEART (Scottish Computed Tomography of the Heart), the use of CCTA was associated with smaller risks for myocardial infarction compared to conventional management.'
	), false);
});

test('the abstract survives', () => {
	assert.equal(isMetadataBlock(
		'Current cardiovascular risk stratification by use of clinical risk score systems or plasma biomarkers is good but less than satisfactory in identifying patients at residual risk for coronary events.'
	), false);
});

test('headings, keywords and short body fragments survive', () => {
	assert.equal(isMetadataBlock('Introduction'), false);
	assert.equal(isMetadataBlock('Coronary calcification'), false);
	assert.equal(isMetadataBlock('Keywords: Coronary computed tomography angiography, Atherosclerosis, Coronary artery disease'), false);
});

test('a normal paragraph rect is not a vertical sliver', () => {
	assert.equal(isVerticalSliver([54, 500, 292, 560]), false);
});

test('semicolon-style rosters with inline superscripts and degrees are filtered', () => {
	assert.equal(isMetadataBlock(
		'Patrick W. Serruys1*, MD, PhD; Nozomi Kotoku1, MD; Bjarne L. Nørgaard2, MD, PhD; Scot Garg3, MD, PhD; Koen Nieman4, MD, PhD; Marc R. Dweck5, MD, PhD'
	), true);
});

test('orphan affiliation numbers and author notes are filtered', () => {
	assert.equal(isMetadataBlock('18'), true);
	assert.equal(isMetadataBlock('20, 21'), true);
	assert.equal(isMetadataBlock('P.W. Serruys and N. Kotoku contributed equally to this work.'), true);
	assert.equal(isMetadataBlock("The authors' affiliations can be found in the Appendix paragraph."), true);
});

test('a year inside body prose does not make it metadata', () => {
	assert.equal(isMetadataBlock(
		'In 2015 the CONFIRM registry reported that the five-year prognostic value of the score was significant in patients without obstructive stenosis, which changed clinical practice.'
	), false);
});

// ---- the PLOS ONE front-matter sidebar that leaked into the translation -----

test('journal sidebar labels are filtered (Citation/Editor/Published/Data/Funding)', () => {
	assert.equal(isMetadataBlock(
		'Citation: Lu N, Di Y, Feng X-Y, Qiang J-W, Zhang J-w, Wang Y-g, et al. (2015) CT Perfusion with Acetazolamide Challenge in C6 Gliomas and Angiogenesis. PLoS ONE 10(3): e0121631. doi:10.1371/journal.pone.0121631'
	), true);
	assert.equal(isMetadataBlock(
		'Academic Editor: Jonathan A Coles, Glasgow University, UNITED KINGDOM'
	), true);
	assert.equal(isMetadataBlock('Published: March 17, 2015'), true);
	assert.equal(isMetadataBlock(
		'Data Availability Statement: All relevant data are made available in supporting information files S1, S2, S3.'
	), true);
	assert.equal(isMetadataBlock(
		'Funding: This work was supported by National Natural Science Foundations of China (Grant No. 30970805, 81400428), a grant from Science and Technology Commission of Shanghai Municipality (Grant No. 09JC1403100).'
	), true);
});

test('article-type banners are filtered', () => {
	assert.equal(isMetadataBlock('RESEARCH ARTICLE'), true);
	assert.equal(isMetadataBlock('OPEN ACCESS'), true);
	assert.equal(isMetadataBlock('Review'), true);
});

test('licence and funding tails split off the © head block are filtered', () => {
	assert.equal(isMetadataBlock(
		'unrestricted use, distribution, and reproduction in any medium, provided the original author and source are credited.'
	), true);
	assert.equal(isMetadataBlock(
		'The funders had no role in study design, data collection and analysis, decision to publish, or preparation of the manuscript.'
	), true);
	assert.equal(isMetadataBlock(
		'a grant from Shanghai Jinshan Municipality Health Bureau Youth Foundation (Grant No. JWKJ-KTYQ-201202, JWKJ-RCYQ-201202).'
	), true);
});

test('narrow outer-margin sidebar blocks are filtered by geometry', () => {
	// PLOS left strip: x ≈ 43–175 on a 612pt page — whatever it says.
	const sidebar: Rect = [43, 380, 172, 520]; // 129×140pt stack
	assert.equal(isMetadataBlock('Anything the sidebar says, in any novel format.', sidebar, 612), true);
	// A real two-column reading column (~0.44 page width) is never caught.
	const column: Rect = [43, 380, 300, 520]; // 257pt wide: a reading column
	assert.equal(isMetadataBlock('Anything the sidebar says, in any novel format.', column, 612), false);
	// Centre content is never caught even when narrow.
	const centre: Rect = [250, 380, 380, 520];
	assert.equal(isMetadataBlock('A narrow centred fragment of real prose here.', centre, 612), false);
});

test('body prose starting with a label word but no colon survives', () => {
	assert.equal(isMetadataBlock(
		'Published research on perfusion imaging has shown that the technique is reliable across vendors and centres in most clinical settings.'
	), false);
	assert.equal(isMetadataBlock(
		'Funding models for translational research differ between countries, and this shapes what gets studied over the long run.'
	), false);
});

// ---- 1.1.9: 正文尺寸的窄栏不再被当页边栏丢弃 (Horst 2024 第 5/11 页) ----------

// 第 11 页左栏的真实几何: 宽 96pt (< 24% × 594 = 143pt), 高 70pt (5 行), 右边缘
// 144pt (< 34% × 594 = 202pt) —— narrow + tall + outerLeft 三条全中,旧规则丢弃。
const narrowBodyRect: Rect = [48, 300, 144, 370]; // [x1,y1,x2,y2]
const bodyPara = 'It is acknowledged that the literature on adult patients has shown the Bl64 kernel to yield improved visualization of bronchial division.';

test('正文尺寸的窄栏 (10pt vs 正文 10pt) 不再被误判为页边栏', () => {
	assert.equal(isMarginSidebar(narrowBodyRect, 594, { fontSize: 10, bodySize: 10 }), false);
	assert.equal(isMetadataBlock(bodyPara, narrowBodyRect, 594, { fontSize: 10, bodySize: 10 }), false,
		'整列正文不该再被当页边引用/编辑栏静默丢弃');
});

test('真页边栏 (7pt vs 正文 10pt) 仍被识别并过滤', () => {
	// 同样的窄+高+外侧几何, 但字号是真页边栏的 7pt —— 规则本意必须保住。
	assert.equal(isMarginSidebar(narrowBodyRect, 594, { fontSize: 7, bodySize: 10 }), true);
	assert.equal(
		isMetadataBlock('Received July 6, 2023; revision requested August 30; final revision received December 7; accepted January 3, 2024.',
			narrowBodyRect, 594, { fontSize: 7, bodySize: 10 }),
		true);
});

test('没有字号信息时页边栏判定保持原状 (向后兼容)', () => {
	// type 省略 —— 老调用点不传字号, 行为必须与 1.1.8 一致 (纯几何判定)。
	assert.equal(isMarginSidebar(narrowBodyRect, 594), true, '无字号 → 回退到纯几何 → 仍判页边栏');
	assert.equal(isMarginSidebar([48, 300, 144, 315], 594), false, '高度 15pt < 30pt → 不是页边栏 (单行碎片)');
});

test('字号阈值是 0.9 倍: 略小于正文的窄栏仍算正文, 明显小的才算页边', () => {
	assert.equal(isMarginSidebar(narrowBodyRect, 594, { fontSize: 9.2, bodySize: 10 }), false, '9.2 ≥ 10×0.9 → 正文');
	assert.equal(isMarginSidebar(narrowBodyRect, 594, { fontSize: 8.5, bodySize: 10 }), true, '8.5 < 10×0.9 → 页边');
});

// ---- running head/foot vs body lines that reach the margin (1.2.4) ----------
test('a mid-sentence body line in the bottom band is NOT a running foot', () => {
	// Booz 2019 p1: the last lines of each dense column reach y≈23 (bottom 8%
	// band). As one-line blocks they slipped the lineCount<=2 shape test and
	// were dropped, so the translated page showed raw English at the foot.
	const H = 783;
	assert.equal(isRunningHeadOrFoot(
		[66, 23, 285, 33], H, 1,
		'of lumbar disk herniation. More recently, Notohamiprodjo'
	), false);
	assert.equal(isRunningHeadOrFoot(
		[303, 23, 522, 33], H, 1,
		'and confidence for the detection of lumbar disk herniation'
	), false);
	// a hyphenation fragment continuing the previous line
	assert.equal(isRunningHeadOrFoot([66, 35, 285, 45], H, 1, 'agnostic accuracy of single-energy CT compared with MRI'), false);
});

test('real running feet in the band are still dropped', () => {
	const H = 783;
	// page number
	assert.equal(isRunningHeadOrFoot([290, 23, 312, 33], H, 1, '451'), true);
	// n / N page marker
	assert.equal(isRunningHeadOrFoot([280, 23, 330, 33], H, 1, '3 / 13'), true);
	// a title echo running foot begins with a capital
	assert.equal(isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'Virtual Noncalcium Dual-Energy CT'), true);
	// a journal foot typeset lowercase still carries a domain + volume;issue —
	// it must NOT be mistaken for a body continuation and spared.
	assert.equal(isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'n engl j med 378;8 nejm.org February 22, 2018'), true);
});

// ---- 栏底正文以虚词收尾:句子没说完,不是页脚 (2.5.1) ----------------------
test('a capitalised body line that trails off mid-sentence is NOT a running foot', () => {
	// Chen 2023 (Radiology) 第 1 页左栏栏底,真实坐标:单行、54 字符、
	// y=[25.85, 35.85] 落在 783pt 页的底部 8% 带内,首字母大写 —— 「以小写开头」
	// 那条规则看不见它,2.4.8 的诊断里这句正文就是这样整句消失的。
	const H = 783;
	assert.equal(isRunningHeadOrFoot(
		[71.96, 25.85, 290.12, 35.85], H, 1,
		'These features have been reported to be associated with'
	), false);
	// 连字符断词同理
	assert.equal(isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'Radiomic features extracted from peri-'), false);
	// 其它常见虚词收尾
	assert.equal(isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'The primary end point was the composite of'), false);
	assert.equal(isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'Patients were followed until death or'), false);
});

test('虚词收尾规则不放过真正的页眉页脚', () => {
	const H = 783;
	// 自足的标题短语,以实词收尾
	assert.equal(isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'Coronary CT Angiography Radiomics'), true);
	assert.equal(
		isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'Radiomics Model to Identify Vulnerable Plaque'),
		true,
		'中间有虚词但收尾是实词'
	);
	// 期刊脚注带域名/卷期,即使收尾像虚词也照旧丢弃
	assert.equal(
		isRunningHeadOrFoot([66, 23, 400, 33], H, 1, 'radiology.rsna.org ■ Radiology: Volume 307: Number 2—April'),
		true
	);
	// 纯页码不受影响
	assert.equal(isRunningHeadOrFoot([290, 23, 312, 33], H, 1, '451'), true);
});

// ---- 作者单位: 密度判据取代长度上限 (2.5.6) ---------------------------------

test('20 位作者的长单位块必须被丢弃 —— 长度上限原先恰好在这里失效', () => {
	// jacc-ccta2020-p1 实证: 这块 1647 字符、26 个机构词、49 个逗号,却因为
	// 「> 600 字符即放弃」被原样翻译,连同利益声明共约 2700 字符前置信息。
	const affiliation = [
		'From the aNational Heart, Lung, and Blood Institute, National Institutes of Health, Bethesda, Maryland;',
		'bDepartment of Pathology, CVPath Institute, Gaithersburg, Maryland;',
		'cVascular Sciences Section, National Heart and Lung Institute, Imperial College London, London, United Kingdom;',
		'dDivision of Cardiology and Department of Radiology, The George Washington University School of Medicine, Washington, DC;',
		'eDepartment of Radiology, New York–Presbyterian Hospital and Weill Cornell Medicine, New York, New York;',
		'fBritish Heart Foundation Centre for Cardiovascular Science, University of Edinburgh, Edinburgh, United Kingdom;',
		'gEdinburgh Imaging, Queen’s Medical Research Institute University of Edinburgh, Edinburgh, United Kingdom;',
		'hElucid Bioimaging, Boston, Massachusetts; iHeartFlow Inc., Redwood City, California;',
		'jDivision of Cardiology, Emory University School of Medicine, Atlanta, Georgia;',
		'kDivision of Cardiovascular Medicine, Radcliffe Department of Medicine, University of Oxford, Oxford, United Kingdom.'
	].join(' ');
	assert.ok(affiliation.length > 600, '这就是原上限拦不住的长度区间');
	assert.equal(isMetadataBlock(affiliation), true);
});

test('正文段落偶尔提到两所机构,不能被当作者单位丢掉', () => {
	// aquino2023-p2 实证的真·内容丢失: 589 字符、两处 “center”、3 个逗号,
	// 正好落在旧规则(≤600 且 ≥2 机构词 ≥3 逗号)里,整段方法学开篇被丢弃 ——
	// 快照只记前 40 字,块干脆不存在,所以一直没被发现。
	const body = 'The protocol of this prospective, single-center, Health Insurance Portability '
		+ 'and Accountability Act–compliant study was approved by the local institutional review '
		+ 'board at this academic medical center, and written informed consent was obtained from '
		+ 'each participant. Consecutive participants undergoing cardiac MRI for various indications '
		+ 'were recruited for a same-day research photon-counting detector CT examination between '
		+ 'July 2021 and January 2022. All participants underwent CT immediately after the '
		+ 'cardiovascular MRI examination was finished.';
	assert.ok(body.length < 600 && body.length > 400, '就在旧上限的射程之内');
	assert.equal(isMetadataBlock(body), false, '机构词密度远低于单位块');
});

test('短单位块照旧丢弃 —— 密度判据不放松近距离的防守', () => {
	const short = 'Department of Diagnostic Radiology, Jinling Hospital, Medical School of Nanjing University, Nanjing, China';
	assert.equal(isMetadataBlock(short), true);
});
