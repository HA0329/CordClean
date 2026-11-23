# CordClean 项目事实表

> 本文件由 `pnpm facts` 从源码、`vitest list` 与规则 JSON 自动生成，**请勿手改**。
> 生成时间：2026-11-23T14:11:39.307Z；commit：`882b6ed`；版本：`0.6.11`。
> 论文、README、答辩材料引用数量时以本表为准；性能数字以 [benchmark.md](benchmark.md) 为唯一来源；历史发布说明保留发布时口径。

| 项目 | 值 | 来源 |
| --- | --- | --- |
| 当前版本 | 0.6.11 | `package.json` |
| 内置插件 | 12 个（默认启用 8 个，运行时 active 8 个） | `packages/core/src/manifest.ts` + 运行时 `ctx.plugins.list()` |
| 默认清理任务 | 38 个 | 运行时 `ctx.cleaner.list()`（全部内置插件加载后） |
| RPC 方法 | 73 个 | `packages/shared/src/rpc.ts` 的 `ApiMap` |
| 测试文件 | 95 个 | `tests/*.test.ts` |
| 测试用例 | 716 个 | `pnpm exec vitest list --json` |
| 规则库 | 37 类 / 401 条（catalog 28 类/271 条 + extra 9 类/130 条） | `packages/plugins/rule-pack/rules/*.json` |
| 性能快照 | 2026/11/23 16:58:41 · win32 10.0.26100 · 12 核 · Node 24.22.1 | [benchmark.md](benchmark.md)（`pnpm bench` 生成） |

## 口径说明

- 测试用例数来自运行中的 Vitest 收集结果，包含循环/动态生成的用例；静态 `it(` 计数通常会少几条，不能作为论文数字。
- `docs/verification/*`、`docs/release-notes-*`、`docs/defect-log.md` 是历史快照，保留当时版本的测试数量，不代表当前仓库口径。
- 论文中引用性能数据时，必须同时给出 [benchmark.md](benchmark.md) 的快照日期与运行环境；重新跑 `pnpm bench` 会覆盖该文件并生成 `docs/benchmark.json`。
