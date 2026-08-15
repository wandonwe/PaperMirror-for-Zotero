# Third-Party Notices / 第三方声明

PaperMirror 文镜 for Zotero is licensed under AGPL-3.0-or-later (see LICENSE).
It incorporates work from the following projects, reproduced here with their
required notices.

## RetainPDF

- Project 项目: [wxyhgk/retain-pdf](https://github.com/wxyhgk/retain-pdf)
- Author 作者: wxyhgk and the RetainPDF contributors
- License 协议: MIT

诚挚致谢:PaperMirror 的多项核心算法参照并移植自 RetainPDF 的实现与设计,
包括(不限于):

- 译文质量判定规则(copy-dominance 表面相似度、截断判定、混合英文残留跨度、
  数据密集片段豁免、作者署名行豁免、协议壳输出检测)——移植自
  `backend/scripts/services/translation/llm/validation/english_residue.py`、
  `quality.py`、`protocol_shell.py`,对应本项目
  `src/translation/residueRules.ts` 与 `src/translation/responseValidator.ts`
  的部分逻辑;
- 公式密集风险评分与慢道路由(触发短语、占位符计数/密度/位置加分)——移植自
  `segment_risk.py`,对应本项目 `src/reader/formulaGuard.ts` 中的
  `formulaRiskScore`;
- 设计层面的参照:占位符保护与清单校验、batched_fast/single_slow 分道调度、
  纯文本兜底重译与 keep-origin 止损、matched 模式术语/记忆注入、跨页
  continuation hint、页面基准字号(role_min)思想。

The following is the complete license text of RetainPDF, as required by the
MIT License:

```
MIT License

Copyright (c) 2026 RetainPDF contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## old-immersive-translate

- Project: [immersive-translate/old-immersive-translate](https://github.com/immersive-translate/old-immersive-translate)
- Scope: the free Bing and Google machine-translation engine adapters are
  ported from this project.

## Noto Sans SC

- The bundled CJK font is a subset of
  [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC),
  licensed under the SIL Open Font License 1.1.

## lobe-icons

- Provider brand marks are from
  [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons) (MIT). Each mark
  is a trademark of its respective owner, used only to identify the service.
