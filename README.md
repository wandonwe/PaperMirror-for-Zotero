<div align="center">

<img src="assets/icons/icon128.png" width="96" alt="PaperMirror">

# PaperMirror 文镜 · for Zotero

**中英对照阅读 · 版面级重排 · 就地覆盖翻译**
**Bilingual side‑by‑side reading, layout‑faithful, right inside Zotero**

[![Release](https://img.shields.io/github/v/release/wandonwe/PaperMirror-for-Zotero?label=release)](https://github.com/wandonwe/PaperMirror-for-Zotero/releases/latest)
[![CI](https://github.com/wandonwe/PaperMirror-for-Zotero/actions/workflows/ci.yml/badge.svg)](https://github.com/wandonwe/PaperMirror-for-Zotero/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Zotero 9.0](https://img.shields.io/badge/Zotero-9.0.x-CC2936.svg)](https://www.zotero.org/)

**[中文](#中文) · [English](#english)**

</div>

---

<a id="中文"></a>

## 中文

**PaperMirror(文镜)** —— 文字之镜,原文与译文两相映照。在 Zotero 自带的 PDF 阅读器里直接对照阅读外文文献:一边是**原版 PDF**(排版、图表、公式原封不动),另一边是**按版面重排的整页译文**,大小与原文一致、逐段对齐。图表、表格、公式、分栏、页眉页脚等都从原页原样保留,只有正文被替换并重新排版,不会被硬塞进原文的换行里。

### 三种阅读模式

点击阅读器工具栏的**翻译图标**开关翻译;图标右边的**箭头 ▾**可选择模式。

| 模式 | 你会看到 |
| --- | --- |
| **原文** | 未改动的原版 PDF。 |
| **覆盖翻译** | 译文就地绘制在原页上——分页、图表、公式、版式完全不变,只有文字变成译文。鼠标悬停任一段落即可掀开看原文。 |
| **左右对照**(默认) | 左边原版 PDF,右边是同一页按版面重排的整页译文,大小相同,滚动同步。 |

### 安装

1. 到 [Releases](https://github.com/wandonwe/PaperMirror-for-Zotero/releases/latest) 下载最新的 `.xpi` 文件。
2. Zotero 里:**工具 → 插件 → ⚙ → 从文件安装插件…**,选择该 `.xpi`。
3. 打开 **设置 → PaperMirror**,选择翻译引擎;若引擎需要密钥,填入你自己的 API Key。

需要 **Zotero 9.0.x**,支持 macOS / Windows / Linux。

安装后插件会**自动更新**:Zotero 会检查本仓库的最新 Release 并自动升级(**插件 → ⚙ → 检查更新**可立即检查)。0.5.2 及以后的版本都走这条自动更新通道,无需再手动下载 `.xpi`。

### 使用介绍

1. **打开一篇 PDF**。在库中双击任意 PDF 附件,进入 Zotero 阅读器。
2. **点翻译图标**(阅读器顶部工具栏)。首次会弹出一次隐私提示,确认后开始翻译;默认进入**左右对照**模式,右侧出现译文面板。
3. **等待逐页翻译**。当前页优先翻译,并预取前后相邻页;每页翻译完成前显示原文,完成后自动替换为译文。
4. **切换模式**:点翻译图标旁的 **▾** → 选 原文 / 覆盖翻译 / 左右对照;菜单里还有**悬停看原文**、**原文淡化**两个开关(覆盖模式下用)。
5. **译文面板顶部工具条**(左右对照模式)自左向右依次为:语言对 · 翻译服务 · 刷新(重新翻译本页) · 同步滚动开关 · **✦ 解析** · 保存到笔记 · 左右布局切换 · 设置 · 关闭。语言和翻译服务可在这里直接切换,无需进设置。
6. **划词解析**:在左边 PDF 里选中一段文字,点面板工具条上的 **✦ 解析**,即可对选中内容做深度讲解(需要 LLM 服务商,免费必应/谷歌引擎不支持)。也可以直接**双击**右侧某段译文进行解析。
7. **保存到笔记**:点**保存到笔记**,把当前页(或所选段落)的原文+译文存为该条目的子笔记。
8. **重新翻译**:某页翻译不理想时点**刷新**,跳过缓存重译本页。

### 翻译引擎(自备密钥 BYOK)

插件不内置、不共享任何开发者密钥;你的密钥只会发给你所配置的那一家服务。

- **免密钥**:微软(必应)免费、谷歌翻译免费、Ollama(本地)。
- **大模型**:OpenAI 及所有 OpenAI 兼容端点(DeepSeek、Kimi、通义千问、智谱 GLM、OpenRouter、SiliconFlow、Groq…)、Anthropic Claude、Google Gemini。
- **专业机翻**:DeepL。
- **自定义**:任意 HTTPS 端点。

想更快?**设置 → 性能与并行**里可以调并发数,并勾选多个已配置密钥的服务商**并行分担**页面(文本会发给每一个勾选的服务)。

密钥保存在操作系统的凭据管理器(Mozilla Login Manager)里,绝不明文写入项目文件、日志或导出。

### 术语表

**设置 → 术语表**里每行一条 `原文 → 译文` 规则,让专有名词全篇统一;行尾加 ` ?` 表示仅供参考。支持 JSON 导入/导出。

### 隐私

- 论文文本只通过 HTTPS 发送给你配置的引擎;无遥测,你的文献库、账户、数据库信息都不会离开本机。
- 自定义端点默认必须 HTTPS;可选的本地整篇 PDF 服务仅允许回环地址(loopback),因为那类请求会携带密钥。
- 译文按"文件哈希 + 设置"缓存在本地,可在设置里一键清除。

完整声明见 [docs/PRIVACY.md](docs/PRIVACY.md)。

### 常见问题

- **一直转圈/没出译文?** 该 PDF 可能没有文本层(是扫描件),需要先 OCR;或所选引擎需要密钥而尚未配置。
- **提示需要 LLM?** 解析功能需要大模型服务商,免费必应/谷歌引擎只做翻译、不做讲解。
- **译文里夹着英文?** 点该页**刷新**重译一次即可。
- **检查更新说已是最新但其实有新版?** 到 **插件 → ⚙ → 检查更新** 手动触发一次。

---

<a id="english"></a>

## English

Read foreign‑language papers side by side inside Zotero's own PDF reader: the
**original PDF** on one side (layout, figures and formulas untouched) and a
**layout‑faithful, full‑page translation** on the other — same size, paragraph
for paragraph. Figures, tables, equations, columns and running heads are kept
from the rendered page exactly; only body text is replaced and re‑flowed, never
crammed back into the original line breaks.

### Three reading modes

Click the **translate icon** in the reader toolbar to toggle translation; the
**caret ▾** beside it picks the mode.

| Mode | What you see |
| --- | --- |
| **Original** | The untouched PDF. |
| **Overlay** | The translation painted onto the page itself — same pagination, figures, formulas and layout, only the words change. Hover a paragraph to reveal the source underneath. |
| **Side by side** *(default)* | The original PDF on the left; on the right, the same page rebuilt with the text re‑flowed in your language, at the same size, scroll‑synced. |

### Install

1. Download the latest `.xpi` from [Releases](https://github.com/wandonwe/PaperMirror-for-Zotero/releases/latest).
2. In Zotero: **Tools → Add‑ons → ⚙ → Install Add‑on From File…** and pick the `.xpi`.
3. Open **Settings → PaperMirror**, choose a translation engine, and paste your
   own API key if that engine needs one.

Requires **Zotero 9.0.x**. macOS, Windows and Linux.

Once installed, PaperMirror **updates itself**: Zotero checks this repository's
latest release and upgrades automatically (**Add‑ons → ⚙ → Check for Updates**
forces a check now). Every release from 0.5.2 on is served this way — no need to
download the `.xpi` again.

### How to use

1. **Open a PDF** — double‑click any PDF attachment to open Zotero's reader.
2. **Click the translate icon** in the reader toolbar. A one‑time privacy notice
   appears first; after you accept, translation starts in **Side by side** mode
   and the translation pane opens on the right.
3. **Pages translate lazily** — the current page first, with neighbours
   prefetched. Each page shows the original until its translation is ready, then
   swaps to the translation.
4. **Switch modes** with the **▾** next to the icon: Original / Overlay / Side by
   side. The menu also has **Peek original on hover** and **Dim original**
   toggles for overlay mode.
5. **The pane's top bar** (side‑by‑side mode), left to right: language pair ·
   engine · refresh (re‑translate this page) · sync‑scroll toggle · **✦ Explain**
   · Save to note · layout swap · Settings · Close. Language and engine can be
   switched right here, no trip to Settings.
6. **Explain a selection** — select text in the PDF, then click **✦ Explain** in
   the pane's bar for a deep explanation (needs an LLM provider; the free
   Bing/Google engines can't explain). Double‑clicking a translated paragraph
   works too.
7. **Save to note** — store the current page's (or the selected paragraph's)
   original + translation as a child note of the item.
8. **Re‑translate** — if a page came out poorly, click **refresh** to redo it,
   bypassing the cache.

### Translation engines (bring your own key)

No developer keys are bundled or shared; your key only ever goes to the provider
you configured.

- **No key needed:** Microsoft (Bing) free, Google Translate free, Ollama (local).
- **LLM providers:** OpenAI and any OpenAI‑compatible endpoint (DeepSeek, Kimi,
  Qwen, GLM, OpenRouter, SiliconFlow, Groq…), Anthropic Claude, Google Gemini.
- **Dedicated MT:** DeepL.
- **Custom:** any HTTPS endpoint.

Want it faster? **Settings → Performance & parallelism** lets you raise the
concurrency and tick several key‑configured providers to **share pages in
parallel** (text is sent to every ticked service).

Keys live in the OS credential store (Mozilla Login Manager) — never in plain
text, logs, or exports.

### Glossary

**Settings → Glossary**: one `source → target` rule per line to keep terminology
consistent across the whole paper; append ` ?` for reference‑only rules. JSON
import/export supported.

### Privacy

- Paper text goes only to the engine you configured, over HTTPS. No telemetry;
  nothing about your library, account or database leaves the machine.
- Custom endpoints must be HTTPS unless you explicitly allow otherwise; the
  optional local full‑PDF service is restricted to loopback because those
  requests carry your key.
- Translations are cached locally, keyed by file hash + settings, and can be
  cleared from the settings pane.

Full statement: [docs/PRIVACY.md](docs/PRIVACY.md).

### FAQ

- **Spinner never resolves / no translation?** The PDF may have no text layer (a
  scan) and needs OCR; or the chosen engine needs a key you haven't set.
- **"Requires an LLM"?** Explanation needs an LLM provider; the free Bing/Google
  engines translate but don't explain.
- **English mixed into the translation?** Click **refresh** on that page to redo it.
- **"No updates found" but there is one?** Trigger **Add‑ons → ⚙ → Check for
  Updates** manually.

---

## Development

```bash
npm install          # install dependencies
npm test             # unit + integration tests (node:test)
npm run build        # compile TypeScript → build/addon
npm run package      # build and zip → dist/*.xpi
npm run dev-install  # build and drop into a local Zotero profile
```

TypeScript in `strict` mode, bundled with esbuild. No test may be deleted to
make a build pass.

### Releasing (VS Code only, no tags, no terminal)

1. Bump the version in `manifest.json` **and** `package.json` (keep them equal).
2. Add a `CHANGELOG.md` entry.
3. Commit and **Sync** (push to `main`).

That push triggers the Release workflow, which builds, creates the `v<version>`
tag, and publishes the `.xpi` plus `updates.json` as release assets. The plugin's
`update_url` is the latest‑release alias, so every installed copy — anyone's,
anywhere — auto‑updates from that release. Pushes that don't change the version
are ignored; an already‑released version is skipped.

### Layout

```
src/
├── reader/       Reader integration: toolbar, split view, overlay, extraction
├── translation/  Providers, scheduling, prompts, glossary, validation
├── ui/           Translation pane, rebuilt page, flow layout, brand icons
├── pdfgen/       In-plugin translated-PDF generation (pdf-lib)
├── cache/        Persistent per-page translation cache
├── security/     Credential store, log sanitiser
└── utils/        Preferences, localisation, logging
docs/             Architecture, specification, privacy
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
```

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Bug
reports are most useful with the output of `Zotero.PaperMirror.lastErrors()` and,
for layout problems, a screenshot.

## License

[AGPL-3.0-or-later](LICENSE).

Several core algorithms are ported from or designed after
[RetainPDF](https://github.com/wxyhgk/retain-pdf) (MIT) by wxyhgk and the
RetainPDF contributors — translation-quality validation (copy-dominance,
truncation, mixed-residue rules), formula-risk routing, and the overall
placeholder-protection / repair-chain / scheduling design. 诚挚致谢原项目与
作者;完整声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The bundled CJK font is a subset of
[Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)
(SIL Open Font License 1.1). The free Bing and Google engine adapters are ported
from [old-immersive-translate](https://github.com/immersive-translate/old-immersive-translate).
Provider brand marks are from [lobe-icons](https://github.com/lobehub/lobe-icons)
(MIT); each mark is a trademark of its respective owner, used only to identify
the service.
