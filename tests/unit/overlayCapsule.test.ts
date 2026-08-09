import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capsuleStateFor, type OverlayProgress } from '../../src/reader/pdfOverlay';
import { taskPriority } from '../../src/ui/statusCapsule';

const base: OverlayProgress = {
	phase: 'translating',
	currentPage: 3,
	totalPages: 12,
	segTotal: 20,
	segTranslated: 18,
	segPlaced: 0,
	kept: 0
};

test('translating: COMBINED ring fraction (translate is the first half), cancel action', () => {
	const s = capsuleStateFor({ ...base, phase: 'translating', segTranslated: 18, segPlaced: 0 });
	assert.equal(s.main, '正在处理 第 3 / 12 页');
	assert.equal(s.sub, '翻译 18/20 段 · 排版 0/20 段');
	// Combined: (18 + 0) / (20 * 2) = 0.45 — translation caps near 50%, so the
	// ring never resets to 0% when placement begins.
	assert.ok(Math.abs((s.fraction ?? -1) - 0.45) < 1e-9, 'ring = (18+0)/40');
	assert.equal(s.indeterminate, false);
	assert.equal(s.action?.kind, 'cancel');
});

test('translating before segment count known → indeterminate, 识别段落', () => {
	const s = capsuleStateFor({ ...base, phase: 'translating', segTotal: 0, segTranslated: 0 });
	assert.equal(s.indeterminate, true);
	assert.equal(s.sub, '正在识别段落');
});

test('laying-out: COMBINED ring never drops below the translation level', () => {
	const s = capsuleStateFor({ ...base, phase: 'laying-out', segTranslated: 20, segPlaced: 15 });
	assert.equal(s.main, '正在适配 第 3 / 12 页 排版');
	assert.equal(s.sub, '翻译 20/20 段 · 排版 15/20 段');
	// (20 + 15) / 40 = 0.875 — starts at 0.5 when placement begins, climbs to 1.
	assert.ok(Math.abs((s.fraction ?? -1) - 0.875) < 1e-9);
	// The exact "translated, none placed yet" moment is 50%, NOT 0%.
	const start = capsuleStateFor({ ...base, phase: 'laying-out', segTranslated: 20, segPlaced: 0 });
	assert.ok(Math.abs((start.fraction ?? -1) - 0.5) < 1e-9, 'no reset to 0% at layout start');
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
	const s = capsuleStateFor({ ...base, phase: 'partial', segTotal: 20, segTranslated: 20, segPlaced: 17, kept: 3 });
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

test('notice: transient success flash — ✓, custom message, auto-hides, no action', () => {
	const s = capsuleStateFor({ ...base, phase: 'notice', message: '译文已复制到剪贴板' });
	assert.equal(s.glyph, 'check');
	assert.equal(s.main, '译文已复制到剪贴板');
	assert.ok((s.autoHideMs ?? 0) > 0, 'notice auto-hides');
	assert.equal(s.action, undefined, 'a success flash has no button');
});

test('task priority: a success notice shows over active work but under a failure', () => {
	const notice: OverlayProgress = { ...base, phase: 'notice', message: '已保存' };
	const activeTranslate: OverlayProgress = { ...base, phase: 'translating' };
	const failed: OverlayProgress = { ...base, phase: 'failed', message: 'x' };
	assert.ok(taskPriority(notice) > taskPriority(activeTranslate), 'flash is visible over progress');
	assert.ok(taskPriority(failed) > taskPriority(notice), 'a failure still wins');
});

test('idle on a translated page → ✓, full ring, persists (no auto-hide, no action)', () => {
	const s = capsuleStateFor({ ...base, phase: 'idle', segTranslated: 1, segTotal: 0 });
	assert.equal(s.glyph, 'check');
	assert.equal(s.fraction, 1);
	assert.equal(s.autoHideMs, undefined, 'idle never auto-hides');
	assert.equal(s.action, undefined, 'idle has no right-hand action');
});

test('idle on a never-translated page → ↻ refresh glyph', () => {
	const s = capsuleStateFor({ ...base, phase: 'idle', segTranslated: 0, segTotal: 0 });
	assert.equal(s.glyph, 'refresh');
	assert.equal(s.autoHideMs, undefined);
});

test('failed with retryable:false (save/copy/open) → × close action, NOT retry', () => {
	// Issue 1: a non-translation failure must not offer a 重试 that would
	// wrongly re-translate the page.
	const s = capsuleStateFor({ ...base, phase: 'failed', message: '保存笔记失败', retryable: false });
	assert.equal(s.action?.kind, 'close');
	assert.notEqual(s.action?.kind, 'retry');
});

test('failed with retryable omitted (translation) → retry action', () => {
	const s = capsuleStateFor({ ...base, phase: 'failed', message: '翻译失败：网络错误' });
	assert.equal(s.action?.kind, 'retry');
});

test('partial "查看" action is a view, so it can locate the kept segments', () => {
	// Issue 2: the action must be a distinct `view`, wired to onViewPartial —
	// not a retry (which re-translates) or a close (which just dismisses).
	const s = capsuleStateFor({ ...base, phase: 'partial', kept: 2 });
	assert.equal(s.action?.kind, 'view');
});

test('task priority: a failure outranks everything', () => {
	const failed: OverlayProgress = { ...base, phase: 'failed', message: 'x' };
	const activeExport: OverlayProgress = { ...base, phase: 'translating', task: 'export' };
	const activeTranslate: OverlayProgress = { ...base, phase: 'translating' };
	assert.ok(taskPriority(failed) > taskPriority(activeExport));
	assert.ok(taskPriority(failed) > taskPriority(activeTranslate));
});

test('task priority: a running export outranks a running page translation', () => {
	// Issue 5: when a PDF export runs WHILE the current page translates, the
	// capsule must not flip-flop — the more important (export) task wins.
	const activeExport: OverlayProgress = { ...base, phase: 'translating', task: 'export' };
	const activeTranslate: OverlayProgress = { ...base, phase: 'translating', task: 'translation' };
	assert.ok(taskPriority(activeExport) > taskPriority(activeTranslate));
});

test('task priority: partial (kept original) outranks an active translation', () => {
	const partial: OverlayProgress = { ...base, phase: 'partial', kept: 3 };
	const activeTranslate: OverlayProgress = { ...base, phase: 'translating' };
	assert.ok(taskPriority(partial) > taskPriority(activeTranslate));
});

test('task priority: an active translation outranks a finished (done) task', () => {
	const activeTranslate: OverlayProgress = { ...base, phase: 'translating' };
	const done: OverlayProgress = { ...base, phase: 'done' };
	assert.ok(taskPriority(activeTranslate) > taskPriority(done));
});
