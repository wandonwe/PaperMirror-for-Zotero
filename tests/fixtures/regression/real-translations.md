# Saved translation rendering regression

`real-translations.json` contains unedited source blocks and service translations from the user's exported corpus, with the originating JSONL filename on each page. These cases exercise rendering independently of the latest extraction algorithm. They must not be described as a fresh end-to-end translation run.

- Stroke 2026, PDF pages 35 and 40: recommendation tables, dense prose and unplaced list items.
- Stroke 2026, PDF page 27: a CT illustration and its translated caption. Image exclusion rectangles come from the original PDF.
- Serruys 2021, PDF page 22: references. Its original bitmap is physical page 43 (zero-based 42) of the user's 48-page dual PDF.

The PNGs are original page bitmaps at one PDF point per pixel. The browser test renders at 1× and 0.75× with the application's CSS. It checks full text retention, explicit accounting for unplaced translations, geometry after the final audit, minimum placement counts, and access to complete unplaced translations. Original bad structure is deliberately retained in these fixtures; extraction regressions are checked separately with span/grid fixtures.

Run `node scripts/check-wrap-layout.mjs` for the entire local browser suite, or `PM_REAL_ONLY=1 node scripts/check-wrap-layout.mjs` for these cases. `PM_VISUAL_OUTPUT=/absolute/output/directory` additionally writes an offline HTML replay and screenshot for inspection. These are macOS Chromium baselines; they do not replace Zotero export verification, or certify the semantic accuracy of service translations.
