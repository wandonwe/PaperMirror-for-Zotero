/* eslint-disable no-undef */
// Default preferences for PaperMirror for Zotero.
// Loaded by Zotero's plugin system into the default pref branch.
// All keys live under extensions.zotero.* so they are accessible via
// Zotero.Prefs.get('bilingualReader.<key>').

// Default: free Bing engine — works out of the box with no API key.
pref('extensions.zotero.bilingualReader.provider', 'bing-free');
// Legacy GLOBAL Base URL / model (pre-0.9.3). Kept for one-time migration into
// per-provider profiles; the engine now reads providerProfiles instead.
pref('extensions.zotero.bilingualReader.apiBaseURL', '');
pref('extensions.zotero.bilingualReader.model', '');
// Per-provider config profiles (0.9.3): {providerId: {apiBaseUrl, model, customModel}}.
// Each provider keeps its OWN Base URL / model so nothing bleeds across providers.
pref('extensions.zotero.bilingualReader.providerProfiles', '{}');
// 0 until the one-time legacy-globals → current-provider migration has run.
pref('extensions.zotero.bilingualReader.providerConfigMigrated', false);
pref('extensions.zotero.bilingualReader.sourceLanguage', 'auto');
pref('extensions.zotero.bilingualReader.targetLanguage', 'auto');
pref('extensions.zotero.bilingualReader.timeoutMs', 60000);
pref('extensions.zotero.bilingualReader.maxConcurrentRequests', 12); // global page ceiling 1-24
pref('extensions.zotero.bilingualReader.perfMode', 'auto'); // stable | auto | high | custom
pref('extensions.zotero.bilingualReader.providerConcurrency', '{}'); // custom mode: {providerId: pages}
pref('extensions.zotero.bilingualReader.customPrompt', '');
pref('extensions.zotero.bilingualReader.translateCaptions', true);
pref('extensions.zotero.bilingualReader.translateReferences', false);
pref('extensions.zotero.bilingualReader.useContext', true);
pref('extensions.zotero.bilingualReader.autoPrefetch', true);
pref('extensions.zotero.bilingualReader.paneSide', 'right');
pref('extensions.zotero.bilingualReader.syncScroll', true);
// 整页对照下: 开启后掀开遮罩,直接看到原页文字
pref('extensions.zotero.bilingualReader.showOriginal', false);
pref('extensions.zotero.bilingualReader.articleFontSize', 16);
pref('extensions.zotero.bilingualReader.fontSizeFactor', '1');
pref('extensions.zotero.bilingualReader.lineHeightFactor', '1');
pref('extensions.zotero.bilingualReader.overlayEnabled', false);
// 工具栏三态切换器的最后状态: original | overlay | split
// 默认 split(左右对照): 左边原版 PDF, 右边版面级重排的整页译文。
// 覆盖模式(译文直接盖在原页上)在工具栏 ▾ 菜单里随时可切。
pref('extensions.zotero.bilingualReader.viewMode', 'split');
// 右侧面板呈现方式: page = 整页对照(默认, 版面级重排的整页译文,
// 左原文右译文), article = 结构化文章流(备选, 纯文本完整无删减)
pref('extensions.zotero.bilingualReader.paneView', 'page');
// 完整 PDF 翻译的本地桥接服务 (BabelDOC/pdf2zh), 仅允许 localhost
pref('extensions.zotero.bilingualReader.pdfServiceURL', 'http://127.0.0.1:11017');
// 译文PDF生成方式: builtin = 插件内置(默认, 无需任何外部依赖),
// service = 本地 BabelDOC 服务(完整版面重排, 需自行启动)
pref('extensions.zotero.bilingualReader.pdfExportMode', 'builtin');
// dim-original | translation-only | hover — 默认原文淡化:
// 译文遮罩半透明, 原文隐约可见, 对照阅读不需要任何操作
pref('extensions.zotero.bilingualReader.overlayDisplayMode', 'dim-original');
// strict | expand
pref('extensions.zotero.bilingualReader.overlayFitMode', 'expand');
// 覆盖模式下鼠标悬停在译文段落上时,掀开该段遮罩显示原文
pref('extensions.zotero.bilingualReader.overlayPeekHover', true);
// 架构迁移标记: 1 = 已迁移到覆盖渲染器默认值
pref('extensions.zotero.bilingualReader.layoutMigration', 0);
// 并行翻译服务商 (JSON 数组): 与主服务商轮流分担页面, 各自使用自己的密钥。
// 文本会被发送给列表中的每一家 — 仅在你明确勾选后生效。
pref('extensions.zotero.bilingualReader.parallelProviders', '[]');
pref('extensions.zotero.bilingualReader.debugLogging', false);
pref('extensions.zotero.bilingualReader.privacyNoticeAccepted', false);
pref('extensions.zotero.bilingualReader.allowHTTPEndpoint', false);
pref('extensions.zotero.bilingualReader.localOnlyMode', false);
pref('extensions.zotero.bilingualReader.glossaryGlobal', '[]');
pref('extensions.zotero.bilingualReader.promptVersion', 1);
// Fallback API key storage (used only when the Mozilla Login Manager is
// unavailable). Never logged, never exported with settings.
pref('extensions.zotero.bilingualReader.apiKeyFallback', '');
