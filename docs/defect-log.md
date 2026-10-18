# 缺陷记录与修复（自测阶段）

> 本文档记录「主动自测」阶段发现并修复的问题，可作为论文第 6 章「系统测试」中
> 「测试发现的问题与改进」小节，也可用于答辩时说明工程严谨性。
>
> 测试方式：109 个自动化用例 + 11 个插件自测脚本 + 13 个真实插件扫描审计 + Electron 端到端点检 + 性能基准。
> **所有会删除文件的测试都在临时沙箱中进行，未触碰真实用户数据。**

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
扫描吞吐 4526 → **33 551 文件/秒**（4000 个文件 0.12 s）；
删除吞吐 2331 → **6616 文件/秒**。回归：全部 109 个用例通过。

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

## 未修复但已知的限制

| 限制 | 说明 |
| --- | --- |
| 预扫描结果不持久化 | 重启应用后需重新扫描才能看到结果（报告体积可能上万条，未落盘） |
| 计划任务不支持禁用 | `startup` 插件只报告，避免误操作系统任务 |
| `Program Files` 残留只提示 | `leftovers` 插件的目录类残留默认不可删除（保守策略） |
| 8.3 短名解析依赖 cmd.exe | 极端精简系统可能失败，失败时静默降级（仅少一层保护） |
| 未做代码签名 / 安装包 | 需 electron-builder 与证书，属于发布环节 |

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
