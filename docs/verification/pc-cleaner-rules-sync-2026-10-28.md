# PC-Cleaner 规则库同步验收（2026-10-28）

- 上游：https://github.com/HA0329/PC-Cleaner
- 上游版本：`pyproject.toml` = **0.9.11**，最新提交 `af45d0a`（2026-09-28，Add files via upload）
- 上游规则文件：`pc_cleaner/rules.json`（version **0.9.9**，30 分类 / 276 目标）
- 本地目录：`packages/plugins/rule-pack/rules/catalog.json`（导入映射）+ `extra.json`（手工扩充）

## 1. 规则数据对比

用 `scripts/import-rules.ts` 对上游最新 `rules.json` 重新生成目录，并与本地 `catalog.json` 做结构对比（忽略 `generatedFrom` 时间戳）：

- **结果：完全一致**（28 分类 / 271 条规则）；
- 上游比本地多的 5 条目标是**有意不导入**：
  1. `broken_shortcuts`（3 条：开始菜单 / 桌面 / 快速启动栏）：已由独立的 `shortcuts` 插件实现，包含 `.lnk` 解析、离线盘/网络路径/Shell 命名空间等判定边界，避免重复上报；
  2. `dev_purge`（1 条）：依赖 `<CWD>`（当前工作目录）语义，桌面工具没有 CWD 概念，不导入；如需清理项目构建产物，应通过用户自定义扫描根或后续「项目清理」功能实现。
- 上游规则说明中的“分类数 29 / 目标数 276”对应其 0.9.9 文本；最新仓库实际为 30 / 276（0.9.10 拆出 `rdp_legacy_cache`）。本地目录在 0.9.9 导入时已经包含 `rdp_legacy_cache` 拆分结果，因此规则内容仍与上游一致。

## 2. 上游 v0.9.10 / v0.9.11 与规则相关的更新

### v0.9.10

- 将 `rdp_legacy_cache` 从 `java_rdp_legacy` 中拆出（`risk=moderate`，需显式选择）：本地 `catalog.json` 已包含该拆分；
- 规则校验/扫描器的若干修复（多候选路径判定、glob 起点目录、删除计数等）属于上游 Python 实现，不影响本地规则数据；
- 更新 README 分类数/规则数。

### v0.9.11（安全修复）

- **补齐即时通讯数据目录保护**：`Documents/WeChat Files` 是微信 3.x 默认聊天数据目录，上游在 `DEFAULT_PROTECTED_PATTERNS` / 跳过目录名中补入：
  - `wechat files`、`tencent files`、`weixin`、`weixinshuju`、`xwechat_files`；
  - 注意**不能**写成子串 `wechat`，否则 `%APPDATA%\Tencent\WeChat\Logs` / `Temp`（rules.json 中有意清理的可重建内容）会被误保护；
- 仓库自身另有 `.git` / `.venv` / `.idea` / `.vscode` 保护项（开发数据不可逆）；
- 其余修复（孤立代理对文件名、history/audit 写入、删除计数、重解析点测试）属于上游 Python 引擎，本次不移植。

## 3. 本地更新内容

### 路径策略（`packages/core/src/domains/safety/path-policy.ts`）

新增**按完整路径段**匹配的保护目录名：

`wechat files`、`tencent files`、`weixin`、`weixinshuju`、`xwechat_files`、`.git`、`.venv`、`.idea`、`.vscode`

- 在普通清理校验 `checkPath` 中拦截（reason=`protected`）；
- 在清空白名单 `checkClearPath` 中同样拦截，避免通过 clearRoot 绕过；
- `addClearRoot` 拒绝登记含保护目录名的路径；
- `isProtected` / `containsProtected` 同步识别；
- 保持不误伤：`.../WeChat/Logs`、`.../WeChat/Temp` 仍允许清理；
- 测试：`tests/path-policy.test.ts` 新增「即时通讯/开发环境保护名按完整路径段拦截，且不误伤 WeChat 缓存」。

### 规则元数据与审计

- `catalog.json` 的 `generatedFrom` 更新为 **PC-Cleaner 0.9.11（rules.json version 0.9.9；同步 2026-10-28）**，并记录导入说明（broken_shortcuts / dev_purge 的去向）；
- 重新运行 `scripts/audit-rules.ts`：[规则库审计报告](../rules-report.md)，37 分类 / 401 条规则 / 414 个候选根，0 结构错误，0 未实现类型。

## 4. 验证

- `pnpm vitest run tests/path-policy.test.ts tests/path-attack.test.ts`：21 个用例通过；
- 全量测试见本次发布说明；
- `tsc` / `vue-tsc` 0 错误；
- 规则审计 0 错误。

## 5. 结论

上游最新规则数据与本地导入结果一致；本次真正需要同步的是 **v0.9.11 的即时通讯/开发环境保护网**，已落进路径策略并补测试。规则目录与上游保持同一结构，后续上游更新可继续用 `scripts/import-rules.ts` 重导并跑审计。
