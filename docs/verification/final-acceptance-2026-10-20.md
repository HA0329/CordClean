# 批次3-B 最终独立验收报告（批次 1 + 2 + 3）

- 验收人：verifier（独立验收，只读业务代码，未改后端/UI，未提交）
- 验收时间：2026-10-20 15:12–15:22（Asia/Shanghai）
- 仓库：`D:\桌面\deepseek-harness\deepseek-harness-wokplace`（Windows 10.0.26100，Node v24.19.0，pnpm 12.14.0，6 核 / 12 逻辑核）
- HEAD：**445aa07** `fix(ui): typecheck:ui 清零（vue-tsc 24→0）并接入 CI`，历史依次 `d872efe`（批次2）、`e825c21`（批次1）、`1c02a79`（清理选择 v2）
- 验收对象：三批次全部改动（安全加固、文档/依赖/CI、UI 类型修复、E2E/验收脚本）
- 证据日志：`docs/verification/final-2026-10-20/01…11-*.log`（`*.log` 被仓库 `.gitignore` 忽略，属本地证据）

## 结论：**通过**

全部必做项实跑通过：安装/审计/两套类型检查/346 单测/双构建/真实 Electron E2E/3000 条 mock UI 验收/Web 外壳安全复验/批次1 安全回归与代码抽查/文档一致性抽检。
**无阻塞项、无新增缺陷**；发现 1 处低风险文档陈旧描述 + 1 处低风险界面文案口径偏差 + 若干已知残余风险（见第 8 节），均不阻塞验收。

### 关键数字（全部为本次实跑）

| 项 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0（19 workspace 项目，lockfile up-to-date，supply-chain policy 通过） |
| `pnpm audit --prod` | exit 0，**No known vulnerabilities found** |
| `pnpm typecheck` / `pnpm typecheck:ui` | 均 **exit 0**（UI 类型错误 24→0 已确认） |
| `pnpm vitest run` | **44 文件 / 346 用例全绿**，50.99 s（`pool: 'forks'`） |
| `pnpm build:ui` / `pnpm build:desktop` | 均 **exit 0**（1631 modules；main.mjs / preload.cjs 生成成功） |
| `node scripts/e2e-ui.mjs` | **exit 0**：6 页渲染、真实扫描成功、**0 JS 异常** |
| `node scripts/verify-clean-ui.mjs` | **PASS 25/25**，0 页面错误（3000 条 mock / 40 任务 / 40 protected） |
| Web 外壳安全复验 | **18/18**（畸形 URL 400、伪 Host 403、正常 200、WS 错误 Origin 403） |
| 批次1 定向回归 | `host-server`+`batch1-hardening`+`paths-normalize`+`rule-pack-evaluator`：**4 文件 / 48 用例通过** |

---

## 1. 安装与依赖

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0：`Scope: all 19 workspace projects`；`✓ Lockfile passes supply-chain policies`；`Lockfile is up to date, resolution step is skipped`；`Done in 65ms` | `01-install.log` |
| `pnpm audit --prod` | exit 0：`No known vulnerabilities found` | `05-audit-prod.log` |

与 `docs/dependency-policy.md` 声明一致（当前 `pnpm audit --prod` 为 0 漏洞；frozen-lockfile 通过）。

## 2. 静态检查与单元/集成测试

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm typecheck` | **exit 0**，无诊断 | `02-typecheck.log` |
| `pnpm typecheck:ui`（vue-tsc） | **exit 0**，无诊断（批次3-A「24→0」已落地） | `03-typecheck-ui.log` |
| `pnpm vitest run` | **Test Files 44 passed (44) / Tests 346 passed (346)**，Duration 50.99 s | `04-vitest.log` |
| `pnpm vitest run tests/host-server.test.ts tests/batch1-hardening.test.ts tests/paths-normalize.test.ts tests/rule-pack-evaluator.test.ts` | **4 files / 48 tests passed**，1.75 s（host-server 13、batch1-hardening 7、paths-normalize 20、rule-pack-evaluator 8） | `10-batch1-targeted-tests.log` |

数字与文档一致：44 个测试文件 / 346 个用例；`docs/test-plan.md` 称「总耗时约 50 s」，实测 50.99 s。

## 3. 构建与真实 Electron E2E

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm build:ui` | exit 0：`1631 modules transformed`，`built in 6.18s`，`index-CCRj9vRN.js 1,135.50 kB` | `06-build-ui.log` |
| `pnpm build:desktop` | exit 0：`main.mjs 1.5mb`、`preload.cjs 546b` | `07-build-desktop.log` |
| `node scripts/e2e-ui.mjs` | **exit 0** | `08-e2e-electron.log` |

E2E 控制台摘要：

```
IPC 通道可用： true
侧边栏： 🏠概览 / 🧹清理 / 🧩插件 / 🗂️历史与隔离区 / 🤖AI 建议 / ⚙️设置
（6 个页面依次渲染并截图）
扫描完成，统计卡片： 可清理项 953 / 8 个任务 | 推荐清理（安全项）952 / 891.6 MB |
                     需要你确认 1 谨慎 1 项 · 高风险 0 项 | 受保护（不可清理）5
推荐横幅： 已按推荐策略（安全项）勾选 952 项（891.6 MB）…
默认选择： 已选 952 项 · 891.6 MB
✓ 视图切换：分组 8 行 / 明细本页 100 行
✓ 详情抽屉： …类型 文件夹 大小 647.8 MB 修改时间 — 所属任务 更多开发工具缓存 分类 开发缓存
✓ 主题切换 / 侧边栏折叠展开正常
✅ 界面端到端检查通过：6 个页面渲染正常、扫描全链路成功、无 JS 异常
```

截图（`docs/screenshots/`，E2E 生成）：`ui-overview.png`、`ui-clean.png`、`ui-clean-result.png`、`ui-clean-items.png`、`ui-plugins.png`、`ui-history.png`、`ui-ai.png`、`ui-settings.png`、`ui-theme-dark.png`、`ui-rail.png`。

## 4. 3000 条 mock 数据 UI 验收

`node scripts/verify-clean-ui.mjs` → **PASS 25/25，页面错误 0 条**（`09-verify-clean-ui.log`）。抽样断言：

- 分组总览 40 行；可清理 2,960 + 受保护 40 = 3,000 与扫描总数一致；
- 推荐横幅/默认选中 = 1,776 项 / 36.6 GB（safe 且非 protected）；
- 明细分页 100 行；风险筛选 risky 392 条、明细 100 行全为高风险；
- 整组勾选增量与组内非保护项数一致（1776 → 1805，+29）；
- 清理确认摘要数量/大小与当前选择一致，可取消不执行；
- 亮/暗全页截图：`docs/screenshots/scan-select-light.png`、`scan-select-dark.png`（1600×6122）。

## 5. Web 外壳安全复验（真实 web shell，临时端口 61509 / 临时数据目录）

用临时脚本启动 `apps/web/src/main.ts`（`CORDCLEAN_NO_OPEN=1`、临时 `CORDCLEAN_DATA`），HTTP/WS 逐项验证，**18/18 通过**（`11-web-shell-security.log`）：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| `GET /%`（畸形 URL） | 400 且不崩溃 | **400**；随后 `/api/ping` **200**（进程存活） |
| `GET /%E0%A4%A`（非法百分号编码） | 400 | **400** |
| `Host: evil.example` | 403（DNS rebinding 防护） | **403** |
| 正常 `Host`（127.0.0.1:port / localhost:port） | 200 | **200 / 200**；首页含 CSP meta 与注入 token/wsUrl |
| HTTP `/api/rpc` 无 token | 401 | **401** |
| HTTP `/api/rpc` 正确 token | 200 + `app/info` | **CordClean@0.2.1** |
| 运行时 `tasks/list` / `plugins/list` | 38 / 11 | **38 个任务 / 11 个插件**（与文档一致） |
| WS `Origin: http://evil.example` | 拒绝 | **403 Forbidden Origin** |
| WS 错误 token | 拒绝 | **401** |
| WS 正确 Origin+token | 可连接并 RPC | **open + app/info 往返成功** |
| WS 无 Origin（原生客户端） | 允许 | **open** |
| 全部用例后进程 | 存活 | **存活** |

代码对应：`packages/host/src/server.ts` 的 `isAllowedHost`（仅 127.0.0.1/localhost/[::1]，绑定实际端口）、`isAllowedOrigin`（仅界面自身 origin）、`parseRequestUrl`（畸形 URL→HttpError 400）、`WS_MAX_PAYLOAD = 1024*1024`（`server.ts:79/319`）、`readBody` 2MB 限制（`:133`）。

## 6. 批次1 安全回归抽检（用例 + 代码）

用例（全部通过）：见第 2 节定向回归 48/48，覆盖 Host/Origin/token、畸形 URL、WS maxPayload、`addClearRoot` 放大、settings 原型污染/自愈、旧扫描覆盖、clean/start 只认 itemIds、外部插件 fsRoots/env/clearRoot、规则评估 protected 语义。

代码抽查（对照批次1修复）：

| 检查点 | 结论 | 位置 |
| --- | --- | --- |
| `clean/start` 是否只接收 `itemIds` | ✅ 只接受 `{ itemIds, dryRun, forceQuarantine }`，从上次扫描结果解析，绝不信任界面回传路径/大小/风险 | `packages/host/src/api.ts:207-212` |
| 外部插件 env 白名单 | ✅ `PLUGIN_ENV_ALLOWLIST`（USERPROFILE/LOCALAPPDATA/WINDIR/TEMP/PATH 等）+ `PLUGIN_ENV_DENY_PATTERNS`，敏感 Key/Token/Secret/Password 不进入 `ctx.env` | `packages/core/src/domains/kernel/external-proxy.ts:26-68` |
| `pathPolicy.addClearRoot` 限制 | ✅ 仅接受绝对路径/UNC；拒绝盘符根；拒绝保护根本身及其祖先（防止放大清空范围） | `packages/core/src/domains/safety/path-policy.ts`（addClearRoot 方法体） |
| Electron sandbox/导航拦截/CSP | ✅ HEAD 版本：`sandbox: true`、`setWindowOpenHandler` deny、`will-navigate` 白名单（file:// + DEV/SHOT 同源）、CSP meta（含 connect-src ws/wss/127.0.0.1/localhost） | `apps/desktop/src/main.ts`、`packages/ui/index.html`（`git show HEAD:` 核对） |
| 外壳鉴权链路 | ✅ 静态资源也校验 Host；WS 升级同时校验 Host/Origin/token；HTTP RPC 校验 token | 第 5 节实测 + `server.ts` |

## 7. 文档一致性抽检

### 7.1 关键数字（与代码/运行时/测试实测核对）

| 数字 | 文档口径（README / architecture / thesis / defect-log / test-plan / dependency-policy） | 实测/静态核对 |
| --- | --- | --- |
| 11 个内置插件（8 默认启用） | README、architecture、thesis 一致 | `packages/plugins/*` = **11**；manifest 11 项中 3 项 `defaultEnabled:false`（scheduler/shortcuts/ai）→ 默认启用 **8**；运行时 plugins/list = 11 |
| 38 个清理任务 | README `/ 8 默认启用`、architecture、thesis 一致 | web shell 运行时 `tasks/list` = **38** |
| 55 个 RPC 方法 | README、architecture 一致 | `ApiMap` 解析 = **55**，且 55 个 key 在 `host/api.ts` 全部有 handler |
| 44 测试文件 / 346 用例 | README、architecture、thesis、defect-log、test-plan 一致 | 实跑 **44 files / 346 tests** |
| catalog 28 类/271 条/284 候选根 | README、architecture、plugin-authoring 一致 | 按 `scripts/audit-rules.ts` 同口径计算：**28/271/284** |
| extra 9 类/130 条 | 同上 | **9/130** |
| 合计 37 类/401 条/414 候选根 | README、architecture、rules-report 一致 | **37/401/414**（本次未重跑 audit 脚本，按同口径静态计算；rules-report 于 15:00 由批次3生成，头部数字一致） |
| benchmark 数字 | README §8 表 ↔ `docs/benchmark.md` ↔ thesis-outline ↔ defect-log 引用一致：5.4 ms / 162.6 ms / 26770 文件/秒 / 2178 文件/秒 / 0.15 s / 1.84 s / 1.29 ms / 366 MB/秒 / 132.2 MB / 12 MB | `benchmark.md` 生成于 2026-10-20 14:57，环境行「win32 10.0.26100 · 12 核 · Node 24.19.0」与本机一致 |
| 版本 0.2.1 | README、architecture 一致 | root + 5 packages + 2 apps = **8 个 workspace 项目版本 0.2.1**（插件包保留 1.0.0/2.0.0）；运行时 `app/info` = **CordClean@0.2.1** |

### 7.2 链接 / 截图 / 产物

- **README 内嵌图片**：8 张全部存在（ui-overview/ui-clean-result/ui-clean-items/ui-plugins/ui-history/ui-ai/ui-settings/ui-theme-dark）。
- **全 docs 相对链接**（README + `docs/**/*.md` 共 13 个文件）：**60 条相对链接 0 失效**；**14 处图片引用 0 缺失**。
- **README 的 4 张未跟踪 e2e 截图**（`ui-ai-config.png`、`ui-ai-enabled.png`、`ui-clean.png`、`ui-rail.png`）：均存在但**未被 README/docs 引用**，属本地产物（合计约 725 KB）。
- **git status**：本次验收前仅有预先说明的未跟踪项 `docs/mentor-brief/`（7 个本地 HTML 论文素材文件，约 149 KB）与上述 4 张截图；已扫描 `sk-*/api_key/BEGIN PRIVATE KEY/password` 等特征，**未发现密钥/口令**。无大文件异常、无敏感凭据入库。
- **E2E/验收会重写已跟踪截图**：`docs/screenshots/ui-*.png` 在 E2E 中被覆盖，验收完成后已执行 `git checkout -- docs/screenshots` 还原；最终**已跟踪文件 0 修改**。
- **CI**：`.github/workflows/ci.yml` 已包含 `install --frozen-lockfile → typecheck → typecheck:ui → vitest → build:ui`（批次3-A「接入 CI」成立）。

### 7.3 发现的两处低风险不一致（不阻塞）

1. **`docs/test-plan.md:49` 陈旧描述（低）**：「已知缺口」仍写“模板/脚本类型不由 `tsc` 覆盖（未接入 `vue-tsc`）”，但批次3-A 已接入 `pnpm typecheck:ui`（README:118 已写、CI 已跑、本次 exit 0）；该文件命令清单也缺 `pnpm typecheck:ui`。建议更新为“已接入 vue-tsc，覆盖 .vue 模板类型”。
2. **`packages/core/src/manifest.ts` 的 rule-pack 描述（低，界面文案）**：「30 个分类、270+ 条规则」与实际规则库口径（catalog 28 类/271 条；catalog+extra 合计 37 类/401 条；默认装载约 31 类/312 条）不一致，建议改为动态数字或统一口径。

## 8. 残余风险（均已在仓库文档中如实记录，非本次新增）

1. **TOCTOU**：检查与删除之间仍存在窗口（执行器二次复核已压缩窗口，纯 Node 无法彻底消除，需文件句柄/事务删除）——`docs/threat-model.md` §4。
2. **插件信任模型**：安装外部插件等同执行本机代码；worker 隔离不是 OS 沙箱；env 白名单只限制 `ctx.env` 暴露面，插件直接读 `process.env` 仍可见——`external-proxy.ts` 头注释 + `threat-model.md` §3。
3. **Electron 38 可能已 EOL**、无代码签名/安装包；升级需回归 IPC/preload/CSP/CDP——`dependency-policy.md`。
4. **AI Key 明文**保存在 `config.json`；撤销凭据/隔离区 manifest 为明文，同用户可读/可篡改——`threat-model.md` §4。
5. **同用户本机攻击面**：token 内联在页面、本机端口无 TLS，token 只防跨站网页，不防同用户恶意进程——`threat-model.md` §2。
6. **回收站批量删除依赖系统 PowerShell**（参数化/JSON 清单，无命令拼接）——`threat-model.md` §4。
7. **测试缺口（docs/test-plan.md 已列）**：无真实文件锁占用测试；`app/open-path`（D-25）无专门单测（代码审阅+E2E 覆盖）；Electron CSP/sandbox/导航拦截无仓库内自动化断言（本次由 E2E + 独立脚本覆盖）；E2E 未覆盖 AI 工坊/规则试运行弹窗；UI 无组件级单测；无性能回归门禁。
8. UI 24 个 `vue-tsc` 类型错误：**已由 HEAD 445aa07 修复并接入 CI，本次 `pnpm typecheck:ui` exit 0 确认**。

**阻塞项：无。**

## 9. 证据索引

| 证据 | 路径 |
| --- | --- |
| frozen-lockfile 安装 / prod 审计 | `docs/verification/final-2026-10-20/01-install.log`、`05-audit-prod.log` |
| typecheck / typecheck:ui | `docs/verification/final-2026-10-20/02-typecheck.log`、`03-typecheck-ui.log` |
| 全量单测（44/346） | `docs/verification/final-2026-10-20/04-vitest.log` |
| 构建 UI / 桌面 | `docs/verification/final-2026-10-20/06-build-ui.log`、`07-build-desktop.log` |
| 真实 Electron E2E | `docs/verification/final-2026-10-20/08-e2e-electron.log` |
| 3000 条 mock UI 验收 | `docs/verification/final-2026-10-20/09-verify-clean-ui.log` |
| 批次1 定向回归 | `docs/verification/final-2026-10-20/10-batch1-targeted-tests.log` |
| Web 外壳安全复验 | `docs/verification/final-2026-10-20/11-web-shell-security.log` |
| 界面截图 | `docs/screenshots/*.png`（README 引用 8 张）、`docs/screenshots/scan-select-light.png`、`scan-select-dark.png` |
| 历史验收（选择 v2） | `docs/verification/scan-selection-verify.md`（历史快照，数字口径按当时 289 条；README 已注明） |

> 说明：`*.log` 被仓库 `.gitignore` 忽略，为本次验收的本地证据；报告本身未提交（按任务要求）。

## 10. 复现命令

```bash
pnpm install --frozen-lockfile
pnpm audit --prod
pnpm typecheck && pnpm typecheck:ui
pnpm vitest run
pnpm build:ui && pnpm build:desktop
node scripts/e2e-ui.mjs
node scripts/verify-clean-ui.mjs
# Web 外壳安全复验：以临时端口/数据目录启动 pnpm dev:web（CORDCLEAN_NO_OPEN=1），
# 验证 /% 400、伪 Host 403、正常 200、WS 错误 Origin 拒绝（可用临时脚本，勿触碰真实配置）
```
