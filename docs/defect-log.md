# 缺陷记录与修复（自测阶段）

> 本文档记录「主动自测」阶段发现并修复的问题，可作为论文第 6 章「系统测试」中
> 「测试发现的问题与改进」小节，也可用于答辩时说明工程严谨性。
>
> 测试方式：366 个自动化用例（51 个文件）+ 现有插件自测脚本 + 11 个真实插件扫描审计 + Electron 端到端点检 + 性能基准。
> **所有会删除文件的测试都在临时沙箱中进行，未触碰真实用户数据。**
>
> 编号约定：D-01~D-17 为自测阶段（含 AI 接口联调）发现的问题；D-18~D-29 为批次1 安全与正确性加固新增；D-30~D-34 为 v0.2.2 根据用户反馈修复的 AI 顾问页问题。
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

| D-30 | 🟠 中（状态） | 分析完成后 AI 配置表单被覆盖回已保存/默认值，用户每次都要重选 | 已修复 |
| D-31 | 🟠 中（行为） | 修改配置后直接点分析（未保存）时，内核仍使用旧配置 | 已修复 |
| D-32 | 🟠 中（功能） | 桌面外壳未转发 `ai/stream` 事件，流式增量丢失（界面表现为一次性输出） | 已修复 |
| D-33 | 🟡 中（可用性） | AI 插件工坊被包在「有分析结果」条件内，未分析时不可见 | 已修复 |
| D-34 | 🟢 低（可用性） | 模型候选/来源首屏不加载、模型名手动输入提示不足、默认最大输出 token 偏小 | 已修复 |

| D-35 | 🟢 低（体验） | 顶部状态栏展示已保存配置而非当前表单，模型缺口显示旧模型名；默认模型可能是旧的 deepseek-chat | 已修复 |

| D-36 | 🟡 中（兼容性） | 用户设置的 max_tokens 被服务端静默抬到 32768；官方旧模型 ID 未迁移；界面缺少底层模型版本展示 | 已修复 |

| D-37 | 🟢 低（可用性） | 定时任务只能使用固定/自动名称，用户无法给任务起自定义名字 | 已修复 |

| D-38 | 🟠 中（正确性/体验） | 分组点「明细 →」钻取后切回分组，只剩被钻取的那一组，其余组消失 | 已修复 |

| D-39 | 🟠 中（真实性） | AI 插件工坊把含 `@cordisjs/plugin-cleaner` 幻觉 import 的草稿判为“校验通过”，安装时 ERR_MODULE_NOT_FOUND | 已修复 |

| D-40 | 🟠 中（体验/正确性） | 生成插件时界面像卡住、无反馈；草稿语法错误也照样进入审阅 | 已修复 |

| D-41 | 🔴 高（可用性） | Electron 桌面版生成插件时语法检查固定 10 秒超时，导致自动重试也全部失败 | 已修复 |

| D-42 | 🟡 中（能力限制） | AI 插件工坊只能生成零依赖插件，无法使用 npm 生态实现复杂清理能力 | 已增强 |

| D-43 | 🟠 中（残留/体验） | 插件依赖安装/加载失败后会留下 generated-plugins 目录与 node_modules；卸载外部插件也不清文件 | 已修复 |

| D-44 | 🟢 低（测试） | 插件工坊缺少安装 API / UI 的自动化回归，失败清理与卸载清理只能靠手工验证 | 已补测试 |

| D-45 | 🟠 中（可用性） | 外部插件只在本进程有效，重启丢失；插件页不知道如何开始扫描/定时运行 | 已修复 |

| D-46 | 🟡 中（可用性/文案） | 内置插件“卸载”其实只是停用；外部插件停用后没有卸载入口 | 已修复 |

| D-47 | 🟢 低（布局） | 插件卡片操作按钮过多时横向溢出，新增的“加入定时任务”被裁切 | 已修复 |

| D-48 | 🟠 中（架构/扩展性） | 外部插件只能注册清理任务，无法贡献 UI 或后台生命周期；AI 工坊只能生成 cleaner 脚本，离通用插件框架还差一层 | 已修复（P1） |

| D-49 | 🟠 中（扩展性/UI） | active 插件无法主动刷新界面；statusItems/commands 未渲染；Electron 壳没有悬浮窗/托盘能力 | 已修复 |

| D-50 | 🟡 中（文档/提示词） | AI 工坊提示词与说明仍描述旧 worker 单文件契约，generated 结果与 native/desktop/事件/窗口能力不一致 | 已修复 |

| D-51 | 🟠 中（真实性/权限判断） | 顶栏 Windows/Node/权限/外壳信息不真实：Node 显示 Electron 内置 22 而非系统 24；Administrator 账号 Medium Integrity 被误判为管理员 | 已修复 |

| D-52 | 🟠 中（交互/安全） | 点击开始清理后仍停留在结果列表，进度和结果页混在一起，容易误点；离开页面后也看不到清理状态 | 已修复 |

| D-53 | 🟡 中（交互/布局） | 开始清理时旧的“清理完成”结果闪一下；失败原因中的长路径/长 JSON 消息横向溢出 | 已修复 |

| D-54 | 🟠 中（编码/稳定性） | 回收站 PowerShell 脚本回执乱码、解析失败；UTF-8 中文注释导致 Windows PowerShell 5.1 误读脚本，失败项显示整段 JSON 乱码 | 已修复 |

| D-55 | 🟡 中（交互） | 扫描过程仍停留在结果页，进度事件造成页面闪烁；回收站 .NET 异常文案对用户不可读 | 已修复 |

| D-56 | 🟡 中（视觉/交互） | 清理进行中“当前文件”单行高频替换，看起来像界面在闪 | 已修复 |

| D-57 | 🔴 高（多任务进度） | 多任务清理时第一个任务结束就把进度页关掉，进度条只显示一会；实际清理仍在后台继续 | 已修复 |

| D-58 | 🔴 高（插件加载/提示词） | AI 生成的通用插件漏写 inject，却在代码里读取 ctx.cleaner/system 等；校验只警告，安装成功但启动时报 “cannot get property without inject” | 已修复 |

| D-59 | 🟡 中（插件 UI 契约/AI 生成） | showcase-kit 的“环境概览”空白；“候选扫描进度”忽略返回 max；命令按钮用 label 导致标题空白 | 已修复 |

| D-60 | 🟡 中（AI 生成质量/体验） | AI 生成插件缺少 description/手动命令，插件页只有“外部原生插件”；生成等待无秒数；提示词不了解项目结构 | 已修复 |

| D-61 | 🟡 中（AI 工坊交互） | 生成插件时点击弹窗外区域会关闭弹窗，进度/取消入口丢失；生成结果不再显示，也无法安装 | 已修复 |

| D-62 | 🟡 中（信息准确性） | 概览“系统信息”把 Electron 内置 Node 22 当作 Node 版本显示，和顶栏系统 Node 24 冲突；信息只在启动时采样 | 已修复 |

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
删除吞吐 2331 → **6616 文件/秒**（批次1 后基准环境重跑为 2 178 文件/秒，扫描 26 770 文件/秒，见 docs/benchmark.md）。回归：当前全量 382 个用例通过。

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

### D-30 分析完成后 AI 配置表单被覆盖回默认

**现象**：用户选好接口形态/模型/推理等级/输出 token 后点「开始分析」，分析完成后表单恢复为已保存配置或默认值，每次都要重选。
**根因**：`AiView.vue` 对 `[state.plugins, state.aiStatus]` 做了 deep watch；`analyzeAi` 结束会刷新 `state.aiStatus`，watch 无条件调用 `syncFromConfig()`，把未保存表单覆盖回已保存配置。
**修复**：新增 `formDirty` 脏跟踪（`syncFromConfig` 写入期间用 `syncingForm` 抑制），只在表单未修改或插件启用状态变化时回填；保存成功后显式复位并重新同步。
**验证**：真实 Electron + mock 流式接口实测：分析前后表单（形态/模型/推理/JSON/最大 token/baseUrl）完全一致；`pnpm typecheck:ui` 通过。

### D-31 未保存配置直接分析时仍用旧配置

**现象**：用户改完配置直接点分析，界面显示新配置但内核仍用旧配置，结果与预期不符。
**根因**：AI 接口配置只在点「保存并热重载」时写入插件配置，分析 RPC 不携带表单。
**修复**：`run()` 在表单为脏时先静默保存并热重载，再发起分析；保存失败则中止并提示。
**验证**：同上真实 Electron 自检；保存后可正常分析且表单不被覆盖。

### D-32 桌面外壳丢失 AI 流式输出

**现象**：流式分析在浏览器外壳正常，但 Electron 桌面版要等分析结束才一次性出现全文，看起来不是流式。
**根因**：`apps/desktop/src/main.ts` 的内核事件转发列表缺少 `ai/stream`（Web 外壳的 server bridge 已包含），增量事件到不了渲染进程。
**修复**：桌面外壳转发 `ai/stream`（并补上 `scheduler/scan` 通知）。
**验证**：mock 流式接口（30 个增量、90 ms/块）下，桌面版 `.stream-box` 长度按 24→72→96→120… 递增，说明逐段渲染；`tests/ai-stream-analyze.test.ts` 断言内核至少广播多条 delta + done。

### D-33 AI 插件工坊未分析时不可见

**现象**：AI 插件工坊只有出过分析结果后才出现，用户想直接用必须先生成一次分析。
**根因**：工坊卡片与其草稿审阅弹窗被放在 `<template v-if="analysis">` 内。
**修复**：把工坊卡片移到分析结果区块之外（配置就绪即可见），草稿审阅弹窗同步移出；并标注「无需先分析」。
**验证**：真实 Electron 自检中，分析前页面标题列表已包含「🛠️ AI 插件工坊」。

### D-34 模型列表/手动模型名/默认 token 体验问题

**现象**：模型候选与「模型来源」要等第一次分析后才出现；模型名输入提示不清；默认最大输出 token 偏小（历史值 1200/2048）。
**修复**：进入页面/插件启用/配置就绪时自动拉取一次模型列表（失败静默回退内置目录，手动「获取模型」仍可强制刷新）；模型下拉保留 `filterable + allow-create` 并提示「可直接输入模型名，回车确认」；默认最大输出 token 统一为 3000（旧配置 <3000 回填为 3000，保存后生效）。
**验证**：真实 Electron 自检中分析前已显示「模型来源：接口」、可选择 mock-model，最大 token 显示 3000；typecheck/build/E2E 通过。


### D-35 状态栏信息固定、模型默认名陈旧

**现象**：AI 页顶部「凭据/形态/模型/推理/JSON/模型来源」读取的是已保存配置，改表单时不变化，用户感觉「固定、没用」；旧配置里的 `deepseek-chat` 仍显示为默认模型。
**修复**：状态栏改为实时反映当前表单（形态/模型/推理/JSON/最大输出）+ 配置是否已保存（未保存时明确提示分析前会自动保存）+ 模型来源/探测结果；插件侧把旧默认模型 `deepseek-chat`/`deepseek-reasoner`/`deepseek-coder` 迁移为 `deepseek-flash`；模型下拉增加「手动输入模型名」切换，任何模型名都可直接填写。
**验证**：`tests/ai-config-defaults.test.ts`（默认 flash + 旧名迁移 + 自定义模型保持）；typecheck:ui / build / E2E 通过。

### D-36 模型版本与 max_tokens 兼容性

**现象**：按 DeepSeek 官方文档核对后发现：请求 ID 应是 `deepseek-flash`（实际由 DeepSeek-V4.1-Flash-1017 提供服务），`deepseek-v4-flash` 等旧 ID 仍被接受但已退役；项目里用户配置的 3000 tokens 会被内部静默抬到 32768；界面只显示模型 ID、看不到底层版本。
**修复**：扩展官方别名表（chat/reasoner/coder/v4-flash/v4-flash-vision-exp → flash，未知名称保留）；以 `/models` 的 `name` / `max_output_tokens` / 上下文/模态作为显示与能力依据；分析请求严格按「用户值 min 模型上限」收敛，不再偷抬；界面显示「当前模型版本 + 上下文」并支持手动模型名；新增 [AI 模型与接口兼容策略](ai-model-compatibility.md) 记录官方依据与未来变更清单。
**验证**：`tests/ai-model-metadata.test.ts`（/models 能力收敛到 2000、自定义模型名原样发送）；`tests/ai-config-defaults.test.ts`（默认 flash + 旧官方 ID 迁移）；全量 54 文件 / 382 用例通过。

### D-37 定时任务无法自定义名称

**现象**：新建定时任务时名称固定为「新计划/新建任务」之类，多个任务难以区分；已有任务也没有改名入口。
**修复**：新建时弹窗输入任务名称（默认给一个带时间戳的建议名，可随意改，非空/≤40 字校验）；表单新增「任务名称」输入，可随时改名并保存；计划下拉/删除确认都使用自定义名称。
**验证**：真实 Electron 自检：新建时输入「我的自定义定时任务」，创建后表单与下拉均显示该名称，0 JS 异常；typecheck:ui / build 通过。

### D-38 分组明细钻取污染分组总览筛选

**现象**：扫描后分组总览有多组，点某一组的「明细 →」进入逐项明细，再点「分组总览」切回，只剩刚才那一组，其他组全部消失。
**根因**：`showTaskItems()` 为了只展示该任务明细，把全局共享的 `taskFilter` 改成了该任务；切回分组时这个筛选仍然存在，`categoryGroups` 只聚合该任务，导致只剩一组。
**修复**：新增「钻取筛选」状态 `autoTaskFilter`，记录钻取前的用户筛选；切回分组时只撤销钻取自动加的任务筛选并恢复原筛选，用户手动设置的其他筛选不会被破坏。明细页仍保留任务筛选显示，方便返回。
**验证**：`scripts/e2e-ui.mjs` 新增回归步骤「分组→明细→分组：N 组保持一致」，真实扫描 8 组往返后仍为 8 组；全量 E2E 0 JS 异常。

### D-39 AI 插件工坊“校验通过但装不上”

**现象**：工坊生成的插件写了 `import { defineCleanerPlugin } from '@cordisjs/plugin-cleaner'`，界面显示「语法与契约校验通过」，点安装却报 `ERR_MODULE_NOT_FOUND`；该 import 在生成文件所在目录根本不存在。
**根因**：
- 生成提示词要求使用 `defineCleanerPlugin` + 框架包 import，但外部插件是单文件零依赖，从 `<dataDir>/generated-plugins` 加载时解析不到框架包；
- 安装前校验只看语法、`defineCleanerPlugin` 关键字和危险 API，未检查 import 是否可解析，因此“假通过”。
**修复**：
- 新增共享静态契约 `packages/shared/src/plugin-code.ts`：外部插件禁止 import 框架/第三方/相对路径，禁止 `defineCleanerPlugin`，必须 `export default` 普通对象、含 `name`/`setup`；生成端、安装端、测试共用；
- 重写工坊提示词与 tool schema：明确零依赖普通对象契约、允许的 Node 内置模块、`%TEMP%` 等路径模板；
- 生成流程先跑契约检查，失败时把错误回传给模型自动重试（最多 3 次），不把坏草稿交给用户；
- 安装端展开 `%TEMP%/%USERPROFILE%/%LOCALAPPDATA%/%APPDATA%/%WINDIR%`，再做绝对路径/辖区校验；
- 安装成功后刷新插件列表；新增真实安装测试（草稿写入文件 → worker 加载 → 任务注册）。
**验证**：`tests/plugin-workshop-contract.test.ts`（4 个契约用例）、`tests/ai-plugin-workshop.test.ts`（首次坏草稿自动重试 → 最终代码真实安装并注册任务）；全量 54 文件 / 382 用例通过。

### D-40 插件工坊生成无反馈、语法错误草稿未被拦截

**现象**：点「生成插件草稿」后界面长时间无反应，像卡死；草稿出现后又提示「语法错误」，无法安装。
**根因**：
- 生成期间只显示按钮 loading，弹窗要等完整生成+校验后才打开，用户看不到进度；
- 生成链路只有静态契约检查，没有语法检查，模型输出被截断/括号不配对时仍会进入审阅；
- 编辑代码时每个输入事件都同步执行 `node --check`，阻塞宿主主线程。
**修复**：
- 点生成立即打开审阅弹窗并显示「AI 正在生成…（可能 30~90 秒）」进度提示，生成完成再填充代码并自动校验；
- 生成端增加异步语法检查（`node --check`），语法错误会带着错误信息自动重试生成（最多 3 次）；
- 宿主校验改为异步 `spawn`，不再阻塞主线程；
- 代码编辑校验防抖 400ms，并立即把旧校验结果置空、取消“已阅读”勾选，避免用旧结果误装；
- 语法错误信息保留具体行/列与原因，不再只有空泛的「语法错误：」。
**验证**：`tests/ai-plugin-workshop.test.ts` 首次返回语法不完整草稿，断言自动重试后得到可安装代码；`tests/plugin-workshop.test.ts` 覆盖语法错误；全量 54 文件 / 382 用例通过，typecheck/build 通过。

### D-41 Electron 下 `node --check` 误把 electron.exe 当 Node 启动

**现象**：桌面版插件工坊生成时日志连续出现「语法检查超时（10 秒）」，三次自动重试全部失败，弹窗只剩生成失败。
**根因**：Electron 主进程里 `process.execPath` 是 `electron.exe`。直接 `spawn(process.execPath, ['--check', file])` 会启动一个 Electron 应用窗口，而不是执行 Node 的 `--check`，于是子进程一直不退出，10 秒后被杀。
**修复**：宿主与 AI 插件的语法检查子进程都设置 `ELECTRON_RUN_AS_NODE=1`，让 electron.exe 以纯 Node 模式运行 `--check`；超时/异常分支同时清理临时文件。
**验证**：真实 Electron 自检（mock AI 返回合规插件）中，生成后弹窗显示「✓ 语法与契约校验通过」，`hasTimeout=false`，0 JS 异常；Node 测试环境不受影响。

### D-42 插件工坊依赖能力过窄（增强）

**现象**：工坊生成的插件被限制为单文件零依赖，只能使用 Node 内置模块，无法实现 zip/tar 分析、复杂 glob 匹配等能力。
**方案选择**：用户明确选择「按需安装任意 npm 依赖」，而不是预置依赖库。
**实现**：
- 草稿格式增加 `dependencies: { 包名: "semver" }`，tool schema/提示词同步；第三方包必须在 dependencies 声明，未声明 import 会被静态校验拒绝；
- 安装目录改为 `generated-plugins/<name>/`（`plugin.mjs` + `package.json` + `node_modules`），Node ESM 可直接解析；零依赖仍保持单文件；
- 界面展示依赖清单与风险确认，未勾选「允许下载依赖」不允许安装；宿主 RPC 也要求 `acknowledgeDependencies=true`；
- 宿主在插件目录执行 `npm install --ignore-scripts`（失败回落 pnpm），禁用 lifecycle scripts，最多 8 个依赖，只允许 npm 包名 + semver，禁止 file/git/URL；
- 安装依赖期间按钮 loading，防重复点击；依赖安装失败给出可读错误。
**验证**：依赖声明/白名单校验测试；真实 smoke：安装 `is-number@7` 到临时插件目录 → `ExternalPluginProxy` 真实加载并注册任务成功；全量 54 文件 / 382 用例通过。

### D-43 插件工坊失败/卸载残留

**现象**：依赖下载失败、worker 加载失败或取消后，`generated-plugins/<name>/` 与半装好的 `node_modules` 留在数据目录；卸载外部插件也只释放运行时记录，不删文件。
**修复**：
- 安装前先清理同名残留，并检测已加载同名插件（要求先卸载）；
- 安装链路任一步失败：尝试卸载已部分注册的插件，再删除本次生成的插件文件/目录（含 `node_modules`）；
- `plugins/uninstall` 对工坊生成的插件删除对应文件/插件目录；
- 应用启动时清理上一次运行留下的 `generated-plugins/`（外部插件本来就不跨进程持久加载）；
- npm/pnpm 全局下载缓存保留（共享缓存，不属于单插件残留）。
**验证**：`tests/plugin-workshop.test.ts` 覆盖单文件/依赖目录清理；全量 54 文件 / 382 用例通过。

### D-44 插件工坊安装与清理缺少自动化回归

**现象**：工坊的草稿生成/静态校验有测试，但 `ai/plugin/install` 安装成功、缺少依赖确认、依赖安装失败回滚、卸载删除文件、启动清理残留等链路没有自动化覆盖。
**补充测试**：
- `tests/workshop-api.test.ts`：零依赖安装成功 → 卸载删除文件；未确认依赖拒绝且不落盘；模拟 npm/pnpm 不可用 → 依赖安装失败后清理插件目录；启动时清理 stale `generated-plugins`；
- 真实 Electron UI 自检：生成 → 审阅 → 安装 → 插件页出现；卸载后生成文件/目录消失；另测声明 `is-number` 依赖的插件，勾选依赖确认后真实安装依赖并加载成功、卸载后目录删除。
**结果**：全量 54 文件 / 382 用例通过，UI 自检 0 JS 异常。

### D-45 外部插件不持久、插件页无法直接运行

**现象**：AI 工坊生成的插件安装后只存在于当前进程；重启应用不会重新加载（settings 只存了 enabled/config，没有源代码路径），旧版本启动清理还会删掉 generated-plugins。插件页只有配置/源码/卸载，没有“开始使用”的入口，用户不知道如何触发插件任务。
**修复**：
- `settings.plugins[id]` 增加 `externalPath`；安装/启用时持久化；
- 启动时 `PluginManager.loadAll()` 按路径自动加载已启用外部插件；旧配置没有路径时按 `generated-plugins/<name>.mjs` / `<name>/plugin.mjs` 兼容猜测；
- 启动清理只删除没有持久化记录的残留，保留已安装插件文件；
- 卸载时清空持久化记录并删除文件；
- 插件页为外部插件提供「扫描此插件」（只扫描该插件任务并跳到清理页）与「加入定时任务」（预选任务范围）；
- 新增 [插件使用说明](plugin-usage.md)，解释被动插件、定时任务驱动与为什么不支持后台常驻主动插件。
**验证**：`tests/workshop-api.test.ts` 覆盖“安装后重启自动加载且启动清理不删文件”；真实 Electron 自检点击两个新按钮：扫描得到 1 个分组、定时任务预选成功、0 JS 异常；全量 54 文件 / 382 用例通过。

### D-46 插件“停用/卸载”语义与入口不一致

**现象**：内置插件按钮写“卸载”，实际只执行 disable，插件包不会删除；外部插件停用后按钮变成“安装”，没有“卸载并删除”入口；用户无法区分关闭与删除。
**修复**：
- 内置插件：启用时显示「停用」，停用时显示「启用」，文案不再说卸载；
- 工坊外部插件：无论启用/停用都显示「卸载并删除」，点击先弹确认框，确认后删除插件文件与依赖目录；
- 停用开关只释放任务/辖区，不删文件，可随时重新启用；
- 用户手工指定的外部 .mjs 卸载只解除加载，不删除用户文件。
**验证**：`typecheck:ui` / build / 插件页 E2E 按钮渲染通过；`docs/plugin-usage.md` 同步说明。

### D-47 插件卡片操作按钮溢出

**现象**：外部插件卡片同时显示配置/扫描/定时/卸载/热重载/源码等按钮时，单行 flex 不换行，右侧按钮被卡片裁切。
**修复**：操作区拆成「主操作组 + 次要操作组」，两组都 `flex-wrap: wrap`；卡片加 `min-width: 0`；按钮间距统一由 gap 控制，去掉 Element 相邻按钮的 margin-left。当前按钮自动换行，后续继续增加按钮也不会溢出。
**验证**：重新生成插件页截图（`docs/screenshots/ui-plugins.png`），按钮分行显示；全量 E2E 0 JS 异常。

### D-48 通用插件框架 P1：外部插件成为一等公民

**现象**：外部插件运行在 worker 里，只有 describe/configure/scan/clean 四个动作；只能 ctx.cleaner.define，不能注册 UI、服务、事件或后台定时器；AI 工坊只生成 cleaner 单文件。用户无法用外部插件做卡片、自定义页面或主动插件。

**修复（P1，分步提交）**：
- P1.1 通用契约 `packages/shared/src/plugin-api.ts`：PluginKind、UI 卡片/页面/状态项/命令、ctx.ui.register/resolve；
- P1.2 原生外部 Cordis 插件：`installNativePlugin()` 通过 `ctx.plugin()` 获得完整 ctx；持久化 externalPath/externalType；旧 worker cleaner 插件兼容；
- P1.3 概览页渲染插件声明式卡片（metric/text/list/progress + 定时刷新）；
- P1.4 AI 工坊生成原生 Cordis 通用插件（kind/inject/contributes/apply），安装走 native 模式；
- P1.5 iframe 插件页面：sandbox + data URL + postMessage resolve 桥，页面不能访问宿主 DOM；
- 全程未新增具体业务插件，只做框架与验证。

**验证**：
- `tests/generic-plugin.test.ts`：原生安装、UI 贡献、resolve、重启加载、禁用清理；
- `tests/plugin-workshop-contract.test.ts`：native 契约接受 apply/inject/contributes，拒绝旧式 object；
- `tests/ai-plugin-workshop.test.ts` 改成原生 cleaner 草稿安装；
- `tests/workshop-api.test.ts`：AI 安装原生 widget 并注册卡片；
- 真实 Electron：AI 生成 widget → 安装 → 概览渲染卡片；iframe 页面 resolve 返回 from-iframe，0 JS 异常；
- 全量 54 个测试文件 / 382 个用例通过，typecheck/build 通过。

**边界**：外部原生插件是可信代码，拥有完整 Node/Cordis 权限；P1 不做插件市场（P2 暂缓），窗口/托盘/桌面宠物能力仍未暴露。详见 [通用插件框架](generic-plugin-framework.md)。

### D-49 主动事件、状态栏/命令与窗口能力

**现象**：P1.4 之后外部插件能贡献卡片/页面，但 active 插件没有主动更新 UI 的通道；statusItems/commands 只有契约没有渲染；桌面宠物/悬浮窗缺少窗口与托盘 API。

**修复**：
- 新增 `ctx.ui.emit()` / `ctx.ui.notify()`：内核事件 `plugin/ui-event` / `plugin/notify` 经 Host 事件桥/桌面 IPC 转发到 UI；概览卡片监听事件序号立即刷新；
- 顶栏 `PluginStatusItems` 渲染 `statusItems`，插件页渲染 `commands`；新增 `ctx.ui.command()` 与 `ui/command` RPC；
- 新增 `PluginWindowService`（`ctx.window`）与 Electron 后端：独立 BrowserWindow（data URL、透明/置顶/点击穿透、nodeIntegration=false）与 Tray；插件停用/卸载自动关闭其窗口/托盘；浏览器壳明确不可用。

**验证**：
- `tests/plugin-window.test.ts`：无后端报错、后端注入、开窗/关窗/托盘回调、停用关闭窗口；
- 真实 Electron：active 插件顶栏“心跳 在线”、命令按钮触发通知“计数变成 1”、概览卡片 0 → 1；窗口命令打开独立 `pet-window`，0 JS 异常；
- 全量 54 个测试文件 / 382 个用例通过，typecheck/build/E2E 通过。

**边界**：窗口 HTML 是插件可信代码，但 BrowserWindow 已关闭 Node 集成、禁止导航；托盘需要插件提供 data URL 图标；P2 插件市场仍暂缓。

### D-50 AI 工坊提示词/文档与新插件契约同步

**现象**：P1 把 AI 工坊切到原生 Cordis 通用插件后，界面说明与文档仍写“单文件 worker 插件”；提示词没有覆盖 desktop 窗口、active 事件、statusItems/commands，模型容易生成旧式 `export default + setup` 草稿；插件作者文档 §6.1、威胁模型、架构、插件使用说明也有旧描述。

**修复**：
- 提示词/tool schema 更新为原生契约：`kind = cleaner|widget|active|desktop`、`apply(ctx)`、`inject`、`contributes`、`ctx.ui.resolve/command/emit/notify`、`ctx.window.open/createTray`；
- AI 工坊界面说明改为“原生 Cordis 插件”，支持四类插件；
- 同步 `docs/plugin-authoring.md`、`docs/plugin-usage.md`、`docs/architecture.md`、`docs/threat-model.md`、`docs/test-plan.md`；
- 新增 `tests/ai-plugin-native-kinds.test.ts`：断言请求提示词包含原生契约/desktop/window/events，草稿 `mode=native`、`kind` 正确。

**验证**：AI 专项 53+1 用例；真实 Electron 专项：
- AI 顾问分析：摘要/建议/观察项渲染，0 JS 异常；
- AI 生成原生 widget：安装后概览卡片渲染；
- active 插件：状态栏“心跳 在线”、命令通知、卡片 0→1；
- iframe 页面 resolve 返回 from-iframe；
- 桌面命令打开独立 `pet-window`；
- 全量 54 个测试文件 / 382 个用例通过。

**边界**：AI 生成代码仍必须人工审阅；提示词能降低旧契约/幻觉概率，但不能保证模型一定输出合法代码，最终以静态校验 + 真实加载为准。

### D-51 顶栏运行时信息与管理员权限误判

**现象**：顶栏只显示笼统的“Windows”“Node 22.22.0”“管理员权限”“桌面外壳”，用户无法判断来源；在 Administrator 账号 + UAC Medium Integrity 下，原 `detectElevated()` 仅对 `hosts` 做 `access(W_OK)`，会误报“管理员权限”；系统 Node 24 与 Electron 内置 Node 22 也没区分。

**修复**：
- 新增 Windows Mandatory Label 检测：`whoami /groups` 的 `S-1-16-12288/16384`（High/System）才判定管理员，`S-1-16-8192`（Medium）判定普通用户；`whoami` 失败才退回文件可写探测；结果缓存并记录真实检测时间；
- `app/info` 扩展真实字段：`platformLabel/osRelease/osVersion/arch/nodeRuntime/systemNode/electron/shell/elevatedCheckedAt`；
- 顶栏显示实际系统 Node（如 24.22.1），鼠标悬停说明 Electron 内置 Node（22.22.0）、系统 PATH Node、Electron 版本；
- Windows 显示实际平台标签（如 Windows 11）与完整版本 tooltip；外壳显示 IPC/WS 类型与 Electron 版本；
- 启动后获取一次，窗口重新聚焦或点击顶栏信息时自动刷新。

**验证**：
- `tests/runtime-info.test.ts`：Medium/High/System SID 解析、检测稳定；
- `tests/api-flow.test.ts`：app/info 返回真实 node/nodeRuntime/shell/platform/elevated；
- 真实 Electron：顶栏显示 `Windows 11`、`普通用户`（Medium）、`Node 24.22.1（系统）`、`桌面外壳`；tooltip 显示 Electron 内置 Node 22.22.0 / Electron 38.8.6，0 JS 异常。

**边界**：权限完整性在进程启动时确定，运行期间不会改变；系统 Node 来自 PATH，未安装时只显示 Electron 内置 Node。

### D-52 清理过程缺少独立实时进度界面

**现象**：点击「开始清理」后仍停留在扫描结果列表，只在按钮上显示 loading；进度和结果混在一起，用户容易继续勾选、点击或重复操作。切换到其他侧边栏后虽然清理在后台继续，但界面上没有入口回到清理状态，也不知道是否完成。

**修复**：
- 新增独立 `CleaningView` 页面：开始清理后立即切换到该页；
- 实时展示：当前任务、已完成/总项数、进度条、已释放字节、失败数、当前路径；支持取消；
- 清理完成后展示结果摘要：处理项、释放空间、回收站/隔离区、失败、按任务统计、失败原因前 20 条；
- 顶栏在清理期间显示「🧹 清理中 · 查看进度」入口；侧边栏「清理」保持高亮；
- 清理期间切到其他页面不取消清理；完成后如果不在进度页，用 `ElNotification` 提示；
- 清理期间清理页显示“本页操作已暂停”横幅，扫描/任务勾选/清理按钮禁用，避免误操作；
- 清理失败/取消路径：异常时自动回到清理页，已处理项不回滚，结果摘要会标记“已取消”。

**验证**（真实 Electron，临时测试插件生成 1200 个临时文件）：
- 点击确认清理 → 自动进入「正在清理」页，显示实时进度；
- 立即切换到「插件」页 → 顶栏“清理中 · 查看进度”仍可见，清理继续；
- 点顶栏入口回到进度页 → 最终显示「清理完成 / 处理 1200 项 / 进入回收站 600 KB / 失败 0」；
- 0 JS 异常；全量 54 个测试文件 / 382 个用例保持通过。

**边界**：导航不中断清理是设计行为；取消清理只停止后续项，已完成项不回滚。

### D-53 清理进度页旧结果闪烁与失败详情溢出

**现象**：点击开始清理后，进度页会短暂闪现上一次的「清理完成」结果，再切换到实时进度；清理结果页的失败路径/长错误 JSON 横向撑出卡片。

**根因**：
- `state.lastClean` 保留上一次报告；`state.page='cleaning'` 后、`startClean` 把 `cleaning=true` 前，CleaningView 会先渲染旧报告；
- 失败详情使用长路径和未截断的 JSON 错误文本，默认 `word-break` 不足以处理无空格长串。

**修复**：
- `startClean()` 开始时清空 `lastClean` / `cleanProgress`；CleanView 切页前也先清空，确保进度页首帧就是“正在清理”；
- 失败详情改用 `overflow-wrap:anywhere` + `word-break:break-word`，路径和错误文本强制换行；按任务统计名称同样允许断行；
- 保留真实进度（总项/完成/失败/字节/当前路径），不伪造最短显示时间，快速清理仍会如实进入结果页。

**验证**：真实 Electron 1200 项清理专项（前序 D-52）进度页、导航中查看、结果摘要正常；本次布局用长路径/长 JSON 文本 CSS 检查；全量 54 文件 / 382 用例保持通过。

### D-54 回收站回执乱码与 PowerShell 脚本解析

**现象**：清理完成后失败详情出现乱码，甚至把整段回收站 JSON 当作错误消息；部分 Windows 机器上回收站回执文件没有生成，所有成功项被误报为“回收站调用失败”。

**根因**：
- PowerShell 5.1 把无 BOM 的 UTF-8 脚本按 ANSI 读取；脚本里的中文注释在部分系统上导致解析异常，回执写入代码没有执行；
- 回执通过 stdout 输出时受控制台 codepage 影响，Node 按 UTF-8 解码产生 mojibake。

**修复**：
- PowerShell 脚本改为**纯 ASCII**（注释也用英文），避免 5.1 代码页解析问题；
- 不再从 stdout 解析回执：脚本用 `[System.IO.File]::WriteAllText` 写入 UTF-8 结果文件，Node 直接读文件，完全绕开控制台编码；
- `parseReceipt` 同时兼容 BOM、前置额外输出、错误消息内含 `{` 的情况；
- 清理结果页遇到旧式“整段 JSON” message 时，自动提取内部真实 message，避免整段 JSON 乱码铺满页面。

**验证**：
- 新增 `tests/recycle-receipt.test.ts`：中文 message、前置输出、含花括号消息、空内容；
- 真实回收站调用（本机）：`ok:[临时文件]`，失败 0，文件成功进入回收站；
- 全量 54 个测试文件 / 382 个用例通过，typecheck/build/UI E2E 通过。

**边界**：回收站仍依赖 Windows PowerShell 5.1；脚本已保持 ASCII 与 UTF-8 文件回执，不再受控制台 codepage 影响。

### D-55 扫描独立进度页与失败文案

**现象**：点击开始扫描后仍停留在任务/结果页，扫描进度事件持续更新导致页面闪烁；切换侧边栏后没有回到扫描状态的入口。清理失败详情仍显示 “使用 3 个参数调用 DeleteFile 时发生异常” 这类 .NET 内部文案。

**修复**：
- 新增 `ScanningView`：点击开始扫描立即切到独立扫描进度页，显示当前任务、候选项目、文件/目录数、发现体积、当前路径；支持取消；
- 扫描期间顶栏显示「🔍 扫描中 · 查看进度」，侧边栏「清理」高亮；
- 切到其他侧边栏不中断扫描；扫描结束仍在进度页则自动回清理结果页，否则弹通知；
- 清理页扫描期间显示暂停横幅，开始扫描/任务勾选/清理按钮禁用；
- 清理失败文案对 `DeleteFile` / 系统占用错误做友好映射：“文件正被系统占用或受保护，无法放入回收站，已跳过”；
- 清理进度页仍保持首帧不闪旧结果（D-53/D-54）。

**验证**：真实 Electron 慢扫描专项：开始扫描 → `正在扫描` 页 + spinner；切到插件页 → 顶栏“扫描中”入口仍在；返回后自动回到清理结果页；0 JS 异常。

### D-56 清理进度的“当前文件”高频闪烁

**现象**：清理进行中，进度卡片里的“当前：某个文件路径”每 120ms 被替换一次；路径长度和内容变化让整块区域看起来在闪，用户误以为页面异常。

**根因**：`CleanProgressEvent.current` 随每个清理项变化，CleaningView 把它直接绑定到单行文本；高频 DOM 文本替换 + 路径长度变化造成视觉抖动。

**修复**：
- 改为**最近处理文件滚动列表**：保留最近 8 条，固定高度、单行省略号，新增行从列表末尾出现；
- 监听 `state.cleanProgress.sessionId`，新会话自动清空旧日志；
- 去掉快速变化的单行“当前路径”，保留稳定的计数/失败/字节统计和任务名；
- 不伪造进度、不降低后端事件频率，只改变展示方式。

**验证**：typecheck / build / 6 页面 UI E2E 通过；清理进度页滚动日志不再出现整行高频替换。

### D-57 多任务清理进度页提前消失

**现象**：点击开始清理后进度条只出现一会就消失，页面像“直接清理好了”；实际清理仍在继续，最后才出现结果页。

**根因**：后端 `CleanProgressEvent.finished` 的语义是**当前任务完成**（每个任务分组结束都会发 true），不是整个清理会话完成；UI 之前写成 `state.cleaning = !event.finished`，所以第一个任务结束后就关闭了进度态。

**修复**：
- `clean/progress` 处理器不再根据 `finished` 关闭进度：收到任何进度事件都保持 `state.cleaning=true`；
- 只有 `clean/done` 事件（或 `startClean` 请求 finally）才结束进度态；
- 进度页仍按当前任务的 total/done 显示进度，任务切换时重置为当前任务；
- 结果页只在真正完成后展示。

**验证**：typecheck / build / UI E2E 通过；全量 54 文件 / 382 用例保持通过。

### D-58 通用插件漏写 inject 导致“启用但加载失败”

**现象**：AI 工坊生成的 `plugin-probe` 只声明 `inject = ["ui"]`，但代码里读取 `ctx.cleaner / ctx.system / ctx.settings / ctx.pathPolicy / ctx.window`。插件卡片显示已安装/可启用，实际加载报 `cannot get property "cleaner" without inject`，任务/卡片不可用。

**根因**：
- Cordis 对未 `inject` 的服务属性访问会**直接抛错**，不能用条件判断探测；
- 原生插件校验之前只对 ui/window/cleaner 发 warning，不阻断安装；
- AI 提示词虽然写了 inject 规则，但没有明确禁止“用 if (ctx.foo) 探测能力”。

**修复**：
- 原生插件静态校验把“使用 ctx 服务但未 inject”改成**硬错误**，AI 工坊会带错误自动重试；
- 提示词明确：不要探测未声明服务，只使用 inject 中声明的服务；补充 statusItems 使用 `label`；
- `PluginManager.installNativePlugin` 对旧工坊产物做兼容：按源码扫描 `ctx.<service>`，自动补齐缺失 inject 并记录 warning；无需用户改文件；
- 顶栏 statusItems 兼容旧产物把 `label` 写成 `title` 的情况。

**验证**：
- 复制用户实际 `plugin-probe.mjs` 到临时数据目录，用新加载器启动：插件 `status=active`，3 张卡片/1 个状态项/1 个命令全部注册；
- 新增测试：漏 inject 判为错误；旧插件自动补齐 inject 后 active；
- 全量 54 个测试文件 / 382 个用例通过，typecheck/build/UI E2E 通过。

**说明**：用户实际数据目录中的 `plugin-probe.mjs` 没有被删除或篡改；升级后重启应用，加载器会按源码自动补齐 inject。若仍失败，可在插件页「卸载并删除」后重新生成。

### D-59 声明式卡片数据形状不匹配导致空白

**现象**：真实 AI 生成的 `showcase-kit` 插件加载正常，但概览“环境概览”卡片空白；其命令按钮标题也可能空白。`plugin-probe` 的“可用能力 7”被误认为错误，实际是它自检到的 7 个宿主能力。

**根因**：
- list 卡片 resolver 返回 `{ value: string[] }`，而 UI 只接受 `string[]` 或 `{ items: string[] }`；
- progress 卡片 resolver 返回 `{ value, max }`，UI 只读取 `card.max`，忽略 resolver 的 max；
- 旧 AI 产物把 commands 的标题写成 `label`，而契约为 `title`；
- 提示词没有给出四种卡片的精确返回格式，模型只能猜。

**修复**：
- `PluginOverviewCards` 的 list 兼容 `{ value: [] }` 与 `{ items: [] }`；progress 同时读取 `card.max` 和 resolver 返回的 `max`；
- 插件页命令标题兼容 `title` / 旧 `label`；
- 提示词补充精确返回格式：metric → `{value,unit?}`，text → `{text}`，list → `string[]` 或 `{items}`，progress → `{value,max}`；commands 必须用 `title`；
- 保持严格 inject 校验与旧插件自动补齐（D-58）。

**验证**：复制用户实际 `plugin-probe.mjs` 与 `showcase-kit.mjs` 到临时数据目录，真实 Electron：
- plugin-probe 卡片正常（可用能力 7 是自检结果，不是错误）；
- showcase-kit “环境概览”显示平台/临时目录/数据目录/用户目录四行，临时目录 10.8 MB，候选进度 100；
- 0 JS 异常。

本次是 UI 兼容 + 提示词修正，**没有修改用户数据目录中的插件文件**。

### D-60 AI 插件说明、手动入口、项目上下文与生成计时

**现象**：
- 新生成插件没有说明，插件页只显示“外部原生插件”；
- widget/active 插件没有命令按钮，例如 super-panel 只有卡片，用户不知道如何触发或它做什么；
- 生成插件时只有“正在生成…”，没有耗时秒数；
- 提示词只描述契约，不知道项目目录、内置插件/任务，生成结果容易重复或偏离项目。

**修复**：
- 提示词要求 `export const description`；PluginManager 对旧插件按 kind/卡片数生成兜底说明（如“AI 工坊 Widget 插件：贡献 6 张概览卡片（自动刷新）”）；
- widget/active/desktop 提示词要求至少一个 commands（刷新/运行）并注册 `ctx.ui.command`；校验增加对应 warning；
- 插件页为有概览卡片的插件增加「查看概览卡片（N）」按钮；
- AI 提示词注入“项目上下文”：目录结构、宿主服务契约、UI 数据格式、内置清理任务清单（不发送源码/用户数据）；
- 生成弹窗每秒刷新「已等待 N 秒」。

**验证**：AI 原生插件测试断言请求体包含项目上下文；typecheck/build/UI E2E 通过；全量 54 文件 / 382 用例保持通过。

### D-61 AI 插件生成弹窗被误关后无法恢复

**现象**：点击「生成插件草稿」后，生成过程中点击弹窗外区域（或按 ESC）会关闭弹窗；界面没有进度入口，无法看耗时或取消。生成完成后弹窗不会自动重新出现，草稿像“消失”了，也无法继续安装插件。

**根因**：
- Element Plus dialog 默认 close-on-click-modal / close-on-press-escape 为 true；
- AI 生成是异步长任务，关闭弹窗只改变 UI，不取消/恢复任务；
- 没有“生成中/草稿待审阅”的持久入口。

**修复**：
- 生成中禁用点击遮罩关闭、ESC 关闭和右上角关闭按钮；
- 弹窗底部在生成中显示「取消生成」，点击后使本次请求结果失效并关闭（模型请求可能已发出，不保证服务端立刻中断）；
- 生成成功/失败后自动重新打开审阅弹窗；
- 生成中或已生成草稿但弹窗关闭时，AI 页保留持久横幅：显示已等待秒数、查看进度、取消生成；草稿可查看/放弃；
- 保留 v0.5.11 的每秒耗时显示与安装审阅流程。

**验证**：typecheck / build / 6 页面 UI E2E 通过；全量 54 文件 / 382 用例保持通过。

### D-62 系统信息 Node 版本与实时性

**现象**：顶栏显示系统 Node 24.22.1，但概览“系统信息”的 Node 版本显示 22.22.0（Electron 内置 Node）；信息像启动时固定，刷新按钮也只刷新 system/info。

**修复**：
- 概览 Node 行改为优先展示 `app/info.systemNode`（系统 PATH Node），单独显示“Electron Node”行并加 tooltip 区分；
- 操作系统显示 `platformLabel`（如 Windows 11）+ 真实 release（10.0.26100）；
- 系统信息卡片显示“采样于 HH:mm:ss”；
- 每次进入概览、点击刷新都会同时重新拉取 `system/info` 与 `app/info`，不再只读启动时缓存；
- 顶栏窗口聚焦刷新 app/info 的逻辑保持不变。

**验证**：typecheck / build / 6 页面 UI E2E 通过；全量 54 文件 / 382 用例保持通过。

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
