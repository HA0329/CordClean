# CordClean v0.6.9 发布说明

**发布日期：2026-10-31** · 前置版本：v0.6.8

本次完成剩余 P1/后续项：工坊 Key 状态复核、旧 client 页面兼容、AI 推荐过滤自身产物、真实流式生成进度，以及 AppData 扫描根按用户意愿可选添加。

## 重点更新

### 工坊 Key 状态复核 + 启动配置兜底

- 用真实配置复核：工坊启用时读取到 Key、停用/再启用后 Key 保留，`apiKeySource=config`；
- 另加兜底：插件启用时如果运行时 record 配置为空，优先从已持久化的 `settings.plugins[id].config` 恢复，而不是直接用默认值覆盖（防止异常启动导致 Key 丢失）；
- 新增回归测试：模拟 record 配置为空后启用，Key 仍保留。

### 旧 client 页面自动兼容（不需要重新生成）

- 宿主 iframe bridge 现在同时兼容：
  - 新协议：`{type, method:'resolve', id, resolverId, params}`；
  - 旧工坊协议：`{type, action:'resolve', id, key, dataId, requestId}`；
- 旧页面无需重新生成/安装即可重新拿到数据；回包同时带 `id/requestId/requestID/replyTo/reqId` 兼容不同旧页面关联方式；
- 新增 bridge 兼容层单测。

### AI 推荐过滤自身产物

- AI 分析候选列表不再包含 CordClean 自己的数据目录、日志、插件目录，以及名字为 `cordclean-*` / `cc-usability-*` 的临时/截图目录；
- 避免 AI 建议用户清理工具自己的运行数据。

### 工坊真实流式进度

- 工坊生成改为 **SSE 流式请求**（chat 形态）：
  - 实时上报 `request → streaming → received → validating → done` 阶段；
  - 流式阶段显示已接收字符数、工具调用数，而不是纯耗时估算；
  - 流式失败自动回退非流式，不牺牲兼容性；
- 实测真实模型生成 widget：**60 个进度事件**，阶段依次覆盖 request/streaming/received/validating/done，总耗时约 **8.2 秒**；
- UI 阶段条仍保留，作为无事件时的兜底。

### AI 扫描根（按用户意愿可选）

- AppData 等宽目录仍显示建议，默认勾选、标注“范围较大”；
- 用户可逐项取消/选择；添加前二次确认，不强制过滤用户明确想添加的目录；
- 保持“可选添加”而不是替用户做决定。

## 验证

- 全量测试：**67 个测试文件 / 487 个用例通过**；
- `tsc` / `vue-tsc` 0 错误；`pnpm build` 成功；
- 新增 4 项桥接/配置回归测试；
- 真实流式工坊生成验证通过（见上）。

## 兼容与升级

- 旧 client 页面无需重新生成即可兼容宿主 bridge；
- 已有 AI 自定义规则不会被删除；
- 工坊流式请求失败会自动回退，接口兼容性不变。

## 已知限制

- 流式仅对 chat 形态启用；messages/responses 仍走非流式（会自动回退，不影响功能）；
- 流式事件显示的是字符数/工具调用数，不是逐个文件解析后的进度；
- 旧页面兼容层会同时接受两种协议，长期仍建议重新生成使用新协议。
