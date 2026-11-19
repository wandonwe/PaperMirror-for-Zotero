import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksTranslated, looksLikeReferenceEntry } from '../../src/translation/translationManager';

/**
 * 5.0 (真机 Frontiers 一文第 9/12/13/14 页): 参考文献条目被模型原样返回时当作
 * 「保持原文」接受;正文绝不因此被放过不翻。
 */
const refs = [
	'12. Smith JA, Brown K, Lee H, et al. Wear of vitamin E-stabilized polyethylene in total knee arthroplasty. J Arthroplasty. 2019;34(7):1452–8. doi:10.1016/j.arth.2019.03.012',
	'[3] Wang D, Zhou Q. Carbon-fiber PEEK implants in CT imaging. Front Surg 2022; 9: 812345.',
	'Kurtz SM, Devine JN. PEEK biomaterials in trauma, orthopedic, and spinal implants. Biomaterials. 2007;28(32):4845-69.'
];
const body = [
	'The PEEK prosthesis value was 182.95 (SD 4.90, coefficient of variation 2.68) HU, and the mean HXLPE value was −89.41 HU, as reported in 2019 by our group.',
	'As shown by Smith et al. in 2019, wear rates decreased markedly after the introduction of vitamin E-stabilized polyethylene, which motivated the present study design and the follow-up protocol used here.',
	'Patients were followed for 10 years (2009–2019); radiographs were reviewed at 1, 2, 5 and 10 years by two independent observers.'
];

test('参考文献条目的结构判定: 真条目通过,正文不通过', () => {
	for (const r of refs) assert.equal(looksLikeReferenceEntry(r), true, r);
	for (const b of body) assert.equal(looksLikeReferenceEntry(b), false, b);
});

test('参考文献原样返回 → 接受(保持原文)', () => {
	for (const r of refs) assert.equal(looksTranslated(r, r, 'zh-CN', { isReference: true }), true, r);
});

test('正文原样返回仍判为没翻 —— 即使被误标为参考文献区', () => {
	for (const b of body) {
		assert.equal(looksTranslated(b, b, 'zh-CN', { isReference: true }), false, b);
		assert.equal(looksTranslated(b, b, 'zh-CN'), false, b);
	}
});

test('参考文献被截断仍判废', () => {
	assert.equal(looksTranslated(refs[0]!, 'Smith JA, Brown K.', 'zh-CN', { isReference: true }), false);
});

test('不是参考文献区的块,即使长得像条目,原样返回也不放过', () => {
	assert.equal(looksTranslated(refs[2]!, refs[2]!, 'zh-CN'), false);
});
