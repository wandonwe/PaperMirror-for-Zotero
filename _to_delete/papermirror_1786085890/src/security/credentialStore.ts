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

async function findLogin(providerId: string): Promise<any | null> {
	const logins = await Services.logins.searchLoginsAsync({
		origin: ORIGIN,
		httpRealm: REALM
	});
	return logins.find((l: any) => l.username === providerId) ?? null;
}

export async function getApiKey(providerId: string): Promise<string> {
	try {
		const login = await findLogin(providerId);
		if (login) {
			registerSecret(login.password);
			return login.password;
		}
	}
	catch (e) {
		logger.warn(MODULE, 'Login Manager unavailable; using pref fallback', e);
	}
	const fallback = getPref<string>('apiKeyFallback', '');
	if (fallback) {
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
	return '';
}

export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
	registerSecret(apiKey);
	try {
		const existing = await findLogin(providerId);
		if (!apiKey) {
			if (existing) {
				Services.logins.removeLogin(existing);
			}
			return;
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
		return;
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
	}
	catch (e) {
		logger.error(MODULE, 'Failed to store API key', e);
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
	await setApiKey(providerId, '');
	clearFallbackKey(providerId);
}
