# CordClean 架构设计说明

> 本文档对应论文第 3 章（系统设计）与第 4 章（系统实现），包含分层结构、Cordis 的具体用法、
> 关键流程、安全模型与工程折中。所有结论均可在源码中找到对应实现。
>
> 事实基准：11 个内置插件（8 个默认启用）、默认 38 个清理任务、55 个 RPC 方法、
> 49 个测试文件 / 365 个用例、规则库 catalog 28 类/271 条 + extra 9 类/130 条。
> 安全边界与残余风险另见 [威胁模型与信任边界](threat-model.md)。

## 1. 设计目标与约束

| 目标 | 约束 / 落地方式 |
| --- | --- |
| G1 可扩展：新增清理能力不应改动内核 | 清理能力 = 独立 npm 包，通过 `ctx.cleaner.define()` 注册 |
| G2 可裁剪：用户能启停任意能力 | 插件管理器持久化 `enabled`，运行时 `ctx.plugin()` / `fiber.dispose()` |
| G3 可维护：每个能力独立配置、独立失败 | 每插件一个 Schemastery `Config`；加载异常被隔离为该插件 `error` 状态 |
| G4 可审计：所有删除都受同一套规则约束 | 引擎统一执行删除，路径策略 + 隔离区是唯一出口 |
| G5 端无关：桌面与浏览器共用一套实现 | 内核与界面通过 JSON-RPC 解耦，传输层可替换 |
| G6 安全优先：宁可少清理，不可误删 | 默认保守（高风险项默认不勾选、Program Files 只报告） |

**非目标**：不做跨平台（Windows 专用）、不做注册表全量扫描、不做常驻内存优化型服务。

## 2. 分层结构

```
shared（契约：纯类型/纯函数，零 Node 依赖）
  └─ utils（工具：路径、遍历、文件操作、命令、哈希）
       ├─ core（内核：Cordis 服务与引擎）
       │    └─ plugins/*（清理插件，反向只依赖 shared+utils）
       └─ host（传输：RPC 方法与 WebSocket 宿主）
            ├─ apps/web（HTTP + WS 外壳）
            └─ apps/desktop（Electron IPC 外壳）
ui（界面：只依赖 shared 的类型与 RPC 协议）
```

依赖方向严格单向，`plugins` 与 `core` 之间只有「运行时通过 ctx 拿能力」的关系，不存在 import 依赖，
这保证了 G1：**内核编译产物中不包含任何插件实现细节，插件也不 import 内核**。

> 唯一的例外是 `core/manifest.ts` 用动态 `import()` 引用插件包（懒加载），这属于「装配信息」而非「实现依赖」。

## 3. Cordis 框架的使用方式

Cordis 提供 `Context`（依赖容器 / 服务注册表）、`Service`（具名能力）、`Fiber`（插件实例的生命周期）、
`ctx.effect()`（可回收副作用）。本系统的映射关系如下：

| Cordis 概念 | 在本系统中的用法 |
| --- | --- |
| `class X extends Service` | `SettingsService`、`SystemService`、`PathPolicyService`、`QuarantineService`、`HistoryService`、`CleanerService`、`PluginManagerService`、`AiService` |
| `static inject` | 声明服务依赖顺序，如 `PathPolicy` 依赖 `['settings','system']` |
| `ctx.plugin(plugin, config)` | 插件管理器装载清理插件；内核装配时装载各服务 |
| `ctx.effect(() => dispose)` | 插件在 `setup()` 中注册清理任务、声明清理辖区；插件卸载时框架自动回收 |
| `Config`（Schemastery） | 校验插件配置，同时用于「插件配置界面」的默认值推导 |
| `fiber.update(config)` | 修改插件配置后热重载；校验失败不会破坏运行中的实例 |
| `ctx.emit / ctx.on` | 进度与状态事件：`cleaner/scan-progress`、`cleaner/clean-done`、`plugins/changed` 等 |

### 3.1 为什么不直接 `new` 服务

`new SettingsService(ctx)` 也能工作（Service 构造函数会自注册），但无法获得：
- 依赖注入检查（`ctx.settings` 未 inject 就访问会抛错，避免启动期空指针）；
- 自动回收（fiber 卸载时服务与监听一起清理）；
- 生命周期状态（`ACTIVE/PENDING/FAILED` 可用于健康检查）。

因此内核统一用 `ctx.plugin(ServiceClass, config)` 装配。

### 3.2 任务归属的「差分」技巧

插件管理器需要知道「某个清理任务是哪个插件注册的」，以便停用插件后正确归类。
让插件自报 id 会引入耦合，因此采用：

```
before = new Set(ctx.cleaner.list().map(t => t.id))
fiber  = ctx.plugin(module, config); await fiber
after  = new Set(ctx.cleaner.list().map(t => t.id))
record.taskIds = [...after].filter(id => !before.has(id))
```

代价是**插件必须顺序加载**（并发加载会互相污染差分结果），换取插件零感知。
`packages/core/src/domains/kernel/plugins.ts` 中的 `loadAll()` 因此是串行的；11 个插件顺序加载的开销
相对完整启动（162.6 ms，含服务初始化）很小，可接受。

## 4. 清理引擎设计（CleanerService）

### 4.1 任务模型

```ts
interface TaskDefinition {
  id, name, description, category, risk, icon, defaultSelected, targets, tips
  scan(ctx: TaskScanContext): Promise<CleanItemDraft[] | void> | CleanItemDraft[] | void
  clean?(items: CleanItem[], ctx: TaskCleanContext): Promise<CleanItemResult[]>   // 可选
}
```

- `scan` 负责「找出可清理项」，可流式 `ctx.emit()`，也可返回数组；
- `clean` 缺省时由引擎执行通用文件删除（受隔离区与路径策略约束），
  仅当清理对象是注册表 / 命令行等非文件对象时才由插件实现。

这个「默认实现 + 可选覆写」的设计让 90% 的文件类插件只需写 `scan`，而注册表类插件仍能实现安全备份。

### 4.2 扫描流程

```
scan(options)
 ├─ 组装任务列表（按 taskIds 过滤）
 ├─ 并发调度（settings.scan.concurrency，默认 3）
 │   └─ 每任务：
 │       ├─ 构造 TaskScanContext（signal / logger / pathPolicy / env / emit / count / addError）
 │       ├─ 调用 task.scan()
 │       └─ emit() → 规范化 → 路径策略校验 → 去重 → 入队
 ├─ 进度节流（120 ms）→ cleaner/scan-progress 事件
 └─ 汇总 ScanReport（排序、统计、错误截断 200 条）
```

关键实现细节：

1. **项规范化**：`id = sha1(taskId + path)`（FNV-1a 实现于 shared，保证浏览器与 Node 结果一致）；
   风险继承任务默认值，`protected` 由路径策略给出。
2. **去重**：以 `pathKey`（规范化+小写）为键，同一路径被多个任务发现时只保留一份并取较大体积，
   避免「重复计数」与「重复删除」。
3. **上限保护**：单任务 `maxItemsPerTask`（默认 2 万），超出标记 `truncated`；
   插件内部一般还会限制遍历条目上限。
4. **取消**：`AbortController` 贯穿 `walk` / 哈希 / 删除，取消后返回 `cancelled: true` 的半成品报告。

### 4.3 清理流程

```
clean({ items | itemIds, dryRun, forceQuarantine })
 ├─ 解析选中项（不信任界面回传，从最近一次扫描结果中按 id 查）
 ├─ 按 taskId 分组
 │   ├─ 有自定义 clean → 构造 TaskCleanContext（含 quarantineDir）
 │   └─ 无自定义 clean → deletePath() 并发池（上限 6）
 │        ├─ dryRun：只统计字节
 │        ├─ 二次策略校验（扫描→清理之间状态可能变化）
 │        ├─ risk != safe 且开启隔离区 → 移入隔离区
 │        └─ 否则 deletePath（不跟随链接、长路径、只读属性重试）
 └─ 汇总 CleanReport → 写历史（dryRun 不写）→ cleaner/clean-done
```

**为什么清理时要二次校验**：扫描与清理之间用户可能改了设置、插件配置或文件系统发生变化；
更重要的是**不信任界面回传的路径**（即使界面被篡改，也无法清理辖区外文件）。

### 4.4 通用文件删除的安全约束

`packages/utils/src/fs-ops.ts` 的 `deletePath()`：

| 情况 | 处理 |
| --- | --- |
| 符号链接 / NTFS 联接点 | 只删除链接本身（`unlink`/`rmdir`），绝不进入目标 |
| 目录 | 先 `lstat` 判断，`fs.rm({recursive})`；删除前统计字节用于报表 |
| 长路径 > 260 | 统一 `\\?\` 前缀 |
| 只读文件 | `chmod` 后重试（可配置重试次数） |
| 被占用（EBUSY/EPERM） | 抛出原始错误，引擎归类为「文件正被其它程序占用」并计入失败 |

## 5. 安全模型

### 5.1 四层防护

| 层 | 实现 | 拦截的威胁 |
| --- | --- | --- |
| 路径策略 | `PathPolicyService.check()` | 误删系统目录、越权删除（插件 bug）、驱动器根目录、尾点/短名写法绕过 |
| 链接祖先检查 | `findLinkAncestor()` + 清理引擎 | 辖区内 junction 把删除引到辖区外（越界删除） |
| 隔离区 | `QuarantineService.beginSession()` | 用户误勾选高风险项、清理后想找回 |
| 注册表备份 | 插件内 `regExport()` | 误删启动项、误删卸载项 |

### 5.2 路径策略判定顺序

```
check(path):
  1. 空路径 / 非绝对路径                → 拒绝
  2. 驱动器根目录（C:\）                → 拒绝（protected）
  3. 位于保护根内 / 是保护根的祖先       → 拒绝（protected，返回命中的保护根）
  4. 文件名在黑名单（pagefile.sys）      → 拒绝（name-denied）
  5. 不在任何「辖区」或用户扫描根内      → 拒绝（outside）
  6. 否则                               → 允许
```

「祖先检查」是容易遗漏的一点：如果只判断「路径是否在保护目录内」，那么删除 `C:\Windows`
这样的祖先目录仍会连带删除 `System32`。因此匹配时同时判断两个方向：

```ts
if (isUnder(root, path) || isUnder(path, root)) return root
```

### 5.3 路径规范化：三种「写法差异」绕过

字符串比较与文件系统语义并不等价，本系统针对三种写法做了规范化：

| 写法 | 文件系统语义 | 处理 |
| --- | --- | --- |
| `C:\Windows\System32.` | 忽略尾部 `.`，实际指向 `System32` | `canonicalizePath()` 逐段去掉尾部 `.`/空格 |
| `C:\PROGRA~1\...` | 8.3 短名，等价于 `Program Files` | 首次校验时解析保护目录短名并加入保护列表（模块级缓存） |
| `\\?\C:\Windows\...` | 长路径前缀 | `normalizePath()` 剥离前缀后再比较 |

### 5.4 链接祖先检查（切断越界删除）

路径策略只能判断**字符串**是否落在辖区内；若辖区目录里存在指向外部的联接点，
`辖区\link\file` 仍然「字符串合法」，但删除会命中真实外部文件。因此在删除前增加一道检查：

```
cleanOne(item):
  ...
  const link = await findLinkAncestor(item.path, policy.rootOf(item.path))
  if (link) return fail('路径包含联接点或符号链接，已拒绝')
```

`findLinkAncestor` 从父目录向上 lstat 到辖区根，命中链接即返回；
结果按「父目录 + 辖区」缓存，同一目录下的文件只需检查一次（实测不影响删除吞吐）。

### 5.5 辖区（allowRoot）机制的意义

传统清理工具的安全检查是「黑名单」：只要不在黑名单就允许删。本系统改为「白名单」：
插件必须在 `apply` 阶段声明「我只会清这些目录」，否则连自己扫描出来的文件也删不掉。

```ts
ctx.effect(() => {
  const disposers = sources().map(s => ctx.pathPolicy.addRoot(s.path, 'temp'))
  return () => disposers.forEach(d => d())      // 插件卸载时自动撤销辖区
})
```

好处：即使某个插件被恶意替换或写错路径，也只能影响它声明过的目录；且辖区随插件生命周期自动回收。

### 5.6 路径策略的性能设计

校验是万级 QPS 的热路径，最初实现为 166 µs/次，成为扫描瓶颈（详见 [缺陷记录](defect-log.md) D-10）。
优化后为 10.4 µs/次，做法有三点：

1. **前缀树**：保护目录按路径段建树，匹配复杂度从 O(N)（N=保护根数量）降到 O(路径深度≈5)；
2. **热状态对象**：Cordis 服务实例是代理，方法内每次 `this.x` 都有拦截开销（≈4 µs/次），
   因此把 `check()` 等热路径抽成「纯对象 + 模块级函数」，类方法只做一次委托；
3. **去掉重复读取**：设置里的自定义扫描根缓存为数组，订阅 `settings.onChange` 刷新；
   引擎在一次扫描/清理开始时缓存服务引用，而不是每项取一次。

## 6. 传输层与外壳

### 6.1 为什么用 JSON-RPC 而不是 Electron IPC 直连

若界面直接依赖 `ipcRenderer`，则无法在浏览器中运行，也无法用 `curl` 调试。
因此定义一层最小协议（`packages/shared/src/rpc.ts`）：

```ts
{ jsonrpc: '2.0', id, method, params }          // 请求
{ jsonrpc: '2.0', id, result | error }          // 响应
{ jsonrpc: '2.0', method, params }              // 事件通知（无 id）
```

服务端事件与内核事件一一映射（`scan/progress`、`clean/done`、`plugins/changed` …），
界面侧 `ApiTransport` 接口只有 `request()` 与 `on()` 两个方法，两种外壳各自实现即可。

### 6.2 双外壳对比

| | Web 外壳 | Electron 外壳 |
| --- | --- | --- |
| 传输 | WebSocket（`ws://127.0.0.1:7801/rpc`） | `ipcRenderer.invoke` + `webContents.send` |
| 鉴权 | 启动时 CSPRNG 随机 token（注入 `window.__CORDCLEAN__`），并校验 token + Host + Origin | 进程内 IPC，无需 token |
| 静态资源 | 由 `server.ts` 提供（带 SPA 回退） | `loadFile()` 加载本地构建产物 |
| 调试 | 浏览器 DevTools、`curl /api/rpc` | Electron DevTools |
| 打包 | 单进程 Node 服务 | 主进程 + 渲染进程 |

两者共用 `createHandlers()` 与同一份界面代码，差异只在 `ShellAdapter`（打开文件/目录的实现）。

### 6.3 安全考虑

- Web 外壳只监听 `127.0.0.1`，每次启动用 `crypto.randomBytes` 生成 CSPRNG 随机 token 并注入页面；
  `/api/rpc` 与 WebSocket 升级均校验 token，防止本机其它网页（CSRF/CSWSH）调用高权限清理接口；
- 所有 HTTP 请求先校验 **Host** 头（只允许 `127.0.0.1` / `localhost` / `[::1]`），阻断 **DNS rebinding**；
  WebSocket 额外校验 **Origin** 必须等于界面自身 origin（无 Origin 的原生客户端放行）；
- 畸形 URL/非法百分号编码返回 400 而不是抛未捕获异常；WebSocket `maxPayload` 限制 1 MB；
  静态资源保留「目录 + 分隔符」边界校验（修复前缀误判）；
- 桌面外壳用 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，preload 只暴露最小 IPC；
  禁止新窗口（`setWindowOpenHandler` → deny）、拦截非白名单导航，界面 `index.html` 带 CSP；
- `app/open-path` 改用 `explorer` 参数数组（不经 shell），消除路径拼接导致的命令注入面；
- 外部插件不获得清空白名单（`addClearRoot`），`targets` 必须落在能力声明的 `fsRoots` 内，
  仅白名单环境变量经 `workerData.env` 暴露给插件上下文。

> 完整威胁模型（谁在防谁、插件信任模型、TOCTOU 等残余风险）见 [威胁模型与信任边界](threat-model.md)。

### 6.4 插件信任边界（如实说明）

- **内置插件 = 可信代码**：与内核同进程，安全依赖路径策略/补偿链等约定，而非沙箱；
- **外部插件**：worker 只提供**故障隔离**（崩溃/超时不影响主线程），不是安全沙箱 ——
  插件仍可访问文件系统、`process.env` 与 `child_process`；能力声明只是安装时静态校验，运行时并不强制；
  安装外部插件等同于允许其执行本机代码，界面会给出风险警告；
- 因此本系统的安全目标是「能力收窄 + 故障隔离 + 风险提示 + 删除链唯一入口」，不是「不可信插件沙箱」。

## 7. 界面实现

- Vue 3 `<script setup>` + 轻量响应式 store（`packages/ui/src/api/store.ts`），不引入 Pinia；
- 数据流单向：RPC 请求 → store → 视图；进度靠事件推送更新，不做轮询；
- 页面：概览 / 清理 / 插件 / 历史与隔离区 / AI 建议 / 设置；
- 结果表格分页（默认 100 条/页，可选 200/500）以避免上万行渲染卡顿；分组总览按「分类 → 任务」聚合，只渲染任务级行；
- 通过 URL hash 同步页面，便于深链接与自动化截图。

## 8. 性能优化点

| 优化 | 位置 | 效果 |
| --- | --- | --- |
| 目录内批量并发 `lstat`（默认 24） | `utils/walk.ts` | 4000 文件遍历 0.15 s（含校验） |
| 路径策略前缀树 + 热状态对象 | `core/domains/safety/path-policy.ts` | 单次校验 166 µs → **10.4 µs** |
| 服务引用按会话缓存 | `core/domains/engine/cleaner.ts` | 避免每项都经 Cordis 代理取服务（省 ≈10 µs/项） |
| 链接祖先检查按目录缓存 | `core/domains/engine/cleaner.ts` | 同目录文件只检查一次，避免重复 lstat（删除吞吐见性能基准） |
| 8.3 短名懒解析 + 模块级缓存 | `core/short-names.ts` | 每次启动不再付 35 ms；多实例复用结果 |
| 任务级并发（默认 3） | `core/domains/engine/cleaner.ts` | 38 个任务并行调度，完整扫描耗时见性能基准 |
| 进度事件 120 ms 节流 | `core/domains/engine/cleaner.ts` | 避免 IPC/WS 洪泛 |
| 插件懒加载（`import()`） | `core/manifest.ts` | 启动只加载启用的插件 |
| 重复文件三级筛选 | `plugins/duplicates` | 只对同尺寸+同前缀文件做全量哈希，实测 366 MB/s |
| 删除并发池（上限 6） | `core/domains/engine/cleaner.ts` | 2 178 文件/秒（4000 个文件 1.84 s） |
| 系统信息缓存（5 s / 10 s / 60 s） | `core/domains/engine/system.ts` | 界面刷新不重复探测磁盘 |

> 性能数字均在 `pnpm bench` 中可复现，原始表格见 [性能基准](benchmark.md)。
> 其中「路径策略」一项是自测阶段发现并优化的（详见 [缺陷记录](defect-log.md) D-10）。

## 9. 测试策略

| 层次 | 方式 | 覆盖 |
| --- | --- | --- |
| 单元 / 集成 | Vitest（48 个文件、**365 个用例**） | 路径策略与攻击面、文件系统安全、长路径/UNC、引擎、插件管理、外部插件边界、隔离区、设置/历史、Host/Origin 鉴权、RPC、AI、规则纯逻辑 |
| 插件审计 | `scripts/audit-plugins.ts` | 11 个内置插件真实扫描 + 清理项契约不变量（只读） |
| 插件自测 | `scripts/check-*.ts` | 现有插件的定向验证（只扫描，清理只用 dryRun） |
| 冒烟 | `scripts/smoke.ts` | 内核启动 + 全插件加载 + 扫描 |
| 端到端 | `scripts/e2e-ui.mjs` | 启动真实 Electron，CDP 点击 6 个页面、触发真实扫描、收集 JS 异常 |
| 性能 | `bench/scan.bench.ts` | 启动/扫描/删除/隔离/哈希/内存 |

安全类用例（`path-attack`、`fs-safety`、`paths-normalize`、`host-server`、`batch1-hardening`）覆盖：
尾点/尾空格、`..`、正斜杠与混合分隔符、`\\?\` 长路径前缀、UNC/设备路径 fail-closed、8.3 短名、
大小写混写、前缀相同的兄弟目录、辖区内 junction 穿透、Host/DNS rebinding、Origin 跨站、
畸形 URL、设置原型污染、`addClearRoot` 边界。

AI 插件的测试使用本地 HTTP Mock：验证请求体（隐私约束：不含路径与文件名）、
JSON 解析（含 ```json 围栏）、字段兜底（风险值非法时降级为 caution）、
接口 500、超时、非 JSON 输出、环境变量凭据。

自测阶段与批次1 安全加固共发现并修复 **29 个缺陷**（D-01~D-17 自测阶段，D-18~D-29 批次1），
记录在 [缺陷记录](defect-log.md)。其中 D-01（越界删除）、D-10（路径校验性能）、
D-19（DNS rebinding/Origin）与 D-26（清空白名单放大）具有代表性，可作为论文第 6 章
「测试发现的问题与改进」的素材。

## 10. AI 插件设计（接口可演进）

大模型接口是本系统里**变化最快**的外部依赖：DeepSeek 在 2026 年把 `deepseek-chat`
换成了 `deepseek-flash`，新增了思考模式开关（`thinking`）与推理等级（`reasoning_effort`），
并同时提供 OpenAI / Anthropic / Responses 三套兼容接口。
如果把这些写死在插件里，接口一改就得重新发版。

因此 AI 插件按「**稳定的业务逻辑 + 可替换的适配层 + 用户可改的配置**」三层来设计：

```
service.ts      业务：取画像 → 发请求 → 解析建议（不含任何厂商字段名）
  ├─ adapters.ts  形态适配：chat / messages / responses 的请求组装与响应解析
  ├─ http.ts      传输：超时、429/5xx 退避重试、错误归类（AUTH/RATE_LIMIT/TIMEOUT…）
  ├─ models.ts    模型发现：/models 动态拉取 + 内置目录兜底
  └─ config.ts    配置与参数映射：effort/jsonMode/paths/extraBody/extraHeaders
```

### 10.1 三种接口形态的字段映射

| 能力 | chat（OpenAI Chat） | messages（Anthropic） | responses（OpenAI Responses） |
| --- | --- | --- | --- |
| 端点 | `POST /chat/completions` | `POST /anthropic/v1/messages` | `POST /responses` |
| 鉴权 | `Authorization: Bearer` | `x-api-key` + `anthropic-version` | `Authorization: Bearer` |
| 系统提示 | `messages[0].role=system` | `system` 字段 | `instructions` |
| 输出上限 | `max_tokens` | `max_tokens` | `max_output_tokens` |
| JSON 输出 | `response_format:{type:'json_object'}` | 无原生支持 → 追加提示词 | `text.format:{type:'json_object'}` |
| 关闭思考 | `thinking:{type:'disabled'}` | `thinking:{type:'disabled'}` | `reasoning:{effort:'none'}` |
| 推理等级 | `reasoning_effort:low/high/max` | `output_config:{effort:...}` | `reasoning:{effort:...}` |
| 取文本 | `choices[0].message.content` | `content[].text`（拼 `type='text'`） | `output[].content[].text`（`type='output_text'`） |
| 取思维链 | `message.reasoning_content` | `content[].thinking` | `output[].content[].text`（`type='reasoning_text'`） |
| token 用量 | `usage.prompt_tokens/completion_tokens` | `usage.input_tokens/output_tokens` | `usage.input_tokens/output_tokens` |

`reasoningEffort` 在插件里抽象为 `auto/off/low/medium/high/max`（`medium` 映射为 `high`），
由 `applyEffort()` 按形态翻译成上表的具体字段 —— 换模型/换接口时业务代码不变。

### 10.2 配置即扩展点

| 变更类型 | 用户怎么做 | 需要改代码吗 |
| --- | --- | --- |
| 模型改名/新增模型 | 界面「获取模型」下拉选，或直接输入模型名 | 否 |
| 新增请求参数（如新的推理字段、缓存、工具） | 写进 `extraBody`（深合并、优先级最高） | 否 |
| 换网关/代理/自定义鉴权 | 改 `baseUrl` / `chatPath` / `extraHeaders` | 否 |
| 提示词调整 | 改 `systemPrompt` | 否 |
| 出现第四种接口形态 | 在 `adapters.ts` 增加一个分支（约 40 行） | 是 |

`extraBody` 的优先级高于插件生成的所有字段，因此厂商即使修改了默认行为，
用户也能在界面上直接覆盖，不需要等新版本。

### 10.3 模型发现与探测

- `GET {baseUrl}/models` 解析 `context_window`、`max_output_tokens`、`input_modalities`、
  `effort.supported_levels` 等能力信息；失败时回落到内置目录（保证离线可用）。
- `probe()` 发一条最小请求（“回复 OK”），返回 HTTP 状态、耗时、模型原文，
  用于快速定位「Key 错 / 地址错 / 模型名错 / 参数不兼容」。
- 实测（2026-10，`deepseek-flash`）：probe 约 140~350 ms；
  完整分析 `effort=high` 约 7~8 s（输出 ~1370 token，其中思维链 ~850），
  `effort=off` 约 4 s（无思维链）—— 关闭思考能省一半时间，适合交互式场景。

### 10.4 两个实测踩到的坑

1. **`messages` 形态的路径拼接**：其 `baseUrl` 必须是 `.../anthropic`，
   但用户通常只填 `https://api.deepseek.com`，直接拼默认路径会得到
   `.../anthropic/anthropic/v1/messages` → 404。现在 `resolveChatUrl()`
   会把默认路径 `/v1/messages` 与缺省的 `/anthropic` 前缀自动对齐。
2. **延迟计时点**：非流式响应可能先回响应头、后回 body，
   若在 `fetch` 返回时计时，会把 8 秒的生成过程显示成 0.2 秒。
   `requestJson()` 改为读完 `response.text()` 再计时。

## 11. 规则库：让内容与代码分离

清理工具的规则会持续增长（新软件、新版本、新缓存目录），如果每个清理域都要写一个插件，
`src/plugins/` 迟早会变成第二个"规则地狱"。因此本系统在插件层之上再引入一层**规则库**：

```
catalog.json / 用户规则（数据）
        │  规则包插件 rule-pack 读取并校验
        ▼
  ctx.rules.register(ctx, rules)     ← 登记即副作用，归属规则包 fiber
        │  一个分类 = 一个清理任务（rule:<category>）
        ▼
  scan(rule) → 候选（clear_dir / glob / find_dirs …）
        │
        ▼
  ctx.evaluator.evaluate(candidates) → risk / suggest / reason
        │
        ▼
  内核：路径策略 → 清理引擎（清空/删除）
```

### 11.1 数据模型

一条规则由「分类 + 目标 + 风险 + 来源」组成，目标支持 **7 种全部已实现**的类型：

| 类型 | 语义 | 典型用法 |
| --- | --- | --- |
| `clear_dir` | 清空目录内容、保留目录 | `%TEMP%`、Chrome `Cache` |
| `delete_dir` | 删除目录本身 | 已知可整体删除的缓存目录 |
| `glob_files` | 按模式匹配文件 | `thumbcache_*.db` |
| `glob_dirs` | 按模式匹配目录 | `net_*`（微信多实例） |
| `files_by_rule` | 按大小/年龄筛选 | Downloads 中 180 天前的大文件 |
| `find_dirs` | 按目录名递归查找 | 散落的 `node_modules`/`dist` |
| `compact_db` | SQLite 数据库压缩（VACUUM，不删数据） | 浏览器 History/Favicons |

条件字段：`olderThanDays`、`minSizeMb`、`maxDepth`、`excludeDirs`、`deepOnly`、
`skipIfInUse`、`requiresAdmin`、`paths`/`bases`（多候选）。

### 11.2 安全上的三个决定

1. **辖区照旧**：规则包在 `setup` 里把每条规则的根目录登记进路径策略，
   未登记的路径内核仍然拒绝——规则是"申请"，不是"授权"；
2. **清空白名单**：`C:\Windows\System32\LogFiles` 这类目录受保护但内容可重建，
   用 `addClearRoot()` 只放行"清空内容"，目录本身仍不可删；
3. **默认收紧**：高风险分类（浏览器密码/Cookie、Windows.old、Downloads 大文件）
   与 `deep_only` 规则默认不装载，需在设置里显式打开。

### 11.3 与论文 v4.0 的对应

| 论文设计 | 本实现 |
| --- | --- |
| 5.2 规则契约（CleanRule/ScanTarget） | `packages/shared/src/rules.ts` |
| 6.2.1 规则注册归属申请者 | `ctx.rules.register(scope, rules)`，`scope.effect()` 注销 |
| 5.4 可替换评估器 | `ctx.evaluator`（heuristic 默认，可注册 AI 适配器） |
| 场景插件登记规则 | `rule-pack` 按分类登记规则并生成任务 |
| 新增清理域零改动 | 加一段 JSON 即可，内核/插件代码不变 |

### 11.4 已导入规模

从 PC-Cleaner `rules.json` 转换并扩充：`catalog.json` 为 **28 个分类 / 271 条规则 / 284 个候选根目录**，
`extra.json` 为 9 个分类 / 130 条规则，两套合计 37 类 / 401 条 / 414 个候选根（同一目标可能被多个分类引用）。
7 种目标类型全部已实现，**不存在“未实现类型”**；`scripts/audit-rules.ts` 目前只审计 `catalog.json`
（报告见 [规则库审计报告](rules-report.md)）。默认装载非高风险、非 `deepOnly` 的规则，约 31 个分类 / 312 条规则。

## 12. 补偿链与唯一删除入口

删除不可回滚，框架的 effect 也救不了"已经删掉的文件"。因此本系统把删除前的检查
显式化为一条**补偿链**，并让执行器只接受过链令牌：

```
清理项 ──► compensate.issue()：①规范化 ②黑名单 ③白名单 ④条件/链接 ⑤预览一致性 ⑥预算 ⑦回收站
                              │ 通过 → CleanTicket（私有 brand，外部无法伪造）
                              ▼
                        executor.execute(ticket)
                              │ 逐项复核，不信任令牌内容
                              ├─ recycle   → PowerShell 批量 SendToRecycleBin
                              ├─ quarantine→ 隔离区（可恢复）
                              ├─ delete    → 永久删除
                              └─ compact   → SQLite VACUUM（不删数据）
```

### 12.1 七步链的判定

| 步骤 | 做了什么 | 失败结果 |
| --- | --- | --- |
| ① 规范化 | `normalizePath` + `canonicalizePath`，拒绝相对路径/盘符根 | `normalize` 拒绝 |
| ② 黑名单 | 路径策略（前缀树）判定受保护目录 | `protected` 拒绝 |
| ③ 白名单 | 必须命中插件登记的辖区；`action=clear` 走清空白名单 | `outside` 拒绝 |
| ④ 条件 | 只处理文件/目录；链接祖先检查阻断 junction 穿透；文件占用探测 | `in-use` / `protected` |
| ⑤ 预览一致性 | 文件大小与扫描时不一致 → 跳过；不一致比例 > 5% → 整批中止 | `changed` / `changed-ratio` |
| ⑥ 预算 | 单次 ≤ 5 万项 / 20 GB（可配置） | `budget` 整批拒绝 |
| ⑦ 回收站 | 按卷探测 `$Recycle.Bin`；不可用且允许回落 → 逐项改走隔离区 | `recycle-unavailable` |

令牌是模块私有 `Symbol` 标记的类实例：`isCleanTicket()` 做运行期身份校验，
类型标注挡不住 `any`，所以执行器在每次执行前还会逐项 `recheck()`（规范化 + 策略 + 存在性）。

### 12.2 诚实计量

| 指标 | 含义 | 计量方式 |
| --- | --- | --- |
| `freedBytes` | 真正从磁盘消失的字节 | 永久删除/清空后按实际删除量；VACUUM 按前后文件大小差 |
| `recycledBytes` | 进了回收站的字节 | 回收站回执成功的项按扫描体积累计（不虚报为释放） |
| `quarantinedBytes` | 进了隔离区的字节 | 隔离区移动成功的项 |
| `vanished` | 扫描后已不存在的项 | `stat` 失败，单独计数，不计入释放 |
| `skipped` | 条件不满足/预览变化被跳过的项 | 结构化拒绝原因 |

这解决了旧实现"用扫描体积当释放量"的虚报问题，也让界面能说清楚
"这 3 GB 是进了回收站，还是真的释放了"。

### 12.3 与论文 v4.0 的对应

| 论文 | 本实现 |
| --- | --- |
| 表 5-2 补偿链七步 | `packages/core/src/domains/safety/compensate.ts` |
| 令牌化唯一入口 | `CleanTicket` + `isCleanTicket()` + `executor.recheck()` |
| 回收站批量执行 | `domains/safety/recycle-bin.ts`（JSON 清单 + PowerShell 批量 + 逐项回执） |
| 诚实计量 | `CleanReport.recycledBytes / quarantinedBytes / vanished / skipped` |
| 高风险进隔离区 | `settings.clean.highRiskQuarantine`，引擎按风险拆两批执行 |
## 13. 工程折中与反思

1. **顺序加载插件**：为换取任务归属的零侵入，牺牲了并行加载速度（实测差异 < 20 ms，可接受）；
2. **不引入 ORM/数据库**：历史用 JSONL 追加写，隔离区用目录 + manifest，简单且可人工修复；
3. **保守策略**：`Program Files` 残留只报告不删除，牺牲一部分清理收益换取安全；
4. **AI 只做建议不做执行**：模型输出不直接触发删除，必须由用户勾选，避免「幻觉导致误删」；
5. **未做插件市场**：目前插件为内置包，`PluginManifestEntry` 已预留 `source: 'external'` 字段，
   后续可通过扫描插件目录加载第三方包（需配合签名校验）。
