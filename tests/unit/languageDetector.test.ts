import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, defaultTargetFor, analyze } from '../../src/utils/languageDetector';

test('detects English text', () => {
	assert.equal(detectLanguage('This retrospective study aims to evaluate the overall survival.'), 'en');
});

test('detects Chinese text', () => {
	assert.equal(detectLanguage('本研究旨在回顾性评估患者的总生存期与影像组学特征的关系。'), 'zh');
});

test('detects Chinese even when mixed with English terms', () => {
	assert.equal(detectLanguage('我们使用 radiomics 特征来预测 overall survival 总生存期结果。'), 'zh');
});

test('short strings are "other"', () => {
	assert.equal(detectLanguage('OK'), 'other');
});

test('default direction: Chinese -> English, else -> zh-CN', () => {
	assert.equal(defaultTargetFor('zh'), 'en');
	assert.equal(defaultTargetFor('en'), 'zh-CN');
	assert.equal(defaultTargetFor('other'), 'zh-CN');
});

test('analyze ignores punctuation and digits', () => {
	const stats = analyze('123 !!! ... 456');
	assert.equal(stats.total, 0);
	assert.equal(stats.cjkRatio, 0);
});
