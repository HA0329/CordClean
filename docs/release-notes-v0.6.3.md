# CordClean v0.6.3 发布说明

**发布日期：2026-10-26** · 前置版本：v0.6.2

本次更新是日志系统 Phase 3：补齐**重复日志合并、插件级日志级别、结构化诊断导出**，让日志在插件多、告警重复的真实场景下更安静、更可控。

## 重点更新

### 重复日志合并

- 默认 3000ms 窗口内，相同 `level + scope + message` 只保留首条，后续只计数；
- 窗口结束输出汇总，`fields.repeat = N`，避免插件刷屏；
- 设置项 `logging.dedupeWindowMs` 可调，`0` 关闭；
- 读取/退出/切换配置前自动 flush，汇总不丢。

### 插件级日志级别

- 新增 `logging.pluginLevels`：可为单个插件指定 `debug/info/warn/error`；
- 设置页「插件级别覆盖」按插件下拉选择，留空跟随全局；
- 全局与插件级变更都运行时生效，无需重启。

### 结构化诊断导出

- 新增 `app/logs/export-json` RPC 与设置页「导出 JSON」按钮；
- 导出环境信息 + 最近 2000 条 `LogEntry` + 日志文件/大小，便于机器分析或反馈；
- 原有 txt 诊断报告保留。

### 设置与界面

- 日志设置卡片新增：重复合并窗口、插件级别覆盖；
- 日志查看器继续支持实时 tail/级别/来源筛选/搜索/暂停/自动刷新/复制/打开目录。

## 验证

- 自动化测试：**65 个测试文件 / 473 个用例全部通过**；
- `tsc` / `vue-tsc` 0 错误；`pnpm build` 成功；
- `pnpm bench:logging`：JSONL 写入约 **204,000 行/秒（35.2 MB/秒）**，读取 1000 条约 12.5 ms；
- 日志文档：[logging.md](logging.md)；基准：[benchmark-logging.md](benchmark-logging.md)。

## 兼容与升级

- 旧配置缺少 `dedupeWindowMs` / `pluginLevels` 时自动使用默认值；
- 旧文本日志仍可读取；`app/logs/recent` / `export` 接口保持兼容；
- 新增 `app/logs/export-json`（第 72 个 RPC）。

## 已知限制

- 暂无远程诊断上传（需要服务端与隐私授权）；
- 去重窗口按进程内合并，不跨重启统计；
- 插件级别覆盖目前跟随插件名，第三方插件需保证 `ctx.logger` 名称稳定。
