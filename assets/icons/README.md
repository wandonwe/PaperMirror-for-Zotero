# Icons

`icon.svg` is the **single source of truth** for the PaperMirror mark. The PNGs
beside it are renders, committed because Zotero's manifest wants raster icons;
regenerate them whenever the SVG changes:

```bash
# any one of these
for s in 48 96 128; do rsvg-convert -w $s -h $s icon.svg -o icon$s.png; done
for s in 48 96 128; do inkscape icon.svg -w $s -h $s -o icon$s.png; done
python3 -c "import cairosvg;[cairosvg.svg2png(url='icon.svg',write_to=f'icon{s}.png',output_width=s,output_height=s) for s in (48,96,128)]"
```

The in-app miniatures — the reader toolbar button and the pane's brand mark —
are drawn in code (`src/reader/readerToolbar.ts`, `src/ui/translationPane.ts`)
on the same 16px grid this file uses ×8, so the two cannot drift apart. At 16px
only the heading rule and two body lines survive; everything else is identical.

The mark has **no backdrop** — no rounded-square canvas, no plate. The card is
the whole icon, which is what lets it sit cleanly in a toolbar, a settings list
and a dock alike.
