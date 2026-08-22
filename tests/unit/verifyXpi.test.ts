import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore -- release script is plain JS; imported here for its pure helpers
import { disallowedEntries, forbiddenEntries, missingRequired, semverCompare } from '../../scripts/xpi-checks.mjs';

/**
 * P3-E (2.1.1): 打包门禁的纯判定逻辑。
 *  - 允许清单: 任何不在白名单上的文件都必须被拒(防源码映射/.ts/.env/密钥
 *    文件混入已发布 XPI)。
 *  - 版本选取: 默认挑版本时必须按 semver 而非字典序 —— 否则 "2.0.9" 被排在
 *    "2.0.10" 之上,会去校验一个陈旧的构建。
 */

const GOOD_ENTRIES = [
	'LICENSE', 'THIRD-PARTY-NOTICES.md', 'manifest.json', 'bootstrap.js', 'prefs.js',
	'content/', 'content/index.js', 'content/preferences.js', 'content/preferences.xhtml',
	'content/fonts/', 'content/fonts/NotoSansSC-PM.ttf',
	'content/icons/', 'content/icons/icon.svg', 'content/icons/icon128.png',
	'locale/', 'locale/en-US/', 'locale/en-US/papermirror.ftl',
	'locale/zh-CN/', 'locale/zh-CN/papermirror.ftl'
];

test('allow-list: 干净的条目集合零违规', () => {
	assert.deepEqual(disallowedEntries(GOOD_ENTRIES), []);
	assert.deepEqual(forbiddenEntries(GOOD_ENTRIES), []);
	assert.deepEqual(missingRequired(GOOD_ENTRIES), []);
});

test('allow-list: 拦截混入的源码/映射/密钥/依赖文件', () => {
	const bad = [
		...GOOD_ENTRIES,
		'content/index.js.map',      // 源码映射: 泄露源码
		'src/secret.ts',              // 未编译源码
		'.env',                       // 环境变量/密钥
		'apikey.txt',                 // 密钥文件
		'node_modules/foo/index.js'   // 依赖残留
	];
	const flagged = disallowedEntries(bad);
	for (const leak of ['content/index.js.map', 'src/secret.ts', '.env', 'apikey.txt', 'node_modules/foo/index.js']) {
		assert.ok(flagged.includes(leak), `必须拦截 ${leak}`);
	}
	// 目录条目不算违规
	assert.ok(!flagged.some((e: string) => e.endsWith('/')));
});

test('forbidden: macOS 垃圾与构建标记仍被单独拦截', () => {
	const debris = ['manifest.json', '.DS_Store', 'content/._index.js', '.built'];
	const f = forbiddenEntries(debris);
	assert.ok(f.includes('.DS_Store'));
	assert.ok(f.includes('content/._index.js'));
	assert.ok(f.includes('.built'));
});

test('missingRequired: 缺法律文件被报出', () => {
	assert.deepEqual(missingRequired(['manifest.json']).sort(), ['LICENSE', 'THIRD-PARTY-NOTICES.md']);
});

test('semverCompare: 数字段按数值而非字典序', () => {
	assert.ok(semverCompare('2.0.10', '2.0.9') > 0, '2.0.10 必须大于 2.0.9');
	assert.ok(semverCompare('2.1.1', '2.1.0') > 0);
	assert.ok(semverCompare('2.1.0', '2.1.0') === 0);
	assert.ok(semverCompare('1.3.0', '2.0.0') < 0);
	// 用它排序一组版本,最大者必须是真正的最高版本
	const versions = ['2.0.9', '2.0.10', '2.1.1', '1.3.1', '2.1.0'];
	const max = versions.slice().sort(semverCompare).at(-1);
	assert.equal(max, '2.1.1');
});
