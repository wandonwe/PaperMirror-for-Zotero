import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capsuleStateFor, type OverlayProgress } from '../../src/reader/pdfOverlay';

const base: OverlayProgress = {
	phase: 'translating',
	currentPage: 3,
	totalPages: 12,
	segTotal: 20,
	segTranslated: 18,
	segPlaced: 0,
	kept: 0
};

test('translating: real ring fraction from translated/total, cancel action', () => {
	const s = capsuleStateFor({ ...base, phase: 'translating', segTranslated: 18, segPlaced: 0 });
	assert.equal(s.main, '正在处理 第 3 / 12 页');
	assert.equal(s.sub, '翻译 18/20 段 · 排版 0/20 段');
	assert.ok(Math.abs((s.fraction ?? -1) - 0.9) < 1e-9, 'ring = 18/20');
	assert.equal(s.indeterminate, false);
	assert.equal(s.action?.kind, 'cancel');
});

test('translating before segment count known → indeterminate, 识别段落', () => {
	const s = capsuleStateFor({ ...base, phase: 'translating', segTotal: 0, segTranslated: 0 });
	assert.equal(s.indeterminate, true);
	assert.equal(s.sub, '正在识别段落');
});

test('laying-out: ring from placed/total', () => {
	const s = capsuleStateFor({ ...base, phase: 'laying-out', segTranslated: 20, segPlaced: 15 });
	assert.equal(s.main, '正在适配 第 3 / 12 页 排版');
	assert.equal(s.sub, '翻译 20/20 段 · 排版 15/20 段');
	assert.ok(Math.abs((s.fraction ?? -1) - 0.75) < 1e-9);
});

test('done: check glyph, full ring, auto-hides, no action', () => {
	const s = capsuleStateFor({ ...base, phase: 'done', segPlaced: 20, segTranslated: 20 });
	assert.equal(s.glyph, 'check');
	assert.equal(s.fraction, 1);
	assert.equal(s.main, '已完成 第 3 页');
	assert.ok((s.autoHideMs ?? 0) > 0, 'done auto-hides');
	assert.equal(s.action, undefined);
});

test('partial: warns, reports kept count, persists with a 查看 action', () => {
	const s = capsuleStateFor({ ...base, phase: 'partial', segTranslated: 20, segPlaced: 17, kept: 3 });
	assert.equal(s.glyph, 'warn');
	assert.equal(s.main, '第 3 页 · 3 段保留原文');
	assert.equal(s.autoHideMs, undefined, 'partial must NOT auto-hide');
	assert.equal(s.action?.kind, 'view');
});

test('failed: error glyph, message, retry action, persists', () => {
	const s = capsuleStateFor({ ...base, phase: 'failed', message: '翻译失败：网络错误' });
	assert.equal(s.glyph, 'error');
	assert.equal(s.main, '翻译失败：网络错误');
	assert.equal(s.autoHideMs, undefined);
	assert.equal(s.action?.kind, 'retry');
});

test('cancelled: stop glyph, auto-hides', () => {
	const s = capsuleStateFor({ ...base, phase: 'cancelled' });
	assert.equal(s.glyph, 'stop');
	assert.equal(s.main, '已停止翻译');
	assert.ok((s.autoHideMs ?? 0) > 0);
});
