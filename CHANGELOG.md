# Changelog

All notable changes to PaperMirror for Zotero are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays below `1.0.0`, the reading UI is still settling and
minor releases may change defaults.

## [Unreleased]

- Planned (needs real-PDF validation): build a unified PageLayout before any
  merging; detect tables at extraction time with stable per-cell ids so the
  translator receives text cells; make region coalescing table-structure-aware
  instead of removing it; run page extraction on its own local queue so a slow
  PDF.js call never occupies a provider concurrency slot.

## [1.0.1] — 2026-08-15

### Fixed(每翻一页都要手动点圆环)

- **提取悬挂不再卡死自动翻译.** 0.9.22 把页面提取移出服务商并发槽时,提取阶段
  同时脱离了空闲看门狗:预取一个**尚未渲染**的页面时,PDF.js 文字提取可能永久
  挂起——该页状态永远停在"读取中"(之后每次访问都被提前返回拦下,什么也不做),
  两个悬挂更会占满 2 槽提取信号量,后面所有页面无限排队;切页时又清掉过期任务,
  胶囊落回"点击圆环翻译本页"。表现即为:**每到新页面必须手点圆环**(点击等于
  删状态重来,而此时页面已渲染、提取秒过)。
- 修复:提取阶段加 20s 超时——超时立即释放信号量槽位并**遗忘该页状态**,下次
  滚动到该页自动重跑完整流程,无需任何点击;僵尸提取在后台自然结束、结果按
  "已被取代"丢弃。另加保险:状态卡在"读取中"超过 2×超时的页面,访问时直接
  替换重跑,不再被提前返回拦截。
- 新增 2 组回归测试(悬挂超时后自动重试、双悬挂不饿死后续页面)。
  全套 529 项通过。

## [1.0.0] — 2026-08-15

### 正式版

0.9.x 系列三十余个版本的收敛点。相对 0.9.2 时代,1.0.0 的翻译内核、调度器、
版面识别与诊断体系均已重写:占位符保护与清单校验、copy-dominance/截断/混合
残留判定、三分道调度与公式风险路由、纯文本兜底与 keep-origin 止损、文档术语
记忆、跨页续接、页面基准字号、段级诊断与单段重译。全套 527 项单元测试。

### 致谢 (Acknowledgements)

本项目多项核心算法参照并移植自开源项目
**[RetainPDF](https://github.com/wxyhgk/retain-pdf)**(作者 **wxyhgk** 及
RetainPDF contributors,MIT 协议):译文质量判定规则(copy-dominance、截断、
混合残留、数据密集与署名豁免、协议壳检测)、公式密集风险评分,以及占位符保护、
分道调度、修复链路、术语记忆、跨页续接、页面基准字号等设计思想。诚挚感谢原
项目和作者的开创性工作。按 MIT 协议要求,完整版权与许可声明收录于新增的
`THIRD-PARTY-NOTICES.md`;移植文件(`src/translation/residueRules.ts`、
`src/reader/formulaGuard.ts` 相关部分)已内嵌来源与协议标注。README 许可
章节同步致谢。

## [0.9.31] — 2026-08-15

### Changed(retain-pdf 源码级核心算法移植)

深读 retain-pdf 源码(`llm/validation/english_residue.py`、`quality.py`、
`segment_risk.py`、`protocol_shell.py`),把其在真实失败样本上磨出来的判定规则
逐条移植进对应模块:

- **copy-dominance 判据.** "未翻译/混合残留"的硬判据改为表面相似度:归一化
  英文表面(小写、去标点)与原文相似度 ≥0.82 才算"抄的"——标点大小写变化藏
  不住回声,而真翻译永远不会相似。新增 `residueRules.ts` 纯模块。
- **混合残留硬拒.** 长段落整体中文占比达标、但结尾仍拖着一句 ≥12 词且与原文
  copy-similar 的英文——比例检查看不见它,现在拒收进补救链。
- **截断硬拒.** 原文 ≥200 字符而译文不足其 15%(EN→ZH 正常 0.3–0.5)必是
  半截/尾巴输出,原先比例检查会把一小段全中文的残缺译文当"已翻译"存下。
- **两项误拒豁免.** 数据密集片段(数字 ≥ max(6, 字母×0.35),NMR 谱线/数值串)
  永不算残留;作者署名行(≥3 段、每段 2–5 个人名词)合法保留拉丁文。
- **残留检测跨度规则.** 除既有的 6 连小写词规则外,新增 ≥30 字符、≥10 词、
  像散文且非数据密集的拉丁跨度判定——Title-Case 残留句(原规则刻意跳过大写词)
  现在也能触发补译。
- **公式密集评分路由.** 慢道判据从"占位符 ≥5"升级为 retain-pdf 的风险评分:
  定义句触发短语(defined as / denoted as / where …)+3、占位符 ≥4/≥8 各 +2、
  散文 ≥180 字符 +1、密度阈值 +1/+1、占位符前置/中置 +1/+1;占位符 ≥4 且
  总分 ≥6 即入慢道——比单纯计数更早识别高风险块。
- **协议壳检测.** 纯文本兜底若返回 JSON 信封则从中恢复译文,若返回"请提供
  原文"类提示语则按失败处理——两者都不再可能被当成译文存储。
- 新增 12 组移植对照测试。全套 527 项通过。

## [0.9.30] — 2026-08-14

### Added(参照 retain-pdf 批次7:跨页续接 + context_bleed + 不译词列表)

- **跨页段落续接.** 上一页末段以逗号/未完句结尾、或本页开头像续接(小写/标点开头)
  时,上一页尾部原文(≤600 字符)注入为本页第一批的理解上下文——只注入上下文,
  不跨页合并块,逐页覆盖与整页一次提交的契约不变。译文衔接不再生硬。
- **context_bleed 校验.** 注入了上下文的批次,其**首块**译文若长得离谱(CJK 字数
  超过原文单词数×2.4,含下限),判定为"上下文被翻进当前块",拒收并经无上下文的
  补救链重新获取。
- **不译词列表.** 设置页新增多行输入:产品名、算法名等必须逐字保留的词,发送前
  经占位符掩蔽、译后原样还原——比 prompt 恳求可靠。每行一个,# 开头为注释。
- 新增 3 组回归测试(bleed 判定、跨页尾巴注入、不译词掩蔽往返)。全套 515 项通过。

## [0.9.29] — 2026-08-14

### Added(参照 retain-pdf 批次6:段级诊断 + 单段重译 + 诊断导出)

- **右键"重译此段".** 左右对照页的任意译文段右键即单独重译:一个前台单块请求,
  清除该段的 keep-origin 标记与止损记忆,成功后就地替换并写入缓存;进行中段落
  呼吸闪烁,完成后胶囊提示。不再需要为一段错译强制重译整页。
- **页级诊断采集.** 每页记录真实请求数、补救数、429 限流数、超时数、段缓存命中、
  耗时(`state.diagnostics`);段级状态(已译 / unrecovered / repeated-failure)
  可查。
- **一键脱敏诊断导出.** 面板菜单栏新增"诊断"按钮:整文档逐页诊断 JSON 复制到
  剪贴板——只含状态、计数与原因,**不含任何正文、译文、密钥、URL**。以后排查问题
  贴 JSON 即可,不用截图倒推。
- 新增 2 组回归测试(429 计数与导出脱敏、单段重译清除 keep-origin)。
  全套 512 项通过。

## [0.9.28] — 2026-08-14

### Added(参照 retain-pdf 批次5:页面基准字号 + 用户倍率)

- **同页正文统一到页面基准字号(role_min).** 左右对照的重排页里,正文段不再各用
  各的提取字号——按页取"中位数带内的稳健最小值"为锚点,所有正文段统一到锚点,
  相邻段落大小不再发花;标题、图注保持自己的字号。零星的 6pt 上标碎片或 14pt
  首行样式拖不动锚点。
- **译文字号/行距用户倍率.** 设置页"阅读界面"新增两个倍率下拉(0.8×–1.3×):译文
  偏大/偏挤时整体微调。左右对照页完全生效;覆盖模式受原文框约束,倍率只在缩小方向
  生效(放大由适配器按框裁定)。行距经 CSS 变量作用于正文/标题/图注三档。
- 新增 2 组回归测试(稳健最小值锚点、倍率解析与钳制)。全套 510 项通过。

## [0.9.27] — 2026-08-14

### Added(参照 retain-pdf 批次4:文档术语记忆)

- **同一术语全文一致.** 新增文档级术语记忆:译文中出现标准首现形式「中文术语(ABBR)」
  且缩写确实存在于原文时(防幻觉交叉校验),该词对被记住;后续页面凡命中此缩写的请求
  自动注入为**参考性**术语规则——第 12 页的 CEUS 从此和第 2 页译得一样。
- 首现优先(论文自己的首次展开是权威),统计缩写(CI/OR/HR/SD 等)与单大写字母
  排除,上限 200 条防膨胀;换语言/换服务商时清空。**用户词汇表始终优先**于记忆
  (matched 合并注入,不整表塞 prompt)。
- 新增 6 组回归测试(抽取、防幻觉、停用词、首现优先、容量上限、跨页注入)。
  全套 508 项通过。

## [0.9.26] — 2026-08-14

### Added(参照 retain-pdf 批次3:拒收段修复链路)

- **纯文本兜底重译.** 被 JSON 链反复拒收(回声、半翻、丢 id)的段落,在整页收尾时
  获得最后一次**纯文本模式**请求:系统提示只要求"只输出译文本身",响应整体即译文,
  JSON 包裹和 id 漂移不可能再让它失败。每页预算 4 段,计入页请求上限。原则同
  retain-pdf:「该翻的段不允许以空译文结束」。
- **keep-origin 止损.** 连续两轮整页运行仍失败的段落记入止损记忆,后续访问直接标记
  keep-origin 跳过——不再每次翻页都为注定失败的段落重复烧请求。**强制重译**清空
  止损记忆,给所有段落重新机会。段级状态记入 `state.keepOrigin`(原因:
  unrecovered / repeated-failure),为批次6的诊断面板铺路。
- 纯文本模式下不再强制 JSON 输出(response_format / responseMimeType 按模式切换),
  三家 LLM 适配器 + Gemini 原生接口统一接入。
- 新增 5 组回归测试(纯文本解析、纯文本 prompt、兜底拯救、止损跳过、空响应抛错)。
  全套 502 项通过。

## [0.9.25] — 2026-08-14

### Changed(参照 retain-pdf 批次2:三分道调度)

- **高风险块隔离进单块慢道.** 表格、超长段(>2400 字符)、公式密集段(≥5 个保护
  token)不再混入 24 块的大批次:一个难块的 id 漂移或截断曾让整批重试,现在它单独
  成请求、排在快批之后——快批先回来把页面的大部分先画出来,难块慢慢来。
- **慢道不参与位置上下文.** 慢道块脱离阅读序,既不接收也不提供前后文——孤立难块
  不需要邻居的尾巴,错误的邻居比没有更糟。
- 新增 3 组回归测试(风险块隔离、无 riskOf 行为不变、公式密集块单独成请求)。
  全套 497 项通过。

## [0.9.24] — 2026-08-14

### Added(参照 retain-pdf 批次1:占位符保护体系)

- **引用标记与统计量进入占位符保护.** 原先只有公式(LaTeX 定界 + 符号密集判定)被
  替换为 ⟦PMn⟧ token;现在方括号数字引用 `[12,15-18]`、p 值 `p = 0.003`、置信区间
  `95% CI: 0.71–0.94`、均值±偏差 `34.2 ± 5.1`、样本量 `n = 342` 也在请求前掩蔽、
  译后逐字回填——模型再也无法改写或漏掉它们。
- **占位符清单校验.** 译文丢失 token(⟦PMn⟧ 与裸 PMn 均认)或凭空多出 token 的响应
  按无效处理,进入既有的重试/补救链,而不是无声还原成缺公式的段落。刻意**不校验顺序**
  ——目标语言重排引用位置是合法的翻译行为。
- **"疑似未翻译"校验改为只看散文.** 统计密集行(数值、引用、单位在完美译文里本来就
  与原文逐字相同)以前把拉丁字符比例拉低而被误拒留在英文——斑马纹的一半成因。现在
  比例计算前先剥掉可保护片段,只对散文部分打分;短统计行掩蔽后直接过闸不再误判。
- `protectFormulas` 支持外部字面量列表(为批次7的"不译词列表"铺路,掩蔽比 prompt
  恳求可靠)。
- 新增 6 组回归测试(掩蔽往返、清单校验、散文剥离、统计密集行通过校验、回声仍被拒、
  不译词掩蔽)。全套 494 项通过。

## [0.9.23] — 2026-08-14

### Fixed(双栏识别第五批:三栏首页左中两栏逐行中英夹杂)

- **一根悬垂矩形不能再把两栏"焊"成一条带.** 三栏排版的栏距比双栏窄(约 12–15pt),
  只要有一行连字符悬垂几 pt 伸进栏距(或栏距本身窄于链式阈值 11pt),贪心链式列检测
  就把左、中两栏焊成一条带:列标注塌掉 → 规范阅读序失效 → 两栏文字按基线交错成
  逐行小块 → 逐行翻译后一半被"疑似未翻译"校验拒收留在英文——正是 Radiology 首页
  左中两栏中英夹杂、而第三栏完好的原因。现在每条带内做**覆盖投票**(与栏距投票同一
  思路):≥90% 成员避开的、宽 ≥6pt 的内部空白通道判定为栏距,带在此处拆开;悬垂
  矩形归属自己一侧,其突出边缘不再把带拉伸过栏距。参差右缘、缩进首行、零星矩形均
  无法触发拆分,普通单栏/双栏页行为不变。
- **列标注改由行级矩形推导.** 原先最终标注用"段落并集矩形"重新检测列——一页只有
  几个段落,数量不足以投票,一个悬垂段落并集又会在标注环节把两栏重新焊死;两条提取
  路径均改用行级矩形(数量足、粒度细)。
- **投票栏距上的连字符悬垂不再把左右两行拼成一行.** 行分组允许前一行超过栏距中心
  ≤0.6em 的悬垂仍按跨栏处理。
- 新增 3 组以该页真实形态为原型的回归测试(反焊接、焊接矩形下三栏各自成段、
  普通单双栏不被误拆)。全套 488 项测试通过。

## [0.9.22] — 2026-08-14

### Fixed(审核报告第 2+3 步:调度第二批 + 进度真实化)

- **页面提取不再占用服务商并发槽.** 提取(PDF.js getTextContent 等)从翻译任务里拆出,
  改在**独立的提取信号量**(并发 2,当前阅读页优先)中先行完成,拿到块后才进入服务商
  队列。原先一次慢提取会白白占住一个 API 并发槽,后面所有页面跟着排队——三症状里
  "速度太慢"的调度层主因之一。
- **429 限流按服务器指示退避.** HTTP 客户端现在读取 `Retry-After` 响应头(秒数或
  HTTP 日期均可,上限 120s)并透传到错误对象;重试等待改为
  `max(Retry-After, 2.5s)`,不再固定盲等。同时新增调度器公开接口
  `laneFeedback`:每次成功/限流/超时都实时驱动自适应并发的升降,而不是只在整页任务
  结束时才反馈一次。
- **取消或超时的页面保留已译段落(增量持久化).** 整页任务被取消、超时或中途失败时,
  已完成分块的译文现在**立即写入存储**;重新打开该页时这些段落直接命中缓存,只补译
  剩余部分。原先一个分块超时会让同页已成功的几千字全部作废重来——"大文本卡住后
  又从头再来"的直接原因。
- **状态胶囊显示真实阶段.** 提取阶段显示"正在读取 第 x / y 页"(副行"正在读取页面
  文字"),拿到分段后才显示"正在翻译";排版阶段在尚未落下任何段落时用不确定动画,
  避免"0/0 段"的假进度。切页时清除上一页遗留的过期"翻译中"任务提示。
- **几何收尾两处.** 栏间距检测的覆盖标记改为精确取整(消除 1px 级误差把窄间距抹掉的
  问题),最短间距游程收紧为 6;区域合并器 canMerge/canAbsorb 现在**尊重列标注**——
  两块分属不同列时无论几何测试怎么说都拒绝合并(审核项:一个坏 union 矩形曾污染整页
  后续几何判断)。
- 新增回归测试:提取信号量并发上限、取消页增量持久化;更新胶囊阶段文案断言。
  全套 485 项测试通过。

## [0.9.21] — 2026-08-10

### Fixed(双栏识别第四批:中英逐行"斑马纹"页)

- **流序逐行交错的双栏页现在能正确拼段.** 不少 PDF 按"行"输出双栏(左一行、右一行交替),
  而区域合并器只合并**相邻**块——交错后同栏邻居永不相邻,一行一个块永远拼不回去,逐行翻译
  后统计密集的行又被"疑似未翻译"校验拒收留在英文,形成中英逐行斑马纹。新增**规范阅读序**
  (`readingOrder`):全宽块作为水平分隔把页面切成若干"段带",每带内按 左栏自上而下 → 右栏
  自上而下 输出,再进入合并器。顺带修复了审核项"页中全宽块(跨栏表题)被排到整个右栏之后"。
- **逐行乱打的段落断行标志不再被信任.** 某些 PDF 给几乎每一行都打 `paragraphBreakAfter`
  (行数≥8 且 >80% 带标志时判为无信息量),此时忽略标志、完全由几何决定分段——原先它被
  当作权威信号,一页被切成逐行块。
- 新增 4 组以"斑马纹"真实形态为原型的回归测试(交错重排、重排后并段、页中全宽块定位、
  假断行标志)。

## [0.9.20] — 2026-08-10

### Fixed(双栏识别第三批:按内容剔除出版商样板文字)

- **首页居中的 reprint 声明不再毁掉整页.** "This copy is for personal use only. To order
  copies, contact reprints@rsna.org" 在第 1 页常出现在**页面中部**(摘要附近)——不在上下 6%
  家具区内,0.9.18 的位置过滤看不到它,它照旧横跨栏间距把双栏桥接成单栏。位置不可靠,改用
  **内容识别**:reprint/personal use/Downloaded from/© 年份/all rights reserved 这类出版商
  样板行,**无论出现在页面何处**,都在进入栏检测之前整行剔除(两条提取路径一致),它们也
  不再被翻译。行长上限 180 字符——正文中"引用"这类句子的长段落不受影响。
- 新增 2 组以第 1 页真实形态为原型的回归测试(页中部居中声明不桥接双栏、样板行不成块)。

## [0.9.19] — 2026-08-10

### Fixed(双栏识别第二批:边框硬屏障)

- **图框成为提取阶段的一等公民.** 操作符列表得到的真实图片矩形此前只用于渲染,提取器
  看不见它们——图内文字("X-rays"、"Low keV" 等图注标签)混入正文流,相邻两图的题注隔着
  图框互相融合,一个坏合并的联合矩形随后吞掉半页(用户实拍 Radiology 三栏图文页确认)。
  现在图框在提取全程生效,三条硬规则:
  1. **框内文字不进翻译流**(≥60% 落在图内的行判为图表标签,保留原样);
  2. **隔框的行永不合并成段**(段落构建与修复合并均被图框强制断开);
  3. **区域合并器见框即停**(canMerge/canAbsorb 对被图框分隔的区域直接拒绝)。
- 图框获取为 best-effort(2.5s 超时、按页缓存),拿不到时行为与旧版完全一致。
- 新增 figureBarriers 纯函数模块与 4 组回归测试(以该真实页面几何为原型)。

## [0.9.18] — 2026-08-10

### Fixed(双栏识别第一批,由真实 RSNA 页面验证驱动)

- **居中的页脚/页码不再把双栏"桥接"成单栏(P0,用户实拍页面确认).** 页底居中的
  "This copy is for personal use only…" 这类边界文字宽度不足 62% 全宽阈值、又横跨栏间距,
  被贪心链连带后左右栏合成一个带 → 整页判单栏 → 右栏被"缩进"规则切成逐行碎片(截图中
  一行一句的断裂形态)。现在栏检测**排除页面上下 6% 区域内的行**和 **<5% 页宽的小矩形**
  (页码、公式号、首字下沉),它们不再参与投票。
- **栏左缘改用成员行左缘的中位数(P0).** 原取最小值,一个悬挂缩进/项目符号就把左缘拉低
  ~1em,之后全栏每行都判"缩进"而逐行断段。
- **文字层回退路径补上 column 标注(P0)**,语义模块不再在该路径下跨栏;两条提取路径对
  同一页的输出趋于一致。
- **文字层栏距回退阈值 2.5em → 1.6em.** 10pt 正文下旧阈值 25pt 大于常见 18–24pt 栏距,
  左右栏同基线的行被直接拼接(跨栏乱序的经典来源);两端对齐的词间距不超过 ~1.3em,
  1.6em 仍不会把句子从中间切开。
- **只剩碎条带时报告"无栏"**(整页单栏流)而不是把页码带当成栏(旧行为使每行恒判
  wrapped 或 indented)。
- 新增 5 个以该真实页面几何为原型的回归测试。

## [0.9.17] — 2026-08-10

### Fixed(全代码审核后的大文本卡住/提速修复)

- **看门狗改为「空闲心跳 + 真正中止」.** 旧看门狗量的是页面总时长(120s),大页面所有请求都
  成功也会被杀;且它只拒绝 Promise 不中止任务——超时后 translatePage 变成僵尸继续发请求、
  取消无效、还会把已判错的页面改回 done,并误罚服务商并发。现在:每个完成的请求(含提取)
  都会重置 150s 空闲时钟,只要页面在推进就永不误杀;真挂起时通过本地 AbortController
  **真正中止**全部在飞请求,并以 TIMEOUT(而非 CANCELLED)上报。
- **请求超时随文本量缩放.** 固定 60s 对 8000 字符批次在慢/思考模型上结构性不足(真实生成
  需 70–200s)。现在按 `20s + 12ms/字符` 缩放、封顶 120s(< 空闲看门狗 150s);单块补救仍
  是小超时。TIMEOUT 类错误只重试一次——烧满整个超时的请求再重试通常还是超时,这正是
  旧版"卡住几分钟"的来源。
- **页内批次 2 路并行.** 审核确认批次请求只依赖原文(上下文预生成),不依赖上一批响应,
  因此当前页的多个批次并发发送(上限 2)——多批大页面的墙钟时间约减半,也不再因"串行总和
  超过看门狗"而全体失败。
- **英文残留补译纳入请求预算**(逐块检查,预算耗尽即停,不再在封顶之外追加最多 8 个串行请求)。
- **Anthropic 输出上限 8192 → 16384**,且思考预算改为**加在输出之外**(原先从 max_tokens 里
  扣走一半,大批次 JSON 截断 → 不可重试错误 → 整批丢失)。

### Notes

- 本版为三症状审核(大文本卡住/速度慢/双栏识别)中"引擎层安全可修"的部分。其余已定位、
  待真实 PDF 验证的项:整页对照的渐进显示(目前 done 前隐藏全部译文)、提取移出服务商并发槽、
  429 的 Retry-After 透传、增量持久化、以及双栏几何缺陷族(居中页码桥接栏检测、band.left
  取最小值致逐行断段、文字层路径缺 column、三套同栏判定不一致等)。

## [0.9.16] — 2026-08-10

### Changed

- **模型下拉只显示纯模型 ID(Bob 插件风格).** 移除所有「需付费档」「预览」等文字标注 —
  Gemini 与通义千问的残留标注全部清掉,下拉里就是干净的模型名。账户档位不足时由
  连接测试的错误提示说明("当前账户不可用,如免费档限制"),不再写进列表。
- 「自定义模型」输入框的提示语随服务商变化(如 Gemini 下显示 `e.g. gemini-2.5-flash`)。

## [0.9.15] — 2026-08-10

### Changed

- **Gemini 改走 Google 原生 generateContent API(参照 Bob Gemini 插件设计).**
  Base URL 默认 `https://generativelanguage.googleapis.com`(便于代理转发,同
  bob-plugin-gemini);请求打到 `/v1beta/models/{model}:generateContent`,Key 走
  `x-goog-api-key` 头(绝不进 URL/日志)。带来的实质改进:
  - 「深度思考」用**一等公民** `thinkingConfig`:禁用思考 → `thinkingBudget: 0`,
    自动思考 → `thinkingBudget: -1`(此前经 OpenAI 兼容层二手模拟);
  - 严格 JSON 输出用官方 `responseMimeType: "application/json"`;
  - 温度 / 最大输出 token 进 `generationConfig`(温度默认 0);
  - 连接测试关思考 + 小输出上限,更快更省。
  自定义 API Path 仍可整体覆盖路径(网关场景)。

### Removed

- **仓库清理**:删除 5 个历史版本发布说明(`发布说明-0.9.x.md`)——内容已完整存在于
  CHANGELOG.md 与 GitHub Releases;`.gitignore` 新增会话传输包(`pm-*.tgz`)与
  版本发布说明的忽略规则,仓库根目录不再越积越杂。

## [0.9.14] — 2026-08-10

### Changed

- **Gemini 改用独立的「深度思考」开关(与 GPT 的推理档位不同).** Gemini 的思考控制是
  开关语义而非强度阶梯,现在按 Bob 的设计单独显示:默认设置 / **禁用思考** / **自动思考**。
  映射到 Google 官方接口:禁用思考 → `reasoning_effort: "none"`;自动思考 → 动态思考预算
  (`extra_body.google.thinking_config.thinking_budget: -1`);默认设置不下发。翻译建议
  「禁用思考」(更快更省)。GPT 系(OpenAI/OpenRouter)保持 minimal…xhigh 档位不变;
  旧存的 minimal 在 Gemini 下自动显示为「禁用思考」。

## [0.9.13] — 2026-08-10

### Fixed

- **Gemini 只有 2.5-flash / 2.5-flash-lite 可用.** 根因是 Google 2026-04 收紧了
  API 免费档:Pro 与 3.x 系模型转为付费档专属,免费 Key 仅开放 2.5-flash / lite。
  默认模型改回对所有账户都可用的 **`gemini-2.5-flash`**;3.x 与 Pro 保留在列表中并
  标注「需付费档」。连接测试的"模型不存在"提示补充了"当前账户不可用(如免费档限制)"
  这一常见原因。

## [0.9.12] — 2026-08-10

### Changed

- **模型下拉取消分组标题.** The model picker is now a FLAT list (still ordered
  推荐 → 高质量 → 快速 → 预览 → 旧版) ending in 自定义模型… — no category headers.
- **推理强度改为官方英文取值.** 默认设置 / minimal / low / medium / high / **xhigh**
  (xhigh 为 OpenAI gpt-5.4+ 的官方档位)。映射:OpenAI/OpenRouter → 原样下发
  `reasoning_effort`;Gemini → minimal→`none`、xhigh→`high`;Anthropic → high/xhigh
  启用 extended thinking;其它服务商不下发。
- **最大输出 token 改为下拉选择.** 默认(不限制)/ 1024 / 2048 / 3072 / 4096 / 8192。
  批量翻译仍建议保持默认以免 JSON 截断丢段。
- **温度默认 0.** 翻译确定性最好。未显式设置时,对安全的服务商默认下发
  `temperature: 0`(deepseek/qwen/zhipu/moonshot/siliconflow/groq/gemini/ollama/
  兼容端点/Anthropic 非思考模式);OpenAI 官方端点与 OpenRouter 不注入默认值
  (gpt-5.x 仅接受默认温度),显式设置则始终照发。

## [0.9.11] — 2026-08-10

### Added

- **每个服务商的高级参数(Bob 风格,全部选填).** 在「模型/地址」下新增「高级参数」区,按各家
  官方 API 适配,**均为选填——不设置则请求体与之前完全一致(零回归)**:
  - **推理强度 / 思考**:默认 / 最低 / 低 / 中 / 高。翻译建议设「最低」——gpt-5.x、Gemini、
    Claude 等推理/思考模型会更快更省。映射:OpenAI/OpenRouter → `reasoning_effort`;
    Gemini → `reasoning_effort`(「最低」→ `none` 关闭思考);Anthropic → 仅「高」启用
    extended thinking;其它服务商暂不下发该参数(避免 400)。
  - **自定义 API Path**:单独的请求路径字段(留空用默认 `/v1/chat/completions` 等),应对特殊
    代理/网关;「实际请求地址」预览会实时反映。
  - **最大输出 token 数**:OpenAI 官方端点用 `max_completion_tokens`,其它兼容端点用
    `max_tokens`;批量翻译建议留空以免截断。
  - **温度 temperature**:留空用服务商默认(部分新模型只接受默认温度)。
- 每个参数按服务商各自保存;连接测试使用当前(未保存的)高级参数实测;非 LLM 引擎
  (微软/谷歌/DeepL)不显示高级参数。

## [0.9.10] — 2026-08-10

### Fixed

- **gpt-5.x 等新模型"测试连接"误报"模型不存在".** OpenAI 的推理模型(gpt-5.x)在
  chat/completions 上**拒绝旧的 `max_tokens` 参数**,必须用 `max_completion_tokens`。
  连接测试原本发送 `max_tokens: 32`,导致合法的 gpt-5.5 返回 400 并被归类为"模型不存在
  /路径不对"。现在对官方 OpenAI 端点(`openai`)改用 `max_completion_tokens`(对
  gpt-4o 与 gpt-5.x 都适用),其它 OpenAI 兼容端点仍用 `max_tokens`。
  (实际翻译请求本就不带 `max_tokens`,所以翻译可能一直是好的——坏的只是测试。)

## [0.9.9] — 2026-08-10

### Fixed

- **翻页后"卡住很久"的根因:取消整页级自动重试(P0).** 一个页面过去是一个可重试的
  调度任务——可重试错误会把**整个** `translatePage` 重跑(重新提取 PDF、重新分批、重新
  翻译、重新补救),最多 3 次重试 × 300 秒看门狗,最坏接近 20 分钟才真正失败。现在:
  - 页面调度任务 **`maxRetries: 0`**(最多执行一次,绝不整页重跑);
  - 瞬时错误(网络/超时/限流)改为在**单个请求层**重试(最多 2 次、短退避),不再重新提取;
  - 单个 chunk 请求彻底失败**不再拖垮整页**——其区块交给(已封顶的)补救,后续 chunk 继续;
  - 页面看门狗 **300s → 120s**;已翻译的区块始终即时保留。
  - 调度器新增 per-job `maxRetries` 覆盖(默认仍沿用全局值)。

### Notes

- 这是调度架构 P0 的第一项(消除"卡住")。其余 P0/P1——整表"完整保护"、active 页面升级为
  前台(`promoteActive`)、提取队列与 API 队列分离、整页任务拆成 chunk 级任务、真实阶段
  文案——会改动表格几何与调度粒度,需在真实 PDF 上验证,按"我改一块、你装 xpi 实测"推进。

## [0.9.8] — 2026-08-10

### Changed

- **翻译请求计划改造(第一阶段:软边界 + 高填充 + 补救封顶).** 效率优化全部发生在
  请求计划与调度层,页面结构(blocks / ID / 矩形 / 栏位 / 表格边界 / 阅读顺序)完全冻结不动。
  - **语义模块由硬边界改为软边界(上下文标签).** 以前"模块边界 = 请求边界",小标题一多
    就产生 4–8 个半空请求;现在字符预算才是真正的请求边界,普通页尽量打包成 1–2 个高填充
    请求。请求预算从 6000 提到 **8000 字符 / 24 块**,目标填充率 85%。
  - **模块被拆分时,标题作为 `moduleContext` 传给后续批次**(仅供理解,不再要求返回标题译文);
    标题只翻译一次。上下文直接来自原文,两个批次可并行翻译而不丢语义背景。
  - **补救流程封顶,杜绝请求风暴.** 单页总请求数硬性限制为 **初始 chunk 数 × 2 + 2**;达到上限
    即停止自动补救,已成功的译文全部保留,剩余留给「刷新本页」(熔断仍会把该页改投备用服务商)。
    英文残留补译也纳入同一预算,不再无限追加。

### Notes

- 这是调度层重构的第一阶段(高收益、低结构风险),不触碰任何页面几何。后续阶段(当前页双槽
  并行 + 后台预取让路、提取队列与 API 队列分离、不可变 PageLayoutSnapshot 与三层缓存)会改变
  取数/调度时序,需在真实 PDF 上验证,仍列于 Unreleased。
- 提示词只是新增了 `moduleContext` 的"仅理解"说明,输出格式不变,因此不提升 promptVersion
  (不使现有翻译缓存失效)。

## [0.9.7] — 2026-08-10

### Changed

- **模型选择器改版:分组 + 精选清单.** Each provider now offers a curated set of
  *current, paper-translation-suitable text models*, grouped in the picker as
  推荐 / 高质量 / 快速·低成本 / 预览版 / 旧版兼容, then a separator and 自定义模型….
  Image, audio/realtime, embedding, code-only, safety and retiring models are
  deliberately excluded. The list is a picker convenience, never a call
  whitelist — any model you type is still used, and preview models are labelled
  as such.
- **Refreshed default models** (low-latency / stable structured output over the
  strongest/most-expensive): OpenAI `gpt-5.6-luna`, Gemini `gemini-3.6-flash`,
  Anthropic `claude-sonnet-5`, Qwen `qwen3.7-plus`, Zhipu `glm-5`, Kimi `kimi-k3`,
  DeepSeek `deepseek-v4-flash`, Groq `llama-3.3-70b-versatile`, OpenRouter
  `openrouter/auto`, SiliconFlow `deepseek-ai/DeepSeek-V4-Flash`, Ollama `qwen3.5`.
- Retired aliases moved to 旧版兼容 or dropped: Qwen `qwen-plus/max/turbo`,
  Zhipu bare `glm-4-*` (dated ids kept under 旧版), OpenAI `gpt-4.1*`/`gpt-5-mini`.
- OpenAI-compatible / Custom endpoints show only 自定义模型… (unknown backend);
  Microsoft / Google / DeepL show no model field (fixed server-side model).

### Notes

- No account isolation and no online model-list fetching, by design — the
  built-in list plus a custom entry covers it. Model ids are compiled from each
  provider's official docs (2026-08-10); aggregator ids (OpenRouter/SiliconFlow)
  follow their consoles, so the custom entry is always available.

## [0.9.6] — 2026-08-10

### Fixed

- **首次打开慢:当前页被提取两次.** Opening the reader ran `getPageData()` for the
  current page twice back to back — once in `prime()` to measure the body font
  size, then again in `extractPage()` for the real work — up to two 8 s
  round-trips on a slow PDF. `prime()` now keeps that page's char stream and the
  first `extractPage()` of the page reuses it (one-shot; a re-translate still
  re-reads fresh), removing the duplicate round-trip.

### Notes

- This is the first, zero-risk step of the extraction-pipeline review. The larger
  items (table modeling moved ahead of translation with per-cell ids;
  structure-aware coalescing; a separate extraction queue) change table geometry
  and layout and must be validated against real PDFs, so they are staged in
  Unreleased rather than shipped blind.

## [0.9.5] — 2026-08-10

### Fixed

- **内置模型清单里部分模型不可用.** Re-verified every provider's model IDs against
  official docs and replaced retired ones:
  - **OpenAI**: `gpt-5-mini` / `gpt-4o-mini` → the current **GPT-5.6** family
    (`gpt-5.6-luna` default, plus `gpt-5.6-terra` / `gpt-5.6-sol`).
  - **Kimi (Moonshot)**: `moonshot-v1-*` is being sunset and `kimi-k2` / `kimi-latest`
    were discontinued → **`kimi-k3`** (plus `kimi-k2.6` / `kimi-k2.7-code` / `kimi-k2.5`).
    The default Base URL also moved to **`https://api.moonshot.ai`**.
  - **智谱 GLM**: the bare `glm-4-flash` / `glm-4-air` / `glm-4-flashx` aliases are
    retired → the dated IDs **`glm-4-flash-250414`** (free), `glm-4-air-250414`,
    `glm-4-flashx-250414` (plus `glm-4-plus` / `glm-4-airx`).
  - **DeepSeek**: removed the discontinued `deepseek-chat`; keeps `deepseek-v4-flash`
    (default) / `deepseek-v4-pro`.
  - **OpenRouter**: refreshed to current slugs (`deepseek/deepseek-v4-flash-latest`
    default, `deepseek/deepseek-v4-pro`, `google/gemini-2.5-flash`).
  - **Gemini**: added `gemini-3.5-flash` / `gemini-3.6-flash` (2.5-flash still default).
  - **Anthropic**: added `claude-fable-5`. **Qwen**: added `qwen3.7-plus/flash`.
    **Ollama**: suggestions bumped to `qwen3` / `llama3.3` / `gemma3`.
- The catalog remains a *fallback*, never a whitelist — any model you have typed
  yourself is still shown and used; only the built-in suggestions changed.

## [0.9.4] — 2026-08-10

### Added

- **语义模块锚点 (semantic layout modules).** Blocks are now grouped into modules
  anchored on structure — a heading and the paragraphs beneath it, a figure, a
  table, the references section, or a virtual 「column-continuation」anchor for the
  top of a column that continues a section with no heading of its own. A module
  is used only to give the model the section's CONTEXT: every heading, paragraph,
  caption and reference still carries its own id, rectangle and translation and
  is replaced in place independently — modules are never rendered as one merged
  block. New pure module `reader/layoutModules.ts` (`buildLayoutModules`).
- **模块级翻译分批.** Requests are now chunked by module (`chunkByModules`), so a
  heading reaches the model together with its paragraphs instead of being split
  across requests by a blind character budget. Small modules still share a
  request; a module larger than the budget is split but keeps reading order.

### Fixed

- **粗体小标题被当成正文.** Heading detection was size-only, so a bold subheading
  typeset at the body size (very common in medical/《…》journals) was classified as
  a paragraph and merged into the text around it. `classifyBlock` now also uses
  the embedded font weight (`isBoldFontName`): a bold, short, non-sentence line at
  body size is recognised as a subheading. Guarded hard (≤2 lines, <90 chars, not
  ending like a sentence) so bold emphasis inside a paragraph is not promoted.
- **模块不再跨栏.** Each block now records its column; a module never spans the
  gutter, so a right-column heading can no longer be associated with left-column
  body. Figures, tables and the references heading are hard anchors that break the
  running body.

### Notes

- Per-block in-place replacement, rectangles and the strict-fit renderer are
  unchanged — this release changes how blocks are GROUPED for context, not how
  they are replaced. `SourceBlock` gains optional `column` and `moduleId` fields.

## [0.9.3] — 2026-08-10

### Fixed

- **Cross-provider配置串味 (root cause).** Base URL and model were single GLOBAL
  prefs shared by every provider, so a model typed for one provider (e.g.
  `gpt-4o`) stayed in the field after switching to another (e.g. Gemini) and was
  sent there → `INVALID_MODEL` / HTTP 404. Each provider now keeps its OWN Base
  URL / model / custom model in a per-provider profile (`providerProfiles`), and
  BOTH the primary and every parallel provider read from their own profile — no
  more bleed. Old global values migrate ONCE into the currently-selected
  provider only.

### Added

- **Per-provider 模型选择器.** LLM providers show a dropdown of current models
  (recommended first, marked 推荐) plus 自定义模型…; the custom model is saved per
  provider and restored when you switch back. A saved model that is not in the
  built-in list is never dropped — it is shown as the current custom model. The
  built-in model catalog records the date it was checked and cites each
  provider's official docs; it is a fallback, never a whitelist. Fixed MT engines
  (Microsoft/Google/DeepL) hide the field with 「该服务商无需选择模型」.
- **Per-provider Base URL 编辑.** Each provider shows its 默认地址, a
  「当前使用自定义地址」marker when overridden, a 「恢复默认地址」button, and a separate
  「实际请求地址」line computed from the SAME URL builder the transport uses (so the
  preview can never drift). URL normalization avoids `/v1/v1`,
  `/chat/completions/chat/completions`, and the doubled native paths for
  Anthropic (`/v1/messages`) and DeepL (`/v2/translate`).
- **差异化的连接测试.** 「测试」now runs against the LIVE, unsaved Base URL / model in
  the pane and reports a specific reason — API Key 无效 / 模型不存在或路径不对 /
  限流 / 额度不足 / 超时 / 网络错误 etc. The API Key is never printed in any result.

### Changed

- Refreshed default models to current, verified IDs (2026-08-10, official docs):
  OpenAI `gpt-4o-mini` → `gpt-5-mini`, DeepSeek `deepseek-chat` (discontinued
  2026-07-24) → `deepseek-v4-flash`, Anthropic default → `claude-sonnet-4-6`.
  Any model you have saved yourself is untouched.

### Security

- API keys continue to live only in the OS credential store (Mozilla Login
  Manager) — never in `providerProfiles`, never in logs, never in the test result.

## [0.9.2] — 2026-08-10

### Added

- **自定义性能模式 (custom performance mode).** A fourth mode alongside 稳定/自动/
  高速 that sets the max parallel pages PER enabled provider: cloud LLM 1–6
  (default 3), traditional paid MT 1–4 (default 3), Ollama 1–2 (default 1); free
  engines are shown as 1 and locked. Each provider's value is saved separately
  (`providerConcurrency` pref), kept when switching to another mode and restored
  on return; a newly-enabled LLM defaults to 3; safe throttling (429/timeout
  back-off) still applies. 「恢复默认」resets only the concurrency values, not keys
  or provider selection.
- **性能与并行 settings redesign.** Horizontal segmented mode selector (selection
  shown by background + border + the native mark, not colour alone) with a
  description that changes per mode; a 「当前配置」summary card showing 预计并行 N
  页 · 当前页优先 (· 自动调节中 in auto), per-provider chips (wrapping, free chips
  dimmed), and an explicit line for why the real parallelism can be below the
  global ceiling (全局上限 vs 服务商能力合计). Custom mode expands per-provider
  page-limit rows. The summary updates immediately on any change.

### Notes

- The global 最大并行页面数 (1–24, default 12) and the actual-parallelism rule
  `min(global, Σ lane caps, schedulable pages)` are unchanged from 0.9.0; the
  wording avoids implying throughput always multiplies by provider count.

## [0.9.1] — 2026-08-10

### Fixed

断句与残留 (in-page segmentation):

- **行尾断词不再残留 (line-break de-hyphenation).** Line-broken words rejoin across
  all four hyphens — `-` `­` `‐` `‑` — when a Latin letter sits on both sides, so
  `sen-`/`sory` → `sensory` and no more `ional` / `est` / `sory` fragments. The
  span path joins a paragraph's lines with `joinLines()` (de-hyphenate + CJK
  without spaces) instead of a naive space-join; the char-stream path was widened
  to the same hyphen set and both letter cases.
- **编号列表不再误判为大标题 (numbered list vs section heading).** A single-level
  `1.` / `2)` / `10.` at body font size is a list item; a larger numbered line
  (`3. Model Architecture`) or a multi-level `1.1` / `4.6.1` is a heading. A
  short numbered list at a page foot is no longer read as a title.
- **段内英文残留局部补译 (local English-residue re-translation).** A block that
  passed validation but still carries a run of 6+ consecutive untranslated
  English words is re-translated ON ITS OWN (single-block request, capped 8/page)
  and patched in place — the block is replaced only if the retry clears the
  residue, and the page is never re-extracted or wholesale re-rendered.

对照同步 (side-by-side sync):

- **换页不再跳到页首 (no snap on page change).** A page change no longer forces the
  pane to the new page's top; the continuous updateviewarea → anchor sync keeps
  the two sides aligned to the reader's exact position, so page transitions are
  smooth. Page-change now only updates the label and translation priority.
- **锚点不再被截断 (untruncated scroll anchor).** The page scroll ratio is no longer
  clamped to 0–1, so a partly-visible page maps to the real position instead of
  snapping to an edge (drift-free across many pages because each page anchors on
  its own offset).
- **右页尺寸取自左页实际像素 (right page matches the left page's actual size).** The
  pane's display scale is derived from the current PDF page's real rendered
  `clientWidth` rather than re-deriving from PDF-points × viewport scale, so
  corresponding pages match within ~1px.

### Deferred

- Absolute-positioned page labels (step 6) — the per-page anchored sync already
  prevents cumulative drift, so this was unnecessary for correctness and would
  have required an `offsetParent` refactor; left as-is.
- True cross-page sentence merge (step 8) — kept out per the review's own
  recommendation; the next visit re-runs; a cross-page 断词 is de-hyphenated
  within a page but not merged across the page boundary yet.

## [0.9.0] — 2026-08-10

### Added

- **性能模式:稳定 ｜ 自动(推荐) ｜ 高速 (performance modes).** 「性能与并行」now
  has three modes that control how EACH provider runs — its per-lane
  concurrency band, prefetch reach and dynamic throttling:
  - **稳定** — free 1 / cloud LLM 2 / local 1 / paid-MT 2; prefetch +2/−1. Fewest
    requests, highest success rate, least likely to hit limits.
  - **自动(默认)** — free 1 / cloud LLM 3→6 / local 1→2 / paid-MT 3→4; prefetch
    +min(2N,10)/−1. Each lane grows on sustained success and backs off on
    429/timeout, per provider.
  - **高速** — free 1 / cloud LLM 6 / local 2 / paid-MT 4; prefetch +12/−2. Fills
    each provider's capacity and prefetches aggressively; still auto-throttles on
    429/timeout and never exceeds a provider's own limit or the global ceiling.

### Changed

- **「最大并行页面数」改为纯全局上限 (global ceiling, no more 0=自动).** Now a plain
  number 1–24 (default 12) capping the pages ALL providers run at once. The
  actual parallelism is `min(global ceiling, Σ current lane caps, schedulable
  pages)`, so raising it never forces a provider past its own lane. Legacy
  values migrate: 0/absent → 12, >24 → 24, 1–6 kept.
- **调度带上下限 (adaptive bands with min/initial/max).** Lane caps are now bands:
  auto mode grows a lane from its initial toward its max on a run of clean
  successes and backs off toward its min on 429/timeout; stable and high are
  fixed. Only the erroring provider is throttled.
- Settings pane: mode radios + a live 「当前配置」preview (预计并行 N 页 · 当前页
  优先, with each provider's current lane), and the global-ceiling field
  relabelled and re-ranged 1–24.

## [0.8.10] — 2026-08-09

### Fixed

- **缩放时译文闪现后消失 (zoom no longer drops overlay translations).** The
  on-page overlay's redraw lifecycle is fixed — the translations were never
  lost (they stayed in memory); only the DOM layer vanished. Four root causes:
  - **重绘请求累积 (redraw requests accumulate).** `scheduleRedraw()` kept only
    the LAST event's page (it reset the timer and captured one index), so during
    a zoom storm every page but the last was dropped and never repainted. It now
    merges a dirty-page set (and a redraw-all flag for scalechanging /
    rotationchanging) into one pass.
  - **原子替换 (atomic layer swap).** The new layer is now built in full and only
    swapped in once it has real content — the old layer stays visible right up to
    that frame. Previously the old layer was removed up front, so any mid-zoom
    early-return left the page showing only the original.
  - **签名只在挂载成功后保存 (signature saved after mount).** The geometry
    signature that suppresses redundant redraws is now recorded ONLY after a real
    layer mounts; an aborted or empty draw leaves it unset so the next event
    retries, instead of marking a blank page "done".
  - **失效节点保护 (stale-node guard).** If PDF.js swapped the page div during the
    debounce, the draw reschedules onto the fresh node instead of painting a
    layer that is about to be discarded.

## [0.8.9] — 2026-08-09

### Changed

并发调度重构 — 每服务商独立限流 + 真正的多服务商并行(引擎层,无 UI 模式选择器):

- **每服务商独立限流 (per-provider lanes).** The scheduler now caps concurrency
  PER PROVIDER (a "lane") instead of by one global number keyed off the main
  provider. Each provider runs its own pages in parallel up to its own cap;
  another provider's busy lane never blocks a page on a different lane. Lane
  caps come from a per-type profile: free MT (Bing/Google) 1, DeepL-style paid
  MT 3, cloud LLM 3, local (Ollama) 1.
- **全局并发自动计算 (auto global cap).** The global page-task cap is the SUM of
  the enabled providers' lane caps, clamped to [2, 24] — e.g. Google-free +
  OpenAI + Gemini = 1 + 3 + 3 = 7. The setting is renamed 并发请求数 →
  **最大并行页面数**, defaulting to **0 = 自动**; a value >0 is an optional manual
  ceiling. Actual HTTP requests are managed internally, not exposed.
- **多服务商真正并行 (pool actually multiplies throughput).** Neighbour prefetch
  is now enqueued immediately (not only after the current page finishes), so
  other providers' lanes fill while the current page translates. The current
  page's provider lane always keeps one reserved foreground slot, so the visible
  page never waits for a prefetch.
- **预取窗口随服务商数扩展 (pool-sized prefetch window).** Forward = min(2 × pool
  size, 12), backward = 1 (was a fixed ±1). Nearer pages get higher priority.
- **动态降速 (per-lane adaptive throttling).** A `429` halves the offending
  lane's cap; a timeout drops it by one; `Retry-After` is honoured when present;
  a run of clean successes slowly restores one slot. Only the erroring provider
  is throttled — never the whole pool. Session-scoped, not persisted.

## [0.8.8] — 2026-08-09

### Changed

- **通知彻底统一到胶囊 (single capsule is now the ONLY notification surface).**
  The bottom-center success toast module (`.pm-toast`) is fully removed —
  fields, DOM, `toast()` method, timer and CSS. Transient successes (译文已复制 /
  已保存为子笔记 / 缓存已清除) now flash as a new capsule `notice` state: a ✓ over
  a green ring with the message, auto-hiding after ~1.9s, priced just under a
  failure so it shows over active work then reverts to whatever was underneath.
- **刷新全部 / 清除缓存不再弹底部提示.** Both immediately re-translate the current
  page, so the capsule's own progress IS the confirmation — no separate toast.

## [0.8.7] — 2026-08-09

### Changed

翻译效率专项(按审核清单逐项实施):

- **1. 段落分组指标 (grouping metrics).** Extraction now logs
  `fragments → units (ratio)` per page and warns when a fragment-heavy page
  barely merges (ratio > 0.85 at ≥40 fragments) — the signal that the semantic
  coalescer is not working for that layout. Page completion logs
  units / segment-cache hits / chunks / requests / salvage / untranslated / ms.
- **2. 首次请求携带排版字符预算 (initial char budget).** Prose blocks with real
  geometry now send `charBudget ≈ Σ(line width / font) × 0.9` in the FIRST
  request (zh targets), so most paragraphs fit on the first pass instead of the
  translate → measure-fail → compress → re-measure round trip. The prompt's
  budget rules (dense phrasing, never dropped facts/numbers/units/citations)
  apply from the start.
- **3. 段落级缓存与增量刷新 (segment-level cache + tiered refresh).** Beneath the
  page cache there is now a per-segment store keyed by content+language hash and
  scoped by provider/model/promptVersion/glossary. 圆环「刷新本页」is now 普通刷新:
  it bypasses the page cache but reuses qualified segments — only untranslated /
  previously-invalid segments cost new requests (with a provider pool it still
  rotates engines, whose separate store forces a genuine re-translation). 菜单
  「刷新全部」remains 强制: it clears everything. Compress-accepted shorter
  translations overwrite their segment entry, so a refresh cannot resurrect a
  translation that already failed placement.
- **4. 缺失 ID 分级补救与服务商熔断 (tiered salvage + circuit breaker).** Missing
  ids now recover in tiers: full-batch retry → SMALL batches of 4 → single-block
  requests only for the leftovers, instead of one request per dropped block.
  When >25% of a chunk is still missing after batch+retry, `onProviderUnstable`
  fires once per page and the session deals the page's remaining requests to the
  next engine in the pool (logged; single-provider setups log and continue).

## [0.8.6] — 2026-08-09

### Changed

- **圆环颜色改为状态语义 (semantic ring colours).** The ring colour now means a
  STATE, never a provider or a per-page hue: 翻译中蓝 `#6C9BFF`, 排版紫
  `#8B7CF6`, 完成绿 `#37C871`, 部分完成橙 `#F5A623`, 失败红 `#FF6B6B`, 已停止灰
  `#8B93A1`, 空闲深灰蓝 `#748096`, 底部轨道 `rgba(255,255,255,.16)`. All routed
  through CSS variables. The centre percentage is ALWAYS white (never tinted by
  the ring), and the stop button is red only on hover — not a permanent alarm.
- **永远优先翻译当前页 (the visible page always wins scheduling).** Two scheduler
  gaps closed:
  - **已排队页可被提升 (queued pages can be promoted).** Navigating to a page that
    was already enqueued as a low-priority prefetch used to hit an early return
    and keep its prefetch priority. `RequestScheduler.promote()` now raises it to
    the foreground current-page priority (and `setCurrentPage` calls it), so it
    stops waiting behind neighbours.
  - **当前页专属并发槽 (a reserved foreground slot).** The scheduler reserves one
    slot for foreground work (`reservedForeground`), so background prefetch can
    never occupy every slot and make the visible page wait for a neighbour to
    finish. Even on the free engines' 2 slots, prefetch is capped at 1.
- Prefetch window narrowed to `[current, next, previous]` (dropped current+2);
  explicit priority tiers (retranslate 1000 > current 900 > compress 850 > next
  100 > previous 80 > second-next 20); neighbour prefetch is never enqueued
  until the current page is done; pages leaving the window are cancelled.

## [0.8.5] — 2026-08-09

### Changed

- **缩小圆环在两种翻译模式中常驻右下角 (the shrunk ring is now persistent and
  shared).** Two problems fixed together:
  - **折叠状态共享 (shared collapsed state).** The collapsed/expanded state is no
    longer stored inside each of the two `StatusCapsule` instances (overlay vs
    pane) — the `ReaderSession` owns one `capsuleCollapsed` flag and mirrors it
    onto both surfaces (`onCollapsedChange` callback + `setCollapsed`). Collapse
    in 覆盖原文, switch to 对照翻译 → still collapsed, and vice-versa.
  - **常驻 idle 状态 (persistent idle state).** When the task queue empties the
    capsule no longer calls `setProgress(null)` and disappears. It renders a new
    `idle` phase: a bottom-right resting ring showing ✓ 本页翻译已完成 if the
    current page is translated, or ↻ 点击圆环翻译本页 if it never was. The center
    still re-translates the page.
- **完成后自动缩小而非隐藏 (done auto-collapses, not auto-hides).** A finished
  page shows its full “已完成” message for ~2.2s, then auto-collapses into the
  persistent idle ring. Failed and partial states never auto-collapse — they
  stay expanded until the user acts.
- The idle ring retargets the current page on scroll (✓ vs ↻), and 原文 mode
  shows no capsule (there is nothing to refresh there).

## [0.8.4] — 2026-08-09

### Fixed

- **百分比稳定居中 (percentage sits at the ring's true centre).** The center
  button is now a fully-reset native `<button>` (appearance / margin / min-width
  / text-align / text-indent / box-sizing all cleared) sized to the full 34×34
  ring, and the `%` moved into an independent `.pm-ring-label` span
  (`inset: 0; display: grid; place-items: center; pointer-events: none`). Host
  platform button defaults can no longer nudge the number, and “100%” no longer
  overflows a too-narrow (24px) button.
- **折叠后不再变高 (collapsed capsule keeps the same 56px height).** Collapsed
  state used `padding: 6px` around a 56px shell (= 68px tall) while expanded was
  56px, so the widget jumped taller when collapsed. Collapsed is now a fixed
  56×56 box (`padding: 0; gap: 0`); the SVG stays 34×34, so only the clickable
  background fills the square — the ring itself does not grow.

## [0.8.3] — 2026-08-09

### Changed

- **胶囊圆环改用真实 DOM 点击分层 (real hit layers, no distance guessing).** The
  ring no longer decides center-vs-edge by measuring click distance
  (`dist > rect.width * 0.42`), which left the capsule stuck-collapsed. It is now
  three real, stacked elements:
  - **圆环中心按钮** (`.pm-ring-refresh`, over the %) → 重新翻译本页; it stops
    propagation so refreshing never doubles as expand/collapse. Works in both
    expanded and collapsed states.
  - **圆环外圈** (`.pm-ring-progress` SVG) → progress display only,
    `pointer-events: none`, never a hit zone.
  - **文字区域** (`.pm-body`) → 收起.
  - **收起后的方形背景** (`.pm-ring-shell`, enlarged to 56×56px) → 展开, via the
    capsule's own click handler that fires only while collapsed.
- **停止按钮改用 ■ (stop, not pause).** The right-hand action during
  translation/layout is now `■ 停止任务` — the backend cancels and restarts, so a
  pause/resume glyph would misrepresent it.
- Hover tooltips: center reads “重新翻译本页”, the collapsed background reads
  “展开任务详情”.

## [0.8.2] — 2026-08-09

### Fixed

- **通知按钮不再执行错误动作 (retry no longer mis-fires).** A non-translation
  failure — save note, copy, clear cache, open — now shows a `×` that dismisses
  the notice, instead of a 重试 that wrongly re-translated the page. Only real
  translation failures offer 重试.
- **「查看保留原文」真正定位 (view-kept-original actually locates).** The capsule's
  查看 action now scrolls to the page that kept segments in the source language
  and briefly highlights those exact segments (the strict `[data-pm-unfit]`
  boxes, or the pending blocks in the pane) — previously a no-op.
- **表格单元格不再重复计数 (no double-count of table cells).** Placed table text
  cells are counted once (they are ordinary committed items); the final tally is
  `placed = committed`, so pages no longer over-report placement.
- **保留原文与失败区分开 (kept-by-design vs real failure).** Table cells kept on
  purpose (numeric/data/spanning) no longer count as failures, so a fully-placed
  page reads 已完成; cells that truly failed to translate or place count as kept
  and correctly show 保留原文.
- **导出与翻译不再互相覆盖 (export and translation stop overwriting each other).**
  The single capsule is now backed by a task queue: when a page translates while
  a PDF exports, the capsule shows the highest-priority task (failed > active
  export > partial > active translation > terminal) instead of whichever updated
  last.

### Removed

- Unused `StatusCapsule.setStatus()`, the dead internal `autoHide` field (the
  session now owns auto-hide via the task queue), and a stale `.pm-status-row`
  comment. The whole-page dim during a page refresh is gone — only the refresh
  button spins now, so translated text no longer appears to vanish mid-refresh.

## [0.8.1] — 2026-08-09

### Changed

- **单一通知组件 (StatusCapsule is the only task/error notifier).** The legacy
  floating status note (`statusNote` + `pane.setStatus`) is deleted from the
  pane and its CSS; `PdfOverlay.setStatus` is gone too. All task and error
  feedback — translation, layout, partial, failed, cancelled, AND PDF export —
  now flows through the one capsule via a progress model, so two components can
  never show conflicting status.
- **PDF 导出走胶囊 (export uses the capsule).** Export progress/done/failure
  render in the capsule (`task: 'export'`); the duplicate completion Toast is
  removed. Toast is now reserved for transient successes only — copy, save
  note, cache cleared.
- **错误进入状态机 (errors go through the model, not raw strings).** Open
  failures and action errors post a `failed` capsule state instead of an
  ad-hoc status string; the translation-success Toast is dropped (the capsule's
  done state is the single completion signal).



### Added

- **圆环两段式交互 (two-zone ring).** Clicking the ring's OUTER edge expands or
  collapses the capsule's detail body; clicking the INNER disc (where the % is)
  re-translates the current page. The hit test splits the ring at ~42% of its
  radius, so the two gestures don't collide on the small ring.

### Changed

- **优先翻译当前页 (current page first).** The page you are on now gets a
  dominant scheduler priority AND the concurrency to itself — neighbour pages
  are not prefetched until the current page is done, so a slow free engine never
  spends its slots translating pages ahead while the visible page waits. Once
  the current page finishes, its neighbours prefetch as before.



### Fixed

- **状态提示不再双显示 / 不再回退到 0% (one state model).** The capsule and the
  old pane status pill were both driving translation feedback, so a page showed
  "✓ 第 3 页已翻译" and a "0%" ring at the same time. All translation-process
  feedback now flows through the ONE capsule; the old `pane.setStatus` is no
  longer called for translating/done/error, and the `done` branch no longer
  shows a completion tick — the FINAL done/partial state is posted only by the
  placement pass. Non-translation messages (export, open failure) still use the
  pane pill.
- **进度百分比连续、不超 100% (combined, monotonic progress).** The ring now
  shows combined progress `(translated + placed) / (2 × total)` — translation
  is the first 50%, placement the second — so a fully-translated page entering
  layout sits at 50% and climbs, instead of resetting to 0%. Placement counts
  use one consistent denominator (placed + real failures), so the ring can
  never exceed 100%.
- **统一的"保留原文"判定.** Partial vs done is decided solely by real failures
  (`abandoned + untranslated`); intentionally-original content (figures, tables,
  tiny fragments) is no longer double-counted by a second status component, so
  the two surfaces can't disagree.
- **取消/圆环交互修正.** In 对照翻译 mode the capsule's 取消 button now actually
  cancels the page (it was wired to re-translate); and 覆盖原文 mode's ring now
  receives its `onRefreshRing` handler, so clicking the ring re-translates the
  current page in both modes.

## [0.7.9] — 2026-08-09

### Changed

- **对照翻译模式也用同一个状态胶囊 (same capsule in the side pane).** The status
  capsule is now a shared component (`statusCapsule.ts`) used by BOTH 覆盖原文 and
  对照翻译 modes, so the pane's bottom-right shows the same real progress ring,
  page position, and honest 翻译 a/b · 排版 c/b counts as the overlay. Progress
  is routed to whichever surface is visible; the other's capsule is dismissed.

### Added

- **点按圆环 = 刷新本页 (click the ring to re-translate the current page).** The
  progress ring is now a button: clicking it re-translates the page you are on
  (rotating to the next pool engine, as before).
- **菜单栏刷新按钮改为「刷新全部」(top button = re-translate everything).** The
  pane menu-bar refresh button now clears the whole document's cached +
  in-memory translations and re-translates; because translation is lazy, the
  current page re-runs now and the rest re-translate as they are viewed. Cancel
  in the capsule now works in both modes.

### Changed

- **覆盖原文模式合并为一个状态胶囊 (one status capsule).** The separate floating
  refresh button (0.7.6) and the status pill are gone; 覆盖原文 mode now has a
  single bottom-right capsule (~260px, 16px radius, offset 22px) with a REAL
  progress ring (no fake infinite spin — the arc reflects an actual fraction),
  a main line `正在处理 第 3 / 12 页` (current page / total — translation is
  lazy, so this is position, not a document-wide bar), and a sub line with
  honest per-page counts `翻译 a/b 段 · 排版 c/b 段` so you can tell "translating
  slowly" from "translated but layout failed".
- **Distinct, honest end states.** 翻译中 / 排版中 (ring) → 已完成 (✓, auto-hides
  after 2s) / 部分保留原文 (!, persists, 查看 opens the pane for per-block detail)
  / 翻译失败 (!, persists, 重试) / 已停止翻译 (—). "Done" is never shown while
  segments are still unplaced — a partial page says so with its kept count.
- **Cancel + collapse.** The right-hand button cancels the current page's
  translation while it runs; clicking the capsule body collapses it to just the
  ring (and back). Placement counts come from the strict renderer's real tally
  (committed paragraphs + translated table cells vs kept-original).

## [0.7.7] — 2026-08-09

### Fixed

- **半段翻译/中英混杂不再被当成功 (target-language RATIO check).** The
  completeness check accepted any response containing a single CJK character,
  so a half-translated or English/Chinese-mixed response passed and the page
  stored it as done. A Chinese target now requires a prose source (≥6 Latin
  words — a real sentence, not a label or acronym/numeric cell) to come back
  PREDOMINANTLY Chinese: CJK characters over (CJK + Latin words) must be ≥0.45.
  A few embedded acronyms (PCCT, MRI) still pass; a mostly-English response is
  rejected and re-translated whole. Short cells/labels and non-CJK targets are
  unaffected.

## [0.7.6] — 2026-08-09

### Added

- **覆盖原文模式的浮动刷新按钮 (floating 刷新 in overlay mode).** In 覆盖原文
  (on-page overlay) mode the translation pane is hidden, so its 刷新 button
  was out of reach. A round refresh button now floats in the bottom-right
  corner whenever the overlay is on — just above where the status pill appears,
  so the two never overlap. It re-translates the current page (rotating to the
  next pool engine, like the pane's 刷新), spins while the request is in flight,
  and is removed when the overlay is turned off.

## [0.7.5] — 2026-08-09

**语义段落组 (semantic paragraph groups).** The coalesced region IS the
paragraph group: one id, one translation request, one strict node, one union
rectangle, per-line masks, and an all-or-nothing commit — there is no
member-by-member commit inside a group by construction. The mixed-language
paragraphs came from fragments that FAILED to join a group; this release makes
grouping authoritative.

### Fixed

- **Length is no longer a rejection criterion for continuations.** A
  lowercase-opening fragment ("least as robust, if not better, than…") is the
  middle of someone else's sentence no matter how long it is — the old ≤60-char
  shard cap left exactly these long fragments as independent blocks, stranded
  in English inside a Chinese paragraph. Absorption's total-length gate is also
  relaxed (bounded at 1.5× the region cap) so the tail of a cap-split paragraph
  can rejoin instead of being stranded.
- **Colon no longer ends a sentence in the region separator** (the same
  contradiction fixed in paragraphHeuristics in 0.7.4, in regionCoalescer's own
  copy): a colon-ending fragment joins with a space, never a paragraph break.
- **Groups keep provenance.** A merged region records `memberIds` — the ids of
  every extraction fragment it absorbed, in reading order — so the source
  relationship survives the merge instead of being lost.

## [0.7.4] — 2026-08-09

### Fixed

- **冒号/分号行不再断段 (colon/semicolon merge contradiction).** `endsSentence`
  counted ":" and ";" as sentence-final, while `danglingEnd` counted the same
  marks as mid-sentence — so a line ending in a colon or semicolon satisfied
  both, and the merge condition (`!endsSentence && (startsContinuation ||
  danglingEnd)`) always rejected it. Such a line was stranded as its own
  one-line block and left in English. Colon and semicolon are no longer treated
  as sentence-final, so these lines rejoin their paragraph.
- **译文完整性/语言校验 (target-language check).** A response was accepted as a
  translation as long as it was non-empty — so a provider that echoed the
  English back, or returned it untranslated, was stored as "done" and the page
  showed English that was indistinguishable from a layout failure. Responses are
  now checked: for a Chinese target, a translation of prose (≥3 English words in
  the source) must contain CJK characters, or it is treated as missing and goes
  through the retry/salvage path; a page that still can't be fully translated is
  left uncached so a revisit retries. Acronym/numeric cells (legitimately
  CJK-free) and non-CJK targets are unaffected.

Still ahead (from the review, not yet done): atomic per-semantic-paragraph
commit so a residual multi-block paragraph can't show half Chinese/half
English; absorbing long (>60-char) continuation fragments the paragraph merge
still misses; retrying a whole failed segment rather than many line fragments;
and an end-to-end two-column page test asserting no non-term English remains.

## [0.7.3] — 2026-08-09

### Fixed

- **残留的段中英文行 (residual mid-paragraph English lines).** After 0.7.2 fixed
  the wholesale line-fragmentation, a few lines mid-paragraph (often the
  citation-bearing ones) still stayed in English. The repair pass `planMerges`
  was rejoining split fragments but still gated on the same unstable *column
  index* — a line whose index had flipped never rejoined, so it stood alone as
  a one-line block and its Chinese couldn't fit a one-line box. The same-column
  test is now geometry-first: when both fragments have rectangles (the real
  pipeline) they belong together iff their x-ranges overlap; the column index is
  only a fallback for rect-less inputs. Different columns never share an
  x-range, so columns still never interleave.

## [0.7.2] — 2026-08-09

### Fixed

- **正文间隔不翻译 (alternating untranslated lines).** On narrow two-column
  pages a paragraph was being cut into one-line blocks, each translated alone
  and dropped into a one-line box — a line whose Chinese needs two lines could
  not fit and stayed English, so translated and original lines alternated down
  the column. The cause: a paragraph break was forced whenever two stacked
  lines got different *column indices*, and the column detector flips that index
  row-to-row on a narrow layout. Column continuity is now decided by geometry
  alone (two stacked lines that share an x-range are one column; lines in
  different columns never share an x-range), so paragraphs stay whole and
  translate as units. Applied to both the char-stream and text-layer builders.
- **表格整表未翻译 (whole text table left in English).** A table cell was flagged
  "data → keep original" if it merely clipped a second column band (a 0.35
  overlap test); a legitimately wide column like "Key results" trips that, so a
  5-column text table had most cells flagged and stayed English. A cell now
  counts as spanning only when it actually COVERS ≥2 bands (>0.5 of each) —
  which only a true full-width stitched fragment does — so wide prose columns
  translate while genuine cross-column fragments still stay original.

## [0.7.1] — 2026-08-09

**表格单元格模型 (table cell model).** From this release on, every fix bumps the
patch version by 0.0.1.

### Added

- **Table cell model — text cells now translate in place (`tableStructure.ts`).**
  A detected table region is no longer kept wholesale in English. Its Row/Cell
  grid is inferred geometrically (columns from the members' x-extents seeded
  narrowest-first so a spanning cell can't fuse two columns; rows from their
  y-extents), and each cell is handled on its own: prose cells (labels,
  recommendations, prose headers like "2025 Recommendation") are translated and
  replaced inside their own rectangle through the same measure-before-commit
  pipeline, while data cells (numbers, value±sd, ranges, symbols), whole
  numeric columns, and any fragment stitched ACROSS columns stay original — so
  a data table's figures and alignment are never disturbed and nothing is ever
  stamped across the grid. Each cell carries a stable id
  (`page-<p>-table-<t>-r<row>-c<col>`). The placement tally gains a
  `tableTranslated` count beside `tableExcluded`.

Still ahead: ruling-line detection from the operator list for tables drawn with
rules rather than whitespace; splitting a multi-block cell's translation across
its members; and paragraph-granular placement so one overflowing line can't hold
back a long paragraph.

## [0.7.0] — 2026-08-09

**修复表格和图片排版问题 (table & figure layout fixes).** 整页对照重写为严格
原位替换:译文永远写在原文的矩形里,表格整体保留原样,图片零像素变化,页面
尺寸与原版完全一致。This release folds five review rounds of layout work into
one architecture: strict in-place replacement.

### Added

- **刷新 = 只重译当前页,并轮换引擎.** The refresh button re-translates ONLY
  the page you are on (bypassing its cache), and when 多服务商并行 is active
  it also deals that page to the NEXT engine in the pool — a page that came
  out poorly on one service gets a genuinely different translator, with the
  cache entry keyed to the newly chosen engine. Rotation resets when the
  provider/language configuration changes.
- GitHub Releases now carry this changelog section as their release notes
  (the auto-generated commit list follows below).

### Fixed

- **长文本不稳定 — 译文显示后又消失 (measure before commit).** The disappearing
  translation was deterministic, not random loss: the renderer showed every
  block's translation immediately, then — after fonts loaded and it re-measured
  — hid the ones that overflowed, so a long paragraph flashed in Chinese and
  reverted to English. The renderer no longer shows a block it might take back.
  Each block starts hidden with its ORIGINAL text visible (no mask painted);
  only a block measured to fit is revealed — mask and text committed together
  in one step. A block that cannot fit is never shown translated in the first
  place, so there is nothing to retract. Transitions are only ever English →
  Chinese (when a fix lands), never Chinese → English.
- **Compress rounds are counted per block, only once, on the final measure.**
  The measure pass runs several times per render (font-readiness insurance);
  only the final, fonts-settled pass now reveals blocks or spends a round, and
  an in-flight guard stops two compress requests racing on one page. Round
  counters are keyed per block (not per page), so two long paragraphs at the
  top of a page can no longer exhaust the budget for every long paragraph below.
- **Compressed retries applied in place; only shorter results accepted.** A
  budgeted retry patches just its own blocks into the live page — already-fit
  blocks never flicker on a re-render — and the manager rejects any retry that
  is not actually shorter than the translation it would replace, so a service
  echoing back the same (or longer) text can't waste a round or clobber a good
  result. Budgets are the tighter of the geometric estimate and the block's own
  measured need (`textLen × boxHeight/scrollHeight × 0.92`).
- **Free MT engines skip straight to shrink.** Character budgets only help
  prompt-driven engines, so provider capability is now an explicit
  `supportsCharBudget` flag (LLM/OpenAI-compatible = yes; Bing/Google/DeepL =
  no) rather than being inferred from the explain feature — non-budget engines
  no longer waste compress rounds.
- **Last-resort font shrink before abandoning a block.** A block still too long
  after its budgeted retries tries 94% then 88% of its fixed size (floor 8.5px,
  plus a new tightest 1.14/−0.02em ladder step) before giving up — a
  deliberate, bounded exception to the fixed-type-size rule. Only a block that
  fails even this keeps the original.
- **Stale renders can't overwrite the live page.** Each page render claims a
  generation token; an older render still finishing its async tail (bitmap,
  image rects, compress) bows out instead of flashing an outdated page in over
  a newer one.
- Scrolling no longer cancels the in-flight compress task of a page still near
  the viewport — the scheduler keeps `page-N-compress` alive for wanted pages.
- **Fit to the block's own leading, not a fixed floor (完整率).** The fit ladder
  now bottoms out at each block's ORIGINAL line spacing (median gap between its
  source line tops), never a blanket 1.14. A one-line heading whose rectangle
  is barely taller than its glyphs gets a ~1.0 step it can actually pass —
  short titles no longer fail placement outright — while a body paragraph is
  never crushed below its own leading. This markedly raises how many blocks fit
  in place instead of keeping English.
- **Every missing block is salvaged, not just the first eight.** The one-by-one
  salvage pass (single-block requests that can't suffer id drift) now covers
  ALL ids a provider dropped from a batch, with a log warning when an engine is
  systematically dropping many. Leaving a block untranslated to save a request
  was exactly the mixed-language page this was meant to prevent.
- **Honest placement accounting.** A strict page now reports a full tally —
  shown, won't-fit, untranslated, in-table, on-image, too-small — logged every
  render, and when any block is kept in English a non-blocking pane note says
  so ("本页 N 段过长，已保留英文"). "Translation complete" and "every block
  placed" are surfaced as distinct states: with rectangle-fixed, no-shrink-past-
  floor, no-continuation constraints, an arbitrarily long translation cannot be
  guaranteed to fit, so the rare true failure is now stated rather than left
  silently English.

- **Long-page translation no longer stalls on salvage.** Salvaging every
  dropped id one-by-one, strictly sequentially, made a page where the provider
  dropped many ids crawl. Salvage now runs in bounded-parallel waves (4 at a
  time) — still one block per request (no id drift), but a long page finishes
  in a fraction of the wall-clock instead of appearing to hang.
- **Tables stay cleanly original, never half-translated or bled over.** Any
  block overlapping a detected table region is now kept in the original — not
  only the cells the detector flagged, but also long recommendation cells that
  look like paragraphs and the stitched-across-cells paragraphs the extractor
  sometimes emits. This removes the mixed English/Chinese cells and the Chinese
  text that was overlapping table rows. (A table is all-original until the real
  cell model lands.)

### Changed (architecture)

- **整页对照 is now STRICT in-place replacement** (`strictPageReplacement.ts`).
  The page the reader sees is the original page — same size, figures, table
  lines, background and positions — with translations written into exactly
  the rectangles the source text occupied. No block moves, no page growth, no
  continuation sheet, no reflow. pageFlow (flow/packing/sweep) is no longer
  used by this mode; it remains available to the 文章流 mode where reflow is
  the point.
- **Fixed geometry, fixed type size.** Fit uses only the leading/tracking
  ladder (1.42 → 1.18, up to −0.02em); the font size never shrinks. Body
  blocks are typeset at their own body-cluster MINIMUM size
  (`replacementFontSize`: sizes filtered to [0.75×, 1.25×] of the median —
  drop caps and superscript citations excluded — then the smallest survivor),
  so a decorated first letter never inflates a paragraph and a 6pt citation
  never shrinks one.
- **Budgeted compress-and-retry.** A translation that cannot fit its
  rectangle is re-requested with a character budget
  (`estimateCjkCapacity` of the box; `charBudget` on the request; prompt
  rules demand denser academic phrasing, never dropped facts/numbers/units).
  Up to two rounds; a block that still cannot fit REVERTS to the original
  text (its masks are wiped) — never clipped, never overlapped, never moved.
  `PROMPT_VERSION` → 2, invalidating every cache entry produced under the
  old long-form prompts.
- **Masks hug the strokes and can never touch a figure.** Per-line masks use
  font-relative padding (0.08em, clamped 1–3px) instead of a fixed 2px, and
  the real image rectangles are wiped out of the mask canvas afterwards —
  `intersection(mask, image) === 0` holds by construction. A "paragraph" box
  overlapping an image by >15% is treated as an extraction error and left
  entirely alone. Table regions keep their whole original rendering (the
  cell-level model with per-cell translation IDs is the next stage).

### Added

- **Table protection.** Detected table regions (clusters of numeric/symbol
  cells, transitively merged across column strips, anchored by `Table N`
  captions, sweeping in row labels beside them) keep their ENTIRE original
  rendering: no cell is translated, nothing may be parked on the region.
  Real Table→Row→Cell re-layout stays future work; this stops translated
  fragments being stamped across data tables today.
- **Real image boundaries.** The operator list (walked with the matrix stack,
  via the poll-the-flags pattern — content promises are never awaited) yields
  every painted image's true rectangle; those join the flow as obstacles with
  exact horizontal extents and the sweep as no-park boxes. The luminance grid
  remains the fallback when the operator list is unavailable.
- **Header/footer guard bands.** Extraction deletes running heads/feet, so
  the layout never knew the furniture was there. Adaptive bands (never
  swallowing real source content) now make pushed blocks hop past the footer
  onto grown paper instead of flowing through it.
- **Final visual safety check with a safe fallback.** After settling, every
  page is checked for block-block overlaps, block-on-figure/table/band
  violations, and sideways clipping. A failing page is not shown wrong — it
  degrades to the untouched original page with the full translation flowed
  cleanly underneath.
- **Representative font size.** Block sizes now come from the MODE of the
  member lines (`dominantFontSize`) at build and at merge, not the first
  line — drop caps, superscripts and heading-styled lead-ins no longer skew
  a whole paragraph's translated size. Region merges follow the longer
  fragment's size.
- planFlow only hops obstacles a block actually intersects horizontally.
- **Shard absorption.** Bare citation markers ("(5,6)."), superscript runs
  and torn-off lowercase continuations ("ated light is isolated…") are no
  longer independent blocks: a looser second coalescing pass folds them into
  the adjacent body region, so they translate with their sentence instead of
  surviving as English crumbs below the replacement threshold.
- **Figure groups.** A bare "Figure N:"/"图 N" label re-unites with the
  caption text PDF.js tore it from (the union classifies as one caption and
  is translated whole), captions get a laxer replacement size gate, and the
  strip between an image and its caption is a no-park zone — the caption can
  grow downward but can never be separated from its figure.
- **Real pagination instead of unbounded growth.** Blocks pushed to or past
  the footer zone leave the absolute layout entirely and re-flow, in
  column-major reading order, on a tidy continuation sheet appended after
  the page ("本页译文续") — no more footer stranded mid-article with
  fragments and single-word slivers scattered after it.
- **Body text packs upward.** planFlow gains anchor semantics: headings,
  titles and captions still hold their source position, but ordinary body
  paragraphs now pack from the column cursor, reclaiming the whitespace a
  shorter Chinese paragraph leaves. Packing knows every hard box (images,
  tables, kept-original text, caption gaps) as obstacles, so it can never
  climb onto anything. Legacy callers without the flag keep the old rule.

### Fixed

- **The final overlap sweep can no longer park a block on a figure.** planFlow
  hops figure/table obstacles, but `resolveOverlaps` — the last global sweep —
  knew nothing about them: a block pushed down to clear another block could
  land squarely on a figure. The obstacles now join the sweep as immovable
  boxes (`obstaclesToBoxes`), with a regression test reproducing the exact
  push-onto-figure case.
- **The column-tightening pass no longer undoes the containment ladder.** When
  a column overflowed the page, the second pass blanket-reset every block in
  it to line-height 1.34 — making blocks that had settled at 1.24 *taller*
  and re-breaking their own boxes. It now only ever tightens
  (`min(current, 1.34)`).
- **Borderline boxes no longer seep past their bottom edge.** The fit
  tolerance shrinks from ±2px to ±0.5px, and the containment ladder gains a
  final 1.18 leading step (matching the overlay's ladder) before the type
  starts shrinking.
- **Measure-once insurance.** `pmSettle` is now idempotent — every block AND
  the page height reset to their start state first, so a re-settle can shrink
  a previously grown page instead of leaving a band of stale blank paper —
  and the settle re-runs via an unconditional `document.fonts.ready` hook
  (catching loads our own text insertion triggers, with one second-wave
  re-check, never an unbounded chain). Slot height re-syncs after every
  settle. With the system CJK stack this is normally a cheap no-op.
- **Small obstacles no longer wall off their whole column.** `inkToObstacles`
  now records each obstacle's actual horizontal ink extent, and the final
  sweep uses that tight box — a small inline figure only repels blocks that
  genuinely overlap it, instead of bouncing every pushed block in the column
  below it (the column band remains the fallback when no extent is known).

### Notes

- The overlay's behaviour is unchanged and deliberate: boxes clip with an "…"
  badge at the 8.5px readability floor (expand caps at 2.2× the original
  height) and a click expands the paragraph.

## [0.6.1] — 2026-08-08

### Changed

- Adopted the Chinese name **文镜** ("a mirror for text"). It now appears
  alongside PaperMirror in the add-on's name (Zotero's add-ons list), the
  settings pane label, and the README home page. No functional changes.

## [0.6.0] — 2026-08-08

First stable release. Same reader, now presented as a finished project.

### Added

- Bilingual (中文 / English) GitHub home page with a step‑by‑step usage guide,
  an FAQ, and a language switcher — covering the three reading modes, install
  and auto‑update, translation engines and BYOK, the glossary, and privacy.

### Notes

- No functional changes to the reader from 0.5.3; 0.6.0 marks the point where
  the feature set, the auto‑update pipeline (release‑asset `updates.json` via
  the latest‑release alias) and the VS Code‑only publish flow are all settled.

## [0.5.3] — 2026-08-08

### Changed

- **Releases now trigger on a push to `main`, not on a tag** — so the whole
  flow works from VS Code's Sync button with no terminal and no manual tags.
  Bump the version in `manifest.json` + `package.json`, commit, Sync; the
  workflow reads the version, creates the `v<version>` tag itself, and
  publishes the XPI + `updates.json` release assets. Versions already released
  are skipped, and pushes that don't change `manifest.json` are ignored.
- Combined with 0.5.2's release-asset auto-update (nothing is ever written to
  `main`), `main` no longer diverges, so VS Code Sync stays a clean
  fast-forward. Anyone who installs a 0.5.2+ `.xpi` from Releases auto-updates
  from the latest release — no configuration on their end.

## [0.5.2] — 2026-08-08

### Changed

- **Auto-update no longer depends on committing to main.** `updates.json` is
  now published as a *release asset* on every tag, and the manifest's
  `update_url` points at GitHub's latest-release alias
  (`releases/latest/download/updates.json`). Previously the release workflow
  tried to commit the manifest back to `main`; that push kept being rejected
  (branch protection / concurrent tag builds), so `updates.json` stayed stuck
  at 0.4.2 and Zotero reported "No updates found" even though newer releases
  existed. Nothing is written to `main` anymore, so the stall cannot recur.
- Dropped `update_hash` from the manifest: a hash that had to match a build
  byte-for-byte only ever produced mismatches between locally-built and
  CI-built XPIs. The XPI is fetched over HTTPS from the project's own release.

## [0.5.1] — 2026-08-08

### Fixed

- **Auto-update was stuck.** `updates.json` on main stopped advancing past
  0.4.2, so Zotero reported "No updates found" even though newer releases had
  been published. Two root causes in the release workflow: it regenerated the
  file *after* `git checkout main` (which swapped `package.json`'s version out
  from under `gen-updates`), and when tags were pushed close together the
  later build regenerated against a stale main and its push was rejected. The
  workflow now resets to the true `origin/main` before regenerating and takes
  the version from the release tag explicitly (`gen-updates.mjs <version>
  [xpi]`), so the manifest always lands on the version just released.

## [0.5.0] — 2026-08-08

Housekeeping release: a full audit of the tree, removing everything the
current version no longer reaches. No behaviour changes.

### Removed

- Dead modules and helpers: `src/utils/throttle.ts` (no importers), the
  adapter's `getPdfViewerWindow` (only user was the deleted floating chip),
  and the session's `copyCurrent` (its only caller was an unwired callback).
- Dead pane surface: the never-mounted 显示原文对照 / PDF叠加 switches, the
  unused `onToggleShowOriginal` / `onToggleOverlay` / `onCopy` /
  `onExportPdf` callbacks and their session wiring, and `setOverlayEnabled`.
  (The compare state itself, `Zotero.PaperMirror.exportTranslatedPdf()` and
  the overlay mode are untouched — only the orphaned plumbing is gone.)
- The 141-line hand-drawn brand-badge set, obsolete since the real official
  marks landed in 0.4.3. The fallback is now the neutral letter tile; the
  generic-endpoint globe stays.
- 25 orphaned locale strings per language (old settings-pane labels, mode
  tooltips, 复制译文 / 生成译文PDF button labels), the dead `paneRatio`
  pref, the 生成译文PDF button CSS, and the empty `addon/` and
  `docs/design/` scaffolding directories.

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

[Unreleased]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.10...v0.8.0
[0.7.10]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.9...v0.7.10
[0.7.9]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.8...v0.7.9
[0.7.8]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.7...v0.7.8
[0.7.7]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.6...v0.7.7
[0.7.6]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/wandonwe/PaperMirror-for-Zotero/compare/v0.4.3...v0.5.0
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
