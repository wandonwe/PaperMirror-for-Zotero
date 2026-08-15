/**
 * Typed access to plugin preferences.
 * All keys live under extensions.zotero.bilingualReader.*
 */

const NS = 'bilingualReader.';

export type PrefKey
	= 'provider'
	| 'apiBaseURL'
	| 'model'
	| 'providerProfiles'
	| 'providerConfigMigrated'
	| 'sourceLanguage'
	| 'targetLanguage'
	| 'timeoutMs'
	| 'maxConcurrentRequests'
	| 'perfMode'
	| 'providerConcurrency'
	| 'customPrompt'
	| 'translateCaptions'
	| 'translateReferences'
	| 'useContext'
	| 'autoPrefetch'
	| 'paneSide'
	| 'syncScroll'
	| 'showOriginal'
	| 'viewMode'
	| 'paneView'
	| 'pdfServiceURL'
	| 'pdfExportMode'
	| 'articleFontSize'
	| 'fontSizeFactor'
	| 'lineHeightFactor'
	| 'noTranslateList'
	| 'overlayEnabled'
	| 'overlayDisplayMode'
	| 'overlayFitMode'
	| 'overlayPeekHover'
	| 'debugLogging'
	| 'privacyNoticeAccepted'
	| 'allowHTTPEndpoint'
	| 'localOnlyMode'
	| 'glossaryGlobal'
	| 'promptVersion'
	| 'apiKeyFallback'
	| 'parallelProviders'
	| 'layoutMigration';

export function getPref<T = unknown>(key: PrefKey, fallback?: T): T {
	try {
		const value = Zotero.Prefs.get(NS + key);
		if (value === undefined || value === null) {
			return fallback as T;
		}
		return value as T;
	}
	catch {
		return fallback as T;
	}
}

export function setPref(key: PrefKey, value: unknown): void {
	Zotero.Prefs.set(NS + key, value as never);
}

export function clearPref(key: PrefKey): void {
	try {
		Zotero.Prefs.clear(NS + key);
	}
	catch {
		// ignore
	}
}

export function registerPrefObserver(key: PrefKey, handler: (value: unknown) => void): symbol | string {
	return Zotero.Prefs.registerObserver(NS + key, handler);
}

export function unregisterPrefObserver(id: symbol | string): void {
	Zotero.Prefs.unregisterObserver(id);
}

/**
 * Drive a boolean-pref-gated side effect (1.1.10): call `apply` once with the
 * pref's current value, then again on every change, and return a cleanup that
 * unregisters the observer. Used to show/hide the 「诊断」 button in step with
 * the debugLogging pref, but pref-key agnostic. Observer registration failure
 * is non-fatal — the initial `apply` has already run — so a missing Prefs API
 * (e.g. a stripped test env) degrades to a one-shot read, never a throw.
 */
export function observeBoolPref(key: PrefKey, apply: (on: boolean) => void): () => void {
	apply(getPref<boolean>(key, false));
	let id: symbol | string | null = null;
	try {
		id = registerPrefObserver(key, value => apply(!!value));
	}
	catch {
		id = null;
	}
	return () => {
		if (id !== null) {
			try {
				unregisterPrefObserver(id);
			}
			catch { /* best-effort */ }
			id = null;
		}
	};
}
