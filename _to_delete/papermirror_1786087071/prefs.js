/* eslint-disable no-undef */
// Default preferences for PaperMirror for Zotero.
// Loaded by Zotero's plugin system into the default pref branch.
// All keys live under extensions.zotero.* so they are accessible via
// Zotero.Prefs.get('bilingualReader.<key>').

// Default: free Bing engine — works out of the box with no API key.
pref('extensions.zotero.bilingualReader.provider', 'bing-free');
pref('extensions.zotero.bilingualReader.apiBaseURL', '');
pref('extensions.zotero.bilingualReader.model', '');
pref('extensions.zotero.bilingualReader.sourceLanguage', 'auto');
pref('extensions.zotero.bilingualReader.targetLanguage', 'auto');
pref('extensions.zotero.bilingualReader.timeoutMs', 60000);
pref('extensions.zotero.bilingualReader.maxConcurrentRequests', 2);
pref('extensions.zotero.bilingualReader.customPrompt', '');
pref('extensions.zotero.bilingualReader.translateCaptions', true);
pref('extensions.zotero.bilingualReader.translateReferences', false);
pref('extensions.zotero.bilingualReader.useContext', true);
pref('extensions.zotero.bilingualReader.autoPrefetch', true);
pref('extensions.zotero.bilingualReader.paneRatio', 55);
pref('extensions.zotero.bilingualReader.paneSide', 'right');
pref('extensions.zotero.bilingualReader.syncScroll', true);
pref('extensions.zotero.bilingualReader.showOriginal', true);
pref('extensions.zotero.bilingualReader.articleFontSize', 16);
pref('extensions.zotero.bilingualReader.overlayEnabled', false);
pref('extensions.zotero.bilingualReader.debugLogging', false);
pref('extensions.zotero.bilingualReader.privacyNoticeAccepted', false);
pref('extensions.zotero.bilingualReader.allowHTTPEndpoint', false);
pref('extensions.zotero.bilingualReader.localOnlyMode', false);
pref('extensions.zotero.bilingualReader.glossaryGlobal', '[]');
pref('extensions.zotero.bilingualReader.promptVersion', 1);
// Fallback API key storage (used only when the Mozilla Login Manager is
// unavailable). Never logged, never exported with settings.
pref('extensions.zotero.bilingualReader.apiKeyFallback', '');
