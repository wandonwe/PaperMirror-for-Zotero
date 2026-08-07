# PaperMirror for Zotero · 中英对照双屏阅读

**Zotero 双语阅读器** — a bilingual, side-by-side reading mode for the built-in
Zotero PDF reader. The left pane keeps Zotero's native PDF; the right pane shows
a structured, paragraph-aligned translation with synchronized scrolling.

```
┌──────────────────────┬──────────────────────┐
│ Zotero 原始 PDF      │ 对应段落的翻译       │
│ Abstract             │ 摘要                 │
│ This study aims...   │ 本研究旨在……         │
│ Methods              │ 方法                 │
│ We retrospectively...│ 我们回顾性地……       │
└──────────────────────┴──────────────────────┘
```

- **Plugin ID:** `zotero-bilingual-reader@local`
- **Version:** 0.1.0
- **Target:** Zotero 9.0.x (baseline 9.0.6), macOS / Windows / Linux
- **License:** AGPL-3.0-or-later
- **BYOK:** bring your own API key. No developer keys are bundled or shared.

---

## What works in this MVP

- A **中英对照** toggle button in the PDF reader toolbar (tab readers).
- Left = native Zotero PDF, right = per-paragraph translation.
- Automatic direction: **Chinese → English**, everything else **→ 简体中文**
  (overridable in settings).
- Structured extraction from text-layer PDFs: paragraph merging, de-hyphenation,
  two-column ordering, header/footer/page-number removal, heading & caption
  detection, formula protection, and a References stop (opt-in to translate).
- **Lazy per-page translation** with prefetch (prev 1 / next 2), max 2
  concurrent requests, retry with exponential backoff, cancellation on fast
  page flips, and missing-block re-requests.
- Providers: **Bing/Microsoft free** (default — no API key needed, reachable
  from mainland China), **Google Translate free** (no key), plus one-click
  presets inspired by [Read Frog](https://github.com/mengxi-ream/read-frog):
  **DeepSeek, Kimi (Moonshot), 通义千问 Qwen, 智谱 GLM, Gemini, OpenRouter,
  SiliconFlow, Groq, Ollama (local, no key)** — and **Anthropic**, **OpenAI**,
  **OpenAI-compatible**, **DeepL**, **custom HTTP endpoint**. The free engines
  are ported from
  [old-immersive-translate](https://github.com/immersive-translate/old-immersive-translate)
  (Bing session-token flow and the Google `translate_a/t` + tk-hash endpoint).
- **选中句子深度讲解 (Deep explanation)**, Read Frog-style: select text in the
  PDF (a 「讲解」 button appears in the selection popup, or use the pane
  toolbar) and the configured LLM produces a structured explanation — full
  translation, key terms with field-specific meanings, syntax analysis, and
  abbreviation expansion. Requires an LLM provider; the free MT engines can't
  explain.
- Immersive-translate-style reading pane: flowing article layout, and a
  **对照 (Show original)** toggle that displays the muted original text above
  each translated paragraph.
- **Persistent local cache** keyed by file hash + page + languages + provider +
  model + prompt version + source-text hash (atomic writes; auto-invalidation).
- Adjustable, remembered split ratio (default 55/45); side swap; sync-scroll
  toggle; copy translation / copy original+translation; **save to a Zotero child
  note**.
- A dedicated preferences pane with a **Test connection** button, glossary
  editor (import/export), and cache management.
- Localized UI (en-US / zh-CN / zh-TW) via Fluent.
- Full teardown: disabling or uninstalling the plugin restores the reader with
  no Zotero restart; no listeners, timers, requests, or observers leak.

Scanned/image-only PDFs show a clear **"needs OCR"** notice rather than a blank
pane or fabricated text. OCR, table reconstruction, and batch translation are
future work.

---

## Install

### From the packaged XPI (users)

1. Download `dist/zotero-bilingual-reader-0.1.0.xpi`.
2. In Zotero 9: **Tools → Plugins → gear icon → Install Plugin From File…**
3. Select the `.xpi`. Open a PDF, then click the **译 / 中英对照** button in the
   reader toolbar.
4. First use shows a privacy notice and (if unconfigured) prompts you to add an
   API key in **Settings → PaperMirror**.

### Configure a provider

Out of the box no configuration is needed: the default engine is the **free
Bing translator** (no API key). For LLM-quality translation, open
**Zotero Settings → PaperMirror**:

- **Provider:** Anthropic / OpenAI / OpenAI-compatible / DeepL / Custom.
- **API Base URL:** leave blank to use the provider default, or point to your
  gateway / self-hosted endpoint.
- **API Key:** stored in the OS credential store (Mozilla Login Manager), never
  in prefs, cache, logs, or exports.
- **Model:** e.g. `claude-sonnet-4-5`, `gpt-4o-mini`, or your own.
- Click **Test connection** — it sends a single fixed probe and reports HTTP
  status, model availability, and latency.

---

## Develop

Requirements: Node 18+ (used for tooling only — the shipped XPI has **no**
runtime dependencies).

```bash
npm install
npm run typecheck        # tsc --noEmit over src/ (strict mode)
npm test                 # typechecks tests + runs unit & integration tests
npm run build            # esbuild bundle -> build/addon/ (XPI layout)
npm run package          # build + zip -> dist/zotero-bilingual-reader-<ver>.xpi
```

### Live-reload development install

```bash
npm run build
node scripts/dev-install.mjs /path/to/Zotero/Profile   # writes a proxy file
# start Zotero with -purgecaches; rebuild + restart to pick up changes
```

The proxy file points Zotero at `build/addon/`, so you only rebuild and restart
(no repacking).

### Project layout

```
zotero-bilingual-reader/
├── manifest.json          # manifest_version 2, zotero strict_min/max 9.0 / 9.0.*
├── bootstrap.js           # startup/shutdown/onMainWindow* -> loads content/index.js
├── prefs.js               # default preferences
├── updates.json           # update manifest
├── src/
│   ├── index.ts               # bundle entry; exposes PaperMirrorBundle
│   ├── lifecycle/             # startup, shutdown registry, window manager
│   ├── reader/
│   │   ├── zoteroReaderAdapter.ts  # ⚠ ONLY file touching undocumented Reader internals
│   │   ├── readerToolbar.ts        # renderToolbar button + session management
│   │   ├── readerSession.ts        # per-tab orchestration
│   │   ├── splitView.ts            # DOM split + draggable divider (+ restore)
│   │   ├── textExtractor.ts        # getPageData -> blocks, with fallback
│   │   ├── blockBuilder.ts         # pure: chars -> SourceBlocks
│   │   ├── formulaGuard.ts         # pure: protect/restore formulas
│   │   └── scrollSynchronizer.ts   # pure: sync + loop guard
│   ├── translation/
│   │   ├── translationManager.ts   # lazy pages, prefetch, retry, cache
│   │   ├── requestScheduler.ts     # concurrency 2, backoff, cancel
│   │   ├── segmenter.ts, promptBuilder.ts, responseValidator.ts, glossary.ts, errors.ts
│   │   └── providers/              # anthropic, openai(-compatible), deepl, custom, registry
│   ├── cache/                 # atomic file cache + schema/keys
│   ├── notes/                 # child-note builder (escaped HTML only)
│   ├── security/              # credentialStore (Login Manager), logSanitizer
│   ├── preferences/           # preferences.xhtml + preferences.ts
│   ├── ui/                    # translationPane (text-node rendering) + styles
│   └── utils/                 # prefs, logger, l10n, language detector, throttle
├── locale/{en-US,zh-CN,zh-TW}/papermirror.ftl
├── tests/{unit,integration,fixtures}/
└── scripts/{build,package,test,dev-install}.mjs
```

### Zotero interfaces used (verified against 9.0.6, tag `eabf364`)

All undocumented reader internals are isolated in `zoteroReaderAdapter.ts`:

- `Zotero.Reader.registerEventListener('renderToolbar', handler, pluginID)` —
  the `pluginID` is **required** because 9.0.6's `unregisterEventListener` has
  an inverted filter; Zotero instead removes listeners by `pluginID` on plugin
  shutdown (`Reader` ctor `Zotero.Plugins.addObserver({ shutdown })`).
- `ReaderTab._tabContainer / _iframe / _iframeWindow / _internalReader / tabID`,
  and `reader.navigate({ pageIndex })`.
- `_internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument`
  `.getPageData({ pageIndex })` — Zotero's PDF.js fork, returning reading-order
  `chars` with `rect / fontName / fontSize / spaceAfter / lineBreakAfter /`
  `paragraphBreakAfter / ignorable`. `Zotero.PDFWorker.getFullText` is the
  fallback path.
- `_internalReader._state.primaryViewState.pageIndex` for the current page
  (polled at 350 ms; falls back to `getAttachmentLastPageIndex()`).
- `Zotero.Notifier` (`tab` close), `Zotero.PreferencePanes.register`,
  `Services.logins`, plugin `prefs.js`, and auto-registered Fluent locales.

If any of these change, the adapter throws `READER_API_CHANGED` and the feature
degrades gracefully instead of breaking the reader.

---

## Privacy & security

- **BYOK / no telemetry.** Text is sent only to the provider you configure; the
  pane shows the exact destination host. No Zotero database, account data, or
  unrelated metadata is uploaded.
- **API keys** live in the OS credential store; they are never written to prefs
  (except an explicit fallback if the Login Manager is unavailable), logs,
  cache, or notes. The log sanitizer redacts keys/authorization headers from
  everything that is logged; full document text and translations are not logged
  by default.
- **HTTPS enforced** for custom endpoints unless you explicitly allow HTTP; a
  **local-only** mode refuses non-localhost destinations.
- Translations are rendered as **text nodes** and notes are built from **escaped
  HTML** — model output is never executed as HTML/JS.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No **中英对照** button | Only appears in **tab** readers (not standalone reader windows) and only for PDFs. Reopen the PDF as a tab. |
| "This PDF needs OCR" | The PDF has no text layer. OCR it first (OCR support is planned). |
| "No API key configured" | Add a key in **Settings → PaperMirror**; click **Test connection**. |
| "API key was rejected" (HTTP 401/403) | Wrong key or wrong provider selected. |
| "model not found" (HTTP 404/400) | Fix the model name or Base URL. |
| Rate-limited (HTTP 429) | The plugin retries with backoff automatically; reduce concurrency if persistent. |
| Translations look stale after editing the PDF | The file hash changed, so the cache self-invalidates; if needed use **Re-translate** or clear the cache in settings. |
| Insecure-HTTP blocked | Enable **Allow HTTP endpoint** in Advanced (not recommended). |
| Enable debug logs | **Settings → Advanced → Enable debug logging** (never logs keys or full text). |

---

## Known limitations

- Text-layer PDFs only in the MVP; **no OCR** yet (scanned PDFs are detected and
  reported).
- No table reconstruction; tables are treated as text blocks.
- Standalone reader **windows** are not supported (tab readers only).
- References are skipped by default; enable translation in settings.
- Page tracking uses a 350 ms poll of reader state (Zotero exposes no public
  page-change event), so sync may lag one tick on very fast scrolling.
- Encrypted PDFs are not processed.

## Next steps

OCR for scanned PDFs, coordinate-accurate original-side highlighting, table-aware
extraction, per-collection/per-item glossaries in the UI, batch pre-translation,
and a public page-change hook if Zotero adds one.
