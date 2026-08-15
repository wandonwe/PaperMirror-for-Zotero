# 参照 retain-pdf 的 PaperMirror 改进思路

> 参照对象:[wxyhgk/retain-pdf](https://github.com/wxyhgk/retain-pdf)(2.1k star)。
> 本文基于其 README、doc/ 下约 110 篇设计文档(ADR、API 契约、翻译层 README、字号算法参考文)
> 及翻译层源码(placeholder 保护、质量评审、修复链路、最终兜底)整理。
> 日期:2026-08-14,对应 PaperMirror 0.9.23。

## 一、两个项目的架构差异(先划清哪些不能抄)

retain-pdf 是**离线重排管线**:Rust API 调度 Python 管线,OCR(PaddleOCR/MinerU 等
provider)→ 归一化为 `document.v1.json` 中间层 → 翻译 → **Typst 重新排版编译**出一份
新 PDF(原文用 pikepdf 从 content stream 里物理删除,或仅用背景块覆盖)。它面向扫描件
和整本书,产物是一个独立文件。

PaperMirror 是**阅读器内实时覆盖**:在 Zotero 阅读器里就地提取文本层、翻译、以 overlay
方式盖在原文上,不改动 PDF 文件,BYOK、无服务端。因此以下内容**明确不搬**:

- OCR 管线与扫描件支持——PaperMirror 依赖文本层,这是产品边界而非缺陷(可在 README 声明);
- Typst 重排与 PDF 写回——覆盖式渲染是我们的既定路线(等价于它的 `typst_fill` 策略);
- Rust/Python 双进程架构与 Docker 交付。

真正值得搬的是它在**翻译质量工程**上的积累:占位符保护、质量评审与分层修复、分类分道
调度、按需上下文、术语记忆、动态字号、段级可观测性。这些全部可以在插件内实现。

## 二、P0——直接命中现有三症状的三项

### 1. 占位符保护体系(公式/引用标记/数字串不进翻译)

retain-pdf 的做法(`formula_protection.py` + `placeholder_guard.py`):翻译前用正则识别
行内公式、LaTeX 片段、代码等,替换成**带校验和的类型化 token** `<f0-abc/>`(f=公式、
c=代码、t=术语等),翻译后校验四件事——token 清单一致(`placeholder_inventory_mismatch`)、
顺序未变(`placeholder_order_changed`)、无凭空多出的 token(`unexpected_placeholder`)、
数学定界符平衡(`math_delimiter_unbalanced`)——任一失败进修复链路,最后原样回填。

对 PaperMirror 的价值是双重的:

- 公式、引用标记 `(5,6)`、统计量 `p < 0.001, 95% CI` 不再被模型改写或漏译;
- **顺带解决"疑似未翻译"误拒**:统计密集的行被拒收留在英文(斑马纹的一半成因),是因为
  残留校验把数字/符号当英文残留。掩蔽之后,校验只看散文部分,误拒率自然下降。

实现落点:`segmenter`/`translatePage` 出口处加 mask 层,provider 无关;校验加进现有
未翻译检查;token 用不可译的 ASCII 形式(模型改不动)。

### 2. 分类分道调度 + 小段合批(速度症状的另一半)

retain-pdf 不把 `workers` 当扁平线程池(`doc/api/04-翻译/02-并发与批次.md`):先把 item
分成 `batched_fast`(低风险正文,**多条合并成一个请求**)、`single_fast`(普通单条)、
`single_slow`(公式密集/高风险,独立 worker 上限,不许吃满并发),尾部再跑 `tail_retry`。

PaperMirror 当前每个 chunk 一个请求、同质排队。一页论文里图注、表题、列表项这类
50 字以内的小段占请求数的一半以上——**把同页低风险小段合批成一个请求**(带编号分隔,
回来按编号拆),请求数可以砍掉 30–50%,直接改善"速度太慢";长段/公式密集段走慢道,
不阻塞正文。这与审核报告已排期的"分块级调度任务"是同一件事,retain-pdf 给出了成熟的
三分法。注意合批需配合第 1 项的占位符校验(拆分错位可检测、可降级为逐条重发)。

### 3. 拒收段的分层修复链路(而不是一拒了之)

retain-pdf 的兜底原则写得很硬:「`should_translate=true` 的 item 不能以空译文结束」。
链路是:普通重试 → 短文本专用重试 → 乱码修复 → **agent 修复**(独立小并发 8–16,只处理
阻塞性问题)→ 收尾的 `final untranslated recovery`(全局预算默认 64 条,超预算的标记
`keep_origin` 死信,不无限烧钱)。还有一个反复重试的止损标记:同类英文残留连续被拒就
放弃修复(`english_residue_repeated`),避免同样的 prompt 得到同样被拒的结果。

PaperMirror 当前:段被拒 → 留英文,用户只能整页强制重译。改进:整页完成后收集被拒段,
用**换一种 prompt**("只输出中文译文,不要解释"+更强的术语/上下文)的第二遍小队列修复,
每页设预算上限;仍失败的标记 keep-origin 并在诊断里给出原因,而不是无声留白。

## 三、P1——质量与一致性

### 4. 术语表 + 文档记忆(matched 注入)

retain-pdf 支持用户词汇表(CSV 导入/内联)和**自动文档记忆**(翻译过程中沉淀的术语),
但默认都是 `matched` 模式——只把**当前段命中的**条目注入 prompt,不整表塞入;硬约束
术语(preserve/canonical)走占位符保护而不是 prompt 恳求。

PaperMirror 完全没有术语机制,长论文里同一术语前后页翻得不一样是必然的。落点:
翻译首页/摘要后提取核心术语(或直接用首次译文建立 术语→译名 映射,存进文档级缓存),
后续页命中才注入;设置页加一个可选的用户词汇表(纯本地存储,符合隐私约束)。这正是
审核报告里"翻译一致性"一项的具体解法。

### 5. 跨页段落续接(continuation hint)

retain-pdf 的 provider 适配层把"哪些块属于同一段"归一成 `continuation_hint`
(`role: head/middle/tail`,`scope: intra_page/cross_page`),翻译层对跨页续接**受控消费**:
不合并块,只把上一段尾部作为上下文注入。

PaperMirror 按页翻译,页尾断句的段落(以逗号/连字符结尾)和下一页开头各自独立成段,
译文衔接生硬。落点:提取层已有页级几何,页尾块 `endsSentence=false` 时记录尾巴文本,
下一页首块翻译时注入为上文——**只注入上下文,不跨页合并 overlay**,与整页一次提交的
反闪烁原则不冲突。

### 6. 页面基准字号 + role_min 统一

retain-pdf 有一篇专门的算法参考文(`doc/reference/font-scaling/`),核心三层:
先按**页面密度**(行高、行距、单位宽度容纳字符数)定一页的"基准字号锚点";再按**块的
框形**(宽窄、译文膨胀比)围绕锚点微调;最后 `font_unify_mode=role_min` 把同页同角色
(正文/图注)统一到该角色的最小字号,保证整页协调。另有 `body_font_size_factor`、
`body_leading_factor` 两个全局倍率暴露给用户。

PaperMirror 已有 `replacementFontSize`(段内正文簇最小字号),但没有页面级锚点,也
没有角色级统一——同页相邻两段译文字号可能不同,视觉上发花。落点:overlayLayout 排版
前按页收集正文簇字号取锚,正文段统一用 min(锚点, 自身簇最小);设置页加字号/行距倍率
两个滑块(用户一直有"译文偏大/偏挤"类反馈时可自救)。

### 7. 段级诊断面板 + 单段重译(replay)

retain-pdf 每次运行落盘 `translation_diagnostics.json`(队列拆分、真实并发峰值、重试
统计)、逐 item 的 debug index,并提供 **replay 单条**的调试接口(不建新任务、同步调用、
脱敏)。它的失败结构也是结构化的:`failure_code / category / summary / detail / retryable`。

这正是我们当前迭代最缺的:每轮问题都靠用户截图倒推。落点:

- 面板加"本页诊断"视图:每段状态(已译/被拒-原因/已修复/keep-origin)+ 该页请求数、
  重试数、限流次数;
- 右键单段"重译此段"= replay,不清整页缓存;
- "导出诊断"生成一个脱敏 JSON(绝不含 key 与全文,符合隐私约束),用户贴回来代替截图。

## 四、P2——按需做

- **自定义翻译规则**:retain-pdf 有 `rule_profile_name` + `custom_rules_text`(按学科
  预设 + 用户自由补充规则文本进 prompt)。PaperMirror 可加一个"自定义提示词补充"多行
  文本 + 不译词列表(不译词直接进占位符保护,比 prompt 恳求可靠)。
- **context_bleed 校验**:retain-pdf 把"上下文被翻进当前块"列为阻塞性质量问题。我们
  给 module 续接块注入上下文时应加同样校验(译文长度/内容与上下文重叠度异常即拒)。
- **上下文按需注入(context_mode=needed)**:只有续接段、图注、碎片段才带前后文,完整
  正文段不带——省 token、提速,也降低 context bleed 概率。PaperMirror 目前对所有 chunk
  预计算上下文,可改为按段特征决定。
- **表格开关**:当前"整表保护"等价于 retain-pdf 的表格开关关闭档;做到 TableLayout
  逐格翻译后,把"翻译表格"做成显式开关。
- **失败结构化**:错误对象统一 `code/category/retryable`,胶囊与错误提示按 retryable
  决定是否给"重试"按钮(现有 Retry-After/超时分类已有雏形)。

## 五、明确不做(与项目约束冲突)

- 扫描件 OCR:依赖外部 OCR provider 或本地重型模型,与"纯插件、BYOK、无遥测"冲突;
  如未来要做,唯一可接受形态是既有的 loopback-only 本地服务模式。
- 重排出独立 PDF:与阅读器内覆盖的产品定位冲突;导出需求已有的"双语对照导出"路线即可。
- 多 key 轮换、服务端任务队列:此前已明确不做(ToS/架构)。

## 六、建议落地顺序

| 批次 | 内容 | 对应症状/审核项 |
| --- | --- | --- |
| 1 | 占位符保护 + 残留校验只看散文 | 公式误翻、斑马纹误拒 |
| 2 | 小段合批 + 三分道调度(并入已排期的分块级任务) | 速度太慢 |
| 3 | 拒收段修复链路(预算制)+ keep-origin 标记 | 留英文段 |
| 4 | 术语记忆 + 用户词汇表 | 术语一致性 |
| 5 | 页面基准字号 + role_min + 用户倍率 | 排版观感 |
| 6 | 段级诊断面板 + 单段重译 + 脱敏诊断导出 | 迭代效率 |
| 7 | 跨页续接上下文、context_bleed 校验、自定义规则 | 长文质量 |
