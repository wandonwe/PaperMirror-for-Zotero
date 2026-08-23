# Zotero 10 阅读模式(Reading Mode)接入调研备忘录

**日期**:2026-08-19
**结论性质**:纯代码调研,未修改 PaperMirror 任何代码
**证据来源**:`github.com/zotero/reader` @ `d156498a` (2026-08-11) 与子模块
`github.com/zotero/structured-document-text`(schema.d.ts, 601 行)
**未验证**:调研环境无 Zotero 10 运行时,以下全部结论来自源码阅读,**尚未在真机确认**

---

## 0. 一句话结论

阅读模式是**叠加视图**而非替换视图,原 PDF 视图与 PDF.js 全程存活;Zotero 为它
构建了一套**语义文档模型(SDT)**,内容涵盖 PaperMirror 十几个版本用启发式硬啃的
全部问题(分栏、表格、页眉页脚、多行标题、跨页续段、参考文献),且每块带 PDF 页
坐标。**接入是可行的,而且阅读模式的对照翻译比现有 PDF 路径更简单**。

---

## 1. 先纠正一个错误判断

此前(v2.0.0 交付时)我推测:阅读模式下 PaperMirror 会抛
`PDFViewerApplication is not reachable`。**源码显示这个推测是错的。**

`src/common/reader.js` `_setReadingMode()`:

```js
if (baseView?._iframe) {
    baseView._iframe.style.visibility = 'hidden';
    baseView._iframe.style.position = 'absolute';
}
this[sdtViewKey] = this._createView(primary, location, { sdt: true });
```

基础视图(`_primaryView`,即 PDF.js 视图)**只是被隐藏,对象与 iframe 都还在**。
因此:

- `_primaryView._iframeWindow.PDFViewerApplication` **仍然可达**
- PaperMirror 的抽取链路(`getPageData` / 文本层)**在阅读模式下照常工作**
- 但**渲染会画到隐藏的 iframe 上,用户看不见**

### 由此推断的当前(v2.0.0)真实行为

| 模式 | 推断行为 | 置信度 |
|---|---|---|
| 覆盖(overlay)模式 | 译文画在隐藏 iframe 上 → **用户看不到任何东西**,且不报错 | 高 |
| 分屏(split)模式 | 面板独立于隐藏 iframe,**可能仍显示**;但页面位图取自 PDF.js canvas,隐藏 iframe 是否继续惰性渲染新页未知 → 可能空白/陈旧页 | **低,需实测** |

**这比报错更糟**:静默无输出,用户无从判断。这是 A 方案(防护)存在的理由。

---

## 2. 运行机制

### 2.1 视图对象

| 键 | 含义 |
|---|---|
| `_internalReader._primaryView` | 基础视图(PDF.js),阅读模式下仍存在,仅 `visibility:hidden` |
| `_internalReader._primarySDTView` | 阅读模式叠加视图,**开启时创建,关闭时 `destroy()` 并置 null** |
| `_internalReader._secondaryView` / `_secondarySDTView` | 同上,用于 Zotero 自身的分屏 |

### 2.2 状态标志

`_internalReader._state` 上:

- `primaryReadingModeEnabled` / `secondaryReadingModeEnabled` — 布尔
- `readingModeLoading` — SDT 加载中
- `sdtProgress` — SDT pack 构建进度

### 2.3 切换是串行化的

`_setReadingMode()` 用 `this._readingModeQueue` 串行化,避免快速切换产生两个叠加
视图。**监听方需要容忍中间态**(`readingModeLoading: true` 期间视图尚未创建)。

### 2.4 SDT 数据从哪来

```js
// reader.js:1250 getSDTReader()
result = await this._getSDTPack({ onProgress });   // 宿主(Zotero)注入
// 版本校验:packVersion !== SDT_PACK_VERSION 或 schemaMajorVersion 不符 → 放弃
```

`_getSDTPack` 由**宿主 Zotero 注入**(`options.getSDTPack`),reader 只消费。
说明 SDT 包在 Zotero 侧构建并缓存(与我们自己的翻译缓存无关)。
`_loadSDT()` 结果缓存在 `_internalReader._sdt = { structure, mapper }`。

**若宿主没提供 `_getSDTPack`,`getSDTReader()` 直接返回 null** → 阅读模式不可用
(reader 会显示 `reader-reading-mode-not-supported`)。因此不能假设任何 PDF 都有 SDT。

---

## 3. 可用接口清单(都挂在 PaperMirror 已访问的 `_internalReader` 上)

| 用途 | 接口 | 备注 |
|---|---|---|
| 检测是否处于阅读模式 | `_state.primaryReadingModeEnabled` | 推荐主判据 |
| 兜底检测 | `_primarySDTView != null` | 与上者应一致 |
| 加载中 | `_state.readingModeLoading` | 避免中间态误判 |
| 阅读模式 DOM 文档 | `_primarySDTView._iframeDocument` | `SDTView extends DOMView` |
| 阅读模式 window | `_primarySDTView._iframeWindow` | |
| 逐块元素 | `_iframeDocument.querySelectorAll('#sdt-content > [data-ref-path]')` | sdt-view.ts:140 已如此用 |
| 语义结构 | `_internalReader._sdt.structure` | 需先 `await _loadSDT()` |
| 位置映射器 | `_internalReader._sdt.mapper` | `createPositionMapper(structure)` |

### 块元素的 DOM 约定(renderer.ts)

```js
let refPath = ref.join('.');      // 例如 "12" 或 "12.3.1"
span.dataset.refPath = refPath;   // → data-ref-path="12.3.1"
span.id = 'sdt-' + refPath;       // → id="sdt-12.3.1"
```

**即每个语义块在 DOM 里有稳定、可寻址的元素**,这是注入译文的天然锚点。

> 注意:`flowClass === 'excluded'` 的块**根本不渲染**(renderer.ts:71),
> 多段块(`previousPart`/`nextPart`)会被合并渲染为一个元素
> (`renderedAsPart` 集合)。因此 **DOM 块数 ≠ structure 块数**,
> 遍历时必须以 DOM 的 `data-ref-path` 为准,不能按 structure 下标对齐。

---

## 4. SDT 语义模型(这才是真正的金矿)

`ContentBlockNode` 联合类型:

```
ParagraphNode | HeadingNode | MathNode | ImageNode | BlockquoteNode
| ListNode | TableNode | CaptionNode | NoteNode | PreformattedNode
```

`TableNode` 下还有 `TableRowNode` / `TableCellNode`。

### 4.1 直接命中 PaperMirror 历史 bug 的字段

| SDT 字段 | 对应我们踩过的坑 | 相关版本 |
|---|---|---|
| `flowClass: "auxiliary" \| "excluded"` | 页眉页脚判定;栏底正文被当页脚丢弃 | **1.2.4** |
| `type: "heading"` | 正文被批量误判为 heading(中位数字号) | **1.2.5** |
| `type: "heading"` + 层级 | 多行标题被当正文 | **1.2.3** |
| `previousPart` / `nextPart` | 跨栏/跨页续段;假 heading 当合并屏障 | 1.2.4/1.2.5 |
| `TableNode/Row/Cell` | 表格标签列坍塌、三栏页误判为表 | **1.2.0/1.2.1/1.2.2** |
| `reference?: boolean` | 参考文献识别 | 既有启发式 |
| `type: "caption"` | 图注碎片重聚 | **1.1.8** |
| (Zotero 侧统一构建) | 首字下沉加冕整行 | **1.2.5** |

**换言之:1.1.8 → 1.2.5 这一整串修复所对抗的问题,SDT 在数据层就已经解决。**

### 4.2 关键:SDT 带 PDF 坐标

```ts
export type PdfAnchor = {
  pageRects?: [PageRect, ...PageRect[]];
  textMap?: string;   // 打包的逐 run 布局:[header, pageIndex, minX, minY, maxX, maxY, ...widths]
};
export type PageRect = [number, number, number, number, number];  // [pageIndex, x1, y1, x2, y2]
```

**这意味着 SDT 不只对阅读模式有用**:在标准 PDF 视图里,也能用 SDT 的
`pageRects` 喂给现有的固定几何渲染器,把启发式管线整体替换掉。

### 4.3 文本结构

```ts
ParagraphNode.content: TextNode[]
TextNode = { text: string; style?: { bold?, italic?, ... }; refs?; target?; anchor? }
```

`TextNode` 粒度带样式与引用目标 —— 与我们现有的 `styleRuns` / 占位符保护
(公式、引文、统计量)概念一致,可对接,但需要重新做映射。

---

## 5. 三条实现路径

### A. 防护(小,低风险)

在阅读模式下明确禁用并提示,而不是静默无输出。

- 判据:`_state.primaryReadingModeEnabled === true`
- 行为:对照按钮置灰 + tooltip「阅读模式暂不支持,请切回标准视图」
- 需要监听切换(`_setReadingMode` 是异步串行的,应通过既有 reader 状态变更回调
  或轮询 `_state` 判定;**具体监听点需真机确认**)
- 风险:低。最坏情况是判据取不到 → 退化为现状。
- 前置:无。可立即实施。

### B. 阅读模式内对照翻译(中)

按 `#sdt-content > [data-ref-path]` 逐块注入译文。

**为什么比现有 PDF 路径简单**:文字可重排 → 不需要遮罩、不需要 measure-to-fit、
不需要压缩/缩字号/边界扩展。`strictPageReplacement.ts`(1057 行)那一整套机制在
这条路径上**根本不需要**。

- 复用:翻译调度、缓存(键需加"视图模式")、术语表、占位符保护、验收
- 新建:一个 SDT 渲染通道(注入 + 样式 + 滚动同步)
- 风险:中。DOM 细节、注入位置、Zotero 自身重渲染时机、注解冲突
  (阅读模式仅允许 highlight/underline/note 三种工具)均需实测
- 前置:建议先做 A;需要真机截图与诊断反复迭代

### C. 用 SDT 重构抽取管线(大)

把 SDT 作为抽取源,替换 `spanBlockBuilder` / `tableGuard` / `metaFilter` /
`regionCoalescer` / `readingOrder` 的启发式。

- 收益:标准 PDF 视图**也**大幅受益;上表 1.1.8–1.2.5 那一串问题从根上消失
- 代价:抽取层几乎重写;**12 个语料快照必须全部重新基线**,且要证明不回退
- 风险:高。SDT 不可用时(`_getSDTPack` 缺失、版本不符、旧 PDF)必须保留现有
  管线作为回退 → 长期维护两套抽取路径
- 前置:B 的经验;充分的真机语料

---

## 6. 待真机验证清单

无论走哪条路,以下必须实测确认(我在此环境无法验证):

1. **v2.0.0 在阅读模式下的实际表现** —— 覆盖模式是否真的静默无输出?分屏模式
   是否仍显示、位图是否陈旧?
2. `_state.primaryReadingModeEnabled` 在真机上的实际存在性与时序
3. 阅读模式切换的**可监听事件**(现只确认了状态字段,未找到公开事件)
4. `_getSDTPack` 在真机 Zotero 10 上对普通学术 PDF 的可用率(是否常见 null)
5. SDT 构建耗时与 `sdtProgress` 的实际表现(大文档是否明显卡顿)
6. `#sdt-content > [data-ref-path]` 在真实论文上的块粒度是否符合预期

**采集方式**:在 Zotero 10 打开 PDF、切到阅读模式,「工具 → 开发者 → Run JavaScript」
运行只读探针脚本(见上一轮对话),标准视图各跑一次对比。

---

## 7. 对现有架构的判断

不建议为阅读模式**推倒重来**。合理的形态是**双渲染通道**:

```
                        ┌── 标准 PDF 视图 → 固定几何通道(现有 strictPageReplacement)
翻译调度/缓存/术语/验收 ─┤
                        └── 阅读模式     → 可重排通道(新建,按 data-ref-path 注入)
```

抽取层则可独立演进:SDT 可用时走 SDT,不可用时回退现有启发式 —— 这与既有
`DocumentIR` 的方向一致,也是上一轮外部审核"第三批架构优化"里提到的解耦。

**缓存影响**:视图模式必须进入缓存身份(与 1.3.0 把 `customPromptHash` 加入
缓存键同理),否则两种通道的译文会互相串。

---

## 8. 引用位置索引

| 结论 | 文件:行 |
|---|---|
| 阅读模式是叠加视图、基础视图仅隐藏 | `src/common/reader.js` `_setReadingMode()` |
| 切换串行化队列 | `src/common/reader.js` `_readingModeQueue` |
| SDT 加载与缓存 | `src/common/reader.js:1308` `_loadSDT()` |
| SDT pack 由宿主注入 + 版本校验 | `src/common/reader.js:1250` `getSDTReader()` |
| SDTView 类与 iframe 文档 | `src/dom/sdt/sdt-view.ts:77` |
| 块选择器 `#sdt-content > [data-ref-path]` | `src/dom/sdt/sdt-view.ts:140` |
| `data-ref-path` / `id` 生成 | `src/dom/sdt/lib/renderer.ts:137-140` |
| `excluded` 块不渲染、多段合并 | `src/dom/sdt/lib/renderer.ts:71-82` |
| 语义节点联合类型 | `structured-document-text/schema.d.ts:135` |
| `PdfAnchor` / `PageRect` | `schema.d.ts:157-182` |
| `FlowClass` | `schema.d.ts:206` |
| `ParagraphNode` / `TextNode` | `schema.d.ts:301-338` |

---

## 9. 建议

若要动手,顺序建议 **A → 真机验证 → B → (视收益再评估) C**。

A 现在就能做且风险低;它同时把第 6 节第 1 条(v2.0.0 的静默无输出)这个**已经
存在于线上版本的问题**堵住。C 收益最大但应等 B 积累了 SDT 的真机经验再评估。
