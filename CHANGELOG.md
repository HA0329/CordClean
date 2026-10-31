# 更新日志（Changelog）

> 发布约定：**每次更新都必须有可读的更新说明**。
> 具体做法：新增 `docs/release-notes-vX.Y.Z.md`、在本文件追加对应条目、在 annotated tag 消息中写摘要，并在推送后创建 GitHub Release。
> 版本号遵循语义化版本；详细设计见对应文档。

## v0.6.7 — 2026-10-31

### %TEMP% 逐文件拆分 + 任务级批量操作

- `%TEMP%` 不再作为单个清理项，改为逐顶层条目上报；默认不勾选，可逐项选择，并跳过 CordClean 自身数据目录；
- 清理能力区新增分类三态勾选、全选任务、反选、扫描选中任务；
- 全量 65 个文件 / 475 个用例通过；后端复核 307 条临时条目、根目录项不再出现。

详细说明：[docs/release-notes-v0.6.7.md](docs/release-notes-v0.6.7.md)

## v0.6.6 — 2026-10-31

### 真实用户走查 P2 修复

- 结果区数字对账（发现 = 可清理 + 受保护；可清理 = 推荐 + 待确认）；
- Web 外壳不再误显示 Electron Node；
- 清理能力区支持任务搜索/风险筛选，任务列表限高滚动；
- 历史记录支持展开查看回收站/隔离区/消失/跳过/失败明细；
- AI 未配置 Key 时增加「填写 API Key」入口；
- 日志时间带日期（MM-DD HH:mm:ss）；
- 全量 65 个文件 / 475 个用例通过；P2 复核见 [走查报告](docs/verification/usability-walkthrough-2026-10-31.md)。

详细说明：[docs/release-notes-v0.6.6.md](docs/release-notes-v0.6.6.md)

## v0.6.5 — 2026-10-31

### 真实用户走查 P1 修复

- 扫描结果页「去选择可清理项」自动定位结果区；步骤条按状态高亮；
- 历史页撤销按钮按 `clean/undo-state.available` 禁用并说明原因；任务显示可读名称；
- 预演结果「继续实际清理」保留选择并直接进入实际清理确认；
- 空目录默认不勾选、不进入推荐；整体 `%TEMP%` 标记不推荐并提示风险；`defaultSelected` 与 `recommended` 对齐；
- 全量 65 个文件 / 475 个用例通过；走查复核见 [修复记录](docs/verification/usability-walkthrough-2026-10-31.md#8-p1-修复记录2026-10-31)。

详细说明：[docs/release-notes-v0.6.5.md](docs/release-notes-v0.6.5.md)

## v0.6.4 — 2026-10-28

### PC-Cleaner 规则库同步

- 上游最新 **v0.9.11**：重新导入 `rules.json` 并与本地逐条对比，规则数据 28 分类 / 271 条完全一致；
- 上游多出的 `broken_shortcuts` 由 `shortcuts` 插件实现、`dev_purge`（依赖 `<CWD>`）有意不导入；
- 同步 v0.9.11 安全保护网：`wechat files` / `tencent files` / `weixin` / `weixinshuju` / `xwechat_files`、`.git` / `.venv` / `.idea` / `.vscode` 按完整路径段拦截；
- 保持 `%APPDATA%\Tencent\WeChat\Logs` / `Temp` 可清理，新增保护测试；
- 规则审计：37 分类 / 401 条 / 414 根，0 错误；全量测试 65 文件 / 474 用例。

详细说明：[docs/release-notes-v0.6.4.md](docs/release-notes-v0.6.4.md) · [规则同步验收](docs/verification/pc-cleaner-rules-sync-2026-10-28.md)

## v0.6.3 — 2026-10-26

### 日志系统 Phase 3

- **重复日志合并**：默认 3000ms 窗口内按 `level + scope + message` 合并，输出汇总 `fields.repeat`，可在设置中调整或关闭（`0` 关闭）；
- **插件级日志级别**：`logging.pluginLevels` 支持按插件覆盖 debug/info/warn/error，设置页可按插件选择；
- **结构化诊断导出**：新增 `app/logs/export-json` RPC 与「导出 JSON」按钮，包含环境 + 最近 2000 条结构化日志；
- 设置页新增重复合并窗口、插件级别覆盖；日志设置均可运行时生效；
- 验证：65 个测试文件 / 473 个用例通过；JSONL 写入约 204,000 行/秒；README/架构/测试计划/论文大纲同步。

详细说明：[docs/release-notes-v0.6.3.md](docs/release-notes-v0.6.3.md) · [日志设计](docs/logging.md)

## v0.6.2 — 2026-10-26

### 日志系统 Phase 2

- **结构化 JSONL**：统一日志文件改为每行一个 `LogEntry`（ts/level/scope/message/fields/requestId/pluginId）；
- **实时 tail**：新增 `onLogEvent` 总线，WebSocket/IPC 推送，日志查看器支持实时开关；
- **运行时日志配置**：级别、单文件上限、轮转份数、旧日志保留天数可在设置中即时调整；
- **RPC requestId**：每次 RPC 生成 `rpc-N`，失败/慢请求日志可关联；
- 新增 `app/logs/entries` RPC；验证：65 个测试文件 / 471 个用例通过。

详细说明：[docs/release-notes-v0.6.2.md](docs/release-notes-v0.6.2.md)

## v0.6.1 — 2026-10-26

### 统一日志系统（Phase 1）

- 内核/插件日志与诊断日志统一写入 `<dataDir>/logs/cordclean.log`，插件日志进入界面；
- 64KB/100ms 缓冲写入 + 5MB 轮转/保留策略，旧 `app-*.log` 自动清理；
- RPC 日志降噪：高频只读成功不记，失败/慢请求记录，参数摘要 + 统一脱敏；
- 日志查看器支持级别过滤/搜索/暂停/自动刷新/复制/打开目录；
- 新增崩溃/未处理异常日志；验证：64→65 文件 / 468 用例通过。

详细说明：[docs/release-notes-v0.6.1.md](docs/release-notes-v0.6.1.md)

## v0.6.0 — 2026-10-26

### 插件系统 v2 + 独立 AI 插件工坊

- 外部插件升级为目录 + `plugin.json` v2 清单：apiVersion/engines/权限/依赖声明；
- 安装事务 staging → 校验 → 原子落盘/回滚，旧单文件插件继续兼容；
- AI 插件工坊拆为独立插件，默认生成多文件 v2 插件包，独立 API 配置、审阅后安装；
- AI 清理顾问修复图片/补充说明发送与直答路径；磁盘实时采样、源码查看器；
- 真实模型验收 4/4 类插件；验证：64 个测试文件 / 462 个用例通过。

详细说明：[docs/release-notes-v0.6.0.md](docs/release-notes-v0.6.0.md) · [验收报告](docs/verification/ai-workshop-live-test-2026-10-26.md)

## 更早版本

- v0.5.x：扫描/清理基础能力、规则库、插件化框架、AI 清理顾问、双外壳与测试体系。详见仓库历史与 [docs](docs/)。
