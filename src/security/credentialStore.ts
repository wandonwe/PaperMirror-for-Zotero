/**
 * API-key storage. Primary backend: Mozilla Login Manager (Services.logins),
 * so keys live in the platform credential store, not in plain prefs.
 * Fallback: a pref value (only when the Login Manager is unavailable),
 * clearly marked and never logged.
 */

import * as logger from '../utils/logger';
import { registerSecret } from './logSanitizer';
import { getPref, setPref, clearPref } from '../utils/prefs';

const MODULE = 'credentialStore';
const ORIGIN = 'chrome://zotero-bilingual-reader';
const REALM = 'PaperMirror API key';

function loginInfoContract(): any {
	return Components.classes['@mozilla.org/login-manager/loginInfo;1']
		.createInstance(Components.interfaces.nsILoginInfo);
}

/**
 * How long one Login Manager lookup may take before we stop waiting.
 *
 * searchLoginsAsync can hang indefinitely — most commonly when the credential
 * store is locked behind a primary password and the unlock prompt cannot be
 * shown from a background sandbox call. getApiKey sits on EVERY translation
 * request's path, so an unguarded hang here freezes the whole pipeline on
 * 「正在翻译…」 forever. On timeout we fall back to the pref-stored key.
 */
const LOGIN_LOOKUP_TIMEOUT_MS = 4000;

/**
 * Session cache: providerId -> resolved key. The Login Manager is consulted
 * once per provider per session instead of once per request — faster, and a
 * hang can cost at most one 4-second wait instead of one per page.
 */
const keyCache = new Map<string, string>();

class LoginLookupTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new LoginLookupTimeout(`Login Manager did not respond within ${ms} ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

async function findLogin(providerId: string): Promise<any | null> {
	const logins = await withTimeout(
		Services.logins.searchLoginsAsync({
			origin: ORIGIN,
			httpRealm: REALM
		}),
		LOGIN_LOOKUP_TIMEOUT_MS
	);
	return logins.find((l: any) => l.username === providerId) ?? null;
}

function fallbackKey(providerId: string): string {
	const fallback = getPref<string>('apiKeyFallback', '');
	if (!fallback) {
		return '';
	}
	try {
		const map = JSON.parse(fallback) as Record<string, string>;
		const key = map[providerId] ?? '';
		registerSecret(key);
		return key;
	}
	catch {
		return '';
	}
}

export async function getApiKey(providerId: string): Promise<string> {
	const cached = keyCache.get(providerId);
	if (cached !== undefined) {
		return cached;
	}
	let key = '';
	try {
		const login = await findLogin(providerId);
		if (login) {
			registerSecret(login.password);
			key = login.password;
		}
	}
	catch (e) {
		logger.warn(MODULE, 'Login Manager unavailable or timed out; using pref fallback', e);
	}
	if (!key) {
		key = fallbackKey(providerId);
	}
	// Cache even an empty result: a locked credential store should cost one
	// 4-second wait per provider, not one per translated page.
	keyCache.set(providerId, key);
	return key;
}

/**
 * setApiKey 的落库结果 (2.0.5, 审核 P2-18):
 *  - 'secure'    密钥进了系统凭据库 (Login Manager);
 *  - 'plaintext' 凭据库不可用,密钥**明文**写进了首选项 (prefs.js) —— 会随
 *                profile 备份/同步外流,调用方(设置界面)必须显式告知用户;
 *  - 'failed'    两条路都失败,密钥没有被保存;
 *  - 'removed'   请求的是删除(空密钥)。
 * 此前所有路径都静默返回 void,明文回退唯一的痕迹是一条 logger.warn。
 */
export type ApiKeyStoreResult = 'secure' | 'plaintext' | 'failed' | 'removed';

export async function setApiKey(providerId: string, apiKey: string): Promise<ApiKeyStoreResult> {
	registerSecret(apiKey);
	// The session cache must never serve a stale key after a change.
	keyCache.delete(providerId);
	try {
		const existing = await findLogin(providerId);
		if (!apiKey) {
			if (existing) {
				Services.logins.removeLogin(existing);
			}
			// 明文回退副本一并清 (2.0.7, 审核 P2-7): 密钥曾因凭据库不可用落进
			// apiKeyFallback,凭据库恢复后用户清空密钥走到这里 —— 此前直接
			// return,明文留在 prefs.js 随备份/同步外流,且 getApiKey 回退读
			// 它,被「删除」的密钥继续被请求使用,UI 却显示删除成功。
			clearFallbackKey(providerId);
			return 'removed';
		}
		if (existing) {
			const updated = loginInfoContract();
			updated.init(ORIGIN, null, REALM, providerId, apiKey, '', '');
			Services.logins.modifyLogin(existing, updated);
		}
		else {
			const login = loginInfoContract();
			login.init(ORIGIN, null, REALM, providerId, apiKey, '', '');
			await Services.logins.addLoginAsync(login);
		}
		// Successful secure storage: make sure no fallback copy remains
		clearFallbackKey(providerId);
		return 'secure';
	}
	catch (e) {
		logger.warn(MODULE, 'Login Manager write failed; using pref fallback', e);
	}
	// Fallback path
	try {
		const raw = getPref<string>('apiKeyFallback', '');
		const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
		if (apiKey) {
			map[providerId] = apiKey;
		}
		else {
			delete map[providerId];
		}
		setPref('apiKeyFallback', JSON.stringify(map));
		return apiKey ? 'plaintext' : 'removed';
	}
	catch (e) {
		logger.error(MODULE, 'Failed to store API key', e);
		return 'failed';
	}
}

function clearFallbackKey(providerId: string): void {
	try {
		const raw = getPref<string>('apiKeyFallback', '');
		if (!raw) {
			return;
		}
		const map = JSON.parse(raw) as Record<string, string>;
		if (providerId in map) {
			delete map[providerId];
			if (Object.keys(map).length) {
				setPref('apiKeyFallback', JSON.stringify(map));
			}
			else {
				clearPref('apiKeyFallback');
			}
		}
	}
	catch {
		// ignore
	}
}

export async function deleteApiKey(providerId: string): Promise<void> {
	keyCache.delete(providerId);
	await setApiKey(providerId, '');
	clearFallbackKey(providerId);
}
