# 插件包规范 v2（`plugin.json`）

> 状态：**Step 1–6 已实现**——清单契约与校验、目录扫描、兼容性检查、安装事务、PluginManager 接入、管理面（RPC + 插件页审阅安装）、客户端资源加载、AI 工坊产出 v2 插件包，以及文档/测试/发布打包验收。
>
> 实现位置：
> - 契约与校验：`packages/shared/src/plugin-manifest.ts`
> - 目录扫描：`packages/core/src/domains/kernel/plugin-package.ts`
> - 安装事务：`packages/core/src/domains/kernel/plugin-installer.ts`
> - 生命周期接入：`packages/core/src/domains/kernel/plugins.ts`
> - 测试：`tests/plugin-manifest.test.ts`、`tests/plugin-package.test.ts`、`tests/plugin-installer.test.ts`、`tests/plugin-package-manager.test.ts`

## 1. 目标

v1 的外部插件是**单文件**（`<name>.mjs` 或 `<name>/plugin.mjs`），元数据靠模块导出推断。这带来四个限制：

1. 不能携带页面/样式/本地化/测试等资源（静态检查禁止相对 import）；
2. 安装前无法回答「它要什么权限、兼容哪个宿主版本、贡献了什么」；
3. 无法做版本升级/降级、兼容性拒绝与安装回滚；
4. AI 生成物只能是一个文件，无法长成真正的插件项目。

v2 把插件升级为**目录 + 清单**：`plugin.json` 是安装、启用、展示、审计的唯一事实来源；旧版单文件插件保留，扫描时合成为 apiVersion=1 的兼容清单。

## 2. 包目录结构

```
plugins/<id>/
  plugin.json          # 必需：清单
  index.mjs            # 默认入口（entry 可改）
  client/              # 可选：client.mode=page 的客户端资源
    index.html
  config.schema.json   # 可选：配置 schema（后续设置页自动渲染）
  locales/             # 可选：本地化文本（后续）
  README.md            # 可选
```

`plugins/` 位于用户数据目录（`dataDir/plugins`），启动时扫描。`.staging/` 与 `node_modules/` 目录会被扫描器忽略。

## 3. `plugin.json` 字段

### 必填

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 2–40 位小写字母/数字/连字符；建议与目录名一致 |
| `name` | string | 展示名，≤64 字符 |
| `version` | string | 严格 semver（`1.2.0`、`1.2.0-beta.1`） |
| `apiVersion` | number | 必须为 `2`（旧版单文件插件走兼容模式，不写清单） |
| `engines.cordclean` | string | 宿主版本范围，semver range，如 `>=0.6.0 <0.7.0` |
| `kind` | enum | `cleaner` / `widget` / `active` / `desktop` / `integration` |
| `entry` | string | 包内相对路径，`.mjs`/`.js`，不能指向 `client/` |
| `permissions` | object | 见第 4 节 |
| `permissions.services` | string[] | 需要注入的宿主服务（可为空数组） |
| `permissions.network` | boolean | 是否声明需要网络 |
| `permissions.subprocess` | boolean | 是否声明需要子进程 |

### 可选

| 字段 | 类型 | 说明 |
|---|---|---|
| `description` | string | ≤512 字符，插件页展示 |
| `author` / `license` / `homepage` | string | 元信息；`homepage` 仅 http(s) |
| `client.mode` | enum | `none` / `declarative`（默认能力）/ `page` |
| `client.entry` | string | `page` 模式必填，必须在 `client/` 下，`.html/.htm/.js` |
| `configSchema` | string | 包内 `.json` 相对路径 |
| `contributes` | object | `tasks` / `overviewCards` / `pages` / `statusItems` / `commands`，每项为 kebab-case id 数组（每类 ≤64） |
| `dependencies` | object | 插件自己的 npm 依赖，名称 → semver 范围（沿用 `plugin-code.ts` 的校验：≤8 个、不能是路径/git/URL、不能依赖框架内部包） |

示例：

```json
{
  "id": "dev-cache",
  "name": "开发缓存清理",
  "version": "1.2.0",
  "description": "清理 npm/pnpm/yarn 缓存，只报告可恢复项",
  "author": "CordClean",
  "license": "MIT",
  "apiVersion": 2,
  "engines": { "cordclean": ">=0.6.0 <0.7.0" },
  "kind": "cleaner",
  "entry": "index.mjs",
  "client": { "mode": "declarative" },
  "permissions": {
    "services": ["cleaner", "ui", "system"],
    "fsRoots": ["%LOCALAPPDATA%\\npm-cache", "%LOCALAPPDATA%\\pnpm\\store"],
    "network": false,
    "subprocess": false
  },
  "contributes": {
    "tasks": ["dev-cache"],
    "overviewCards": ["dev-cache-card"]
  }
}
```

## 4. 权限声明

- `services`：允许的宿主服务集合，与 `plugin-code.ts` 的 inject 白名单一致：`ui`、`cleaner`、`window`、`settings`、`system`、`pathPolicy`、`rules`、`evaluator`、`history`、`quarantine`、`compensate`、`executor`、`recycleBin`、`ai`、`aiContext`、`egress`。未知服务直接拒绝。
- `fsRoots`：worker/清理类插件的可访问目录根（绝对路径或 `%VAR%` 模板；≤20 项；拒绝盘符根与 `..`）。
- `network` / `subprocess`：v2 **默认不允许**；声明为 `true` 时清单校验只给警告，安装事务必须要求用户显式确认（后续步骤实现）。
- 权限声明是**安装前审阅**与**管理页展示**的依据；运行时的强制（native 插件）在 Step 3 接入。

## 5. 兼容性

- 清单 `apiVersion` 必须等于宿主当前支持的 `PLUGIN_API_VERSION`（当前为 2）；
- `engines.cordclean` 在安装/启用时用 `checkPluginManifestCompatibility()` 对照宿主版本；
- 不兼容时拒绝加载并给出可读原因（例如 `插件 dev-cache 要求 CordClean >=0.6.0 <0.7.0，当前版本 0.6.0`）；
- 旧版单文件插件合成为 `apiVersion=1`、`engines=*`，不参与 v2 兼容检查。

## 6. 客户端资源（Step 4 已实现）

- `client.mode=none`：无界面；
- `client.mode=declarative`：只通过 `ctx.ui` 注册声明式贡献（现有能力）；
- `client.mode=page`：包内自带 `client/` 目录，宿主按两种外壳提供：

| 外壳 | 加载方式 | URL 形式 |
|---|---|---|
| Electron | 主进程注册 `cordclean-plugin://` 自定义协议（standard/secure/supportFetchAPI） | `cordclean-plugin://<pluginId>/<client 内相对路径>` |
| Web | 宿主 HTTP 静态路由 | `/plugin-assets/<pluginId>/<client 内相对路径>` |

实现要点：

- 解析入口 `resolvePluginClientAsset()`（`packages/core/src/domains/kernel/plugin-package.ts`）：校验插件 id → 读清单确认 `client.mode=page` → 解码路径并拒绝 `..`/反斜杠/控制字符 → realpath 必须仍在 `client/` 内 → 必须是文件；
- 响应头：`Content-Type`、`Content-Security-Policy`（清单未声明 `network` 时 `connect-src 'none'`）、`X-Content-Type-Options: nosniff`、`Cache-Control: no-cache`；
- UI：`plugins/client-url` RPC 按外壳返回 URL；插件页用 `sandbox="allow-scripts"` 的 iframe 打开，页面脚本通过 `postMessage` 与宿主通信；
- 父页面 CSP `frame-src` 已加入 `cordclean-plugin:`；Electron 主进程在 app ready 前注册 scheme 权限，随后 `protocol.handle()` 提供资源。

## 7. 旧版单文件插件
- 扫描器把 `plugins/*.mjs|js` 记为 legacy 候选，用 `createLegacyPluginManifest()` 合成清单；
- `generated-plugins/` 下的 AI 工坊产物继续可用，Step 5 起工坊改为产出 v2 包（同时保留单文件快捷模式）；
- 旧插件在管理页标记为「兼容模式」，迁移时提示升级为包。

## 8. 安装事务（Step 2 已实现）

```
选择包目录
  → 读取并校验 plugin.json（语法 + 契约 + apiVersion/engines 兼容）
  → 静态检查入口源码（体积上限 + 不支持子进程/网络/直删等）
  → 复制到 plugins/.staging/<id>-<ts>/（拒绝符号链接；限制文件数/体积/深度）
  → 复查暂存副本
  → 原子 rename 到 plugins/<id>/（同盘）
  → 任一步失败：清理暂存目录；升级失败恢复旧版本
```

要点：

- 已存在同 id 时默认拒绝（`already-installed`）；显式 `upgrade: true` 才替换，旧版本移到 `plugins/.trash/<id>-<ts>/`，可人工回滚；
- 卸载默认移入 `.trash`（`backup: false` 才直接删除）；
- 启动时扫描 `dataDir/plugins` 并登记为 `external:<id>` 记录，按 settings 的 `enabled` 自动启用；
- 启用前再做一次 `apiVersion`/`engines` 兼容检查与入口源码静态复查（防止安装后文件被替换）；
- 卸载/禁用会丢弃模块缓存；reload 会重新 import（生产 Node 用 `?v=` 缓存穿透，Vitest 的 Vite 模块缓存不穿透，仅测试环境差异）；
- 预留 `prepareStaging()` 钩子：Step 5 的依赖安装/冒烟测试在 stage 与 commit 之间执行。

`PluginManager` 对外新增（`ctx.plugins`）：

| 方法 | 作用 |
|---|---|
| `installPackage(sourceDir, { enable?, upgrade? })` | 安装 v2 插件包（校验 → 落盘 → 登记 → 启用） |
| `uninstallPackage(id)` | 停用 → 删除登记 → 目录移入 `.trash` |
| `packageProblems()` | 最近一次启动扫描发现的包问题（供管理页展示） |

安装日志与来源（本地导入 / AI 生成）写入 `plugins/.install-log.jsonl` 属于后续步骤（Step 5/6）。

### 管理面（Step 3 已实现）

RPC（`packages/shared/src/rpc.ts` + `packages/host/src/api.ts`）：

| 方法 | 作用 |
|---|---|
| `plugins/inspect-package` | 只读检查目录：清单、权限、警告、错误、已安装版本（不落盘） |
| `plugins/install-package` | 审阅通过后安装（stage → commit → 登记 → 启用） |
| `plugins/uninstall-package` | 卸载，目录移入 `.trash` |
| `plugins/package-problems` | 启动扫描发现的问题（管理页横幅） |

插件页（`packages/ui/src/views/PluginsView.vue`）：

- “安装插件包”按钮 → 输入目录 → 检查 → 展示名称/id/版本/类型/兼容范围/客户端模式/所需服务/可访问目录/网络与子进程；
- 存在错误时安装按钮禁用；警告（如声明网络/子进程）随审阅展示；
- 插件卡片展示“插件包 vX.Y.Z”和权限数量（悬停看服务列表）；
- 启动扫描失败时页面顶部显示“有插件包未能加载”横幅；
- 卸载 v2 插件包走 `uninstall-package`（保留 `.trash`），与旧工坊插件卸载区分。

兼容/权限检查出现在：启动扫描、启用前（`loadModule`）、安装前（inspect/stage）、管理页展示。
权限清单是**声明 + 审阅 + 展示**，不是运行时沙箱：native 插件在宿主进程内运行，仍以用户权限执行。

## 9. AI 工坊产出 v2 插件包（Step 5 已实现）

AI 工坊的产物从“单文件”升级为“v2 插件包”，但保留旧路径：

- **模型输出**：`emit_plugin` 工具新增可选 `manifest`（v2 清单）与 `files`（`[{path, content}]`，不含 `plugin.json`）。模型只给 `code` 也可以。
- **宿主归一化**（`packages/host/src/ai-plugin-package.ts`）：
  - 单文件草稿 → 自动合成清单：id 由 name 规范化，`apiVersion: 2`，`engines.cordclean: ^<当前版本>`，`kind` 取草稿，`entry: index.mjs`，权限服务从 `export const inject` 提取；
  - `files` 含 `client/index.html` → 自动声明 `client.mode=page`；
  - 校验：清单契约、文件路径安全（`/` 分隔、不越界）、单文件 ≤256 KB / 总数 ≤50 / 总体积 ≤4 MB、入口文件存在且通过静态契约、客户端页面存在、`plugin.json` 不允许出现在 files；
  - **依赖安装**：声明第三方依赖时，安装事务在 staging 内写入 `package.json` 并通过 `prepareStaging` 钩子执行 `npm/pnpm install --ignore-scripts`，把 `node_modules` 一起提交；用户必须先确认依赖清单。
- **安装**：写到 `dataDir/.ai-packages/<id>-<ts>/` → `PluginManager.installPackage()`（staging → commit → 登记 → 启用）→ 清理临时目录。安装前必须 `acknowledgePermissions: true`（UI 的“已阅读代码”勾选即视为权限确认）。
- **RPC**：`ai/plugin/validate` 与 `ai/plugin/install` 新增 `format` / `manifest` / `files` / `acknowledgePermissions`；结果增加 `manifest`。
- **UI**：插件草稿审阅弹窗显示“v2 插件包 / id / 版本 / 兼容范围 / 权限服务 / 文件列表”，安装按钮复用安装事务；多文件包当前只支持编辑入口代码。

## 10. 代码位置与后续路线

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 清单契约、校验器、目录扫描、兼容检查 | ✅ 已完成 |
| 2 | 安装事务 + PluginManager 接入（发现/启用/卸载） | ✅ 已完成 |
| 3 | 兼容/权限检查接入启动与启停、管理页展示与审阅安装 | ✅ 已完成 |
| 4 | 自定义协议 / HTTP 路由加载 `client/` 资源 | ✅ 已完成 |
| 5 | AI 工坊产出 v2 插件包 + 审阅 | ✅ 已完成 |
| 6 | UI、文档、测试、发布 | ✅ 已完成 |

## 11. 验收记录（v0.6.0）

- 自动化测试：**63 个文件 / 459 个用例全部通过**（新增 v2 相关 31+16+6+5+8+4 个用例，含端到端生命周期与旧版插件重启兼容）；
- 类型检查：`tsc -p tsconfig.json --noEmit`、`vue-tsc -p tsconfig.ui.json --noEmit` 均 0 错误；
- 构建：`pnpm build`（UI + Electron 主进程）成功；
- 发布包：`CordClean-v0.6.0/` + `CordClean-v0.6.0.zip`（源码 + 启动脚本 + 文档，不含 node_modules/dist）；
- Web 外壳冒烟：启动后 `/api/ping` 与 `app/info` 正常，插件页可加载 v2 管理 UI；
- 端到端：`tests/plugin-v2-e2e.test.ts` 走真实 HTTP RPC 覆盖 检查 → 安装 → client 资源 → 启停/重载 → 卸载、旧版单文件插件重启自动加载、AI 草稿包安装、11 个内置插件加载；
- 已知边界：Electron 自定义协议无法在无界面环境端到端验证（已验证编译与解析函数）；第三方依赖安装依赖网络与 npm/pnpm 可用性。
