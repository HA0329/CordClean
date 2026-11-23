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
| 当前版本 v0.6.11，自 2026-10 起持续迭代 | `package.json` 0.6.11；`git log` 2026-10-18 起 | `git log --reverse` |
| 12 个内置插件（8 个默认启用） | `packages/core/src/manifest.ts` + 运行时 `ctx.plugins.list()` | [project-facts.md](project-facts.md) |
| 默认 38 个清理任务 | 运行时 `ctx.cleaner.list().length`（加载全部插件后） | [project-facts.md](project-facts.md) |
| 72 个 RPC 方法 | `packages/shared/src/rpc.ts` 的 `ApiMap` | `pnpm facts` |
| 插件可注册任务、卡片、状态项、命令、页面 | `packages/shared/src/plugin-api.ts`、`packages/core/src/domains/kernel/ui.ts` | `pnpm test:platform` |
| inject 声明依赖、effect 登记副作用、卸载回退 | `packages/core/src/domains/kernel/plugins.ts`；E7/E8 | `tests/e7-unload.test.ts`、`tests/e8-dependency.test.ts` |
| 六层删除安全链（路径策略—链接祖先—补偿链—执行器—隔离恢复—审计） | `packages/core/src/domains/safety/{path-policy,compensate,executor,quarantine,recycle-bin}.ts`、`domains/engine/history.ts` | `pnpm test:security`、`pnpm test:engine` |
| 补偿链七步复核 + `CleanTicket` 票据 | `compensate.issue()` 七步；执行器只接受 `isCleanTicket()`；nonce + 5 分钟 TTL + 一次性消费（见 D1） | `tests/compensate.test.ts`、`tests/engine.test.ts` |
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

## 3. 已补 / 待补差异（开题后优先）

### ✅ D1. 一次性令牌与执行前复核（2026-11-23 已补齐）

- 现状：CleanTicket 增加 
once + 5 分钟 TTL；执行器在真正删除前同步 consume()，同一票据第二次执行、超时执行都直接拒绝。echeck() 现在按签发时记录的 size/mtimeMs 复核，签发后同路径文件被替换会被跳过（eason=changed）。dryRun 预览不消费票据。
- 证据：	ests/safety-hardening.test.ts（重放/过期/替换/mtime 变化/dryRun 不烧票）；功能探针复测：重放返回「令牌已被使用过（重放）」，替换后 reedBytes=0 且文件仍在。
- 残余：消费记录在进程内存，票据本身不落盘，因此没有跨进程重放窗口；若要跨重启审计，需要把票据/消费记录落盘（未做）。

### 🟡 D2. AI 根建议的扩权闸门（部分补齐）

- 现状：AI 建议的宽目录（AppData/Desktop/Downloads 等）**默认不勾选**，必须由用户显式选择；pathPolicy.addRoot/addUserRoot 拒绝把驱动器根登记为清理辖区/用户扫描根（AI 建议、外部插件 targets、用户分析范围三条入口都经过这里）。仍未做：nalysis.roots 与「清理辖区」仍复用一套设置，AI roots 没有逐条走 pathPolicy.check（用户手动确认后仍可能把系统目录/用户根加进分析范围）。
- 证据：packages/core/src/domains/safety/path-policy.ts 的盘符根拒绝；packages/ui/src/views/AiView.vue 的默认勾选逻辑；	ests/safety-hardening.test.ts「驱动器根目录不能被登记为清理辖区」。
- 建议：下一步把「分析范围」和「清理辖区」拆成两个概念，AI roots 只进分析范围。

### ✅ D3. preflightDirectory 不再让大目录整体跳过（2026-11-23 已修）

- 现状：预检改为只检查顶层目录可读性，不再递归 open(file,'r+')；超过 5000 项、只读子项都不再阻塞，删除降级为逐项执行（先 clearDirectory 再删空目录），失败子项如实返回 ok:false，已释放字节照实计入，不再静默跳过。
- 证据：	ests/safety-hardening.test.ts（5001 项目录被完整删除、只读文件不再阻塞）、	ests/in-use.test.ts（预检语义改为顶层可读性）；功能探针：5001 项目录 reedBytes=5001、目录已删除。
- 残余：逐项删除时若个别子项被占用，会留下部分内容并返回失败结果（不再保证「要么全删要么不动」）。
### 🟡 D4. “唯一删除入口”的内部维护例外（已收敛为受控通道）

- 现状：执行器新增 `deleteInternal(path, reason)` 受控内部通道，按 reason 校验前缀（`recycle-bin`/`startup-entry`/`quarantine`/`logs`/`plugin-staging`/`generated-plugins`）；`startup`、`recycle` 插件已改用它，插件内不再有 `fs.unlink`/`deletePath` 直删。`plugin-installer` 暂存/插件包卸载、`mover` 删源、隔离区目录清理也已收敛到该通道（cleanup/deleteSource 回调）；只剩日志轮转（logger 基础设施，无 ctx）属于已记录例外。
- 论文写法：写“**用户数据**删除统一经补偿链 + 执行器；内部维护路径经执行器受控通道或模块内维护删除”，并指向 [威胁模型](threat-model.md)。不要写“所有文件删除都只有一个入口”。
### ✅ D5. 性能快照已在目标机重跑（v0.6.10）

- 现状：2026-11-23 在 Windows 11（Ryzen 5 5600 / 12 线程 / Node 24.22.1）用 v0.6.10 重跑 `pnpm bench`，`docs/benchmark.md` 与 `docs/benchmark.json` 为同一次快照（6.5 ms / 167.6 ms / 25 786 文件·秒^-1 / 2 031 文件·秒^-1）。
- 注意：性能数字随机器与磁盘状态波动，论文表 6-2 引用时写清本次快照的日期、CPU/内存/磁盘、Windows 版本与 commit。

### ✅ D6. 递归删除绕过受保护目录名（2026-11-23 已修）

- 现状：执行器在目录递归删除/清空前扫描子树，命中 `.git`、`.venv`、`.idea`、`.vscode`、微信/QQ 数据目录等受保护名即整项拒绝，不再把受保护目录随父目录一起删掉。
- 证据：`tests/safety-hardening.test.ts` 两条用例；独立审计 P0（2026-11-23）。
- 残余：这是删除前的额外一次全树遍历（大目录 IO 成本约 +1 遍），极端超大目录的扫描时间与删除本身同量级。
### ✅ D7. 隔离区 purge 路径穿越（2026-11-23 已修）

- 现状：`manifest.jsonl` 行结构校验；`storedName` 必须是单层文件名且解析后位于会话目录内，非法记录丢弃并告警；`restore()` 校验原路径必须是绝对路径且不在隔离区内。
- 证据：`tests/quarantine.test.ts` 3 条篡改用例（相对路径穿越、绝对路径、非法恢复目标）。
- 残余：恢复目标已加路径策略校验（D-75：系统目录/辖区外一律拒绝）；同用户仍可篡改清单把目标指向「当前允许清理范围内」的其他位置；清单 HMAC 签名仍未做（密钥与清单同目录同用户可读，收益有限，留作后续）。
## 4. 论文里建议怎么写

- 已对齐的部分：直接引用 [project-facts.md](project-facts.md) 与 [benchmark.md](benchmark.md)，不要在各章手抄数字。
- D1~D3：要么在开题后补代码和测试，要么在论文“局限与后续工作”里如实写“当前实现为 X，Y 尚未完成”。不要用“已实现”掩盖差异；答辩时被追问代码细节会很难看。
- D4：用“用户数据删除”限定范围，既准确又不削弱贡献。
- 每次改数量/性能，先跑 `pnpm facts`、`pnpm docs:check`，再改论文。
