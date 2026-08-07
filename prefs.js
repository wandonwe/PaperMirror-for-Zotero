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
// 50/50: 对照翻译下两页大小一致,分隔条可手动调节
pref('extensions.zotero.bilingualReader.paneRatio', 50);
pref('extensions.zotero.bilingualReader.paneSide', 'right');
pref('extensions.zotero.bilingualReader.syncScroll', true);
// 整页对照下: 开启后掀开遮罩,直接看到原页文字
pref('extensions.zotero.bilingualReader.showOriginal', false);
pref('extensions.zotero.bilingualReader.articleFontSize', 16);
pref('extensions.zotero.bilingualReader.overlayEnabled', false);
// 工具栏三态切换器的最后状态: original | overlay | split
pref('extensions.zotero.bilingualReader.viewMode', 'split');
// 右侧面板呈现方式: page = 整页对照(默认, 译文覆盖在原版排版上),
// article = 结构化文章流(备选)
pref('extensions.zotero.bilingualReader.paneView', 'page');
// 完整 PDF 翻译的本地桥接服务 (BabelDOC/pdf2zh), 仅允许 localhost
pref('extensions.zotero.bilingualReader.pdfServiceURL', 'http://127.0.0.1:11017');
// 译文PDF生成方式: builtin = 插件内置(默认, 无需任何外部依赖),
// service = 本地 BabelDOC 服务(完整版面重排, 需自行启动)
pref('extensions.zotero.bilingualReader.pdfExportMode', 'builtin');
// dim-original | translation-only | hover
pref('extensions.zotero.bilingualReader.overlayDisplayMode', 'translation-only');
// strict | expand
pref('extensions.zotero.bilingualReader.overlayFitMode', 'expand');
pref('extensions.zotero.bilingualReader.debugLogging', false);
pref('extensions.zotero.bilingualReader.privacyNoticeAccepted', false);
pref('extensions.zotero.bilingualReader.allowHTTPEndpoint', false);
pref('extensions.zotero.bilingualReader.localOnlyMode', false);
pref('extensions.zotero.bilingualReader.glossaryGlobal', '[]');
pref('extensions.zotero.bilingualReader.promptVersion', 1);
// Fallback API key storage (used only when the Mozilla Login Manager is
// unavailable). Never logged, never exported with settings.
pref('extensions.zotero.bilingualReader.apiKeyFallback', '');
