# 日志系统设计（v0.6.3 · Phase 3）

> Phase 1 统一文件/降噪/缓冲；Phase 2 JSONL/实时 tail/运行时配置/requestId；Phase 3 继续补齐**重复日志合并、插件级日志级别、结构化诊断导出**。

## 1. 数据流

```
ctx.logger.*（内核/插件） ─┐
                          ├─→ core/logger.ts ─→ 控制台
RPC / 扫描 / 清理 / 安装 ─┘        │   （插件级 level 覆盖）
                                   ├─→ utils/log-file.ts
                                   │      ├─ 去重窗口（level+scope+message）
                                   │      ├─ JSONL 文件（缓冲 → 轮转 → 保留）
                                   │      └─ onLogEvent 事件总线
                                   │              ├─ Web 服务端 → WebSocket `log`
                                   │              └─ Electron 主进程 → IPC `log`
                                   └─→ 界面实时 tail
app/logs/entries / export-json / export / recent ─→ 同一文件
```

## 2. LogEntry 结构

```json
{
  "ts": "2026-10-26T10:15:26.563Z",
  "level": "info",
  "scope": "rpc",
  "message": "plugins/install",
  "fields": { "ms": 42 },
  "requestId": "rpc-18",
  "pluginId": "ai-workshop"
}
```

- `level`：`debug | info | warn | error`
- `scope`：`rpc / app / scan / clean / 插件名 / kernel`
- `fields`：已脱敏、字符串截断、数组/深度受限
- `requestId`：RPC 关联 ID；`pluginId`：插件来源

## 3. 重复日志合并（Phase 3）

- 默认窗口 **3000ms**，按 `level + scope + message` 合并；
- 窗口内第一条正常写入；后续重复只计数；
- 窗口结束输出一条汇总，`fields.repeat = N`（含总数），避免插件刷屏；
- 设置项 `logging.dedupeWindowMs` 可调；`0` 关闭；
- 读取日志/进程退出/切换配置前自动 flush 汇总，不丢数据。

## 4. 插件级日志级别（Phase 3）

- 设置项 `logging.pluginLevels: { "plugin-id": "warn" }`；
- 插件日志按 `message.name`（插件名）匹配覆盖级别，未配置则跟随全局；
- 设置页「插件级别覆盖」可为每个插件单独选择 `debug/info/warn/error` 或留空跟随全局；
- 全局/插件级变更均**运行时生效**，无需重启。

## 5. 运行时日志设置

```jsonc
"logging": {
  "level": "info",
  "maxBytes": 5242880,
  "keep": 2,
  "retainDays": 14,
  "dedupeWindowMs": 3000,
  "pluginLevels": {}
}
```

- 设置保存后立即应用；
- `CORDCLEAN_LOG` 环境变量仍可覆盖全局级别；
- 写入 64KB/100ms 缓冲，进程退出自动 flush。

## 6. RPC 日志降噪与关联

- 高频只读 RPC 成功不记；失败/慢请求（≥500ms）/业务方法记录；
- 参数摘要：Key/Token 脱敏，代码/文件/清单只记形状；
- 每次 RPC 生成 `requestId`（`rpc-N`），失败/慢请求日志可关联。

## 7. 界面与诊断

设置 → 诊断与日志：

- **运行日志**：级别/来源筛选、关键字搜索、暂停、自动刷新、**实时开关**（WebSocket/IPC）、复制、打开目录；
- **结构化诊断（JSON）**：导出环境 + 最近 2000 条结构化日志，便于机器分析；
- 原诊断报告（txt）继续保留；
- 日志设置：级别 / 单文件上限 / 轮转份数 / 旧日志保留天数 / 重复合并窗口 / 插件级别覆盖。

## 8. 性能（2026-10-26，Windows 11 / Node 24.22.1）

| 指标 | 数值 |
| --- | --- |
| JSONL 缓冲写入（20,000 行，含 flush） | 约 **204,000 行/秒 · 35.2 MB/秒** |
| 读取末尾 1000 条 | 12.5 ms |
| 统一脱敏 | 约 863,000 次/秒 |
| RPC 参数摘要 | 约 699,000 次/秒 |

复现：`pnpm bench:logging`。去重合并为窗口内 O(1) Map 操作；基准测试关闭去重以测原始写入能力。

## 9. 测试

- `tests/logging.test.ts`：JSONL 解析、实时事件总线、运行时级别、轮转/保留、脱敏、RPC 降噪、requestId、重复合并、插件级别、结构化诊断导出；
- 全量：65 个测试文件 / 473 个用例。

## 10. 后续

- 远程诊断上传（需要服务端与隐私开关）；
- 同 scope 重复告警的智能告警摘要（跨窗口统计）；
- 日志文件按大小/日期混合保留策略的更多模板。
