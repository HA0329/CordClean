# 缺陷记录与修复（自测阶段）

> 本文档记录「主动自测」阶段发现并修复的问题，可作为论文第 6 章「系统测试」中
> 「测试发现的问题与改进」小节，也可用于答辩时说明工程严谨性。
>
> 测试方式：346 个自动化用例（44 个文件）+ 现有插件自测脚本 + 11 个真实插件扫描审计 + Electron 端到端点检 + 性能基准。
> **所有会删除文件的测试都在临时沙箱中进行，未触碰真实用户数据。**
>
> 编号约定：D-01~D-17 为自测阶段（含 AI 接口联调）发现的问题；D-18~D-29 为批次1 安全与正确性加固新增。
> 安全边界与残余风险见 [威胁模型与信任边界](threat-model.md)。

## 汇总

| 编号 | 严重级别 | 问题 | 状态 |
| --- | --- | --- | --- |
| D-01 | 🔴 高（数据安全） | 辖区内 NTFS 联接点可导致删除穿透到辖区外 | 已修复 |
| D-02 | 🟠 中（稳定性） | 异步插件 `setup` 拒绝后变成「未处理的 Promise 拒绝」，Node 24 下可能终止进程 | 已修复 |
| D-03 | 🟠 中（状态污染） | 默认设置对象被就地修改，一次范围校正会永久改写进程内默认值 | 已修复 |
| D-04 | 🟡 中（传输安全） | 静态资源目录穿越校验存在前缀误判（`C:\ui` 与 `C:\ui-evil`） | 已修复 |
| D-05 | 🟡 中（可用性） | 超过 2 MB 的请求体导致连接被重置，客户端看不到错误 | 已修复 |
| D-06 | 🟢 低（体验） | 注册表/命令类清理项报错信息错误（提示"路径被保护"而非"需插件自定义清理"） | 已修复 |
| D-07 | 🟡 中（误判） | 注册表插件把 `SystemComponent` 登记与 Edge Update 误判为垃圾键 | 已修复 |
| D-08 | 🟢 低（统计） | 同一清理项重复提交时 `cleaned` 计数翻倍 | 已修复 |
| D-09 | 🟡 中（健壮性） | 插件配置更新未预校验，非法配置会把运行中的插件打成 error | 已修复 |
| D-10 | 🟠 中（性能） | 单次路径校验 166 µs，扫描吞吐仅 4.5k 文件/秒 | 已修复（→ 10 µs、33k 文件/秒） |
| D-11 | 🟡 中（安全加固） | 尾点（`System32.`）与 8.3 短名（`PROGRA~1`）可绕过字符串比较 | 已修复 |
| D-12 | 🟡 中（功能） | Anthropic 兼容形态路径拼接错误导致 404 | 已修复 |
| D-13 | 🟢 低（体验） | 延迟计时只算到响应头，8 秒显示成 0.2 秒 | 已修复 |
| D-14 | 🟡 中（兼容） | 旧配置字段被 schema 丢弃，兼容映射失效 | 已修复 |
| D-15 | 🟠 中（正确性） | 清空目录被「预览一致性」误判为已变化而全部跳过 | 已修复 |
| D-16 | 🟠 中（安全/行为） | `clear` / `compact` 动作误走回收站 | 已修复 |
| D-17 | 🟡 中（正确性） | 回收站回执 JSON 序列化失败，界面显示全部失败 | 已修复 |
| D-18 | 🟡 中（可用性） | 未认证的畸形 URL 百分号编码抛未捕获异常，可打崩/扰乱 Web 外壳 | 已修复 |
| D-19 | 🔴 高（传输安全） | 本地服务缺少 Host/Origin 校验，可被 DNS rebinding / 跨站页面调用 | 已修复 |
| D-20 | 🔴 高（信任边界） | `clean/start` 接受界面回传的任意 items，绕过扫描结果 | 已修复 |
| D-21 | 🔴 高（安全） | `settings` 可原型链污染 / 未知段无校验 / null 段导致异常 | 已修复 |
| D-22 | 🟠 中（正确性） | 清理会话异常/取消时不收尾、多任务重复登记、旧扫描覆盖新结果 | 已修复 |
| D-23 | 🟡 中（可恢复性） | 撤销凭据误报/误清：回收站项不可恢复却显示可撤销，部分失败也清凭据 | 已修复 |
| D-24 | 🔴 高（安全） | scheduler 授权未绑定任务范围/模式，`revoke` 未清空多计划授权 | 已修复 |
| D-25 | 🔴 高（注入） | 浏览器外壳 `open-path` 经 `cmd /c start` 拼接路径，存在命令注入面 | 已修复 |
| D-26 | 🔴 高（安全） | `addClearRoot` 可登记盘符根/保护根祖先，放大清空范围 | 已修复 |
| D-27 | 🟠 中（正确性/安全） | 长路径 `\\?\` 与 UNC/设备路径规范化顺序错误，可能误判 | 已修复 |
| D-28 | 🟢 低（可解释性） | rule-pack 对普通缓存目录输出「位于受保护目录」误导说明 | 已修复 |
| D-29 | 🔴 高（插件边界） | 外部插件自动获得清空白名单、`targets` 未校验能力声明、env 全量暴露 | 已修复 |

## 详细说明

### D-01 联接点穿越导致越界删除（高）

**现象**：若某个「清理辖区」目录里存在一个 NTFS 联接点（junction）指向外部目录，
插件上报的 `辖区\link\file.txt` 能通过路径策略（字符串在辖区内），
随后 `deletePath` 会沿着链接删除**辖区外**的真实文件。

**复现**：`tests/path-attack.test.ts` →「辖区内的 junction 不能把删除引到辖区外」

**根因**：路径策略只做**字符串**比较，没有考虑文件系统的链接语义；
`walk()` 虽然跳过链接，但插件仍可能直接上报带链接的路径。

**修复**：`packages/utils/src/fs-ops.ts` 新增 `findLinkAncestor()`，
在 `CleanerService.cleanOne()` 删除前从父目录向上检查到辖区根，遇链接即拒绝；
并按「父目录 + 辖区」缓存结果，避免每个文件重复 lstat。

**验证**：外部文件保持完好，报告失败原因为「路径包含联接点或符号链接，已拒绝」。

### D-02 异步插件启动失败导致未处理拒绝

**现象**：插件 `setup` 返回被拒绝的 Promise 时，Vitest 报 unhandled rejection；
Node 24 默认会把未处理拒绝当作致命错误，可能直接退出进程。

**根因**：`defineCleanerPlugin` 的 `apply` 没有把 `setup` 的返回值交还 Cordis，
Promise 变成悬空对象，Cordis 无法把它归类为「插件启动失败」。

**修复**：`apply` 改为 `return options.setup(ctx, config)`，
由 Cordis 的 Fiber 接管：拒绝 → 插件进入 `error` 状态，且不再有未处理拒绝。

**验证**：`tests/plugins-robust.test.ts` →「异步启动失败被捕获为 error 状态」。

### D-03 默认设置被就地修改（状态污染）

**现象**：先在一个实例里把 `scan.concurrency` 写成非法值（被校正为 1），
再新建一个使用全新数据目录的实例，其默认值竟然也是 1。

**根因**：`deepMerge(DEFAULT_SETTINGS, stored)` 只做浅拷贝，
嵌套对象仍与模块级 `DEFAULT_SETTINGS` 共享引用，随后 `sanitize()` **就地**改写，
等于把本次校正结果写进了全局默认值。

**修复**：`load()` 从 `structuredClone(DEFAULT_SETTINGS)` 出发合并；
新增 `cloneSettings()` 并在注释中写明原因。

**验证**：`tests/state.test.ts` →「配置文件损坏时自动备份并回退默认值」。

### D-04 静态资源目录穿越校验前缀误判

**现象**：`resolved.startsWith(normalize(staticDir))` 这种写法，
当静态目录是 `...\ui`、攻击路径落到 `...\ui-evil\...` 时会被误判为「在目录内」。

**修复**：改为「等于 base，或以 `base + path.sep` 开头」的边界判断。

**验证**：`tests/rpc.test.ts` →「编码后的目录穿越无法读取到 dist 之外的文件」
（`/..%2fpackage.json`、`/%2e%2e%2f%2e%2e%2fWindows/win.ini` 均返回 403）。

### D-05 超大请求体导致连接重置

**现象**：发送 3 MB 的 JSON-RPC 请求，客户端收到 `ECONNRESET` 而不是错误响应。

**根因**：超限时 `req.destroy()` 直接断开连接，响应还没写出去。

**修复**：超限后停止缓存但继续排空数据，`end` 时返回 **413** +
`{"error":"请求体过大（上限 2048 KB）"}`；后续请求仍可正常处理。

**验证**：`tests/rpc.test.ts` →「超过 2MB 的请求体返回 413 且连接不被重置」。

### D-06 非文件类清理项的报错信息错误

**现象**：注册表类清理项（`kind: 'registry'`）在没有自定义 `clean` 时，
失败原因显示「路径被策略保护（outside）」，容易误导用户。

**修复**：把「类型检查」提前到路径校验之前，返回
「该类型需要插件自定义清理逻辑」。

**验证**：`tests/engine-robust.test.ts` →「未实现 clean 的非文件类清理项会被拒绝」。

### D-07 注册表垃圾键误判

**现象**：审计发现 3 个被标记为「无效卸载项」的键，实际都是合法登记：
`Connection Manager`（只有 `SystemComponent=1`）与
`Microsoft Edge Update`（`NoModify/NoRepair/DisplayVersion/Version`）。
删除它们会破坏系统组件/更新器的卸载登记。

**修复**：改为保守判定 `isJunkUninstall()`：
只有「完全空键」或「值 ≤ 3 且不含任何有效标识字段
（DisplayName / UninstallString / DisplayVersion / SystemComponent 等）」才算垃圾键。

**验证**：`tests/plugin-rules.test.ts`（6 个用例）；真实环境扫描从 3 项误报降为 0 项，
同时仍能识别真正的空键。

### D-08 重复提交导致计数翻倍

**现象**：`clean({ itemIds: [x, x, x] })` 报告 `cleaned = 3`（实际只删了一个文件）。

**修复**：`clean()` 入参按 `item.id` 去重后再分组清理。

**验证**：`tests/engine-robust.test.ts` →「同一清理项被重复提交只清理一次」。

### D-09 配置更新缺少预校验

**现象**：给插件提交类型错误的配置时，Cordis 的 `fiber.update()` 抛错，
插件管理器把**运行中**的插件状态改成 `error`，但插件其实还在正常跑。

**修复**：`updateConfig()` 先用插件的 Schemastery schema 校验，
失败立即抛给调用方（界面能看到具体字段），运行中的插件不受影响；
校验通过后才写入设置并热重载。

**验证**：`tests/plugins-robust.test.ts` →「非法配置被拒绝，运行中的插件保持原状」。

### D-10 路径校验性能问题

**现象**：基准测试显示扫描吞吐从 7284 文件/秒跌到 4526 文件/秒；
微基准测得单次 `check()` 高达 **166 µs**（4000 次校验耗时 663 ms）。

**根因**（三层）：
1. 每次校验对 25 个保护目录各调用两次 `isSubPath`，而 `isSubPath` 内部又做路径规范化；
2. `rootOf()` 每次都读取 `ctx.settings` —— Cordis 服务实例是**代理对象**，
   方法内部每个 `this.x` 访问都要过一层拦截（实测约 4 µs）；
3. 8.3 短名解析放在启动阶段，每次启动都拉起 cmd.exe。

**修复**：
1. 保护目录改为**前缀树**（按路径段建树），校验复杂度从 O(N) 降为 O(路径深度)；
2. 热路径抽成「纯对象 `HotState` + 模块级函数」，类方法只做一次委托，代理开销不再进循环；
3. 清理引擎在一次扫描/清理开始时缓存 `pathPolicy` 服务引用，而不是每项取一次；
4. 短名解析改为**首次校验时懒加载** + 模块级缓存（同一进程只付一次 35 ms）。

**效果**：单次校验 166 µs → **10.4 µs**（走代理约 20 µs）；
扫描吞吐 4526 → **33 551 文件/秒**（4000 个文件 0.12 s，修复当时的基准环境）；
删除吞吐 2331 → **6616 文件/秒**（批次1 后基准环境重跑为 2 178 文件/秒，扫描 26 770 文件/秒，见 docs/benchmark.md）。回归：当前全量 346 个用例通过。

### D-11 路径写法绕过（尾点与 8.3 短名）

**现象**：`C:\Windows\System32.`（Windows 会忽略尾部点）与 `C:\PROGRA~1\...`
在字符串比较下都不等于保护目录，属于潜在绕过。

**修复**：
1. 新增 `canonicalizePath()`，逐段去掉尾部 `.` 与空格，`check()` 与 `rootOf()` 都使用规范化后的路径；
2. 启动后首次校验时解析保护目录的 8.3 短名并加入保护列表（模块级缓存）；
3. `normalizePath()` 处理 `\\?\` 前缀，避免长路径写法绕过。

**验证**：`tests/path-attack.test.ts` 覆盖 14 种写法（空路径、相对路径、盘符根、
尾点、混合分隔符、长路径前缀、短名、大小写、UNC、辖区内前缀相同目录等）。

> 以下三条是接入**真实大模型接口**联调时发现的（AI 插件 v2）。

### D-12 `messages` 形态路径拼接错误（404）

**现象**：用 Anthropic 兼容形态调用 `deepseek-flash` 时报 `404 Not Found`。
**根因**：`baseUrl` 已是 `https://api.deepseek.com/anthropic`，而默认 `chatPath`
也带 `/anthropic` 前缀，拼出 `.../anthropic/anthropic/v1/messages`。
**修复**：默认路径改为 `/v1/messages`；`resolveChatUrl()` 检测到路径以 `/v1/messages`
开头而 `baseUrl` 缺少 `/anthropic` 时自动补前缀，两种填法都可用。
**验证**：`tests/ai-shapes.test.ts` →「messages 形态：baseUrl 不带 /anthropic 时自动补全路径」；
真实接口联调脚本三种形态全部通过。

### D-13 延迟计时只算到响应头

**现象**：真实分析耗时约 8 秒，界面却显示 `0.2 s`。
**根因**：`requestJson()` 在 `fetch` 返回（拿到响应头）时就计算耗时，
而非流式补全会先回响应头、再逐步回 body，导致计时严重偏小。
**修复**：改为读完 `response.text()` 之后再计时。
**验证**：真实接口实测 `latencyMs` 从 161 ms 修正为 7 706 ms，与 wall time 一致。

### D-14 旧配置字段被 schema 丢弃，兼容映射失效

**现象**：升级到 v2 后，旧配置里的 `timeout: 5000` 不再生效，仍按默认 90 s 超时。
**根因**：插件配置在加载时会先经过 Schemastery 校验，**schema 未声明的字段会被丢弃**，
所以 `normalizeConfig()` 里的旧字段兼容逻辑永远拿不到 `timeout`。
**修复**：把 `timeout` / `max_tokens` 作为「已废弃」字段写进 schema（默认 0），
`normalizeConfig()` 在 `timeoutMs`/`maxTokens` 未设置时回落到旧字段。
**验证**：`tests/ai-robust.test.ts` →「请求超时后返回可读错误」（用旧字段 `timeout` 触发）。

### D-15 清空目录被"预览一致性"误判为已变化

**现象**：`action: clear` 的目录在清理时全部被跳过，报告"文件大小已变化（2048 → 0）"。
**根因**：`stat()` 对目录返回的 `size` 是目录项大小（通常 0），却拿它和扫描时聚合的体积比较。
**修复**：预览一致性只对 `kind === 'file'` 比较体积，目录只校验存在性。
**验证**：`tests/compensate.test.ts` 与 `tests/rules.test.ts`（清空后目录保留、内容消失）。

### D-16 clear / compact 误走回收站

**现象**：清空目录时整个目录被移入回收站；数据库压缩（VACUUM）把 `.db` 文件移进了回收站。
**根因**：补偿链按全局模式（默认 recycle）给每一项定模式，没有为"原地操作"单独分流。
**修复**：`action=clear` 与 `action=compact` 固定走原地执行（永久删除内容 / VACUUM），不进入回收站队列。
**验证**：`tests/rules.test.ts` 的 compact 用例（VACUUM 后文件仍在、空闲页变小、数据完整）。

### D-17 回收站回执 JSON 序列化失败

**现象**：回收站脚本执行后返回 "Argument types do not match"，界面显示全部失败。
**根因**：Windows PowerShell 5.1 的 `ConvertTo-Json` 无法序列化 `List<string>`（`@{ ok = @($ok) }` 把 List 当成单个对象）。
**修复**：先 `.ToArray()` 再序列化；回执路径用 `pathKey()` 归一化后匹配（兼容 8.3 短名）。
**验证**：`tests/compensate.test.ts` 的回收站回执用例 + 真实脚本手工验证。

> 以下 D-18~D-29 为批次1（HEAD `e825c21`）安全与正确性加固新增，均配有回归测试。

### D-18 畸形 URL 导致未捕获异常（可用性）

**现象**：向 Web 外壳发送 `/%` 等非法百分号编码的请求，`decodeURIComponent` 抛 `URIError` 逃逸成未处理拒绝，可能打崩/扰乱服务。
**根因**：请求目标解析与编码解码没有统一包在错误处理里，且解析使用的基准地址曾依赖未校验的 Host。
**修复**：请求目标解析改为固定基准 + `try/catch`，非法编码统一转 `HttpError(400)`；WS 升级路径同样先校验再解析。
**验证**：`tests/host-server.test.ts`「非法百分号编码返回 400，且服务器仍能继续响应请求」。

### D-19 本地服务缺少 Host/Origin 校验（DNS rebinding / 跨站调用）

**现象**：浏览器版只校验 token；本机恶意网页可通过 DNS rebinding 把自己的域名解析到 127.0.0.1 读取注入的 token，或跨站发起 WebSocket 调用高权限 RPC。
**根因**：token 能防「不知道 token 的请求」，但挡不住「能读页面/能发跨站 WS」的同机网页；缺少 Host 与 Origin 校验。
**修复**：token 改用 `crypto.randomBytes(24)`（CSPRNG）；所有 HTTP 请求校验 Host 头（只允许 `127.0.0.1`/`localhost`/`[::1]` 且端口匹配，阻断 DNS rebinding）；WS 握手校验 Origin 必须等于界面 origin（无 Origin 的原生客户端放行）；WS `maxPayload` 限制 1 MB。
**验证**：`tests/host-server.test.ts`「Host 头校验」「WebSocket 握手校验」（含 DNS rebinding 形态 Host、错误 Origin、超大消息）。

### D-20 `clean/start` 信任界面回传的清理项

**现象**：RPC 接受界面回传的 `items`（含任意 path），一旦页面被篡改/XSS，就能绕过扫描结果直接请求清理。
**根因**：早期为方便实现允许 `items` 直传，违反「不信任界面输入」原则。
**修复**：`clean/start` 只接受 `itemIds`，由内核从最近一次扫描结果按 id 解析；保留 `dryRun`/`forceQuarantine`；自定义清理仍需走补偿链令牌；zod 严格校验拒绝 `items`。
**验证**：`tests/api-flow.test.ts`「clean/start 不接受界面回传的清理项（只认 itemIds）」。

### D-21 settings 原型污染与无校验配置段

**现象**：`settings/set` 可写 `__proto__.polluted` 污染 `Object.prototype`；`settings/patch` 传入未知段或 `null` 段会写入异常配置甚至抛 `TypeError`。
**根因**：设置合并只做 `deepMerge`，没有危险键过滤、段白名单与段级自愈。
**修复**：禁止 `__proto__`/`prototype`/`constructor`；`settings/set` 只允许已知配置段；`null`/非对象段自动恢复默认值；RPC 参数补 zod 严格校验。
**验证**：`tests/batch1-hardening.test.ts`「settings 输入加固」（3 例）+ `tests/api-flow.test.ts`「settings/set 拒绝原型链路径，settings/patch 对 null 配置段自愈」。

### D-22 清理会话不收尾与旧扫描覆盖结果

**现象**：清理过程中异常/取消时历史会话不落库或状态错误；一次清理多个任务重复登记多条会话；取消后的旧扫描返回时覆盖新扫描的 `lastScan`。
**根因**：会话登记散落在正常路径；扫描结果写回缺少「当前扫描」判定。
**修复**：会话登记收敛为一次并移入 `try/finally` 收尾（含只有插件自定义清理的路径）；记录扫描 id，过期扫描结果不再覆盖最新结果。
**验证**：`tests/batch1-hardening.test.ts`「历史会话收尾」「扫描结果不得被旧扫描覆盖」。

### D-23 撤销凭据误报 / 误清

**现象**：回收站模式的清理项在界面显示为「可撤销」，但撤销接口无法真正恢复；部分隔离项恢复失败时 UI 也清空了撤销凭据，导致剩余项无法重试。
**根因**：撤销状态没有区分「隔离区可恢复」与「回收站/永久删除不可恢复」，且清凭据条件过宽。
**修复**：只有隔离项可撤销（`clean/undo-state` 的 available 仅由隔离项决定）；只有全部隔离项恢复成功后才删除 `.undo/last-clean.json`，部分失败保留并提示。
**验证**：`tests/api-flow.test.ts`「扫描 → 清理 → 历史 → 撤销状态」；`tests/undo.test.ts`。

### D-24 scheduler 授权与 revoke 未绑定范围

**现象**：定时计划的 `clean` 授权指纹只覆盖规则哈希，没有绑定 `taskIds`/`mode`/`everyMinutes`；`revoke` 只清空当前配置，`plans[]` 中其它计划仍保留授权，可能后台自动清理未授权范围。
**根因**：多计划配置引入后，授权与计划范围的绑定、撤销遍历未同步。
**修复**：授权指纹绑定 `taskIds`/`mode`/`everyMinutes`；`revoke` 同步清空 `plans[]` 中全部授权并经插件处理；未授权计划只能扫描。
**验证**：`tests/scheduler.test.ts`「撤销会清空所有计划的授权（多计划也不会漏）」等。

### D-25 浏览器外壳打开位置存在命令注入面

**现象**：`app/open-path` 以 `cmd.exe /c start "" <路径>` 打开目标，路径中的 `&`、`|`、`^` 会被 cmd 二次解析，存在命令注入/参数注入风险。
**根因**：为兼容中文与空格使用 shell 拼接。
**修复**：改用 `explorer.exe ['/select,', target]` 参数数组（不经 shell）；启动浏览器改用独立的 `openDataDir` 打开 URL。
**验证**：代码审阅 + E2E（`scripts/e2e-ui.mjs`）；该路径**暂无专门单测**，建议补一条不触发真实打开的断言测试。

### D-26 清空白名单放大保护范围

**现象**：`addClearRoot` 可登记盘符根或保护目录的祖先（如 `C:\`、`C:\Windows`），相当于把整个保护区变成「可清空内容」，外部插件可借此放大清空范围。
**根因**：早期只要路径合法就接受，未校验与保护根的关系。
**修复**：拒绝盘符根、保护根本身与保护根的祖先（会覆盖保护目录的一律拒绝）；拒绝相对路径；外部插件不再获得 `addClearRoot`。
**验证**：`tests/batch1-hardening.test.ts`「清空白名单不允许放大保护范围」；`tests/external-install.test.ts`。

### D-27 长路径 / UNC / 设备路径规范化错误

**现象**：`\\?\` 长路径、UNC（`\\server\share`）、设备路径（`\\.\`、`\\?\GLOBALROOT`）在规范化/判绝对路径时顺序错误，可能把设备路径误判为合法绝对路径，或让长路径与普通路径的 `pathKey` 不等价。
**根因**：先剥离前缀再判定的实现不完整，UNC 折叠分隔符时丢失开头双斜杠。
**修复**：重写规范化顺序：先识别 `\\?\`/`\\.\` 形态→还原/保持，再折叠重复分隔符并保留 UNC 双斜杠；无法确认的形态一律 fail-closed（不判为绝对路径）；`toLongPath` 幂等。
**验证**：`tests/paths-normalize.test.ts`（22 个用例，覆盖长路径/UNC/设备路径/尾点/超长路径/pathKey 等价）。

### D-28 rule-pack 规则说明误导（protected 误判）

**现象**：`clear` 类规则扫描普通缓存目录时，被评估器标记为受保护并输出「位于受保护目录」note，用户会误以为该目录不可清。
**根因**：rule-pack 评估 protected 时只用了 `check()`，未与引擎的 `action=clear` 语义（`checkClear` 优先、失败回退）对齐。
**修复**：抽出 `policyAllowsItem` 与引擎语义对齐；普通缓存目录 clear 不再误标 protected，note 不再输出误导说明；受保护目录仍正确标记。
**验证**：`tests/rule-pack-evaluator.test.ts`「rule-pack 扫描集成：普通缓存目录 vs 受保护目录」。

### D-29 外部插件信任边界过宽

**现象**：外部插件安装后自动获得 `addClearRoot`（清空白名单）、`targets` 未与 `capabilities.fsRoots` 对齐、插件上下文可拿到全部 `process.env`、安装时无风险提示。
**根因**：外部插件按「可信插件」路径接入，worker 隔离只做了故障隔离，没有收窄能力面。
**修复**：外部插件只登记普通辖区（`addRoot`），不再获得清空白名单；`targets` 必须落在 `capabilities.fsRoots` 内（越界任务跳过、不阻塞同插件合法任务）；仅 `PLUGIN_ENV_ALLOWLIST` 环境变量经 `workerData.env` 暴露且过滤 `*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`DEEPSEEK_*` 等；辖区随插件卸载回收；安装界面展示「执行本机代码」风险警告。
**验证**：`tests/external-install.test.ts`「target 不在 capabilities.fsRoots 内时跳过任务，且不注册清空白名单」；`tests/external-proxy.test.ts`；边界说明见 [威胁模型](threat-model.md) §3.2。

## 未修复但已知的限制

| 限制 | 说明 |
| --- | --- |
| 预扫描结果不持久化 | 重启应用后需重新扫描才能看到结果（报告体积可能上万条，未落盘） |
| 计划任务不支持禁用 | `startup` 插件只报告，避免误操作系统任务 |
| `Program Files` 残留只提示 | `leftovers` 插件的目录类残留默认不可删除（保守策略） |
| 8.3 短名解析依赖 cmd.exe | 极端精简系统可能失败，失败时静默降级（仅少一层保护） |
| 未做代码签名 / 安装包 | 需 electron-builder 与证书，属于发布环节 |
| 插件信任边界 | 内置/外部插件都不是沙箱；外部插件安装即执行代码，见 [威胁模型](threat-model.md) |
| TOCTOU / AI Key 明文 | 检查与删除之间的窗口、Key 明文存储等残余风险，见 [威胁模型](threat-model.md) §4 |
