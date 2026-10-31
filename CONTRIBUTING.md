# 贡献指南

感谢你愿意改进 CordClean。这个项目优先保证 **安全、可恢复、可测试**，其次才是功能数量。

> 当前版本：`0.6.9` · 测试基线：67 个测试文件 / 487 个用例 · 发布约定见 [docs/release-process.md](docs/release-process.md)。

## 1. 开发环境

- Windows 10/11（主要目标平台；内核代码尽量保持跨平台可测）
- Node.js **22+**（`engines.node: >=22`）
- pnpm **12.14.0**（`packageManager` 固定版本，推荐用 corepack 自动切换）

```powershell
corepack enable
pnpm install

pnpm dev:web        # 浏览器外壳，默认 http://127.0.0.1:7801/
pnpm dev:desktop    # Electron 桌面外壳
```

首次安装会自动准备 Electron 镜像；如果网络受限，可先只跑 Web 外壳。

## 2. 提交前必须通过

```powershell
pnpm typecheck      # tsc
pnpm typecheck:ui   # vue-tsc
pnpm test           # 67 个文件 / 487 个用例（会先构建 UI）
pnpm build          # UI + 桌面主进程
```

按改动范围可以只先跑子集，但 PR 前建议跑全量：

```powershell
pnpm test:security  # 路径策略 / 补偿链 / 能力边界
pnpm test:ai        # AI 顾问、接口形态、上下文与选择
pnpm test:engine    # 扫描/清理引擎、规则、隔离区、撤销
pnpm test:api       # RPC、参数校验、API 流程
pnpm test:platform  # 插件运行时与外部插件
```

测试默认使用临时数据目录（`CORDCLEAN_DATA`），不会碰真实清理历史。不要为了“让测试变绿”删除断言或跳过安全用例。

## 3. 目录结构

```text
apps/web             浏览器外壳（HTTP + WebSocket）
apps/desktop         Electron 外壳
packages/core        内核：Settings / System / PathPolicy / Quarantine / History / PluginManager
packages/host        RPC、HTTP/WS、安装事务、AI 工坊宿主逻辑
packages/ui          Vue 3 + Element Plus 界面
packages/shared      共享类型、RPC 契约、清理任务/插件契约
packages/plugins/*   内置插件（规则库、调度、AI 顾问、AI 工坊等）
tests                Vitest 单元/集成测试
scripts              审计、冒烟、规则导入、构建脚本
docs                 架构、威胁模型、发布说明、验收记录
```

本项目的分层原则：**插件只产生清理候选，内核统一执行删除**。不要绕过 `ctx.compensate` + `ctx.executor` 直接操作文件系统。

## 4. 提交与 PR 规范

- 一个提交/PR 只做一件事；从 `main` 开分支，分支名建议 `feat/...`、`fix/...`、`docs/...`；
- 提交信息建议 `type(scope): subject`（中文或英文均可），例如 `fix(ai): 拦截过宽 AI 规则`；
- 新功能必须有测试；修复 bug 先写能复现的失败用例；
- 安全相关改动必须说明威胁场景、影响与新增校验；
- 不要提交 `node_modules/`、`dist/`、`.run/`、日志、临时数据、真实 API Key；
- PR 描述至少包含：改了什么、为什么改、如何验证、是否有兼容性影响。

### 代码风格

- TypeScript strict；公共 API 和 RPC 参数保持显式类型；
- 避免无必要的 `any`；确实需要的边界处请注释原因；
- 用户可见文案使用中文；错误信息要能指导用户下一步；
- 涉及文件删除、注册表、AI 规则、插件安装的代码，可读性优先于“巧妙”；
- 不要引入隐式后台网络请求、遥测或自动更新。

## 5. 新增清理能力

优先新增 **规则数据**，而不是写新插件：

1. 修改 `packages/plugins/rule-pack/catalog/*.json`；
2. 确认目标是「可重建缓存」，不是用户数据、文档、聊天记录或配置；
3. 使用受支持的目标类型（`clear_dir` / `glob_dirs` 等），路径尽量使用 `%ENV%` 变量；
4. 选择合适的 `risk` 和 `note`，说明可能影响；
5. 运行审计与只读预演：

```powershell
pnpm exec tsx scripts/audit-rules.ts     # 输出 docs/rules-report.md
pnpm exec tsx scripts/dryrun-clean.ts    # 真实环境预演，不删除文件
```

6. 需要时补 `tests/rules.test.ts` / `tests/path-policy.test.ts` 用例。

规则会经过安全策略过滤；受保护目录、盘符根、过宽目录会被拒绝。不要通过 `exclude` 绕过安全边界。

## 6. 写插件

外部插件包使用 v2 目录结构：`plugin.json` + `index.mjs`（+ 可选 `client/`）。完整规范见 [docs/plugin-package-v2.md](docs/plugin-package-v2.md)。

最低要求：

- 只通过 `ctx.cleaner.define` 注册任务，`scan` 只 `emit` 候选，不直接删除文件；
- 最小权限：只声明需要的 `permissions.services`、`fsRoots`、`network`、`subprocess`；
- 路径来自配置或 `ctx.system.env`，不得硬编码用户名；
- 不阻塞内核：扫描/清理中的耗时逻辑要响应取消信号；
- client 页面若需要宿主数据，必须使用宿主 bridge 契约：
  `window.parent.postMessage({ type: 'cordclean/plugin-page', method: 'resolve', id, resolverId, params }, '*')`
  并监听 `cordclean/plugin-page-result`；旧协议只是运行期兼容，不应在新插件中使用；
- 插件安装走 staging → 校验 → 原子落盘/回滚；不要手写安装流程。

### 关于权限清单

`permissions` 用于审阅、静态校验和用户知情，**不是沙箱**。插件运行在宿主 Node 进程中，拥有完整权限；安装前必须审阅源码，只安装可信插件。

### AI 工坊生成的插件

AI 生成的插件同样是第三方代码，不能因为“是本地生成的”就跳过审阅。安装前请检查清单、文件、权限和 bridge 实现。

## 7. AI 相关改动

- 不要把 API Key 写入代码、测试、日志、截图或提交历史；本地调试用环境变量或临时数据目录；
- 修改 AI prompt、上下文采集、规则建议、推荐选择时，至少补 mocked 测试；涉及真实接口行为变化时，用 `scripts/ai-live-test.ts` 在本地验证，不要提交密钥；
- AI 规则必须经过安全门（宽目录拦截、默认不选中、用户确认），不得为了“方便”放宽；
- AI 推荐不能直接执行删除：必须走选择、确认、补偿链、隔离区/回收站；
- 新增 AI 输出字段时，考虑旧模型/旧接口的缺省与失败路径。

## 8. 安全相关改动

删除逻辑、路径策略、注册表、插件加载、本地 HTTP/WS、密钥与日志相关 PR：

1. 先阅读 [docs/threat-model.md](docs/threat-model.md) 和 [SECURITY.md](SECURITY.md)；
2. PR 中写清：会误删/泄露什么、现有防护为什么不够、新增校验点、回滚/恢复路径；
3. 补安全测试（`tests/path-policy.test.ts`、`tests/path-attack.test.ts`、`tests/fs-safety.test.ts`、`tests/compensate.test.ts` 等）；
4. 发现可利用漏洞不要开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 9. 文档与发布

- 用户可见行为变化：更新 README、相关 docs 与本版本发布说明；
- 发布流程见 [docs/release-process.md](docs/release-process.md)；
- 每个版本至少包含：CHANGELOG、发布说明、测试结果、发布包与安装说明；
- 不把“未验证”“看起来应该可以”写进发布说明；真实测试结果与实际命令要一致。

## 10. 行为准则

保持友善、就事论事，针对代码和设计讨论，不针对个人。安全边界有分歧时，以 **默认拒绝、可恢复优先、可审计** 为准。

## 11. 许可

提交即表示你同意以本项目的 [MIT License](LICENSE) 授权你的贡献。项目不要求签署 CLA。
