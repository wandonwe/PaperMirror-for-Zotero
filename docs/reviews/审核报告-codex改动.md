# Codex 改动专项审核报告

> 对象:工作区未提交改动(基于 v1.0.1 `25a4562`),18 个文件 +308/−59,
> 新增 docs/REAL_PDF_QA.md、docs/RELEASE_NOTES_1.0.1.md、scripts/verify-xpi.mjs。
> 已在沙盒完整验证:typecheck 干净,**532/532 测试全绿**,build+package+verify-xpi
> 闸门通过。日期 2026-08-15。

## 改动清单(五个主题)

1. **切页隔离**:`setCurrentPage` 主动拒绝离开预取窗口的提取等待者;新增
   `navigationGeneration` 代际号,提取完成后若页面已不在窗口内则丢弃状态,
   过期提取结果不再进入翻译队列;dispose 时清空等待者。
2. **僵尸提取治理**:超时的 worker 提取按页登记(`extractZombies`),存活期间
   同页绝不重复启动 worker 请求;当前可见页改走新增的
   `extractRenderedPage()`(只读已渲染文字层)立即恢复。
3. **提取期表格建模**:`structureTableCells()` 在正文合并**之前**把表格区域
   规整为稳定行/列/单元格块(`page-N-table-…` id):文字单元格逐格翻译,
   数字/统计单元格标 `translationMode:'preserve'` 永不送翻;已归入单元格的
   碎片从正文流中消费掉,不再重复翻译。strictPageReplacement 相应适配
   (preserve 不替换但参与表格几何检测)。
4. **全局并行下限 1→2**:任何配置下都给当前页保留一个槽位(prefs 默认注释、
   UI、normalizeGlobalMax、测试同步)。
5. **发布工程**:构建过滤 .DS_Store/AppleDouble、移除 `.built` 时间戳
   (可复现构建)、XPI 内置 LICENSE 与 THIRD-PARTY-NOTICES;打包后自动校验
   清单/版本号/违禁文件(verify-xpi.mjs);SPEC/CHANGELOG/QA 文档更新。

## 总评

方向全部正确:主题 1、2、4 精准回应了上一份审核报告的 P2-1/2/5/6(提取隔离、
预取治理、并行下限),主题 3 落地的是路线图里排了很久的"表格逐格翻译",
主题 5 是纯净增益。四个新回归测试(切页隔离、文字层恢复、僵尸去重、单元格
建模)写得到位。**可以合入**,但有 1 个 P1 建议合入前修掉,另有几个 P2 与
两个此前遗留 P1 需要排期。

---

## P1(建议合入前修)

### P1-1 表格单元格把"表格列号"写进了"页面栏号",搅乱整页阅读序

`tableStructure.ts:278` `column: cell.col` —— `cell.col` 是表格内列索引
(0..n),而 `SourceBlock.column` 全工程语义是**页面栏**(0=左栏,-1=通栏)。
`textExtractor.ts` 随后 `orderBlocksForReading([...prose, ...tableCells])`
按 column 升序重排:

- 单栏页含 3 列表格 → 全页被误判为"3 栏页"参与重排,正文(栏0)之后跟着
  表格第 1 列、再第 2 列;
- 双栏页左栏有表格 → 表格第 1 列单元格混进**右栏正文**的排序里。

影响:文章视图顺序错乱、chunk 打包与上下文跨表格断裂、layoutModules 的
栏一致性假设被破坏。覆盖模式不受影响(按几何定位)。**修法**:单元格的
`column` 改存表格区域所在的页面栏(用区域中心对 detectColumns 的 bands 求
`columnOf`,或整表标 -1 当通栏处理);表格列号如需保留,放新字段 `tableCol`。

## P2

1. **僵尸/超时恢复路径绕开信号量与超时**:两处 `await extractRenderedPage()`
   (zombie 分支、TIMEOUT catch 分支)既不占提取槽也无超时保护。实际实现读
   DOM 文字层通常毫秒级、obstaclesFor 自带 2.5s 超时,风险低,但建议同样套
   `withExtractTimeout` 求一致。
2. **当前页文字层为空时仍会"闪回等待点击"**:TIMEOUT 分支里 rendered 为空 →
   静默删状态返回,可见页回到 idle 胶囊。触发条件苛刻(worker 挂 + 文字层
   未渲染),建议至少 flashNotice 一句"本页读取失败,滚动或点圆环重试"。
3. **僵尸存活期间强制重译永远走低保真路径**:worker 永挂时该页永远用文字层
   提取(无 paragraphBreak 标志,质量略低)且无日志区分来源。建议
   `retranslatePage('force')` 顺带清该页 `extractZombies`(接受重复 worker
   的风险换一次全质量重试),或在诊断里标注提取来源。
4. **上次审核的信号量竞态仍在**:`withExtractionSlot` 的
   `if (active>=2) await` 检查-等待-自增仍非原子,唤醒间隙可短暂 3 路并发。
   codex 加的 reject 通道没触碰这段;改 `while` 复查即闭合。
5. **小瑕疵**:`preferences.ts:167` 与 `strictPageReplacement.ts:678` 各有一处
   缩进错位(不影响编译);CHANGELOG 的 `[Unreleased]` 段落合入时应并进下一个
   版本号;`docs/RELEASE_NOTES_1.0.1.md` 与仓库"发布说明不入库"的既有约定
   (.gitignore 只挡 `发布说明-*.md`)是否要保留请定夺。

## 此前遗留、本次未涉及(仍开放)

- **P1 裸占位符前缀碰撞**(PM1 吃 PM10):`restoreFormulas`/`verifyPlaceholders`
  仍用 `includes(bare)`,公式偶发乱码的根源未修。
- **P1 keep-origin 段进页缓存后普通刷新救不回**:缓存条件与 `failedSegments`
  清理策略未动。

建议下一个版本(1.0.2)= P1-1(表格栏号)+ 上面两个遗留 P1 + P2-4/5 顺手修。

## 验证记录

- `npm run typecheck` / `typecheck:tests`:通过
- `npm test`:532/532(新增 4 例全部通过,与 CHANGELOG 声明一致)
- `npm run package`:XPI 生成并通过 verify-xpi 闸门(LICENSE/NOTICES 在包内,
  无 .DS_Store/.built,版本号匹配)
- 表格建模用点坐标喂给 detectTableRegions(em≈10)与其像素阈值同量级,单测
  通过;**真实 PDF 的表格页请按 codex 新增的 docs/REAL_PDF_QA.md 走一遍验收**
  ——几何阈值这类东西,合成测试过了不等于真页面过了。
