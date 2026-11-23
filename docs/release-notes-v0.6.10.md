# CordClean v0.6.10 发布说明

> **历史快照**：本文是 v0.6.10 发布时的说明，测试数按发布时记录为 489；
> 当前事实表为 532（后续安全加固新增用例），见 [project-facts.md](project-facts.md)。

**发布日期：2026-11-14** · 前置版本：v0.6.9

本次修复 E8 实验发现的插件管理器状态不同步问题，并补齐 E7/E8 设计属性验证材料。

## 重点修复

### 插件依赖挂起时的状态同步（E8 发现）

背景：provider 被禁用时，Cordis 会把依赖它的 consumer fiber 自动置为 `PENDING`，但插件管理器原来仍显示 consumer 为 `active`。

修复：

- `PluginInfo.status` 新增 **`suspended`**；
- `PluginManager.list()` / `find()` 改为从真实 fiber 状态派生 effective status：
  - ACTIVE → `active`
  - PENDING → `suspended`
  - FAILED → `error`
  - DISPOSED / UNLOADING → `stopped`
  - 管理器自己的 `loading` / `error` / `stopped` 优先保留；
- `suspended` 仍视为「已启用」：插件开关保持打开，依赖恢复后会自动回到 active；
- 插件管理页状态标签新增「等待依赖」，并增加 `.status-suspended` 配色；
- E8 自动化测试新增断言：禁用 provider 后 `plugins.list()` 的 consumer status 必须为 `suspended`，重新启用后恢复 `active`。

### E7/E8 设计属性验证材料

- E7：插件卸载无残留正例/阴性对照，见 [E7 实验设计](experiments/e7-unload-residue.md)；
- E8：provider/consumer 依赖挂起与自动恢复，见 [E8 实验设计](experiments/e8-dependency-response.md)；
- 两个实验均可通过 `pnpm exec vitest run tests/e7-unload.test.ts` / `tests/e8-dependency.test.ts` 复现。

## 验证

- 全量测试：**69 个测试文件 / 489 个用例通过**；
- `tsc` / `vue-tsc` 0 错误；`pnpm build` 成功；
- E8 测试同时验证：consumer 自动挂起/恢复、管理器 `suspended`/`active` 状态同步。

## 兼容性

- 新增 `suspended` 状态值；读取 `plugins/list` 的旧前端需能处理未知状态（当前界面已处理并显示「等待依赖」）；
- 不改变 Cordis 依赖响应与插件启停语义；
- 既有插件配置、任务、规则库无迁移。

## 已知限制

- 依赖状态派生以当前 fiber 状态为准，不额外保存历史；UI 仍依赖 `plugins/changed` 事件刷新；
- 多个 provider/consumer、循环依赖等场景尚未纳入 E8；
- 本次为本地发布候选，尚未推送 GitHub Release。
