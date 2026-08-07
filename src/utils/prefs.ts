/**
 * Typed access to plugin preferences.
 * All keys live under extensions.zotero.bilingualReader.*
 */

const NS = 'bilingualReader.';

export type PrefKey
	= 'provider'
	| 'apiBaseURL'
	| 'model'
	| 'sourceLanguage'
	| 'targetLanguage'
	| 'timeoutMs'
	| 'maxConcurrentRequests'
	| 'customPrompt'
	| 'translateCaptions'
	| 'translateReferences'
	| 'useContext'
	| 'autoPrefetch'
	| 'paneRatio'
	| 'paneSide'
	| 'syncScroll'
	| 'showOriginal'
	| 'viewMode'
	| 'paneView'
	| 'pdfServiceURL'
	| 'pdfExportMode'
	| 'articleFontSize'
	| 'overlayEnabled'
	| 'overlayDisplayMode'
	| 'overlayFitMode'
	| 'debugLogging'
	| 'privacyNoticeAccepted'
	| 'allowHTTPEndpoint'
	| 'localOnlyMode'
	| 'glossaryGlobal'
	| 'promptVersion'
	| 'apiKeyFallback';

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
