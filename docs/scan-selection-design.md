# 扫描结果选择体验升级设计（Cleaning Selection UX v2）

> 目标：扫描出几百到几千条清理项时，用户不需要逐条判断也能安全、快速地做出选择；
> 看不明白的项可以通过「分组 + 说明 + 打开位置 + 风险默认策略」处理。

## 1. 现状问题（v0.2.0 界面）

- 扫描结果只有一张平铺表格（每页 60 条），没有按任务/类别聚合，千条级结果无法总体决策；
- 默认勾选只是「全部 safe 项」，用户不知道"为什么这些被勾上"，也无法按阈值/风险调整；
- 每项已有 `note`（规则说明）、`mtime`、`meta`、风险等级，但界面只显示名称/路径/大小/风险，说明信息被浪费；
- 批量操作只有「本页全选 / 恢复默认 / 清空」，不能按筛选结果、按大小、按类别选择；
- 危险项与安全项混在一起，缺少"推荐选择"和逐项详情，用户只能凭路径猜；
- 受保护项被过滤掉但看不到原因，用户会误以为"扫描漏了"。

## 2. 市面清理工具的选择交互（调研摘要）

详见 `docs/research/scan-selection-ux.md`。共同规律：

1. **决策单位上移**：不要求用户逐条勾选文件，而是按「类别/任务」给出聚合大小与勾选框（360、火绒、CCleaner、Dism++、Windows 磁盘清理）。
2. **默认推荐 + 风险分层**：安全项默认勾选、谨慎项默认不勾选并给出说明、高风险项需要显式操作（CleanMyMac、BleachBit、Dism++）。
3. **可解释**：每个类别有"这是什么/删了会怎样"的一句话说明（BleachBit、Windows 磁盘清理、Dism++ 描述列）。
4. **可筛选/可排序**：按大小排序找大头、按类别过滤、搜索路径（CCleaner 高级模式、WizTree/TreeSize 的大文件视角）。
5. **批量助手**：全选/反选、按类别全选、按大小阈值筛选（Glary/Wise、存储感知的大文件清理）。
6. **渐进披露**：先给汇总，想看细节再下钻到文件列表，避免首屏被上千行淹没。

## 3. 升级方案

### 3.1 三个视图

| 视图 | 内容 | 作用 |
| --- | --- | --- |
| **分组总览（默认）** | 按功能分类 → 清理任务聚合：风险、项数、大小、推荐项数、空间占比、三态勾选、展开前 3 大项样例 | 千条结果一屏决策，整组勾选 |
| **逐项明细** | 可搜索/按风险/大小过滤/排序/分页的表格；行内「说明」+ 详情抽屉 | 微调、核对具体文件 |
| **受保护项** | 只读列表 + 保护原因 | 解释"为什么不能删"，避免误以为漏扫 |

三个视图共享同一份选择集；切换视图不丢选择。

### 3.2 推荐选择策略（默认勾选 ≠ 全选）

- **安全项（safe）且未被路径策略保护** → 默认推荐勾选；
- **谨慎项（caution）** → 默认不勾选，可手动勾选或通过「包含谨慎项」策略纳入推荐；
- **高风险项（risky）** → 永不批量推荐，必须逐项勾选，清理时强制隔离；
- **受保护项（protected）** → 不可勾选；
- 推荐阈值可调：最小大小 0 / 1 MB / 10 MB / 100 MB（过滤碎文件，聚焦大头）。

界面顶部横幅明确展示："已按安全策略推荐勾选 N 项（M），高风险 X 项、受保护 Y 项未选"，
并提供「应用推荐」「只选安全项」「选大于 100 MB」一键操作。

### 3.3 批量选择助手

- 应用推荐 / 恢复推荐
- 全选当前筛选结果 / 反选当前筛选结果 / 清空
- 按组勾选（三态：全选、部分、未选）
- 本页全选（明细视图）
- 行详情抽屉：类型、大小、修改时间、所属任务与插件、规则说明、风险说明、打开位置

### 3.4 可解释性（"看不明白怎么办"）

- 分组行：任务名 + 类别 + 任务描述 tooltip + 风险 pill + 推荐原因；
- 展开组：前 3 大项的名称/路径/`note` 说明；
- 明细行：名称下方显示 `note`（规则说明）；点击「详情」打开抽屉，展示完整说明与安全解释；
- 风险说明固定文案（安全/谨慎/高风险/受保护），并与删除安全链的闸门对应；
- 提供「打开位置」让用户实地确认；
- 排序支持按大小/修改时间，帮助识别"大而旧"的候选。

### 3.5 性能与规模

- 纯函数做分组/筛选/排序（`packages/shared/src/selection.ts`），只遍历一次；
- 分组视图只渲染 ≤ 任务数（38）行，样例按需展开；
- 明细视图分页（默认 100，可选 200/500），只渲染当前页；
- 选择集用 `Set<id>`，跨筛选/跨页保留；
- 验收用 3,000 条合成数据在真实浏览器里跑（`scripts/ui-mock-server.mjs` + `scripts/verify-clean-ui.mjs`）。

## 4. 模块契约（`packages/shared/src/selection.ts`）

```ts
export interface RecommendOptions {
  minSize?: number                 // 字节，默认 0
  includeCaution?: boolean         // 默认 false；risky 永不推荐
  taskIds?: readonly string[]      // 仅这些任务
}
export function recommendIds(items: readonly CleanItem[], options?: RecommendOptions): string[]

export type SelectionState = 'all' | 'partial' | 'none'
export function selectionState(ids: readonly string[], selected: ReadonlySet<string>): SelectionState

export interface TaskGroup { taskId; name; icon?; category; risk; count; bytes;
  recommendCount; recommendBytes; protectedCount; ids; samples }
export function groupByTask(items, tasks, options?): TaskGroup[]

export interface CategoryGroup { category; name; color; count; bytes; recommendCount; recommendBytes; tasks: TaskGroup[] }
export function groupByCategory(items, tasks, options?): CategoryGroup[]

export interface ItemFilter { query?; taskIds?; risks?; minSize?; onlyRecommended?; onlySelected?; includeProtected? }
export function filterItems(items, filter, selected?): CleanItem[]

export type ItemSort = 'size-desc' | 'size-asc' | 'name' | 'mtime-desc' | 'risk-desc'
export function sortItems(items, sort): CleanItem[]
export function topNBySize(items, n): CleanItem[]

export interface SelectionSummary { count; bytes; byRisk; byTask; warnCount; riskyIds }
export function summarizeSelection(items, selected, tasks): SelectionSummary
```

约束：纯函数、无 DOM/Node 依赖、不依赖 Vue；对 5,000 条输入需在百毫秒级完成分组+筛选+排序。

## 5. 验收标准

1. `tests/selection.test.ts` 覆盖推荐策略、分组聚合、筛选、排序、汇总、边界（空/受保护/未知任务）；
2. `pnpm typecheck` / `pnpm build:ui` / 全量 `pnpm test` 通过；
3. 3,000 条 mock 扫描数据下：分组总览正确渲染、推荐数为 0 风险误选、筛选/排序/整组勾选/详情抽屉/确认摘要可用，无 JS 报错，截图存档；
4. 真实扫描 E2E（Electron/CDP）通过，旧功能（扫描、清理、预演、选择互斥）不回归。

## 6. 落地结果（2026-10-20）

| 项 | 结果 |
| --- | --- |
| 共享选择逻辑 | `packages/shared/src/selection.ts`（15 个导出，纯函数）；`tests/selection.test.ts` 55 条单测 |
| 清理页 UI | `packages/ui/src/views/CleanView.vue` 重写：分组总览 / 逐项明细 / 受保护三视图 + 推荐横幅 + 批量选择助手 + 详情抽屉 + 确认摘要 |
| 测试 | 全量 40 个文件 / 289 条用例全绿（原 234 + 新增 55） |
| 类型检查 / 构建 | `pnpm typecheck` exit 0；`pnpm build:ui` exit 0 |
| 真实 E2E | Electron 6 页正常、真实扫描 552 项、默认推荐 551 项（= safe 且非 protected）、0 JS 异常；截图 `docs/screenshots/ui-clean-result.png`、`ui-clean-items.png` |
| 千条级验收 | 3,000 条 mock 数据：`scripts/verify-clean-ui.mjs` PASS 25/25；独立语义断言 98/98；默认推荐 1,776 项（36.6 GB）且零 risky/protected；交互最大 78 ms；首屏 669 ms |
| 边界数据 | 空扫描 / 全受保护 / 0 字节 / 无说明 / 超长路径均正常，无 JS 异常 |
| 证据 | [验收报告](verification/scan-selection-verify.md)、[市场调研](research/scan-selection-ux.md)、全页截图 `docs/screenshots/scan-select-light.png` / `scan-select-dark.png` |

已知限制（后续可做）：忽略/排除列表（P9）、清理完成后独立结果页（P14）、AI 挑选清理项与选择集联动。

