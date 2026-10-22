# CordClean 插件开发规范

> 本文档定义「清理插件」的标准写法。新增一个清理能力 = 新增一个插件包，**不需要修改内核任何代码**。

## 1. 目录结构

```
packages/plugins/<id>/
├── package.json          # name: @cordclean/plugin-<id>
└── src/index.ts          # 默认导出 defineCleanerPlugin({...})
```

`package.json` 模板（依赖固定为这三个，不要添加其它运行时依赖）：

```json
{
  "name": "@cordclean/plugin-<id>",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@cordclean/shared": "workspace:*",
    "@cordclean/utils": "workspace:*",
    "schemastery": "^3.17.2"
  }
}
```

## 2. 插件骨架

```ts
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import { exists, walk, errorMessage } from '@cordclean/utils'

export interface MyConfig {
  enabledDir: boolean
}

const Config = Schema.object({
  enabledDir: Schema.boolean().default(true).description('界面上显示的配置说明'),
})

export default defineCleanerPlugin<MyConfig>({
  name: 'my-plugin',            // 必须与包 id 一致
  version: '1.0.0',
  description: '一句话描述',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    // ① 声明清理辖区（安全阀）：只有这些目录下的路径才允许被删除
    ctx.effect(() => {
      const disposers = [ctx.pathPolicy.addRoot('C:\\some\\dir')]
      return () => disposers.forEach((dispose) => dispose())
    })

    // ② 注册清理任务（ctx.effect 保证插件卸载时自动注销）
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'my-task',
        name: '我的清理任务',
        description: '...',
        category: 'system',      // system | browser | privacy | disk | apps | startup | dev | ai
        risk: 'safe',            // safe | caution | risky
        icon: '🧹',              // emoji
        defaultSelected: true,
        targets: ['C:\\some\\dir'],
        tips: ['删除前会经过隔离区'],
        async scan(scan) {
          for await (const entry of walk('C:\\some\\dir', {
            signal: scan.signal,
            onError: (path, error) => scan.addError({ path, message: errorMessage(error) }),
          })) {
            if (entry.isDirectory) continue
            scan.emit({ path: entry.path, size: entry.size })
          }
        },
      }),
    )
  },
})
```

## 3. 扫描上下文 `scan`

| API | 说明 |
| --- | --- |
| `scan.signal` | `AbortSignal`，遍历时要传递给 `walk()` |
| `scan.emit(draft)` | 上报一个清理项（流式）。字段见下 |
| `scan.count('file'\|'directory', bytes?)` | 只计入统计、不产出清理项 |
| `scan.addError({ path, message, code? })` | 记录非致命错误（权限不足、文件占用） |
| `scan.throwIfAborted()` | 主动检查取消 |
| `scan.logger.info/warn/error` | 写日志（会自动带上任务前缀） |
| `scan.env` | 环境信息（见下） |
| `scan.pathPolicy` | `check(path)` / `isProtected(path)` |
| `scan.config` | 插件配置（一般直接用闭包里的 `config`） |

`draft` 字段：`path`（必填）、`size`、`risk`（覆盖任务默认风险）、`title`、`kind`（默认 `file`）、
`defaultSelected`、`note`（给用户看的提示）、`meta`（任意附加数据，供界面展示）。

规则：
- **单次扫描最多上报 `settings.scan.maxItemsPerTask` 项**（默认 20000），超出会被引擎截断，请在插件内做合理上限；
- 目录项也可以上报（`kind: 'directory'`），引擎会自动递归删除并检查是否包含受保护目录；
- 同一路径被多个任务上报时引擎会自动去重。

## 4. 自定义清理 `clean`（可选）

默认情况下引擎会自行删除 `kind` 为 `file` / `directory` 的项（并遵守隔离区与路径策略）。
当清理对象是**注册表项、命令行动作**等非文件对象时，必须实现 `clean`：

```ts
ctx.cleaner.define({
  id: 'my-registry-task',
  // ...
  scan(scan) {
    scan.emit({ path: 'HKEY_CURRENT_USER\\Software\\Foo\\Bar', kind: 'registry', size: 0, risk: 'caution' })
  },
  async clean(items, cleanCtx) {
    const results = []
    for (const item of items) {
      if (cleanCtx.dryRun) { results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 }); continue }
      if (cleanCtx.signal.aborted) break
      const ok = await regExport(item.path, `${cleanCtx.env.dataDir}\\backup\\x.reg`)   // 先备份
      results.push({ itemId: item.id, path: item.path, ok, bytes: 0, error: ok ? undefined : '导出备份失败' })
    }
    return results
  },
})
```

`cleanCtx` 提供 `signal`、`dryRun`、`mode`（`delete`/`quarantine`）、`quarantineDir`、`env`、`pathPolicy`、`throwIfAborted()`。
必须在 `dryRun` 时只统计不执行。

## 5. 环境对象 `ctx.system.env`

| 字段 | 说明 |
| --- | --- |
| `platform` / `arch` | `win32` / `x64` |
| `elevated` | 是否管理员权限 |
| `username` | 当前用户名 |
| `systemDrive` | `C:` |
| `windowsDir` | `C:\Windows` |
| `programFiles` / `programFilesX86` / `programData` | 对应系统目录 |
| `appData` / `localAppData` | `%APPDATA%` / `%LOCALAPPDATA%` |
| `userProfile` | 用户主目录 |
| `dataDir` | 应用数据目录（可写） |
| `drives` | 固定磁盘盘符数组，如 `['C:', 'D:']` |
| `get(name)` | 读取环境变量 |

## 6. 可用工具（`@cordclean/utils`）

```ts
import {
  // 路径
  normalizePath, pathKey, isSubPath, toLongPath, driveOf, parentPath, isAbsolutePath,
  // 遍历
  walk, folderSize, exists, safeStat, safeLstat,
  // 文件操作
  measurePath, inspectPath, deletePath, moveFile, describeDeleteError,
  // 异步
  mapLimit, Pool, sleep, errorMessage, errorCode,
  // 命令与注册表
  runCommand, powershell, reg, regQuery, regExport, regDeleteKey, regDeleteValue, regAddValue,
  parseRegValues, parseRegSubKeys,
  // 哈希
  sha256, hashFile,
} from '@cordclean/utils'
```

`@cordclean/shared` 还提供 `formatBytes`、`basename`、`hashString`、`itemId`、`maxRisk`、`CATEGORIES`、`RISK_META` 等纯函数与常量。

## 7. 安全红线（必须遵守）

1. **不要删除**：`System32`、`WinSxS`、`Program Files`、`ProgramData`、用户文档/桌面/图片/视频/音乐/下载、`AppData\Roaming`、回收站目录本身。这些路径由 `pathPolicy` 拦截，插件不要试图绕过。
2. **不要跟随符号链接/联接点**：`walk()` 默认跳过；自行遍历时也必须用 `lstat` 判断。
3. **不要递归删除未声明的目录**：只上报自己 `addRoot()` 过的目录下的内容。
4. **默认不勾选**：风险等级为 `caution` / `risky` 的项要设置 `defaultSelected: false`。
5. **需要管理员权限的操作**（清空回收站、写 HKLM、Prefetch）要在 `note` 中说明，并在 `env.elevated === false` 时降级处理而不是抛错。
6. **所有清理都必须幂等、可跳过**：文件被占用时返回失败而不是让整个任务崩溃。
7. **不要依赖「插件是沙箱」**：内置插件与内核同进程，属于受信任代码；外部插件在 worker 中运行只是故障隔离，
   且不会获得清空白名单（`addClearRoot`），`targets` 必须落在能力声明的 `fsRoots` 内。
   安全边界与残余风险见 [威胁模型](threat-model.md)。

### 6.1 AI 插件工坊生成的外部插件契约

AI 工坊生成的是**单文件外部插件**，和内置插件包不同；它可以声明 npm 依赖：

- 不依赖第三方包时：`generated-plugins/<name>.mjs`，只允许 `node:fs` / `node:fs/promises` / `node:path` / `node:os` / `node:url` / `node:util` / `node:crypto`；
- 需要第三方能力时，生成结果带 `dependencies: { 包名: "semver" }`：
  - 安装目录为 `generated-plugins/<name>/`（`plugin.mjs` + `package.json` + `node_modules`），Node 的 ESM 解析可直接找到依赖；
  - **必须由用户确认依赖清单后才会下载**；安装时禁用 lifecycle scripts（`--ignore-scripts`）；
  - 只允许 npm 包名 + semver，禁止 `file:` / `git` / URL / 路径规格，最多 8 个；
- 不能使用 `defineCleanerPlugin`（框架内部 helper 解析不到），直接 `export default { name, version, description, capabilities, Config, setup }`；
- 不能 `import '@cordclean/shared'`、`@cordisjs/*` 或未在 `dependencies` 声明的包；第三方包按包名匹配，支持子路径 import；
- `capabilities.fsRoots` 与 `targets` 支持 `%TEMP%`、`%USERPROFILE%`、`%LOCALAPPDATA%`、`%APPDATA%`、`%WINDIR%` 模板，
  安装时展开为绝对路径；代码里用 `ctx.system.env.get('TEMP')` 取实际路径；
- 静态检查不通过时工坊会带着错误自动重试生成；最终安装前还会在 worker 中真实加载一次。

> 安全提醒：第三方 npm 包与插件拥有相同的完整 Node 权限；禁用安装脚本只能阻止安装期脚本，不能阻止包代码在 import 时执行。请只安装你信任的依赖，见 [威胁模型](threat-model.md) §3.2。

校验规则在 `packages/shared/src/plugin-code.ts`，生成端、安装端、测试共用同一套。

## 8. 自测方式

新建 `scripts/check-<id>.ts`：

```ts
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { formatBytes } from '@cordclean/shared'

const app = await createApp({ dataDir: path.join(os.tmpdir(), 'cc-' + Date.now()), logLevel: 'warn' })
const report = await app.ctx.cleaner.scan({ taskIds: ['<task-id>'] })
console.log('items', report.items.length, formatBytes(report.stats.bytes), 'errors', report.errors.slice(0, 3))
for (const item of report.items.slice(0, 5)) console.log(formatBytes(item.size), item.path)
await app.dispose()
```

执行：`pnpm exec tsx scripts/check-<id>.ts`

> 注意：**只做扫描（scan）验证，不要在自测中执行真实的 `clean()`**，以免误删本机文件。
> 如需验证清理逻辑，请使用 `dryRun: true`。

## 9. 另一种扩展方式：加一条规则（不用写代码）

从规则库（`rule-pack`）引入起，清理能力有两种扩展粒度（当前规则库含 catalog 28 类 / 271 条 + extra 9 类 / 130 条，默认装载约 31 类 / 312 条）：

| 方式 | 适用场景 | 成本 |
| --- | --- | --- |
| 写插件 | 需要自定义扫描/清理逻辑（回收站解析、重复文件、注册表、浏览器 profile） | 一个包 + 测试 |
| 加规则 | 只是"清某个目录/某类文件"，带条件（年龄/大小/深度） | 一段 JSON |

加规则的步骤：

1. 在 `packages/plugins/rule-pack/rules/catalog.json`（原始导入）或 `extra.json`（扩充）对应分类的 `rules` 数组里加一条：

```json
{
  "id": "system_temp-99",
  "name": "某软件缓存",
  "risk": "safe",
  "source": "builtin",
  "version": 1,
  "target": {
    "type": "clear_dir",
    "path": "%LOCALAPPDATA%/Vendor/App/Cache",
    "skipIfInUse": true
  }
}
```

2. 校验：`pnpm exec tsx scripts/audit-rules.ts`（结构错误、死目标、重复、被策略拦截都会报出来）；
3. 重启应用或热重载 `rule-pack`，界面上出现新的清理项。

注意事项：

- `clear_dir` 表示**清空内容、保留目录**；要删目录本身用 `delete_dir`；
- 位于受保护目录内部的目标（如 `C:\Windows\System32\LogFiles`）请用 `clear_dir`，
  规则包会自动登记"清空白名单"，目录本身仍然不可删；
- 高风险清理（浏览器 Cookie/密码、用户文档下的内容）请放到 `risky` 分类，
  它默认不装载，需要 `settings.rules.includeRisky = true`；
- 只想在"深度模式"生效的规则加 `"deepOnly": true`。
