# 日志系统设计（v0.6.2 · Phase 2）

> Phase 1 解决「统一文件 + 降噪 + 缓冲写入」；Phase 2 继续完成**结构化 JSONL、运行时日志配置、实时 tail、requestId 关联**。

## 1. 数据流

```
ctx.logger.*（内核/插件） ─┐
                          ├─→ core/logger.ts ─→ 控制台
RPC / 扫描 / 清理 / 安装 ─┘        │
  （host/server.ts 中间件）         ├─→ utils/log-file.ts
                                   │      ├─ JSONL 文件（缓冲 → 轮转 → 保留）
                                   │      └─ onLogEvent 事件总线
                                   │              ├─ Web 服务端 → WebSocket `log` 事件
                                   │              └─ Electron 主进程 → IPC `log` 事件
                                   └─→ 界面实时 tail
app/logs/recent / entries / info / export ─→ 同一文件
```

- 文件：`<dataDir>/logs/cordclean.log`，**每行一个 `LogEntry` JSON**；
- 实时：日志写入时同步广播，不依赖轮询；
- 插件日志与 RPC/诊断日志完全同一条链路。

## 2. LogEntry 结构

```json
{
  "ts": "2026-10-26T10:15:26.563Z",
  "level": "info",
  "scope": "rpc",
  "message": "plugins/install",
  "fields": { "ms": 42, "params": { "path": "<120 chars>" } },
  "requestId": "rpc-18",
  "pluginId": "ai-workshop"
}
```

- `level`：`debug | info | warn | error`
- `scope`：`rpc / app / scan / clean / 插件名 / kernel`
- `fields`：结构化附加字段，**已脱敏**、字符串截断 500、数组最多 20 项、深度 ≤3
- `requestId`：一次 RPC 请求的关联 ID（`rpc-N`），错误/慢请求日志可与前端操作对应
- `pluginId`：插件日志自动填插件名

## 3. 写入、轮转与保留

- 64KB / 100ms 缓冲写盘，`process exit` 前自动 flush；
- 默认单文件 5MB → `.1`、`.2`；保留份数可配置；
- 旧 `app-*.log` / `diagnostics-*.txt` 启动时按 `retainDays`（默认 14 天）清理；
- 旧版纯文本日志行会被读取器包装成 `legacy` 条目，不会报错。

## 4. 运行时日志设置

设置 → 日志设置，或直接写 config：

```jsonc
"logging": {
  "level": "info",          // debug | info | warn | error
  "maxBytes": 5242880,      // 单文件上限
  "keep": 2,                // 轮转保留份数
  "retainDays": 14          // 旧日志保留天数
}
```

- 保存后立即生效（settings 变更 → core logger 重新应用），无需重启；
- `CORDCLEAN_LOG` 环境变量仍可覆盖级别，方便开发/排障。

## 5. RPC 日志降噪

- 成功的高频只读 RPC 默认不记（`system/live`、`app/info`、`plugins/list` 等）；
- 失败请求、慢请求（≥500ms）、业务方法记录；
- 参数摘要：Key/Token 脱敏，`code/files/manifest/config` 只记形状；
- 失败 RPC 带 `requestId`，界面实时 tail/日志查看器可直接看到。

## 6. 界面日志查看器与实时 tail

设置 → 诊断与日志 → 运行日志：

- 级别/来源筛选 + 关键字搜索；
- 暂停 / 自动刷新 / **实时开关**（走 `log` WebSocket/IPC 事件，不落轮询）；
- 复制、打开日志目录、显示文件路径与大小；
- 结构化展示：时间、级别、来源、requestId、消息、JSON 字段；
- 兼容历史日志（legacy 行）。

## 7. 崩溃与未处理异常

Web/桌面外壳注册 `uncaughtException` / `unhandledRejection`，写入统一日志并带堆栈。

## 8. 性能（2026-10-26，Windows 11 / Node 24.22.1）

| 指标 | 数值 |
| --- | --- |
| JSONL 缓冲写入（20,000 行，含 flush） | 约 **205,000 行/秒 · 35.5 MB/秒** |
| 读取末尾 1000 条 | 12.7 ms |
| 统一脱敏 | 约 856,000 次/秒 |
| RPC 参数摘要 | 约 677,000 次/秒 |

复现：`pnpm bench:logging`（`bench/logging.bench.ts`）。

## 9. 测试

- `tests/logging.test.ts`：JSONL 解析、实时事件总线、运行时级别、轮转/保留、脱敏、RPC 降噪、requestId、诊断导出；
- 全量：65 个测试文件 / 471 个用例。

## 10. 后续

- 日志去重/节流（同一 scope 短时间重复告警合并）；
- 可选 JSON Schema 校验/日志上传诊断服务；
- 插件级别的日志级别覆盖（目前全局级别）。
