# 日志系统设计（v0.6.1）

> 目标：**一个文件、一个格式、默认安静、可查可控**。v0.6.1 把原先并行的两套日志（Cordis `app-*.log` 与诊断 `cordclean.log`）合并为统一日志系统。

## 1. 数据流

```
ctx.logger.*（内核/插件） ─┐
                          ├─→ core/logger.ts ─→ 控制台
RPC / 扫描 / 清理 / 安装 ─┘        │
  （host/server.ts 中间件）         ├─→ utils/log-file.ts → <dataDir>/logs/cordclean.log
                                   │      （缓冲 → 轮转 → 保留）
                                   └─→ system/log 事件 → 界面实时通道
app/logs/recent / app/logs/info / app/logs/export ─→ 同一文件
```

- 插件日志不再写到单独的 `app-YYYY-MM-DD.log`，而是与诊断日志进入同一个 `cordclean.log`，因此界面“运行日志”能直接看到插件日志；
- 旧版 `app-*.log`、过期 `diagnostics-*.txt` 会在启动时按 14 天保留期自动清理；
- 写入采用 64KB / 100ms 缓冲，进程退出前 `exit` 钩子 flush，避免每行一次同步写盘。

## 2. 文件与格式

- 位置：`<dataDir>/logs/cordclean.log`；
- 单行格式：`ISO时间 [level] [scope] message [JSON extra]`
  - level：`error | warn | info | debug`
  - scope：`rpc / app / scan / clean / 插件名 / kernel` 等
  - extra 最多 600 字符，已脱敏（Key/Token/Authorization 替换为 `<redacted>`）
- 轮转：单文件超过 5MB → `cordclean.log.1`、`.2`；保留份数 2；更旧文件删除；
- 读取：`app/logs/recent` 返回末尾 N 行；`app/logs/info` 返回文件路径与大小；`app/logs/export` 生成 `diagnostics-*.txt`（环境 + 最近 1000 行）。

## 3. RPC 日志降噪（host/logging.ts）

- **默认只记录**：失败请求、耗时 ≥500ms 的慢请求、非高频业务方法；
- **不记录成功**的高频只读方法：`system/live`、`app/info`、`plugins/list`、`settings/get`、`ui/contributions` 等（见 `QUIET_RPC_METHODS`）；
- 参数先摘要：`apiKey/token/authorization/password` → `<redacted>`；`code/files/manifest/config` 等只记 `<N chars>` / `<array:N>` / `<object>`；
- 校验失败只记方法与失败原因，不记录请求体。

## 4. 界面日志查看器

设置 → 诊断与日志 → 查看最近日志：

- 级别过滤（error/warn/info/debug/all）；
- 关键字搜索；
- 暂停 / 自动刷新（3 秒）；
- 复制筛选结果、打开日志目录；
- 显示行数与文件大小、真实日志路径；
- 会话内实时事件（`system/log`）仍保留，后续可做独立 tail 面板。

## 5. 崩溃与未处理异常

Web/桌面外壳都注册了 `uncaughtException` / `unhandledRejection`，写入统一日志（带堆栈），避免进程“悄悄退出”后没有线索。

## 6. 性能（2026-10-26，Windows 11 / Node 24.22.1）

| 指标 | 数值 |
| --- | --- |
| 缓冲写入（20,000 行，含最终 flush） | 约 515,000 行/秒 · 89 MB/秒 |
| 读取末尾 1000 行 | 7.7 ms |
| 统一脱敏 | 约 850,000 次/秒 |
| RPC 参数摘要 | 约 705,000 次/秒 |

复现：`pnpm bench:logging`（`bench/logging.bench.ts`）。

## 7. 已知边界与后续

- 当前为“单文件 + 文本行 + JSON 尾巴”，还不是纯 JSONL；如果后续需要机器聚合/上传，可平滑切换为 JSONL（字段已统一：level/scope/message/extra）；
- 日志配置（级别、保留天数、大小）目前由默认值/环境变量控制，后续可做成设置项并运行时生效；
- `system/log` 实时事件尚未做独立界面 tail，当前通过“自动刷新”轮询统一文件；
- 日志调用的强制节流（例如同一 scope 短时间重复日志去重）尚未实现。
