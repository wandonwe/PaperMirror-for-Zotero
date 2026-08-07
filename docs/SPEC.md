# PaperMirror for Zotero 完整开发 Prompt(v0.1.0 现状复刻版)

> 用途:将本文档整体交给 AI 编码助手,即可从零重建(或在现有代码上继续开发)PaperMirror 插件。
> 本文档在原始需求书基础上,固化了针对 Zotero 9.0.6 **实测验证过的接口结论与已知陷阱**,后续开发不得凭空推翻。

---

你是一名熟悉 TypeScript、Mozilla/XUL、PDF.js 和 Zotero 插件体系的高级开发工程师。请为 Zotero 9.0.x 开发一个可实际安装、运行和打包的插件。不要只输出架构说明或伪代码;生成完整项目源代码、构建脚本、测试、XPI 打包流程和使用文档。

## 一、项目概述

- 中文名:Zotero 双语阅读器;英文名:PaperMirror for Zotero
- 插件 ID:`zotero-bilingual-reader@local`;版本 `0.1.0`;协议 AGPL-3.0
- 核心功能:在 Zotero 内置 PDF 阅读器中提供"原文 + 译文"左右双屏对照阅读,按页码与段落对应、同步滚动
- 增强功能(均已实现,必须保留):
  1. **免费翻译引擎**(移植自 immersive-translate/old-immersive-translate):必应 `ttranslatev3`(抓取 bing.com/translator 页面的 IG/IID/key/token 会话,缓存 8 小时,失效自动刷新)与谷歌 `translate_a/t?anno=3&client=te`(TKK="448487.932609646" 的 tk 签名算法,多 q 表单编码,响应按 q 序对齐,`<pre>/<b>/<i>` 注释清洗)。**默认服务商为必应免费引擎(国内可直连,零配置可用)**
  2. **服务商预设**(参照 mengxi-ream/read-frog):DeepSeek、Kimi(Moonshot)、通义千问(dashscope compatible-mode)、智谱 GLM(/api/paas/v4)、Gemini(/v1beta/openai,不追加 /v1)、OpenRouter、SiliconFlow、Groq、Ollama 本地(localhost:11434,无需 Key),全部走 OpenAI 兼容通道,选中后自动带入默认 Base URL 与模型
  3. **选中句子深度讲解**(参照 read-frog):PDF 选中文字后经官方 `renderTextSelectionPopup` 弹窗按钮或面板「讲解」按钮触发,LLM 输出四段式讲解(整体翻译/关键术语/句法结构/缩写与符号),渲染在面板顶部可关闭卡片;免费 MT 引擎不支持讲解时给出明确提示
  4. **沉浸式风格译文面板**:文章流排版(行距 1.8、标题分级、图注弱化),「显示原文对照」开关在每段译文上方以灰色小字显示原文(pref 记忆)
- 图标:蓝色渐变磁贴 + 左白纸(折角、灰色文字行)+ 右磨砂玻璃镜面(白色文字行),SVG 源文件渲染 48/96px PNG 打入 XPI

## 二、目标环境与已验证接口(不得虚构、不得凭空推翻)

目标 Zotero 9.0.x(基线 9.0.6,tag `eabf364`,reader 子模块 `9643fac`),不兼容 6/7/8;macOS/Windows/Linux。

`manifest.json`:manifest_version 2,`applications.zotero` 内 `strict_min_version: "9.0"`、`strict_max_version: "9.0.*"`。

以下为对照源码实测确认的结论,全部未公开接口只允许出现在 `src/reader/zoteroReaderAdapter.ts` 适配层中,消失时抛 `READER_API_CHANGED` 并优雅降级:

1. **插件生命周期**:`bootstrap.js` 顶层函数 `startup/shutdown/install/uninstall/onMainWindowLoad/onMainWindowUnload({ id, version, rootURI }, reason)`;沙箱内置 `Zotero, Services, ChromeUtils, IOUtils, PathUtils, Localization, setTimeout, fetch, XMLHttpRequest` 等;`prefs.js` 自动加载默认 pref;`locale/<loc>/*.ftl` 自动注册 Fluent(XHTML 中 `<link rel="localization" href="papermirror.ftl"/>`)。
2. **【陷阱】插件沙箱没有 `AbortController`**(plugins.js 的 wantGlobalProperties 白名单不含它)。HTTP 层必须用 `XMLHttpRequest`(自带 timeout/abort),并安装纯 JS 的 AbortController/AbortSignal polyfill(仅协作取消,不传给 fetch)。
3. **Reader 事件**:`Zotero.Reader.registerEventListener(type, handler, pluginID)`,type 含 `renderToolbar`、`renderTextSelectionPopup`。**必须传 pluginID**——9.0.6 的 `unregisterEventListener` 过滤逻辑写反(会保留目标、误删他人),不可调用;Zotero 在插件 shutdown 时按 pluginID 自动清理。`append()` 必须在事件回调内同步调用(custom-sections 契约);选中文本在 `event.params.annotation.text`。
4. **【陷阱】工具栏按钮注入已打开的标签**:toolbar 的 CustomSections 仅在 React 重渲染时派发事件;同 tick 内 `setToolbarPlaceholderWidth(x+1); setToolbarPlaceholderWidth(x)` 会被 React 批处理为无变化(不重渲染)。方案:直接向 `reader._iframeWindow.document.querySelector('.toolbar .custom-sections')` 注入 `<div class="section">` 包裹的按钮(下次自然重渲染会被 replaceChildren 清掉、由事件监听重建,不会重复),另加隔 150ms 时序的两拍 nudge 兜底。
5. **【陷阱】分屏布局绝不能移动 `<browser>` 元素**——重新挂载会销毁 frameloader,阅读器白屏。正确做法:`ReaderTab._tabContainer`(`<tab-content>` 元素)设为 inline `display:flex; flex-direction:row`,分隔条与译文面板作为 browser 的**兄弟节点**插入(`browserEl.after(divider, paneHost)`),左右交换用 CSS `order`,browser 用 `flex: 0 0 calc(N% - 3px)` 控宽;destroy 时精确还原两者的原始 inline style 并移除自建节点。
6. **文本提取主路径**:`reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument.getPageData({ pageIndex })`(Zotero 定制版 PDF.js,官方 read-aloud 同源用法),返回阅读顺序 chars:`{ c, rect:[x1,y1,x2,y2], fontName, fontSize, ignorable, spaceAfter, lineBreakAfter, paragraphBreakAfter }`;跨 compartment 需将 chars 逐字段拷贝为普通对象。降级路径:`Zotero.PDFWorker.getFullText(itemID, null, true)`,`\f` 分页。
7. **页码同步**:当前页读 `_internalReader._state.primaryViewState.pageIndex`(debounce 有延迟,需 `item.getAttachmentLastPageIndex()` 与 0 兜底);面板打开期间 350ms 轮询 + `Zotero.Notifier`(['tab'] close 清理会话);跳页用 `reader.navigate({ pageIndex })`。
8. **设置页**:`Zotero.PreferencePanes.register({ pluginID, id, src, scripts, label, image })`,XHTML fragment(XUL 默认命名空间 + html: 前缀);pane 脚本运行在设置窗口,与插件沙箱隔离——通过启动时挂载的 `Zotero.PaperMirror` 公共 API 通信(listProviders/getApiKey/setApiKey/testConnection/cache/glossary/diagnose/toggle),shutdown 时删除。
9. **凭据**:`Services.logins`(Login Manager,origin `chrome://zotero-bilingual-reader`)为主,失败降级到 pref JSON;注册到日志脱敏器。
10. **笔记**:`new Zotero.Item('note')` + `parentID` + `setNote(escapedHTML)` + `saveTx()`;深链 `zotero://open-pdf/library/items/<KEY>`。
11. 仅支持 ReaderTab(有 `_tabContainer/tabID`);独立 ReaderWindow 不显示按钮(`supportsSplitView` 判定)。

## 三、核心使用流程

打开 PDF → 工具栏「译」按钮 → 左右分屏(左原生 PDF,右结构化译文)→ 自动判向(中文→英文,其他→简体中文)→ 双向同步滚动 → 本地缓存 → 复制/保存子笔记/深度讲解。首次翻译前显示隐私提示(注明实际发送域名)。

## 四、功能需求要点

**4.1 双屏**:默认 55:45 可拖动记忆;左右可交换;开关不影响原生阅读;浅色/深色主题(matchMedia 检测);面板含标题、方向、状态、同步开关、讲解、对照、重新翻译、取消、复制(纯译文/原文+译文)、保存笔记、交换左右、设置、关闭。

**4.2 提取**(纯函数模块 blockBuilder,可单测):基于 chars 断行/断段标志重建段落;英文续行去连字符、CJK 无空格拼接;双栏交错检测与重排(安全网,fork 已排好序则原样);页眉页脚/裸页码过滤(上下 5% 带);标题/图注/表注/列表分类(字号中位数 + 正则);公式保护 `⟦PMn⟧` 占位(LaTeX 定界必护、符号密度启发式),译后还原(含裸 token 兜底);References/参考文献默认截断,可开关。SourceBlock 含 id(`page-N-block-M`)/pageIndex/order/type/sourceText/boundingBox。扫描件三页采样判空后明确报"需要 OCR",绝不伪造译文。

**4.3 翻译策略**:按页懒加载(当前页优先级 10,前 1 后 2 页优先级 1 预取);RequestScheduler 并发 ≤2、指数退避重试(仅 retryable)、快速翻页 `cancelExcept` 取消过时任务、用户可取消;分块 ≤6000 字符或 24 块/请求;LLM 请求带 previousContext(仅理解不输出)、结构化 JSON 返回按 id 对应、缺失 id 只补译缺失部分;数值/P 值/CI/引用编号不得改动;术语表只发送命中的规则(required/suggested 两种)。

**4.4 服务商**(Provider Adapter,接口含 `validateConfiguration/translate/complete?`):bing-free、google-free、anthropic(Messages API)、openai、deepseek、moonshot、qwen、zhipu、gemini、openrouter、siliconflow、groq、ollama、openai-compatible、deepl(v2/translate,按索引对齐)、custom(允许 HTTP 需显式开关)。OpenAI 兼容工厂参数:`requiresApiKey?`、`noV1Suffix?`(URL 构建:无版本段自动补 /v1,gemini/openrouter/groq 等例外)。BYOK,不内置任何开发者 Key;Key 不落日志/缓存/笔记/导出。

**4.5 术语表**:`原文 → 译文`(行尾 ` ?` 为仅供参考)行格式 + JSON 导入导出;匹配大小写不敏感;合并优先级 per-item > collection > global。

**4.6 同步滚动**:页/块锚点;SyncGuard 冷却窗(400ms)防循环(纯函数,可单测);左右双向;可关闭;误差不超一页。

**4.7 缓存**:`<data dir>/bilingual-reader/cache/<attachmentKey>-<fileHash>/page-N_<sl>_<tl>_<provider>_<model>_vP_<textHash>.json`;IOUtils.writeJSON tmpPath 原子写;schema 校验失败即删;清除当前/全部;显示占用;文件 md5 用 `item.attachmentHash`。

**4.8 笔记**:blockquote 原文 + 译文 + 来源(标题/页码/深链),全部 escapeHTML。

## 五、设置页

翻译服务(服务商下拉含全部预设、Base URL 占位符显示默认地址、API Key、模型自动带入、测试连接显示 HTTP 状态/模型可用/耗时)、语言与模型(默认全部自动填充:auto/auto/60000ms/并发2)、阅读界面、术语表、缓存与隐私、高级(调试日志/允许 HTTP/仅本地模式)、关于。所有绑定手动同步(不依赖 preference 属性魔法);XUL menulist 需 selectedIndex 兜底。

## 六、技术架构

TypeScript strict + esbuild(单 bundle `content/index.js`,IIFE,`.css` 以 text loader 内联,零运行时依赖);`node:test` 跑测试(esbuild 先编译到 build/tests);目录结构按原需求书(lifecycle/reader/translation/providers/cache/notes/security/preferences/ui/utils + locale ×3 + tests + scripts)。bootstrap 加载 bundle 后调用 `PaperMirrorBundle` 生命周期对象。shutdown 注册表 LIFO 执行所有 disposer,禁用后不重启即可完全还原(监听器/定时器/DOM/样式/公共 API)。日志全部过脱敏器(密钥模式 + 运行时注册密钥),默认不记录全文。

**脚本**:`npm run typecheck / test / build / package / dev-install`;package.mjs **必须每次强制重建**再 zip(防陈旧 bundle 进 XPI);XPI 根目录含 manifest.json。

## 七、错误处理

错误码枚举:NO_API_KEY / INVALID_API_KEY / INVALID_MODEL / NETWORK / TIMEOUT / RATE_LIMITED / QUOTA_EXCEEDED / BAD_RESPONSE / NO_TEXT_LAYER / PDF_ENCRYPTED / EXTRACTION_FAILED / READER_API_CHANGED / CACHE_CORRUPT / CANCELLED / HTTP_INSECURE;HTTP 映射:401/403→INVALID_API_KEY,404→INVALID_MODEL,429→RATE_LIMITED(含 quota 字样→QUOTA_EXCEEDED 不重试),402→QUOTA_EXCEEDED,5xx→NETWORK 可重试。全部有本地化用户提示。提供 `Zotero.PaperMirror.diagnose()` 自检(版本/沙箱全局/阅读器状态/按钮存在性/Key 配置)与 `Zotero.PaperMirror.toggle()` 手动开关。

## 八、隐私与安全

BYOK、无遥测;首次使用显示隐私提示并注明发送域名;自定义端点强制 HTTPS(localhost 除外,HTTP 需显式开关);仅本地模式拒绝非 localhost;译文/讲解只以 textContent 渲染,永不执行远程 HTML/JS;笔记 HTML 全量转义。

## 九、测试(现状 107 个,必须全绿)

单测覆盖:语言检测、段落合并/去连字符、双栏重排、页眉页脚过滤、References 截断、公式占位/还原、JSON 提取与校验(缺失/重复/多余 id)、缓存键与失效、错误映射、日志脱敏、术语表解析/匹配/合并、同步防循环、调度器(并发/重试/取消/优先级)、AbortController polyfill、免费引擎(tk 哈希、注释清洗、q 对齐、必应页面解析、语言映射、长文切分)、讲解(prompt 构建/MT 拒绝/无 Key 拒绝/超长截断)、预设注册表(id 唯一/默认值/chatURL 构建)、笔记 HTML 转义;集成测试用合成 chars fixtures 跑全管线(单栏/双栏/中文/混排/公式/图注/References/扫描件/失败传播/50+ 页缓存隔离)。

## 十、验收标准

原 15 条全部保留(XPI 可装、双屏可用、中英互译、同步滚动、宽度记忆、≥2 类接口、缓存持久与清除、子笔记、Key 不泄露、关闭全清理、npm 三命令可跑、生成 XPI、README 完整),另加:默认必应免费引擎零配置可翻译;9 个预设选中即自动填 Base URL/模型;选中讲解在 LLM 下可用、MT 下有明确提示;「显示原文对照」可开关且记忆;`diagnose()` 可运行。

## 十一、已知限制(如实保留在 README)

仅带文本层 PDF(无 OCR);表格不重建;仅 ReaderTab;References 默认跳过;页码轮询 350ms;加密 PDF 不支持;免费端点为逆向网页接口,上游改版可能失效(已做会话刷新与明确报错,届时切 LLM 服务商)。

## 十二、执行方式

先核对 Zotero 9.0.6 源码确认上述接口 → 输出简短计划 → 建完整项目 → 每模块过 `tsc --noEmit` 与测试 → 打包 XPI → 输出文件树/架构说明/测试结果/XPI 路径/安装方法/已知限制/下一步建议。MVP 优先保证"可安装、可关闭、不破坏 Zotero、英文 PDF 稳定出中文对照",再谈 OCR、表格重建与批量翻译。
