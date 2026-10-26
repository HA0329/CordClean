# CordClean v0.6.0 发布说明

**发布日期：2026-10-26** · 前置版本：v0.5.18

本次发布的核心是**插件系统 v2**，并把 AI 能力拆成「AI 清理顾问」与「AI 插件工坊」两个独立插件；同时修复了 AI 图片/补充说明发送、磁盘实时采样、源码打开等一批体验问题。

## 重点更新

### 插件系统 v2（目录 + 清单）

- 外部插件升级为**目录 + `plugin.json` 清单**：`apiVersion`、`engines` 兼容检查、权限清单、依赖声明、`client/` 页面；
- 安装事务：`plugins/.staging` → 清单/源码校验 → 原子落盘 → 登记启用；升级/卸载旧目录保留在 `plugins/.trash`，失败自动回滚；
- 管理面：插件页可「检查插件包 → 展示权限/兼容/文件 → 审阅安装」，支持卸载、问题横幅、包内客户端页面；
- 客户端资源：Web 走 `/plugin-assets/<id>/...`，Electron 走 `cordclean-plugin://` 自定义协议，iframe 沙箱 + CSP；
- 旧版单文件插件继续兼容（安装、持久化、重启自动加载）。

### AI 插件工坊（独立插件）

- 从「AI 建议」页拆出独立页面与独立插件 `ai-workshop`，拥有**独立的 API 设置**（API Key / baseUrl / 接口形态 / 模型 / 思考等级 / JSON 输出 / extraBody / extraHeaders），与 AI 清理顾问互不影响；
- 默认生成**多文件 v2 插件包**：`plugin.json` + `index.mjs` + 可选 `client/index.html`；
- 审阅页支持文件增删改、清单 JSON 编辑、权限与校验结果展示、依赖确认，然后走同一安装事务；
- 支持 cleaner / widget / active / desktop 四类插件；desktop 需 Electron 外壳；
- 模型输出不完整时自动修复清单字段、`inject`、`commands` 贡献，并以 warning 提示。

### AI 清理顾问

- 按 [DeepSeek 官方 Vision 文档](https://api-docs.deepseek.com/guides/vision/) 修复图片发送（chat `image_url` / messages `image` / Responses `input_image`），仅在支持视觉的模型（`deepseek-flash`）上启用；
- 补充说明真正随请求发送；补充说明中出现「不要分析 / 只回复」等明确指令时走直答路径，不再输出清理建议；
- 截图上传统一为点击选择 / 拖拽 / Ctrl+V 粘贴。

### 体验与稳定性

- 概览「磁盘使用情况」改为每 5 秒随内存一起轻量采样（`statfs`），不再显示 60 秒前的旧值；
- 「源码」按钮改为内置源码查看器（读取真实源码文件），「用系统程序打开」失败时自动回退系统默认打开；
- 设置页新增「插件系统与扩展目录」「版本与运行环境」卡片；
- 修复 `ui/contributions` / 部分空参数 RPC 的误报校验问题。

## 验证

- 自动化测试：**64 个测试文件 / 462 个用例全部通过**；
- 类型检查：`tsc` / `vue-tsc` 0 错误；
- 构建：`pnpm build`（UI + Electron 主进程）成功；
- 插件审计：`scripts/audit-plugins.ts` 全内置插件真实扫描 0 违规；
- 真实模型验收：cleaner / widget / active / 多文件 client 页面 4 类插件生成 → 校验 → 安装 → 调用 → 卸载全部通过；desktop 草稿生成+校验通过。详见 [验收报告](verification/ai-workshop-live-test-2026-10-26.md)。

## 升级与兼容

- 设置、历史、隔离区数据兼容；
- 新增内置插件「AI 插件工坊」默认停用，需要在插件页启用并填写自己的 API 设置；
- 旧单文件外部插件无需迁移；新的第三方插件建议使用 v2 插件包；
- 本版本仍只支持 Windows；Electron 自定义协议需要在桌面外壳中验证，Web 外壳使用 HTTP 静态路由。

## 已知限制

- 未做代码签名与安装包（可用 electron-builder 补充）；
- 插件以宿主用户权限运行；权限清单是声明/审阅/展示，不是运行时沙箱；
- AI 工坊依赖外网 API，生成质量受模型影响；自动修复项会出现在校验 warning 中；
- desktop 类型插件只能在 Electron 外壳加载；
- 第三方依赖安装依赖本机 npm/pnpm 与网络。
