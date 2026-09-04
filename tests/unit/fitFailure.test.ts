import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitOverflow, fitFailureLabel } from '../../src/ui/strictPageReplacement';

test('fitOverflow: 与 ladderFits 同一套 1.5px 容差', () => {
	assert.equal(fitOverflow(100, 50, 100, 50), 'none');
	assert.equal(fitOverflow(101.4, 50, 100, 50), 'none', '1.5px 内是取整噪声');
	assert.equal(fitOverflow(102, 50, 100, 50), 'width');
	assert.equal(fitOverflow(100, 52, 100, 50), 'height');
	assert.equal(fitOverflow(102, 52, 100, 50), 'both');
});

test('fitFailureLabel: 紧凑枚举串,无文本', () => {
	assert.equal(fitFailureLabel({ stage: 'expand-ink', overflow: 'height' }), 'expand-ink/height');
	assert.equal(fitFailureLabel({ stage: 'compress' }), 'compress');
	assert.equal(fitFailureLabel(undefined), 'unknown');
	// 枚举串只含小写字母、连字符、斜杠 —— diagnosticsPrivacy 的口径。
	for (const s of ['expand-ink/height', 'shrink-floor/width', 'compress', 'audit/both']) {
		assert.match(s, /^[a-z-]+(\/[a-z]+)?$/);
	}
});
