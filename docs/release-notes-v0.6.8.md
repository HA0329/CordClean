# CordClean v0.6.8 发布说明

**发布日期：2026-10-31** · 前置版本：v0.6.7

本次更新修复真实模型深度验收中发现的 **AI 规则安全漏洞**与 **AI 工坊客户端页面 bridge 缺失**，并处理 engines、AI 扫描根与流式展示问题。

## 重点修复

### P0-1 AI 规则安全门

- AI 建议规则不再能直接清理过宽目录：
  - 盘符根、`%LOCALAPPDATA%`、`%APPDATA%`、`%TEMP%`、`%WINDIR%`、`%PROGRAMFILES%`、`%PROGRAMDATA%`、用户目录等整目录直接拒绝；
  - 整体 `npm-cache` / `npm` 父缓存直接拒绝（会破坏运行中的 npx / AI 工具），提示改用 `_cacache` / `_logs` / `_npx` 等具体子目录；
  - AppData 直系子目录降级为 caution 并给出 warning；
- AI 规则采纳前新增二次确认弹窗；
- AI 来源的规则**不再默认选中**，规则任务 `defaultSelected=false`，结果项 `recommended=false`；
- 新增测试：拒绝 npm-cache / AppData / Temp / 盘符根、具体缓存允许、直系子目录降级。

### P0-2 工坊客户端页面 bridge 契约

- 工坊 prompt 写入精确 bridge 协议：
  ```js
  parent.postMessage({ type: 'cordclean/plugin-page', method: 'resolve', id, resolverId, params }, '*')
  ```
  监听 `cordclean/plugin-page-result`；禁止自定义 `action/key/dataId/requestId/channel/source` 字段；
- 校验阶段新增 client 页面 bridge 检查：使用了 postMessage/bridge 但协议不匹配时**直接判为校验错误**，阻止安装；
- 纯静态页面只提示、不阻断；
- 新增测试：错误协议被拒绝、正确协议通过、静态页只警告。

### P1-1 engines 兼容性

- AI 清单 `engines.cordclean` 自动修正为当前应用版本，并在审阅阶段给出明确 warning（例如 `>=1.0.0 → ^0.6.8`）；
- 工坊审阅区展示**修正后的清单**，安装使用修正后的 manifest，不再展示未修正的兼容范围。

### P1-2 AI 扫描根

- AI 扫描根保持**逐项可选**：整个 AppData 等建议仍会显示，并标注“范围较大”；
- 用户可自由勾选/取消（默认全部勾选）；添加前弹确认，说明会扩大扫描范围与磁盘遍历耗时；
- 不强制过滤用户明确想添加的目录。

### P1-3 流式展示

- AI 分析进行中不再直接铺原始 JSON；
- 改为“正在分析…已接收 N 字符”，原始流式输出折叠在“调试”面板中，完成后显示结构化建议。

## 验证

- 工坊生成等待改为阶段提示（理解需求 → 生成清单/代码 → 校验准备），并继续显示已等待秒数；
- 全量测试：**66 个测试文件 / 483 个用例通过**（新增 AI 规则安全 6 项、bridge/engines 2 项）；
- `tsc` / `vue-tsc` 0 错误；`pnpm build` 成功；
- 安全校验单测：`tests/ai-rule-safety.test.ts`；
- 端到端复核：npm-cache 规则采纳被拒绝；具体 Edge 缓存规则可采纳，但 `rule:browser` 任务 `defaultSelected=false`；
- 重新真实生成一次 client 插件：新 prompt 产出正确 bridge（`type/method/resolverId`），校验通过，仅给出 engines 修正 warning；
- 包校验单测：`tests/ai-plugin-package.test.ts` 覆盖 engines 修正 warning 与错误 bridge 拒绝。

## 兼容与升级

- 不改变规则数据格式，仅对 AI 采纳路径加安全门；
- 既有已采纳的 AI 规则不会被自动删除；如需清理，请在自定义规则中手动移除；
- 已安装的旧 client 页面插件不会被自动改写；重新生成/重新安装时会经过新的 bridge 校验。

## 已知限制

- 本次已重新真实生成 1 次 client 插件且 bridge 正确，但仍建议在不同需求下多生成几次验证稳定性；
- 现有旧生成页若不重新安装仍可能显示无数据；
- AI 规则安全门基于路径启发式，仍建议用户采纳前查看试运行结果。
