# CordClean v0.6.1 发布说明

**发布日期：2026-10-26** · 前置版本：v0.6.0

本次更新聚焦**日志系统升级**：把原先并行的「Cordis 每日日志」与「自研诊断日志」合并为统一日志系统，并完成 RPC 降噪、日志查看器、崩溃日志、缓冲写入与性能基准。

## 重点更新

### 统一日志文件

- 内核/插件日志与诊断日志统一写入 `<dataDir>/logs/cordclean.log`；
- 固定格式：`ISO时间 [level] [scope] message [JSON extra]`，一条日志带级别与来源；
- 插件日志使用插件名作为 scope，界面「运行日志」现在能看到插件日志；
- 统一脱敏：Key / Token / Authorization 在落盘与实时转发前替换为 `<redacted>`。

### 写入性能与可靠性

- 64KB / 100ms 缓冲写盘，避免每行一次同步 I/O；进程退出前自动 flush；
- 日志轮转统一为 5MB → `.1`、`.2`，保留份数 2；启动时清理 14 天前的旧 `app-*.log` / `diagnostics-*.txt`；
- 基准：缓冲写入约 **515,000 行/秒（含 flush，89 MB/秒）**，读取末尾 1000 行 7.7ms。

### RPC 日志降噪

- 成功的高频只读 RPC（`system/live`、`app/info`、`plugins/list` 等）默认不记日志；
- 失败请求、慢请求（≥500ms）、业务方法仍记录；
- 参数摘要化：Key 脱敏，代码/文件/清单只记形状，不再把大段代码写进日志。

### 日志查看器与诊断

- 设置 → 诊断与日志：级别过滤、关键字搜索、暂停、自动刷新、复制、打开目录；
- 显示真实日志文件路径与大小；新增 `app/logs/info` RPC；
- 诊断导出包含统一日志（最近 1000 行）与环境摘要；
- Web/桌面外壳新增 `uncaughtException` / `unhandledRejection` 日志。

## 验证

- 自动化测试：**65 个测试文件 / 468 个用例全部通过**（新增 `tests/logging.test.ts`：轮转/保留/脱敏/RPC 降噪/内核日志统一）；
- `tsc` / `vue-tsc` 0 错误；`pnpm build` 成功；
- 新增 `pnpm bench:logging`，基准结果见 [日志系统设计](../docs/logging.md)；
- 日志实现说明：`docs/logging.md`。

## 兼容与升级

- 日志目录会自动迁移（旧 `app-*.log` 保留 14 天后清理），无需手动操作；
- 新增日志文件仍位于 `<dataDir>/logs`，诊断导出/打开目录行为不变；
- 日志界面与 RPC 契约向后兼容（`app/logs/recent` 不变，仅新增 `app/logs/info`）。

## 已知限制

- 日志仍为文本行 + JSON 尾巴，尚未切换纯 JSONL；
- 日志级别/保留策略暂为默认值（环境变量控制），后续可做成设置项；
- 实时 `system/log` 暂无独立 tail 面板，界面通过 3 秒自动刷新统一文件查看。
