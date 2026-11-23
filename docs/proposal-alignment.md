# 开题报告 ↔ 仓库对齐表

> 目的：把《基于 Cordis 插件架构的 Windows 安全清理工具的设计与实现》开题报告中的声明，
> 逐条映射到仓库里的代码、测试和文档；写论文/答辩时只引用这张表和
> [项目事实表](project-facts.md)、[性能基准](benchmark.md) 的数字。
>
> 状态含义：✅ 已对齐；🟡 口径需注意（已实现但有边界）；🔴 待补（开题后优先处理）。

## 1. 已对齐的声明

| 开题报告声明 | 仓库证据 | 核对方式 |
| --- | --- | --- |
| 题目：基于 Cordis 插件架构的 Windows 安全清理工具 | README 标题、`package.json` description、`docs/thesis-outline.md` 题目 | `pnpm docs:check` |
| 当前版本 v0.6.10，自 2026-10 起持续迭代 | `package.json` 0.6.10；`git log` 2026-10-18 起 | `git log --reverse` |
| 12 个内置插件（8 个默认启用） | `packages/core/src/manifest.ts` + 运行时 `ctx.plugins.list()` | [project-facts.md](project-facts.md) |
| 默认 38 个清理任务 | 运行时 `ctx.cleaner.list().length`（加载全部插件后） | [project-facts.md](project-facts.md) |
| 72 个 RPC 方法 | `packages/shared/src/rpc.ts` 的 `ApiMap` | `pnpm facts` |
| 插件可注册任务、卡片、状态项、命令、页面 | `packages/shared/src/plugin-api.ts`、`packages/core/src/domains/kernel/ui.ts` | `pnpm test:platform` |
| inject 声明依赖、effect 登记副作用、卸载回退 | `packages/core/src/domains/kernel/plugins.ts`；E7/E8 | `tests/e7-unload.test.ts`、`tests/e8-dependency.test.ts` |
| 六层删除安全链（路径策略—链接祖先—补偿链—执行器—隔离恢复—审计） | `packages/core/src/domains/safety/{path-policy,compensate,executor,quarantine,recycle-bin}.ts`、`domains/engine/history.ts` | `pnpm test:security`、`pnpm test:engine` |
| 补偿链七步复核 + `CleanTicket` 票据 | `compensate.issue()` 七步；执行器只接受 `isCleanTicket()`；**消费标记/TTL 仍待补，见 D1** | `tests/compensate.test.ts`、`tests/engine.test.ts` |
| 取消清理返回已执行部分，不丢报告 | `executor.execute()` 返回 `ExecuteOutcome.cancelled`；`cleaner.clean()` 保留 partial report | `tests/engine.test.ts`、`tests/compensate.test.ts` |
| 隔离区保存副本 + manifest，可恢复 | `quarantine.ts`、`tests/quarantine.test.ts`、S-01 修复记录 | `tests/quarantine.test.ts` |
| 回收站逐项回执 | `recycle-bin.ts` 的 PowerShell JSON 回执 | `tests/recycle.test.ts`（如存在）/ `pnpm test:engine` |
| AI 顾问只接收脱敏画像、输出结构化 JSON | `plugins/ai/src/{profile,service}.ts`、`egress.ts` | `pnpm test:ai` |
| AI 工坊四道静态闸门（导出/契约、inject、manifest/权限、语法/危险 API） | `packages/shared/src/plugin-code.ts`、`packages/core/src/domains/kernel/{plugin-package,plugin-installer}.ts`、`plugins/ai-workshop` | `tests/ai-plugin-workshop.test.ts`、`tests/ai-workshop-plugin.test.ts` |
| 危险路径/链接祖先用例 | `tests/path-attack.test.ts`（14 条）、`tests/path-policy.test.ts`、`tests/fs-safety.test.ts` | `pnpm test:security` |
| 性能快照 | `docs/benchmark.md` + `docs/benchmark.json`（2026-11-23 在目标机重跑） | `pnpm bench`（Windows 目标机） |

## 2. 术语统一

| 开题报告 / 旧文档 | 仓库统一用 | 说明 |
| --- | --- | --- |
| `CleanupToken`（开题报告表 3） | `CleanTicket` | 代码与论文统一用 `CleanTicket`；建议把开题报告表 3 改成“补偿令牌（CleanTicket）” |
| “Cordis 插件架构” / “Cordis 插件框架” | 题目用“Cordis 插件架构”，技术章节可称“Cordis 插件框架” | Cordis 本身是框架；“插件架构”指本文在其上建立的清理领域架构 |
| “三层安全模型”（旧版论文大纲） | “六层删除安全链” | 旧大纲的“路径策略—隔离区—注册表备份”已过期，论文统一写六层 |
| “安全清理” | 删除行为可约束、可恢复、可审计 | 不是杀毒/防护软件；摘要第一段就要定义 |

## 3. 仍需补的差异（开题后优先）

### 🔴 D1. “一次性令牌”目前不是一次性的

- 代码现状：`CleanTicket` 只有 `issuedAt`，没有 `consumed` 标记 / TTL；`executor.recheck()` 只校验路径策略、存在性和 clear 链接，不核对签发时的 `size`/`mtimeMs`。同一 ticket 可以重复 `execute`；签发后同路径文件被替换，也可能按旧票据删除。
- 开题报告写法：在补齐前，不要把“一次性令牌”写成已完全实现；可写“令牌化入口 + 执行前复核”，并把消费校验列为开题后工作。
- 建议实现：`CleanTicket` 增加 `consumed`/nonce + TTL；`CompensateService.recheck()` 对文件比较 `size`/`mtimeMs`；补“重放票据”“同路径替换”两个回归用例。

### 🔴 D2. AI 根建议没有过路径策略

- 代码现状：`AiView.vue` 把模型返回的 `roots` 直接加入 `analysis.roots`；`large-files`/`empty-dirs` 又把每个 `analysis.roots` 注册为 `addRoot` + `addUserRoot`。UI 只对 AppData/Windows 等宽目录做提示，`C:\`、`C:\Users` 仍可加。
- 开题报告写法：对普通建议成立，对 `roots` 不成立；不要写成“AI 的全部输出都经路径策略校验”。
- 建议实现：root 建议默认不勾选；单独走 `pathPolicy.check`（或新增 `checkSuggestedRoot`），拒绝盘符根/系统目录/用户根；或把“分析范围”和“清理辖区”拆成两个概念。

### 🔴 D3. `preflightDirectory` 会让大于 5000 项的目录整体跳过

- 代码现状：`executor.ts` 的 `preflightDirectory` 递归 `open(file,'r+')`，`visited > 5000` 直接返回“目录项过多，已跳过”；浏览器缓存、`%TEMP%` 很容易超过 5000 项；只读文件也会 EACCES 导致整目录跳过。
- 影响：核心清理场景（大缓存目录）可能永远清不掉；benchmark 的 4000 文件数据集覆盖不到。
- 建议实现：预检只做顶层抽样，或超限时降级为逐项删除 + partial 报告；`r+` 只用于占用探测；补 5 万项目录用例。

### 🟡 D4. “唯一删除入口”有内部维护路径例外

- 代码现状：`plugins/recycle` 直接 `fs.unlink` 删 `$I` 元数据；`plugin-installer`、`mover`、AI 临时目录也有直接 `rm/unlink`。
- 论文写法：改为“**用户数据**删除统一经执行器；插件安装 staging、回收站元数据、移动/临时文件属于内部维护路径”，并指向 [威胁模型](threat-model.md)。不要写“所有文件删除都只有一个入口”。

### ✅ D5. 性能快照已在目标机重跑（v0.6.10）

- 现状：2026-11-23 在 Windows 11（Ryzen 5 5600 / 12 线程 / Node 24.22.1）用 v0.6.10 重跑 `pnpm bench`，`docs/benchmark.md` 与 `docs/benchmark.json` 为同一次快照（6.5 ms / 167.6 ms / 25 786 文件·秒^-1 / 2 031 文件·秒^-1）。
- 注意：性能数字随机器与磁盘状态波动，论文表 6-2 引用时写清本次快照的日期、CPU/内存/磁盘、Windows 版本与 commit。

## 4. 论文里建议怎么写

- 已对齐的部分：直接引用 [project-facts.md](project-facts.md) 与 [benchmark.md](benchmark.md)，不要在各章手抄数字。
- D1~D3：要么在开题后补代码和测试，要么在论文“局限与后续工作”里如实写“当前实现为 X，Y 尚未完成”。不要用“已实现”掩盖差异；答辩时被追问代码细节会很难看。
- D4：用“用户数据删除”限定范围，既准确又不削弱贡献。
- 每次改数量/性能，先跑 `pnpm facts`、`pnpm docs:check`，再改论文。
