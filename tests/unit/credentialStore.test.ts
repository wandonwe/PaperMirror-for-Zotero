import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * P2-18 (2.0.5): 登录管理器写入失败时,密钥明文落进首选项曾**完全静默**
 * (唯一痕迹是一条 logger.warn,UI 零提示)。setApiKey 现在向调用方报告
 * 落库结果 —— 'secure' | 'plaintext' | 'failed' | 'removed' —— 设置界面据此
 * 显式告知用户「密钥已明文保存」。本文件驱动真实的 credentialStore,
 * 只 mock 平台层 (Services.logins / Zotero.Prefs / Components)。
 */

function installPlatform(opts: { loginWriteFails?: boolean; prefWriteFails?: boolean }): {
	prefs: Map<string, unknown>;
	logins: { username: string; password: string }[];
	teardown: () => void;
} {
	const prefs = new Map<string, unknown>();
	const logins: { username: string; password: string }[] = [];
	(globalThis as Record<string, any>).Zotero = {
		Prefs: {
			get: (k: string) => prefs.get(k),
			set: (k: string, v: unknown) => {
				if (opts.prefWriteFails) {
					throw new Error('pref storage broken');
				}
				prefs.set(k, v);
			},
			clear: (k: string) => { prefs.delete(k); }
		}
	};
	(globalThis as Record<string, any>).Services = {
		logins: {
			searchLoginsAsync: async () => logins.slice(),
			addLoginAsync: async (login: any) => {
				if (opts.loginWriteFails) {
					throw new Error('MASTER_PASSWORD_LOCKED');
				}
				logins.push({ username: login.username, password: login.password });
			},
			modifyLogin: (_old: any, updated: any) => {
				if (opts.loginWriteFails) {
					throw new Error('MASTER_PASSWORD_LOCKED');
				}
				const i = logins.findIndex(l => l.username === updated.username);
				if (i >= 0) {
					logins[i] = { username: updated.username, password: updated.password };
				}
			},
			removeLogin: (login: any) => {
				const i = logins.findIndex(l => l.username === login.username);
				if (i >= 0) {
					logins.splice(i, 1);
				}
			}
		}
	};
	(globalThis as Record<string, any>).Components = {
		classes: {
			'@mozilla.org/login-manager/loginInfo;1': {
				createInstance: () => ({
					init(_origin: string, _formOrigin: unknown, _realm: string, username: string, password: string) {
						(this as any).username = username;
						(this as any).password = password;
					}
				})
			}
		},
		interfaces: { nsILoginInfo: {} }
	};
	return {
		prefs,
		logins,
		teardown: () => {
			delete (globalThis as Record<string, any>).Zotero;
			delete (globalThis as Record<string, any>).Services;
			delete (globalThis as Record<string, any>).Components;
		}
	};
}

test('凭据库可用 → secure,且不留明文回退副本', async () => {
	const p = installPlatform({});
	try {
		const { setApiKey, getApiKey } = await import('../../src/security/credentialStore');
		const result = await setApiKey('openai', 'sk-test-secure-1');
		assert.equal(result, 'secure');
		assert.equal(p.logins.length, 1, '密钥进了登录管理器');
		assert.equal(p.prefs.has('bilingualReader.apiKeyFallback'), false, '不得留明文副本');
		assert.equal(await getApiKey('openai'), 'sk-test-secure-1');
	}
	finally { p.teardown(); }
});

test('凭据库写入失败 → 明文回退,且**必须**返回 plaintext 供 UI 告知', async () => {
	const p = installPlatform({ loginWriteFails: true });
	try {
		const { setApiKey } = await import('../../src/security/credentialStore');
		const result = await setApiKey('gemini', 'AIza-test-fallback-2');
		assert.equal(result, 'plaintext', '明文落库绝不能对调用方静默');
		const raw = String(p.prefs.get('bilingualReader.apiKeyFallback') ?? '');
		assert.equal((JSON.parse(raw) as Record<string, string>)['gemini'], 'AIza-test-fallback-2');
	}
	finally { p.teardown(); }
});

test('两条路都失败 → failed(密钥没有被保存,UI 必须知道)', async () => {
	const p = installPlatform({ loginWriteFails: true, prefWriteFails: true });
	try {
		const { setApiKey } = await import('../../src/security/credentialStore');
		const result = await setApiKey('anthropic', 'sk-ant-test-3');
		assert.equal(result, 'failed');
	}
	finally { p.teardown(); }
});

test('空密钥 = 删除 → removed', async () => {
	const p = installPlatform({});
	try {
		const { setApiKey } = await import('../../src/security/credentialStore');
		await setApiKey('openai', 'sk-will-be-removed');
		const result = await setApiKey('openai', '');
		assert.equal(result, 'removed');
		assert.equal(p.logins.length, 0);
	}
	finally { p.teardown(); }
});

test('P2-7 (2.0.7): 凭据库恢复后删除密钥,明文回退副本必须一并清除', async () => {
	// 第一阶段: 凭据库坏 → 密钥明文落进 prefs。
	const p1 = installPlatform({ loginWriteFails: true });
	let prefs: Map<string, unknown>;
	try {
		const { setApiKey } = await import('../../src/security/credentialStore');
		assert.equal(await setApiKey('deepl', 'dl-key-fallback'), 'plaintext');
		prefs = p1.prefs;
		assert.ok(String(prefs.get('bilingualReader.apiKeyFallback')).includes('dl-key-fallback'));
	}
	finally { p1.teardown(); }
	// 第二阶段: 凭据库恢复(登录管理器无该项)→ 用户清空密钥。
	const p2 = installPlatform({});
	try {
		// 延续第一阶段的 prefs 内容。
		for (const [k, v] of prefs!) {
			p2.prefs.set(k, v);
		}
		const { setApiKey, getApiKey } = await import('../../src/security/credentialStore');
		assert.equal(await setApiKey('deepl', ''), 'removed');
		const raw = String(p2.prefs.get('bilingualReader.apiKeyFallback') ?? '');
		assert.ok(!raw.includes('dl-key-fallback'),
			'被删除的密钥绝不能留在 prefs.js 明文回退里 —— 它会随备份/同步外流且继续被请求使用');
		assert.equal(await getApiKey('deepl'), '', '删除后任何路径都不得再返回该密钥');
	}
	finally { p2.teardown(); }
});
