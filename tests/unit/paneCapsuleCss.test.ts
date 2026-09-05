import { test } from 'node:test';
import assert from 'node:assert/strict';
import paneCSS from '../../src/ui/styles/translationPane.css';
import { CAPSULE_CLASS } from '../../src/ui/statusCapsule';

/**
 * 2.7.4: 对照翻译窗格里的状态胶囊按窗格绝对定位,不再依赖宿主窗口对
 * position: fixed 的包含块。用户实测: 覆盖模式有胶囊,窗格里整个消失。
 */
test('窗格胶囊: 窗格 CSS 把胶囊改为相对窗格绝对定位', () => {
	const rule = paneCSS.match(new RegExp(`\\.pm-bilingual-pane\\s*>\\s*\\.${CAPSULE_CLASS}\\s*\\{([^}]*)\\}`));
	assert.ok(rule, '存在 .pm-bilingual-pane > .pm-status-capsule 规则');
	assert.match(rule![1]!, /position:\s*absolute/);
	assert.match(rule![1]!, /right:\s*22px/);
	assert.match(rule![1]!, /bottom:\s*22px/);
	assert.match(paneCSS, /\.pm-bilingual-pane\s*\{[^}]*position:\s*relative/, '窗格自身是包含块');
});
