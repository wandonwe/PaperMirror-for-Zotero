# Changelog

All notable changes to PaperMirror for Zotero are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays below `1.0.0`, the reading UI is still settling and
minor releases may change defaults.

## [Unreleased]

## [0.4.3] — 2026-08-08

### Changed

- **The 翻译服务 picker now shows the real, official brand marks.** The
  hand-drawn approximations are replaced by the services' actual vector
  logos (vendored from the MIT-licensed lobe-icons set): Microsoft's four
  squares, Google's G, OpenAI's knot, Claude's coral starburst, Gemini's
  gradient star, DeepSeek's whale, DeepL, Kimi's K + blue dot, 通义千问,
  智谱, SiliconFlow, Groq, Ollama and OpenRouter. Monochrome marks follow
  the pane's text colour so they stay visible in dark mode; the drawn
  glyphs survive only as a parse-failure fallback. OpenAI-compatible and
  Custom HTTP keep the neutral globe — generic endpoints have no brand.

## [0.4.2] — 2026-08-08

### Fixed

- CI/release builds failed on Node 20: the test runner passed a
  `build/tests/**/*.test.mjs` glob to `node --test`, but Node only expands
  test globs itself from v21 — on 20 the literal pattern "could not be
  found" and the release workflow died before publishing. The runner now
  lists the compiled test files explicitly, which works on every Node
  version. (v0.4.1 never got a published release because of this; 0.4.2 is
  the first tag the workflow publishes.)

## [0.4.1] — 2026-08-08

### Changed

- **解析 moved into the 译文面板 menu bar.** The floating selection chip is
  gone — it fought the reader's selection events and never behaved reliably.
  In its place, a fixed 「✦ 解析」 button sits in the pane's top bar next to
  保存到笔记: select text in the PDF (or click a 译文 paragraph) and press it.
  With nothing selected it shows the "select text first" hint. The 划词解析按钮
  setting was removed along with the chip.

## [0.4.0] — 2026-08-08

The 0.4 line is the first prepared for public GitHub distribution.

### Added

- **Automatic updates from GitHub.** The manifest now points Zotero at
  `updates.json` on the repository's main branch, and the release workflow
  regenerates that file — with the release's sha256 — on every tag. Once a
  user has any v0.4.0+ build installed, Zotero downloads and installs each new
  release on its own; no manual `.xpi` re-install. `scripts/gen-updates.mjs`
  produces the manifest, and the CI tag build publishes the release and commits
  the pointer back to main.

### Fixed

- **划词解析 chip never disappeared.** Its `#id` style rule out-specified the
  UA `[hidden]` rule, so hiding it had no visual effect — it now hides through
  a dedicated attribute and reliably auto-dismisses.
- **Clicking the 解析 chip did nothing.** A stray document-level mousedown
  cleared the captured text before the click ran; the click now also falls
  back to the live selection, and an over-chip guard stops the mousedown from
  dismissing the chip mid-interaction. The idle auto-hide now runs on the
  plugin's own timer rather than through the content window.

## [0.3.11] — 2026-08-08

### Fixed

- The 划词解析 chip no longer lingers on the page. It now auto-hides after a
  few idle seconds (the countdown pauses while the pointer is over it and
  restarts, shorter, when the pointer leaves), on top of the existing
  hide-on-click-elsewhere / scroll / empty-selection paths — so it is never
  left showing over the document.

### Changed

- The mode caret beside the 翻译 toolbar icon is now a crisp stroked chevron
  icon instead of the text "▾" (which rendered as a small off-centre glyph).
  It shares the icon button's sizing, tracks an open/pressed state, and the
  menu's single close path keeps the caret state in sync.

## [0.3.10] — 2026-08-08

### Fixed

- The 划词解析 chip now hides the instant the selection collapses. A
  `selectionchange` listener is the authoritative "nothing selected → hidden"
  signal (mouse-up only ever shows it), so the button is present only while
  text is actually selected and never lingers on the page.

### Changed

- Removed the explanatory sub-line under the 划词解析按钮 setting; the
  checkbox label alone is enough.

## [0.3.9] — 2026-08-08

### Changed

- **划词解析 no longer lives in Zotero's shared selection popup.** The button
  that appeared among the highlight swatches (where every translation/note
  plugin competes for space and order) has been removed. Selecting text in
  the PDF now floats our own standalone 「解析」 chip just under the selection —
  it belongs to no shared surface, so nothing else can push it around. It
  hides on the next click, scroll, or empty selection.
- 讲解 renamed to **解析** throughout the UI.

### Added

- 阅读界面 settings gain a **划词解析按钮** toggle (default on). Turn it off
  and the selection chip disappears entirely; 解析 is still available by
  double-clicking a paragraph in the 译文 pane. The toggle applies to every
  open reader immediately.

## [0.3.8] — 2026-08-08

### Changed

- The Anthropic entry in the 翻译服务 picker now shows the company's radial
  burst mark instead of a plain "A" tile, so every provider row carries its
  real brand symbol. (The OpenAI-compatible and Custom HTTP entries keep a
  neutral globe on purpose — they are generic endpoints with no brand.)

## [0.3.7] — 2026-08-08

### Fixed

- **Clicking translated text destroyed the layout.** A single click on a
  paragraph in the 译文 pane ran 深度讲解, jumped the pane to the top of the
  document AND navigated the PDF — and could leave the split collapsed with
  the reader unreachable until the tab was closed. A single click now only
  moves the focus highlight; 深度讲解 is a deliberate **double-click**.
- **Split-view watchdog.** Zotero occasionally rewrites the reader browser's
  inline styles (navigation, theme changes), erasing the split's pixel
  pinning — the reader then collapsed to its minimum and the pane swallowed
  the whole tab. The layout poll now detects the drift and re-pins within
  ~350 ms, and the pane additionally carries a hard `max-width` so it can
  never take the reader's half even if the pinning is lost.

### Changed

- 深度讲解 card no longer scrolls the pane to the document top. It floats
  over the pane's lower edge, the document behind it never moves, and Esc
  (or ×) dismisses it.

## [0.3.6] — 2026-08-08

### Fixed

- **Mixed-language pages (中英混排).** LLM providers sometimes drop block ids
  from a batched response; the manager retried the missing ids once as a
  batch and then silently gave up, leaving those regions untranslated —
  English paragraphs interleaved with Chinese ones in a single column (the
  JACC report). Ids still missing after the batch retry are now salvaged one
  request per block (a single-block answer cannot misalign, and the
  translation is accepted even when the model rewrites the id), capped at 8
  per chunk.
- A page that still has untranslated blocks after salvage is no longer
  written to the cache: previously the partial page was cached and every
  revisit re-served the mixed rendering forever. Left uncached, the next
  visit — or 重新翻译 — runs the whole pipeline again and completes it.

## [0.3.5] — 2026-08-08

### Fixed

- Gemini answered 404/INVALID_MODEL: the preset's default model
  `gemini-2.0-flash` was retired upstream. The preset now defaults to
  `gemini-2.5-flash`, and a stored auto-filled `gemini-2.0-flash` is cleared
  once at startup so the new default applies.
- The provider-pool list rendered once at pane load, so a key saved a minute
  later — or a provider switch — left every LLM row stuck on 「未配置密钥」
  and the just-configured provider still listed. The list re-renders when
  the primary provider changes and after a key is saved.

## [0.3.4] — 2026-08-07

### Added

- **多服务商并行 (provider pool).** Settings gains a 性能与并行 section: check
  any additional configured services and the document's pages are dealt
  round-robin between the primary and every checked provider, each using its
  own key. Throughput multiplies by the number of independent services
  without touching any single provider's rate limits. Sharding is by page
  and deterministic, so each page's cache entry stays with its provider.
  Providers without a stored key are skipped (and shown disabled). The
  section states plainly that text is sent to every checked service.
- 并发请求数 returns to settings (1–6). Key-based providers may run up to 6
  page requests in flight; the free engines stay clamped at 2 internally.

### Notes

- Multi-key rotation on a SINGLE provider is deliberately not offered:
  extra keys of one account share that account's limits, and using multiple
  accounts to evade limits violates provider terms.

## [0.3.3] — 2026-08-07

### Fixed

- The free Microsoft engine was slow for a structural reason: every
  paragraph part was a separate HTTP round trip, awaited strictly one after
  another — ~20 sequential round trips per page after region coalescing.
  Requests now run through a small parallel pool (3 in flight, order
  preserved, first failure aborts), collapsing a page into a few waves.
  The Google engine's independent batches go through the same pool.

## [0.3.2] — 2026-08-07

### Fixed

- Microsoft engine: the real reason the www/cn fix never took effect. The
  settings pane auto-fills the provider's default Base URL
  (`https://www.bing.com`) into the preference, and "use apiBaseURL when
  set" silently overrode the session origin learned from the redirect — so
  cn-issued tokens were posted to www on every install, by construction.
  `resolveBingApiBase` now treats ANY bing.com host in the Base URL as
  "no override" and follows the session-issuing host; only a genuine
  non-bing mirror wins. Covered by regression tests.
- The Bing web channel now goes FIRST; Edge anonymous auth (observed
  returning HTTP 404) is the fallback behind a 5-minute breaker.
- An Edge auth 404 is reported as 「Edge 匿名认证端点不可用」 instead of the
  generic — and here actively misleading — "Endpoint or model not found".

## [0.3.1] — 2026-08-07

### Fixed

- Microsoft engine, continued. The browser-identity fix moved the failure
  from an HTML challenge page to a silent-empty HTTP 200 — Bing's
  rate-limit/flag response for this host. Three counters:
  - The request IID now carries the per-session counter suffix Bing's own
    client sends.
  - A silent-empty 200 rotates to the sibling host (www ↔ cn bing.com),
    refreshes the session there and retries once.
  - The Edge channel's last failure is reported even while the channel is in
    its 5-minute breaker (`Edge通道: 熔断中, 上次: …`), so every
    test-connection line carries both channels' truth.

## [0.3.0] — 2026-08-07

Start of the 0.3 line.

### Fixed

- Microsoft translation, round three — the user's screenshot finally carried
  the decisive clue: **HTTP 200 with a non-JSON body**, which is Microsoft's
  bot check answering an unfamiliar client with an HTML challenge page.
  - Every request to a Microsoft host now introduces itself with a browser
    User-Agent (privileged XHR may set one); the translate POST also carries
    the Referer the endpoint expects.
  - Non-JSON responses are now diagnosed precisely: an HTML page, an empty
    body and other garbage each get their own message.
  - When both paths fail, the error carries BOTH: `Edge通道: … ｜ Bing通道:
    …` — one screenshot of the test-connection line now tells the whole
    story.
  - The scrape path's internal session-refresh retry no longer restarts from
    the Edge path.

## [0.2.10] — 2026-08-07

### Removed

- Settings the reader never needed to see: request timeout and concurrency,
  send-adjacent-context, auto-prefetch, sync-scroll (lives in the header
  bar), 显示原文对照, the article font-size slider, the 生成译文PDF section
  (the capability stays behind `Zotero.PaperMirror.exportTranslatedPdf()`),
  and 仅本地服务模式. Every removed knob keeps working at its default.

### Fixed

- Six checkboxes rendered as bare text with no box (Fluent value-style
  labels): all checkboxes now carry explicit labels.
- The footer version was hardcoded "0.1.0"; it now reads the installed
  version from the plugin.

## [0.2.9] — 2026-08-07

### Changed

- 悬停看原文 and 原文淡化 are ON by default (one-time migration for existing
  installs): in overlay mode the masks are translucent so the original stays
  faintly visible, and hovering a paragraph reveals its source — comparison
  reading needs no setup.

### Added

- The settings pane's 阅读 section now carries the same choices as the
  toolbar menu: a 默认阅读模式 picker (左右对照 / 覆盖翻译 — the mode the
  toolbar button opens), plus checkboxes for 悬停看原文 and 原文淡化.

## [0.2.8] — 2026-08-07

### Added

- **Region-based translation.** A coalescing pass between extraction and
  translation rebuilds semantic regions from whatever fragments extraction
  produced: consecutive body blocks in the same column, at the same type
  size, with only line-spacing between them merge into ONE region — extracted
  in reading order, translated as one semantic block, masked line by line,
  and typeset into the region's own union bounding box. The shredded
  one-line-per-block abstracts are gone.
- Paragraph roles (Background, Methods and Results, Conclusions, Key Words)
  survive the round trip: genuine paragraph boundaries join as blank lines,
  the free Microsoft/Google engines translate paragraph-by-paragraph so the
  structure is never flattened, and the typesetter renders it back as
  separate paragraphs (`white-space: pre-line`).
- Containment-first typesetting: before the flow may move anything, each
  region walks a typographic ladder — leading 1.5 → 1.34 → 1.24, then type
  down to 88% of source (floor 8.5px) — inside its own box. Only what still
  does not fit spills into the push-down/grow machinery, so translated text
  stays inside its region and never overlaps adjacent content.

## [0.2.7] — 2026-08-07

### Fixed

- Translated text is no longer larger than the original. The right pane
  always filled its own width, so whenever the reader displayed the original
  smaller than the pane (fit-page zoom, wide windows) the rebuilt page — and
  every glyph on it — rendered bigger than the page beside it. Pages now
  render at the READER's own zoom (CSS px per PDF point), capped by the pane
  width, and follow zoom changes live.
- The garbled overlap band at the bottom of dense pages is gone. Overflowing
  blocks used to be clamped back inside the page height, piling every long
  translation onto the same bottom strip over unmasked original text. A block
  that runs long now keeps flowing downward and the page GROWS below the
  artwork (plain paper extension); the slot carries the real footprint so the
  next page never overlaps the tail.

## [0.2.6] — 2026-08-07

### Fixed

- The split now reads 缩略图 | 原文 | 译文 with the original and the
  translation dividing the space AFTER the thumbnails equally. Previously the
  raw reader browser was split 50/50, so the left half was sidebar+original
  while the right half was all translation — the translated page ran wider
  than the original and its typography was set for the wrong measure. The
  sidebar's width is measured (browser minus the PDF iframe, so it survives
  Zotero renames) and granted to the reader's side on top of its half; the
  divider drag and the periodic sidebar open/close check both honour it.

## [0.2.5] — 2026-08-07

### Fixed

- Microsoft translation, round two — two independent breakages found:
  - In mainland networks www.bing.com 302s to cn.bing.com; the session was
    scraped from the redirected page but the API call went back to
    www.bing.com, where the token is invalid by construction. The engine now
    tracks where the redirect landed and keeps every call same-origin.
  - Bing renamed the credentials variable from `params_RichTranslateHelper`
    to `params_AbusePreventionHelper`; the parser accepts both.
  - Engine self-test errors now carry the underlying message, not just a code.

### Changed

- Provider badges upgraded to faithful vector reproductions of the real
  marks: Microsoft's four squares, Google's four-colour G (canonical path),
  the OpenAI hexagonal knot, Anthropic's dark A on cream, the Gemini gradient
  star, the DeepSeek whale, the DeepL dart, Kimi's black K tile, the 通义
  hexagram, the SiliconFlow pinwheel, the Ollama llama face, Groq's G ring
  and the OpenRouter fork.

## [0.2.4] — 2026-08-07

### Added

- Brand badges for every translation service — Microsoft's four squares,
  Google's four-colour G, coloured monograms for the LLM providers — drawn in
  code and shared between the header chip and the switcher menu.
- The header chips are now switchers: clicking the language pair opens a
  source/target menu, clicking the engine opens the full provider roster with
  badges. Switching restarts translation in place; no trip through the
  settings pane. (Settings stays one entry away at the bottom of the menu.)

### Fixed

- Microsoft translation works again. The bing.com page-scrape session flow had
  broken; the engine now uses the Edge browser's translator auth (a keyless
  JWT from edge.microsoft.com, the flow current immersive-translate uses) as
  the primary path, with the page scrape kept as a fallback.

### Changed

- Free engines are named plainly in the header — "Microsoft 微软翻译" and
  "Google 谷歌翻译" — without the "(free, no key)" clutter.

## [0.2.3] — 2026-08-07

### Fixed

- The pane no longer freezes on a page spinner. Core page rendering awaited a
  promise from the PDF.js content compartment, which can simply never settle
  for a sandbox awaiter — the same cross-compartment trap getPageData fell
  into long ago — and the render pump hung on it forever. Completion is now
  detected by polling plain flags plus a pixel-stability check on the canvas,
  under a hard deadline; a failed page falls back to copying the left viewer's
  canvas (scaled to fit), and failing slots retry with backoff instead of
  spinning. A 20-second race in the pump is the final backstop.

## [0.2.2] — 2026-08-07

### Fixed

- The header bar now spreads edge to edge. A legacy compact-header rule made
  the header a row flex container, so the bar was sized to its content and the
  flexible gap had no room to grow — every control clustered on the left. The
  bar claims the full line; the left group sits at the left edge and the
  layout/settings/close group is pinned to the right.

## [0.2.1] — 2026-08-07

### Changed

- 整页对照 now shows the **whole document**, not just the page the reader is
  on: one slot per page, laid out from the page boxes before anything renders,
  so the scrollbar and page positions are correct from the first frame. A page
  shows the **original** until its translation completes, then swaps to the
  rebuilt translated page.
- Pages render through pdf.js core directly (`adapter.renderPageBitmap`), so
  the right pane no longer depends on which pages the left viewer happens to
  keep rendered — and no longer needs to rebuild on left-side re-renders or
  zooms at all.

### Fixed

- 同步滚动 offset (原文第 2 页对着译文第 1 页): the pane now follows the
  reader's document position continuously — page **and** fraction within the
  page — instead of snapping per page. Scrolling the pane drives the reader
  the same way, with echo suppression in both directions.
- Memory bounded: only pages near the viewport hold canvases (rendered one at
  a time, nearest first, re-prioritised between renders); far pages release
  back to sized placeholders. The per-canvas supersampling budget was halved
  to match.

## [0.2.0] — 2026-08-07

### Changed

- The application icon is now **vector**. `assets/icons/icon.svg` is the single
  source of truth; the PNGs the manifest needs are renders of it, and the
  regeneration command is documented beside them. The preferences pane loads the
  SVG directly, so it stays sharp at any display scale.
- The mark itself was redrawn as the product it describes — two sheets side by
  side, the original in paper and dark type, the translation in the plugin's
  purple with light type and a live dot. No backdrop plate: the card is the whole
  icon.
- The in-app miniatures (reader toolbar button, pane brand) are drawn on the same
  16px grid the SVG uses ×8, so the large mark and the small one cannot drift
  apart.

## [0.1.9] — 2026-08-07

### Changed

- Redesigned the translation pane's header bar into three zones — what is being
  translated, what to do with it, what to do with the window — separated by
  hairlines. Chips are borderless and quiet; colour is reserved for the primary
  action and the active sync switch.
- The source and target languages share one chip (`English → 简体中文`) instead
  of two chips that both truncated to `Eng… → 简体…`.
- Narrow panes now drop control labels rather than truncating every element.

## [0.1.8] — 2026-08-07

### Changed

- Translation status moved out of the header bar into a floating note in the
  bottom-right corner: it appears on a new action, stays while work is running,
  and leaves on its own. Repeating the same message no longer re-triggers it.
- The rebuilt page now fills the pane in both directions (previously it would
  only ever scale down, leaving empty space beside it).

### Fixed

- Corrected the sign of the transform footprint compensation, which left a band
  of dead space below and to the right of a scaled page.

## [0.1.7] — 2026-08-07

### Added

- The rebuilt page scales with the pane: dragging the divider resizes the
  translation smoothly via a CSS transform, with no re-render and no way for the
  text layer and the artwork to drift apart.
- The layout-swap button draws the current arrangement — two panels with the
  translation's half filled — so it reads as state rather than as a generic
  arrow.

### Changed

- Header bar rebuilt in a fixed order: icon, languages, engine, refresh, status,
  sync scroll, save to note, layout, settings, close.

### Removed

- The 生成译文PDF button. The capability remains available as
  `Zotero.PaperMirror.exportTranslatedPdf()`.

## [0.1.6] — 2026-08-07

### Fixed

- A final overlap-resolution pass guarantees no two blocks occupy the same
  pixels, whatever the column analysis concluded. Blocks left in the original
  (author lists, affiliations) participate as immovable obstacles — previously
  translations could be printed straight over them.
- The rebuilt page no longer sits offset and clipped inside its host.

## [0.1.5] — 2026-08-07

### Fixed

- The rebuilt page is now built at the reader's own pixel geometry (1:1) instead
  of being scaled to the pane's width. Every earlier formula failed the same
  way: an ancestor would clamp the page's width, the bitmap scaled down with the
  container while the text layer kept its pixel coordinates, and the result was
  oversized type spilling past the edge with masks no longer covering the words
  they were cut for. Zoom now propagates to both halves for free.

### Removed

- The width-cap, clamp-detection and resize-redraw machinery that existed only
  to fight the clamping described above.

## [0.1.4] — 2026-08-07

### Changed

- 左右对照 is the default reading mode again: the original PDF on the left, the
  re-flowed translated page on the right. 覆盖模式 remains one click away in the
  toolbar menu.

## [0.1.3] — 2026-08-07

### Added

- Column-aware flow layout for the rebuilt page (`src/ui/pageFlow.ts`). Blocks
  are set at one consistent size and take the height the Chinese needs; three
  strict rules keep the page sane: a block never moves up, never leaves its
  column, and never crosses an obstacle.
- Obstacle detection reads the rendered bitmap directly — the page is
  downsampled to a coarse grid, cells that contrast with the paper are marked,
  the blocks being replaced are erased, and what remains (figures, plots, logos,
  coloured bands) is what the flow hops over.

### Fixed

- A full-width title no longer merges the two text columns into one. Column
  membership is measured against the wider span, not the narrower.

## [0.1.2] — 2026-08-07

### Added

- 悬停看原文: hovering a translated paragraph in overlay mode lifts that
  paragraph's masks and fades its text, revealing the source underneath.
- Toolbar menu entries for 悬停看原文 and 原文淡化.

### Fixed

- Line rects handed back bottom-to-top no longer shatter a paragraph into one
  fragment per source line. The reading direction is detected and normalised.

## [0.1.1] — 2026-08-07

### Fixed

- The translation pane no longer flashes open and then vanishes: the pane's
  visibility is settled when the split view is created rather than after text
  extraction finishes, seconds later.
- Overlay mode shows a progress chip on the page, so a click on 翻译 is
  acknowledged immediately even though the side pane is hidden.
- A failure while opening keeps the pane on screen carrying the error instead of
  silently tearing the session down.

### Added

- An in-memory ring buffer of recent warnings and errors, readable at any time
  via `Zotero.PaperMirror.lastErrors()` — no need to have enabled debug logging
  beforehand.

## [0.1.0] — 2026-08-07

Initial working plugin for Zotero 9.0.x.

### Added

- Side-by-side bilingual reading in the built-in PDF reader, with synchronised
  scrolling and a reader-toolbar toggle.
- On-page overlay mode: the translation is painted onto the rendered page, one
  mask per source line, with the page's own sampled paper colour.
- Structured extraction: paragraph merging, de-hyphenation, two-column reading
  order, heading and caption classification, formula protection, and a
  metadata filter for author rosters, affiliations, copyright, DOI lines,
  running heads and page feet.
- Providers: Bing and Google free engines (no key), plus OpenAI-compatible,
  Anthropic, DeepL and custom endpoints. BYOK only — no developer keys are
  bundled, and keys are stored in the system credential store.
- Deep explanation of a selected passage, a glossary, a persistent local cache
  keyed by file hash and settings, and save-to-note.
- In-plugin translated-PDF generation with pdf-lib and a build-time GB2312
  subset of Noto Sans SC, plus an optional local BabelDOC bridge for full
  layout re-flow.

[Unreleased]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.4.3...HEAD
[0.4.3]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.11...v0.4.0
[0.3.11]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.10...v0.3.0
[0.2.10]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/releases/tag/v0.1.0
