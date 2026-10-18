# CordClean 架构设计说明

> 本文档对应论文第 3 章（系统设计）与第 4 章（系统实现），包含分层结构、Cordis 的具体用法、
> 关键流程、安全模型与工程折中。所有结论均可在源码中找到对应实现。

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
`packages/core/src/services/plugins.ts` 中的 `loadAll()` 因此是串行的，实测 13 个插件共 17.8 ms，可接受。

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

1. **前缀树**：保护目录按路径段建树，匹配复杂度从 O(N=25) 降到 O(路径深度≈5)；
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
| 鉴权 | 启动时随机 token，注入 `window.__CORDCLEAN__` | 进程内 IPC，无需 token |
| 静态资源 | 由 `server.ts` 提供（带 SPA 回退） | `loadFile()` 加载本地构建产物 |
| 调试 | 浏览器 DevTools、`curl /api/rpc` | Electron DevTools |
| 打包 | 单进程 Node 服务 | 主进程 + 渲染进程 |

两者共用 `createHandlers()` 与同一份界面代码，差异只在 `ShellAdapter`（打开文件/目录的实现）。

### 6.3 安全考虑

- Web 外壳只监听 `127.0.0.1`，并对 `/api/rpc` 与 WebSocket 升级校验 token，
  防止本机其它网页（CSRF/CSWSH）调用高权限清理接口；
- 桌面外壳用 `contextIsolation: true` + `nodeIntegration: false`，preload 只暴露最小接口。

## 7. 界面实现

- Vue 3 `<script setup>` + 轻量响应式 store（`packages/ui/src/api/store.ts`），不引入 Pinia；
- 数据流单向：RPC 请求 → store → 视图；进度靠事件推送更新，不做轮询；
- 页面：概览 / 清理 / 插件 / 历史与隔离区 / AI 建议 / 设置；
- 结果表格分页（60 条/页）以避免上万行渲染卡顿；
- 通过 URL hash 同步页面，便于深链接与自动化截图。

## 8. 性能优化点

| 优化 | 位置 | 效果 |
| --- | --- | --- |
| 目录内批量并发 `lstat`（默认 24） | `utils/walk.ts` | 4000 文件遍历 0.12 s（含校验） |
| 路径策略前缀树 + 热状态对象 | `core/services/path-policy.ts` | 单次校验 166 µs → **10.4 µs** |
| 服务引用按会话缓存 | `core/cleaner.ts` | 避免每项都经 Cordis 代理取服务（省 ≈10 µs/项） |
| 链接祖先检查按目录缓存 | `core/cleaner.ts` | 同目录文件只检查一次，删除吞吐 2331 → 6616 文件/秒 |
| 8.3 短名懒解析 + 模块级缓存 | `core/short-names.ts` | 每次启动不再付 35 ms；多实例复用结果 |
| 任务级并发（默认 3） | `core/cleaner.ts` | 全量扫描 15 个任务 6.9 s |
| 进度事件 120 ms 节流 | `core/cleaner.ts` | 避免 IPC/WS 洪泛 |
| 插件懒加载（`import()`） | `core/manifest.ts` | 启动只加载启用的插件 |
| 重复文件三级筛选 | `plugins/duplicates` | 只对同尺寸+同前缀文件做全量哈希，实测 384 MB/s |
| 删除并发池（上限 6） | `core/cleaner.ts` | 6616 文件/秒 |
| 系统信息缓存（5 s / 10 s / 60 s） | `core/services/system.ts` | 界面刷新不重复探测磁盘 |

> 性能数字均在 `pnpm bench` 中可复现，原始表格见 [性能基准](benchmark.md)。
> 其中「路径策略」一项是自测阶段发现并优化的（详见 [缺陷记录](defect-log.md) D-10）。

## 9. 测试策略

| 层次 | 方式 | 覆盖 |
| --- | --- | --- |
| 单元 / 集成 | Vitest（13 个文件、**109 个用例**） | 路径策略与攻击面、文件系统安全、引擎、插件管理、隔离区、设置/历史、RPC、AI、插件纯逻辑 |
| 插件审计 | `scripts/audit-plugins.ts` | 13 个插件真实扫描 + 清理项契约不变量（只读） |
| 插件自测 | `scripts/check-*.ts` | 11 个插件的定向验证（只扫描，清理只用 dryRun） |
| 冒烟 | `scripts/smoke.ts` | 内核启动 + 全插件加载 + 扫描 |
| 端到端 | `scripts/e2e-ui.mjs` | 启动真实 Electron，CDP 点击 6 个页面、触发真实扫描、收集 JS 异常 |
| 性能 | `bench/scan.bench.ts` | 启动/扫描/删除/隔离/哈希/内存 |

安全类用例（`path-attack`、`fs-safety`）覆盖的绕过手法：
尾点/尾空格、`..`、正斜杠与混合分隔符、`\\?\` 长路径前缀、8.3 短名、
大小写混写、UNC、前缀相同的兄弟目录、辖区内 junction 穿透。

AI 插件的测试使用本地 HTTP Mock：验证请求体（隐私约束：不含路径与文件名）、
JSON 解析（含 ```json 围栏）、字段兜底（风险值非法时降级为 caution）、
接口 500、超时、非 JSON 输出、环境变量凭据。

自测阶段发现并修复的 11 个缺陷记录在 [缺陷记录](defect-log.md)，其中 D-01（越界删除）
与 D-10（路径校验性能）具有代表性，可作为论文第 6 章「测试发现的问题与改进」的素材。

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

## 11. 工程折中与反思

1. **顺序加载插件**：为换取任务归属的零侵入，牺牲了并行加载速度（实测差异 < 20 ms，可接受）；
2. **不引入 ORM/数据库**：历史用 JSONL 追加写，隔离区用目录 + manifest，简单且可人工修复；
3. **保守策略**：`Program Files` 残留只报告不删除，牺牲一部分清理收益换取安全；
4. **AI 只做建议不做执行**：模型输出不直接触发删除，必须由用户勾选，避免「幻觉导致误删」；
5. **未做插件市场**：目前插件为内置包，`PluginManifestEntry` 已预留 `source: 'external'` 字段，
   后续可通过扫描插件目录加载第三方包（需配合签名校验）。
