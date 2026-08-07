# Changelog

All notable changes to PaperMirror for Zotero are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays below `1.0.0`, the reading UI is still settling and
minor releases may change defaults.

## [Unreleased]

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

[Unreleased]: https://github.com/wandonwe/papermirror-zotero/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/wandonwe/papermirror-zotero/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/wandonwe/papermirror-zotero/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/wandonwe/papermirror-zotero/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/wandonwe/papermirror-zotero/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wandonwe/papermirror-zotero/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wandonwe/papermirror-zotero/releases/tag/v0.1.0
