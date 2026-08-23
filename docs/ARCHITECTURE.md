# Architecture

## The one rule

Everything that touches Zotero's **undocumented** reader internals lives in
`src/reader/zoteroReaderAdapter.ts`. Nothing else in the codebase reaches into
`reader._internalReader`, `PDFViewerApplication`, page views or the event bus.
When Zotero changes, there is exactly one file to read.

Official APIs (`Zotero.Reader.registerEventListener`, `Zotero.PreferencePanes`,
`Zotero.Prefs`, `Zotero.HTTP`, `Zotero.Attachments`) are used directly.

## Runtime shape

The plugin is a **bootstrap extension** running inside `Cu.Sandbox`, which has a
fixed global whitelist. Notably `AbortController` is absent — `installAbortPolyfill()`
provides a cooperative-cancellation stand-in before anything can request one.

```
bootstrap.js
  └── src/lifecycle/startup.ts
        ├── toolbar controller  (per reader tab → ReaderSession)
        ├── preferences pane
        └── Zotero.PaperMirror  (public API, diagnostics)
```

A `ReaderSession` owns one reader tab: the split view, the translation pane, the
on-page overlay, extraction, the translation manager, scroll sync and teardown.
All three view modes (`original` / `overlay` / `split`) share one session, so
switching never discards translations or re-hits a provider.

## Text extraction

Three paths, tried in order, each with a timeout (`src/reader/textExtractor.ts`):

1. **`getPageData`** from Zotero's PDF.js fork — characters with break flags.
   Richest, but the promise can fail to settle across compartments, hence the
   8-second timeout.
2. **Text-layer DOM** — `.textLayer span` plus `viewport.convertToPdfPoint`.
   This is the path that runs in practice.
3. **`Zotero.PDFWorker.getFullText`** — one string with no page delimiter, so it
   only serves as document-level evidence that a text layer exists at all.

`NO_TEXT_LAYER` is reported only when the whole document comes back empty, never
from a single blank page.

## From glyphs to paragraphs

`src/reader/paragraphHeuristics.ts` holds the shared core; `spanBlockBuilder.ts`
and `blockBuilder.ts` are the two front ends.

- **Columns** by x-projection bands plus per-row gutter voting (60% quorum).
- **Rotated strips** — vertical journal watermarks — dropped before rows form.
- **Line breaks** that are merely the right margin do not end a paragraph
  (`reachesRightMargin`), which is what stopped sentences being shredded.
- **Merge repair** rejoins paragraphs split mid-sentence when they share a
  column, sit within 1.2em, and the first ends dangling.
- **Metadata filter** (`metaFilter.ts`) removes what should never be translated:
  author rosters, affiliations, correspondence, copyright and licence text,
  DOI/URL lines, received/accepted dates, journal sidebars (by geometry, so new
  formats cannot slip past), running heads and page feet.

## Rendering the translation

Two surfaces, deliberately different:

**覆盖模式** (`src/reader/pdfOverlay.ts`) paints onto the rendered page. One mask
per **source line** in the page's own sampled paper colour — never one rectangle
over a paragraph, which would swallow ragged tails and anything the text wraps
around. Text is fitted with a typographic ladder (leading → letter-spacing →
size, floored at 8.5px); what still overflows gets an ellipsis marker and opens
on click. Hovering a paragraph lifts its masks to show the original.

**左右对照** (`src/ui/translatedPageView.ts` + `pageFlow.ts`) rebuilds the page.
The rendered bitmap is copied so figures and furniture survive exactly; body
blocks are masked and re-flowed:

1. A block never moves **up** — its source top is a floor.
2. A block never leaves its **column**.
3. A block never crosses an **obstacle** — regions of original ink we are not
   replacing, found by downsampling the bitmap to a coarse grid.
4. A final sweep guarantees no two boxes share pixels, with untranslated
   originals immovable.

The page is built at the reader's own pixel geometry and fitted to the pane with
a CSS transform. That separation matters: geometry stays exact, so the text
layer and the bitmap cannot drift apart, and resizing costs no re-render.

## Translation

`translationManager.ts` schedules per-page work with prefetch, bounded
concurrency, retry with backoff, cancellation on fast page flips, and a
300-second per-page watchdog. Results are cached by file hash + page + languages
+ provider + model + prompt version + source-text hash.

Providers implement one interface (`translation/providers/types.ts`). The free
Bing and Google adapters are ported from old-immersive-translate.

## Generating a translated PDF

`src/pdfgen/` writes the translation back into a real PDF with pdf-lib. One
sharp edge is documented in the code and repeated here: **pdf-lib's runtime
subsetting drops glyphs for this font**, verified by rendering. The plugin ships
a build-time GB2312 subset of Noto Sans SC and embeds it with `subset: false`.
Characters outside the subset become `〓` rather than vanishing.

The full-document PDF export (`Zotero.PaperMirror.exportTranslatedPdf()`) uses
this built-in generator exclusively. An earlier optional "service mode" that
POSTed the whole PDF to a local BabelDOC bridge (`tools/babeldoc_server.py`) for
layout re-flow was removed in 2.1.6: it had no UI, few users, and carried a
local HTTP server plus a token/handshake auth surface disproportionate to its
value. Nothing in the plugin now opens or talks to a local network service.
