# CordClean v0.6.14 发布说明

**发布日期：2026-11-24** · 前置版本：v0.6.13

本次为补丁版本：修复 **v0.6.13 发布在红 CI 上**的问题。v0.6.13 不回滚，本版在其之上直接修复。

## v0.6.13 CI 失败根因与处理

v0.6.13 的 GitHub Actions（run `45209108405`、job `137812754666`、head `58bd2e5`）在单测阶段失败，表现为 `tests/ai-hardening.test.ts` 三条流式用例超时/请求数异常。后续定位到真正根因：

1. **文档计数过期（直接导致 CI 红）**：v0.6.13 新增 1 条 SSE 超时回归用例，测试口径从 106 文件/931 用例变为 **106 文件/932 用例**，但 README/CONTRIBUTING/architecture/thesis/test-plan/mentor-brief 仍写 931。CI 的 `Docs consistency` 步骤先失败，`Typecheck`、`Unit / integration tests` 被跳过——run 62（head `8667820`）同样因此失败。**已同步全部文档口径并提交**。
2. **AI 流式边界实现与测试加固**：真实 CI 环境下流式 mock 依赖回环 SSE 连接与「服务端不结束」的时序，超时后还会回退非流式请求，可能把一次请求拖成两次超时，并让挂起请求污染共享计数。已修：
   - `requestSse`：外部取消在 fetch 前后都立即返回 CANCELLED；新增 `stopWhen`，识别 `finish_reason=length` 后主动取消剩余流，不再等待服务端结束；
   - 服务层：构建上下文后若已取消则不发请求；**流式超时/断网/限流/AUTH 不再回退非流式**（HTTP/契约类错误才回退一次），截断立即按 `INVALID_RESPONSE` 上报；
   - 测试：取消/截断/401/超时 4 条用例改为可注入 `fetch` + 可控 `ReadableStream`，用 `stream.cancel` 与请求次数作确定性证据，不再依赖真实回环 SSE 与墙钟阈值；`afterAll` 先 `closeAllConnections` 再 `close`。

## 修复后的验证

- 本地 Node 24 与 **CI 同版本 Node 22** 单文件：29/29 通过；
- Node 22 + `CI=true` 全量：**106 个测试文件 / 932 个用例通过**；
- `pnpm typecheck` / `typecheck:ui`、`pnpm build`、`docs:check`、`e2e` 通过；
- GitHub Actions：修复提交（`a3c0168`）与 v0.6.14 发布提交的 CI 运行见仓库 Actions 页面，目标为**全绿**后发版（v0.6.14 发布前的 CI 修复运行：run 63 head 3c0168）。

## 兼容性与升级注意

- 无数据/设置/插件格式/安全限制变更；可直接覆盖升级；
- 行为变化：AI 流式请求在**超时/断网/限流/鉴权失败**时不再二次回退非流式，会更快给出稳定错误码（避免等待翻倍）；
- v0.6.13 的 Release 资产保留不撤回；以本版为准。

## 已知限制

- 真实模型语义仍依赖模型与提示词，界面保留人工复核；
- 本次 CI 修复后的全绿结论以 GitHub Actions 实际运行结果为准（仓库 Actions 页面可查）。
