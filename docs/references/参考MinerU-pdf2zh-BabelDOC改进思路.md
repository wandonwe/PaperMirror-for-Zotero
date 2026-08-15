# 参照 MinerU / PDFMathTranslate / BabelDOC 的改进思路

> 参照对象(均已克隆源码深读):
> [opendatalab/MinerU](https://github.com/opendatalab/MinerU)(Apache-2.0 + 附加条款)、
> [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate)(AGPL-3.0)、
> [funstory-ai/BabelDOC](https://github.com/funstory-ai/BabelDOC)(AGPL-3.0,pdf2zh 2.0
> 引擎,含 7 篇 ImplementationDetails 设计文档)。
> 基线:PaperMirror 1.0.3。日期 2026-08-15。

## 一、三个项目是什么,和文镜的关系

**MinerU** 是 ML 全家桶式的 PDF 解析器:DocLayout-YOLO 版面检测、layoutreader
阅读序模型、UniMERNet 公式识别、表格识别模型,产物是 Markdown/JSON。
**PDFMathTranslate(pdf2zh)** 用 pdfminer 做字符级管线 + DocLayout-YOLO 版面,
翻译后重排出新 PDF——它最出名的资产是 500 行的字符级公式判定与段落装配循环。
**BabelDOC** 是 pdf2zh 2.0 的工程化重写(沉浸式翻译团队维护):IL 中间表示 +
分阶段 midend(ParagraphFinding → StylesAndFormulas → Translate → Typesetting),
支持双语对照 PDF 输出。

三者都是"离线重排出新 PDF"路线;文镜是 Zotero 阅读器内实时覆盖。**ML 模型
(YOLO / layoutreader / UniMERNet)在插件运行时里不可行,不搬**;搬的是它们
在模型之外沉淀的纯算法——尤其 pdf2zh/BabelDOC 的字符级公式判定和 BabelDOC 的
排版算法,这两块是三家共同验证过的精华。注意 pdf2zh 与 BabelDOC 均为 AGPL-3.0,
与文镜同协议,移植代码只需在 THIRD-PARTY-NOTICES 致谢并标注来源;MinerU 为
Apache-2.0 附加条款(附加条款约束其模型权重,启发式代码不受影响)。

## 二、可移植清单

### P0-1 字形级公式判定(pdf2zh `vflag` + BabelDOC `formular_helper`)

**这是本轮最有价值的一项。** 文镜的 formulaGuard 是"拼好文本后的正则猜测";
三家全部在**字符层**用字体与码位证据判公式,精度完全不是一个量级:

- **数学字体名正则**(pdf2zh 原样):
  `CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|
  .*Mono|.*Code|.*Ital|.*Sym|.*Math` —— LaTeX/等宽/斜体/符号字体的字符即公式;
- **Unicode 类别**:Mn/Sk/Sm/Zl/Zp/Zs(修饰符、数学符号、分隔符)+ 希腊字母区
  0x370–0x400;BabelDOC 另加 Co 私有区,数字/方括号/• 可作公式起始,逗号可作
  公式中间字符;
- **角标判定**:同段内字符 size < 段字号 × **0.79**(0.76 角标与 0.799 大写
  之间取中)→ 上下标并入公式;
- **括号配平**:公式内出现 "(" 则配对的 ")" 仍算公式(vbkt 计数器);
- **(cid:) 未解码字符** → 公式;
- **后处理**(BabelDOC):纯数字的"公式"降级回可译文本;重叠公式组合并。

**落地**:字符路径的 `PdfChar` 本来就带 fontName/fontSize——在 blockBuilder 内
按上述规则标记公式 RUN,生成占位符挂到 `SourceBlock.placeholders`(字段已存在,
一直空置);formulaGuard 掩蔽时**字形证据优先、文本正则退为 span 路径的兜底**。
收益:公式密集页的保护从"猜文本"变"看字体",漏保和误保同时下降,还能让
公式风险评分(慢道路由)拿到真实占位符数。TS 无 unicodedata,用显式码位区间
近似(希腊、组合附标 0300–036F、数学运算符 2200–22FF、箭头 2190–21FF、
字母式符号 2100–214F、修饰符 02B0–02FF)。

### P0-2 排版第三算法:先扩边界、再缩字号(BabelDOC Typesetting Algorithm 3)

BabelDOC 的排版是三层梯子:算法1 顺排;算法2 行距 1.5→1.4(步长 0.1)再缩放
(scale>0.6 步长 0.05,否则 0.1,scale<0.7 时行距下限放宽到 1.1);**算法3 在
缩字之前先测量段落右侧实际空白并扩展边界**——以版心宽 90% 为上限,检查右侧
是否有段落/图形重叠,有多少空白扩多少。这正是"图 1 → Figure 1"式短标签和
标题这类**越译越长**内容的解法。

**落地**:strict 适配器已有行距梯子+缩字,缺的就是扩边界这一层。unfit 块在
shrink 之前尝试向右(段落)/向下(标题、图注)扩展进实测空白——imageBoxes 与
兄弟块盒都在手,计算是现成的。预计能把 strict 路径的"放弃保留原文"率再压
一截。

### P1-3 跨页续接的几何收紧(MinerU `__merge_2_text_blocks`)

MinerU 物理合并跨页段落的六个条件里,有两条几何条件是我们 0.9.30 续接判定
(未完句/小写开头)没有的:**上块末行右边界贴住块右边界(差 < 行高)**、
**两块宽度差 < min(两块宽)**。把这两条搬来收紧续接触发,减少"上页末段其实
已结束"的误注入。保持注入式不物理合并(覆盖契约不变);MinerU 的 CROSS_PAGE
span 标记思路验证了我们的方向。

### P1-4 列表块检测(MinerU `__is_list_or_index_block`)

**≥80% 的行以 `.。;;` 结尾 → 列表块**,并区分 start-line/end-line 标记模式。
落地到 blockBuilder 的 list 分类与 planMerges 的 bodyOnly 判定,减少参考文献式
列表、图注列表被并进正文段。

### P1-5 短行分段因子 + 目录行(BabelDOC ParagraphFinding)

以**中位行宽**为基准:行宽 < 中位 × factor 且非段末 wrapped 行 → 允许分段
(`split_short_lines`);**连续点号(……)的目录行**识别为独立行不参与合并。
paragraphHeuristics.shouldBreak 加一条几何信号,目录页不再拼坏。

### P2 项

- **CJK–EN 混排间距**(BabelDOC,UTR #59):中西文边界加 0.5 字宽间距。译文
  渲染观感小改,可在 join 时插 hair space。
- **双语交错导出**(BabelDOC dual 模式):pdfService 导出侧加"原文页/译文页
  交错"的双语 PDF 选项——阅读器内已是对照,导出物对齐这个能力。
- **MinerU 作为可选本地解析后端(方向性)**:MinerU 提供本地 API 服务模式;
  文镜已有 loopback-only 本地服务先例(全文 PDF 导出服务)。做一个显式开关的
  可选集成:用户自装 MinerU 本地服务,插件从 loopback 拉版面 JSON(块/表格/
  公式框)替代自家几何提取——这是打开"扫描件不支持"这条产品边界的唯一现实
  路径,且不破隐私约束(loopback-only、默认关闭)。工作量大,列为 1.x 方向
  选项,不排近期。

## 三、明确不搬

- DocLayout-YOLO / layoutreader / UniMERNet / 表格识别模型的内嵌:插件运行时
  跑不动,体积也不允许;版面识别继续走几何启发式 + (方向性)本地服务选项。
- 重排出独立 PDF 的主路线:与阅读器内覆盖的产品定位冲突,导出需求走双语导出。
- pdfminer 字符流实现细节:Zotero 的 PdfChar 已是等价物。

## 四、建议落地顺序

| 批次 | 内容 | 预期收益 |
| --- | --- | --- |
| 1(1.0.4) | P0-1 字形级公式判定 + P1-4 列表检测 + P1-5 短行/目录 | 公式保护质变;列表/目录页分段 |
| 2(1.0.5) | P0-2 排版扩边界 + P1-3 续接几何收紧 | strict 放弃率下降;跨页误注入下降 |
| 3(1.1 方向) | 双语导出;MinerU 本地后端调研 | 导出能力;扫描件边界 |

移植落地时在 THIRD-PARTY-NOTICES.md 增补三个项目的来源致谢(pdf2zh/BabelDOC
与本项目同为 AGPL-3.0,兼容;MinerU 启发式为 Apache-2.0,兼容)。
