import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listProviders } from '../../src/translation/providers/registry';

/**
 * 2.0.3: 「微软翻译里出现了 Gemini 的 API Key」。
 *
 * 三个相关缺陷:
 *  A. 密钥输入框对**不需要密钥**的引擎(微软/谷歌免费、Ollama)照常显示可编辑;
 *  B. loadApiKey 有 4 秒竞态窗口(getApiKey 查登录管理器最长等
 *     LOGIN_LOOKUP_TIMEOUT_MS=4000ms)—— 用户在此期间换引擎,先前那次查询会
 *     **后**返回并把上一家的密钥写进现在这一家的框里;
 *  C. 随后的 change/blur 会 setApiKey(当前引擎, 那个值),把 A 的密钥真的存到
 *     B 名下 —— 从显示错乱升级为凭据错存。
 *
 * preferences.ts 绑定 XUL,无法在此直接实例化,故用源码级不变量闸 + 注册表事实。
 */

const prefsSrc = readFileSync(join(process.cwd(), 'src/preferences/preferences.ts'), 'utf8');
const xhtml = readFileSync(join(process.cwd(), 'src/preferences/preferences.xhtml'), 'utf8');

test('免费引擎与 Ollama 在注册表里确实声明不需要密钥', () => {
	const byId = new Map(listProviders().map(p => [p.id, p]));
	for (const id of ['bing-free', 'google-free', 'ollama']) {
		assert.equal(byId.get(id)?.requiresApiKey, false, `${id} 不应要求密钥`);
	}
	// 对照:真正需要密钥的引擎不得被误伤
	for (const id of ['gemini', 'anthropic', 'openai', 'deepl']) {
		assert.equal(byId.get(id)?.requiresApiKey, true, `${id} 应要求密钥`);
	}
});

test('A: 密钥区有可显隐的 id, 且按 requiresApiKey 隐藏', () => {
	assert.ok(/id="papermirror-apikey-section"/.test(xhtml), '密钥区需要 id 才能显隐');
	assert.ok(/function syncApiKeyVisibility/.test(prefsSrc), '需要显隐函数');
	assert.ok(/requiresApiKey/.test(prefsSrc), '显隐必须依据 requiresApiKey');
	const fn = prefsSrc.slice(prefsSrc.indexOf('function syncApiKeyVisibility'), prefsSrc.indexOf('async function loadApiKey'));
	assert.ok(/papermirror-apikey-section/.test(fn) && /display/.test(fn), '必须真的改该节的 display');
});

test('B: loadApiKey 有陈旧写入闸(代次 + 归属双判)', () => {
	const start = prefsSrc.indexOf('async function loadApiKey');
	const end = prefsSrc.indexOf('const commitApiKey');
	assert.ok(start > 0 && end > start);
	const body = prefsSrc.slice(start, end);
	assert.ok(/apiKeyLoadToken/.test(body), '需要载入代次');
	assert.ok(/token !== apiKeyLoadToken/.test(body), '写回前必须比对代次');
	assert.ok(/provider !== currentProviderId\(\)/.test(body), '写回前必须比对服务商');
	// 写回必须发生在闸之后
	assert.ok(body.indexOf('token !== apiKeyLoadToken') < body.lastIndexOf('apiKeyInput.value = value'),
		'陈旧闸必须在写回输入框之前');
});

test('C: commitApiKey 只在归属相符时保存(绝不把 A 的密钥存到 B 名下)', () => {
	const start = prefsSrc.indexOf('const commitApiKey');
	const body = prefsSrc.slice(start, start + 900);
	assert.ok(/apiKeyOwner !== provider/.test(body), '保存前必须校验归属');
	assert.ok(body.indexOf('apiKeyOwner !== provider') < body.indexOf('setApiKey'),
		'归属校验必须早于 setApiKey');
	assert.ok(/return;/.test(body.slice(0, body.indexOf('setApiKey'))), '归属不符必须直接返回');
});

test('免费引擎路径下 owner 被清空, 使后续提交不会误写', () => {
	const start = prefsSrc.indexOf('async function loadApiKey');
	const body = prefsSrc.slice(start, prefsSrc.indexOf('const commitApiKey'));
	assert.ok(/apiKeyOwner = null/.test(body), '不需要密钥时必须解除归属');
});
