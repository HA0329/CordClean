# CordClean v0.6.4 发布说明

**发布日期：2026-10-28** · 前置版本：v0.6.3

本次更新同步 **PC-Cleaner 最新规则库与安全保护网**。上游最新版本为 **v0.9.11**；规则数据与本地已导入内容一致，真正需要同步的是 v0.9.11 的即时通讯/开发数据保护修复。

## 重点更新

### 规则库同步

- 上游 `rules.json` 重新导入并与本地 `catalog.json` 逐条对比：**28 分类 / 271 条规则完全一致**；
- 上游比本地多的 5 条目标为**有意不导入**：
  - `broken_shortcuts`（3 条）：已由独立 `shortcuts` 插件实现（`.lnk` 解析、死链判定边界、开始菜单/桌面/快速启动栏）；
  - `dev_purge`（1 条）：依赖 `<CWD>` 当前工作目录语义，桌面工具不导入；
- 更新 `catalog.json` 的 `generatedFrom` 与导入说明，重新生成 [规则库审计报告](../rules-report.md)：37 分类 / 401 条规则 / 414 个候选根，**0 结构错误、0 未实现类型**。

### 安全保护网（PC-Cleaner v0.9.11）

- 新增按**完整路径段**匹配的保护目录名：
  - 即时通讯：`wechat files`、`tencent files`、`weixin`、`weixinshuju`、`xwechat_files`；
  - 开发数据：`.git`、`.venv`、`.idea`、`.vscode`；
- 在普通清理、清空白名单、`addClearRoot` 登记、`isProtected`/`containsProtected` 中统一生效；
- 严格避免过度封锁：`%APPDATA%\Tencent\WeChat\Logs`、`WeChat\Temp` 等可重建内容仍允许清理；
- 新增回归测试覆盖「保护拦截 + 不误伤 WeChat 缓存」。

### 文档

- 新增 [PC-Cleaner 规则库同步验收报告](verification/pc-cleaner-rules-sync-2026-10-28.md)：上游提交/版本、规则对比、v0.9.10/v0.9.11 变更、未导入项说明；
- README / 架构 / 规则报告标注最新上游来源与导入边界。

## 验证

- 全量测试：**65 个测试文件 / 474 个用例通过**；
- 路径策略/攻击测试：21 个用例通过；
- 规则审计：37 分类 / 401 条 / 414 候选根，0 错误、0 未实现类型；
- `tsc` / `vue-tsc` 0 错误；`pnpm build` 成功。

## 兼容与升级

- 规则数据结构不变，已有配置、历史、隔离区不受影响；
- 新增保护名会让“含 WeChat Files / Tencent Files / .git 等目录”的清理项被标记为受保护（预期行为）；
- 如确有清理项目构建产物的需求，应使用自定义扫描根或后续独立功能，不会走 `dev_purge` 的 CWD 语义。

## 已知限制

- `dev_purge` 未实现（依赖工作目录语义）；
- 上游 Python 引擎的删除计数/代理对文件名修复未移植（本地 Node 引擎已有独立的路径与计数处理）；
- 规则数据下次同步仍需手工运行 `scripts/import-rules.ts` 并对比审计报告。
