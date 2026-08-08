<div align="center">

<img src="assets/icons/icon128.png" width="96" alt="PaperMirror">

# PaperMirror for Zotero

**中英对照阅读 · 版面级重排 · 就地覆盖翻译**

A bilingual reading mode for Zotero's built-in PDF reader. The original paper
stays exactly as printed on one side; the same page, re-flowed in your language,
sits beside it.

[![CI](https://github.com/wandonwe/PaperMirror-for-Zotero/actions/workflows/ci.yml/badge.svg)](https://github.com/wandonwe/PaperMirror-for-Zotero/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Zotero 9.0](https://img.shields.io/badge/Zotero-9.0.x-CC2936.svg)](https://www.zotero.org/)

</div>

---

## What it does

Three reading modes, switched from one toolbar button (the caret next to it
picks the mode):

| Mode | What you see |
| --- | --- |
| **原文** | The untouched PDF. |
| **覆盖翻译** | The translation painted onto the page itself — same pagination, figures, formulas and layout, only the words change. Hover any paragraph to reveal the original underneath. |
| **左右对照** *(default)* | The original PDF on the left; on the right, the same page rebuilt with the text re-flowed in your language, at the same size. |

The rebuilt page is not a text dump. Figures, tables, equations, rules, logos
and the journal's furniture come across from the rendered page pixel-for-pixel;
only body text is replaced, and it re-flows properly rather than being crammed
back into the English line breaks.

## Install

1. Download the latest `.xpi` from [Releases](https://github.com/wandonwe/PaperMirror-for-Zotero/releases).
2. In Zotero: **Tools → Add-ons → ⚙ → Install Add-on From File…**
3. Open **Settings → PaperMirror**, choose a translation engine, and paste an
   API key if that engine needs one.

Requires **Zotero 9.0.x**. macOS, Windows and Linux.

Once installed, PaperMirror **updates itself**: Zotero checks this repository for
new releases and installs them automatically (Add-ons → ⚙ → *Check for Updates*
forces an immediate check). Every GitHub release published from v0.4.0 onward is
picked up this way — no need to download the `.xpi` again.

## Translation engines

Bring your own key. No developer keys are bundled, and a key is never sent
anywhere except the provider you configured.

- **No key needed:** Bing/Microsoft free, Google Translate free, Ollama (local).
- **LLM providers:** OpenAI and OpenAI-compatible endpoints (DeepSeek, Kimi,
  Qwen, GLM, OpenRouter, SiliconFlow, Groq…), Anthropic, Gemini.
- **Dedicated MT:** DeepL.
- **Custom:** any HTTPS endpoint you point it at.

Keys live in the operating system's credential store (Mozilla Login Manager),
never in plain text, never in logs, never in exports.

## Privacy

- Paper text goes only to the engine you configured, over HTTPS.
- No telemetry. Nothing about your library, your account or your database leaves
  the machine.
- Custom endpoints must be HTTPS unless you explicitly allow otherwise; the
  optional local PDF service is restricted to loopback addresses because those
  requests carry your key.
- Translations are cached locally, keyed by file hash and settings, and can be
  cleared from the settings pane.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full statement.

## Development

```bash
npm install          # install dependencies
npm test             # 268 unit + integration tests (node:test)
npm run build        # compile TypeScript → build/addon
npm run package      # build and zip → dist/*.xpi
npm run dev-install  # build and drop into a local Zotero profile
```

TypeScript in `strict` mode, bundled with esbuild. No test may be deleted to
make a build pass.

### Layout

```
src/
├── reader/       Reader integration: toolbar, split view, overlay, extraction
├── translation/  Providers, scheduling, prompts, glossary, validation
├── ui/           Translation pane, rebuilt page, flow layout
├── pdfgen/       In-plugin translated-PDF generation (pdf-lib)
├── cache/        Persistent per-page translation cache
├── security/     Credential store, log sanitiser
└── utils/        Preferences, localisation, logging
docs/             Architecture, specification, privacy, design references
tools/            Optional local BabelDOC bridge (Python, loopback only)
```

Everything that touches Zotero's undocumented reader internals is confined to
[`src/reader/zoteroReaderAdapter.ts`](src/reader/zoteroReaderAdapter.ts), so a
Zotero upgrade has exactly one file to check. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Diagnostics

In **Tools → Developer → Run JavaScript**:

```js
return await Zotero.PaperMirror.diagnose();          // environment + engine self-test
return Zotero.PaperMirror.lastErrors();              // recent warnings and errors
return await Zotero.PaperMirror.diagnoseExtraction();// why a page found no text
return await Zotero.PaperMirror.exportTranslatedPdf();
```

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Bug reports are most useful with the output
of `Zotero.PaperMirror.lastErrors()` and, for layout problems, a screenshot.

## License

[AGPL-3.0-or-later](LICENSE).

The bundled CJK font is a subset of
[Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)
(SIL Open Font License 1.1). The free Bing and Google engine adapters are ported
from [old-immersive-translate](https://github.com/immersive-translate/old-immersive-translate).
