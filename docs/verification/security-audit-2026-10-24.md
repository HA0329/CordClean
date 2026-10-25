# CordClean 安全与正确性复审（2026-10-24，追加）

> 基线：v0.5.15
> 方式：独立只读审查 + 定向复现 + 回归测试。所有删除/恢复复现均在系统临时目录进行。

## 1. 结论

本轮追加审查发现并修复了 8 个清理链/插件管理器问题，其中 1 个严重（隔离区恢复路径穿越）、2 个高（取消清理失效、部分清理无报告）。

未发现绕过唯一删除入口新增的永久删除路径；修复后全量 385 个用例通过。

## 2. 核心修复

| ID | 级别 | 问题 | 修复 |
|---|---|---|---|
| S-01 | **严重** | `quarantine.restore()` 把 id 按 `/` 拆分后直接 `path.join`，恶意 id 可让 restore 在隔离区外写 manifest 并递归删除任意目录 | 只接受 `list()` 中真实存在的记录；session/文件名白名单 + resolve 边界校验；未知 id 直接失败，不创建/删除目录 |
| S-02 | 高 | 执行器 `mapLimit` 启动后不传取消信号，取消后已排队文件仍全部删除 | `ExecuteOutcome.cancelled`；逐项检查 signal；`clearDirectory` 接受 signal；取消时返回已执行部分而不是假装完成 |
| S-03 | 高 | 取消发生在批次间时 `clean()` reject，已删除项没有报告/历史/撤销清单 | executor 取消改为返回 partial outcome；清理循环保留 partial report/history；签发令牌期间取消也 break 而不是 reject |
| S-04 | 中高 | inject 自动补齐扫描原始源码，注释/字符串里的 `ctx.ai` 被误当硬依赖，AI 默认停用时插件 pending | 扫描前剥离注释/字符串；只补当前已注册服务，避免把插件挂成永远 pending |
| S-05 | 中 | enable 正在 loading 时 disable：disable 完成后 in-flight enable 又把状态写回 active 并持久化 | RuntimeRecord 记录 enablePromise；disable 先等待 in-flight enable；启动失败不再持久化 enabled=true |
| S-06 | 中 | `quarantine.enabled=false` 在真实清理路径无效 | 关闭时不开启隔离会话、不强制高危隔离；quarantine 模式安全回退到 recycle，报告 mode 同步 |
| S-07 | 中 | 扫描根为 `C:\` 时，链接祖先检查边界变成 `c:\\`，首轮即退出，junction 防线失效 | 边界去掉尾部分隔符后再做前缀判断 |
| S-08 | 中 | `action:clear` 忽略 `clearDirectory` 的 failed，半删除仍报告成功 | 有失败子项时返回失败结果，不再虚报成功 |

## 3. UI/状态修复

| ID | 问题 | 修复 |
|---|---|---|
| U-01 | AI 工坊取消后，校验 RPC 返回仍会写回草稿并重开弹窗 | 校验返回后再次检查 requestId；编辑态校验加序号与 catch，忽略旧结果 |
| U-02 | 生成中切到插件页，AI 组件卸载导致草稿/进度丢失 | App 对 `AiView` 使用 KeepAlive；其他页面仍正常卸载 |
| U-03 | 概览插件卡片卸载后仍创建轮询 interval | disposed 标记；reload/失败后不再 schedule，卸载清 timer |
| U-04 | 扫描入口不防重；清理中可启动单任务扫描；startScan 静默早退却被当成成功 | startScan 返回是否真正启动；概览/插件页/清理页入口检查 scanning/cleaning；单任务扫描按钮禁用 |
| U-05 | AI 推荐清理可双击，第二次 clean/start 中断第一次 | applyingSelection 防重 + loading/disabled；cancelled 不再报成功 |
| U-06 | PluginsView 的 lastScan 永远 null，规则命中为空 | 直接使用共享 state.scan |
| U-07 | 切到其他页完成清理会收到两条通知；失败时被强行拽回清理页 | 删除 CleanView 重复完成提示；只在仍停留进度页时回结果页 |
| U-08 | 系统信息长值被截断且无 tooltip | CPU/主机名/数据目录加 title |

## 4. 回归验证

```text
pnpm typecheck              通过
pnpm typecheck:ui           通过
pnpm vitest run             385 passed / 54 files
pnpm build:ui               通过
pnpm build:desktop          通过
node scripts/e2e-ui.mjs     6 页面 + 扫描全链路成功，0 JS 异常
```

新增回归用例：

- 隔离区恢复 id 穿越 → 失败且外部 victim 目录保留；
- 执行前已取消 → `cancelled=true` 且不删除；
- 关闭隔离区 → 模式回退 recycle、不产生隔离记录。

## 5. 剩余边界

- 取消发生在单个递归 `fs.rm` 内部时，Node 本身无法中断这一次系统调用；当前保证不启动新的删除项、返回 partial report，但已进入的那次递归删除可能完成。
- 隔离区 manifest 若被本机高权限用户篡改，仍可影响恢复目标；当前已限制 session/文件名不能穿越，但 manifest 的 `originalPath` 属于用户可写数据。
- AI 工坊取消仍只使前端等待失效，无法保证取消已发出的模型 HTTP 请求。


