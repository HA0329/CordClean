# CordClean 威胁模型与信任边界

> 本文档如实描述 CordClean 的安全边界、已实现的防护与**已知残余风险**，供论文「系统安全分析」与答辩使用。
> 原则：不夸大防护范围 —— 哪些威胁被拦截、哪些不在范围内，都明确写出来。

## 1. 资产与攻击面

| 资产 | 说明 |
| --- | --- |
| 用户文件系统 | 清理工具会删除/移动文件，误删或越权删除是最高等级风险 |
| 隔离区与撤销凭据 | 误删后的恢复通道（`quarantine/manifest.jsonl`、`数据目录/.undo/last-clean.json`） |
| 注册表 | `startup` / `registry` / `leftovers` 会删除 Run/RunOnce、卸载项；删除前导出 `.reg` 备份 |
| AI API Key | 保存在数据目录 `config.json` 或环境变量 |
| 本机服务端口 | Web 外壳的 HTTP/WebSocket（默认 7801，仅回环） |
| 插件执行权限 | 内置插件与内核同进程；外部插件在 worker 中运行（**非安全沙箱**） |

威胁来源按优先级：

1. **本机其它程序/用户**（同一 Windows 账户下的恶意网页、恶意软件、浏览器扩展）—— 主要威胁模型；
2. **插件本身**（第三方插件代码不可信）—— 安装即信任，见 §3；
3. **界面/传输层被篡改或跨站调用** —— 见 §2；
4. 其他低概率因素（磁盘/文件系统竞态、进程崩溃、日志泄露）。

不覆盖：拥有管理员权限的本机恶意程序、物理访问、操作系统级内核攻击、多用户会话隔离。

## 2. 本地服务的信任边界（Web 外壳）

浏览器版内核在 `apps/web` 中启动，只监听 `127.0.0.1`，接口为 HTTP 静态资源 + `/api/rpc`（curl 调试）+ `/rpc`（WebSocket JSON-RPC）。

| 威胁 | 已实现的防护 | 位置 |
| --- | --- | --- |
| 本机其它网页跨站调用高权限 RPC（CSWSH/CSRF） | 每次启动用 `crypto.randomBytes(24)` 生成随机 token（base64url），注入 `index.html`；`/api/rpc` 与 WebSocket 握手均校验 token；WS 还校验 **Origin** 必须等于界面自身 origin（`http://127.0.0.1:<port>` / `http://localhost:<port>`），无 Origin 的原生客户端（curl/脚本）允许 | `packages/host/src/server.ts` |
| **DNS rebinding**（恶意域名解析到 127.0.0.1 后读取页面内 token） | 所有 HTTP 请求（含静态资源）先校验 **Host** 头，只允许 `127.0.0.1` / `localhost` / `[::1]`（带端口时端口必须匹配），否则 403 | `packages/host/src/server.ts` `isAllowedHost()` |
| 未认证请求打崩服务 | 畸形百分号编码、非法 URL 返回 400 而不是抛未捕获异常；WS `maxPayload` 限制 1 MB | `packages/host/src/server.ts` |
| 静态资源目录穿越 | 解析后的路径必须以静态目录 + 分隔符为边界，否则 403 | `packages/host/src/server.ts` |
| XSS / 外部资源加载 | 界面 `index.html` 带 CSP（`default-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`），`connect-src` 只允许自身与回环 WS/HTTP；渲染进程无 Node 集成 | `packages/ui/index.html`、`apps/desktop/src/main.ts` |

**已知残余风险**

- **同账户本机进程**：token 在页面内联、进程内可读；同一 Windows 用户下的恶意程序可以读进程内存/环境变量/浏览器页面，或直接调用本机端口。token 只能挡住「其它网页/跨站请求」这一类，不防同用户本机恶意软件。
- **`CORDCLEAN_UI_DIR` 被篡改**：若使用者自己把静态目录指向恶意内容，注入的 token 会进入恶意页面（属于使用者自担的本地配置风险）。
- **端口被占用/明文 HTTP**：仅回环通信，无 TLS；本机抓包可见 RPC 内容（本地攻击面，不额外防护）。
- 浏览器扩展若已获得页面读取权限，可读取页面内 token 并调用本机服务；本模型不覆盖已提权/已获页面权限的扩展。

## 3. 插件信任模型

### 3.1 内置插件 = 可信代码

内置插件（`packages/plugins/*`）通过 `packages/core/src/manifest.ts` 的 `import()` 懒加载，**与内核运行在同一 Node 进程**，拥有完整 `require`/`process.env`/文件系统能力。它们与内核一样属于「受信任代码」，安全依靠：

- 路径策略的辖区（`addRoot`）与保护根：插件只能清理自己声明过的目录；
- 清空白名单（`addClearRoot`）限制：只允许清空内容、不允许删目录；批次1 起拒绝盘符根、保护根及其祖先；
- 补偿链 + 执行器复核：删除必须经七步补偿链与令牌，执行器逐项再校验；
- 单元测试与审计脚本（`scripts/audit-plugins.ts`、`scripts/audit-rules.ts`）。

**这不是沙箱**：恶意内置插件代码可以绕过全部约定直接 `fs.rm`。因此"插件安全"的前提是**插件代码可信**。

### 3.2 外部插件：worker 仅故障隔离，不是安全沙箱

外部插件（安装到用户插件目录，`plugins/install`）通过 route 3A 的 worker 协议运行，但必须如实说明边界（见 `packages/core/src/domains/kernel/external-proxy.ts` 文件头注释）：

- worker 只提供**故障隔离**：崩溃/超时只影响该插件线程，不会拖垮主进程；
- 插件代码仍在同一进程内，可 `require('node:fs')`、`child_process`、读完整 `process.env` 与文件系统 —— **无法阻止恶意代码**；
- **能力声明（capabilities）只是安装时静态校验**，运行时并不强制：
  - `capabilities.fsRoots` 会校验任务的 `targets`，越界 target 的任务被跳过（不阻塞同插件合法任务）；
  - 外部插件**不会**获得 `addClearRoot`（清空白名单）授权，只能登记普通清理辖区（`addRoot`），辖区随插件卸载回收；
  - 仅 `PLUGIN_ENV_ALLOWLIST` 中的系统目录变量会经 `workerData.env` 暴露给插件上下文（`_API_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD`、`DEEPSEEK_*`、`OPENAI_*`、`DASHSCOPE_*` 一律过滤）——但插件若直接读 `process.env` 仍可看到全部变量；
  - worker 内**没有删除能力**：只能回传候选，删除由主进程补偿链 + 执行器完成。
- **安装即执行代码**：`plugins/install` / `plugins/install-native` 会在本机加载插件模块，安装不可信插件等同于允许其执行本机代码；界面会展示风险警告。
- **原生外部插件是完整 Cordis 插件**：通过 `ctx.plugin()` 加载，拥有完整 Node/Cordis 权限，可注册 UI、窗口、服务；插件 iframe 页面与独立 BrowserWindow 只是 UI 隔离，不是插件沙箱。
- **持久化外部插件会随启动自动加载**：外部插件路径记录在 `settings.plugins[id].externalPath`，应用启动时会自动重新执行其 `apply()`，等同于开机自启动代码；只应安装可信插件，不用时请卸载。
- **AI 工坊的第三方依赖**：允许插件声明 npm 依赖，用户确认后由宿主在插件目录执行 `npm install --ignore-scripts`（失败回落 pnpm），再加载插件。供应链风险由用户确认与版本锁定缓解，但**依赖包本身仍以完整 Node 权限运行**；禁用 lifecycle scripts 只能阻止安装期脚本，不能阻止包代码在 import 时执行。恶意依赖与恶意插件代码等价。

**残余风险**：恶意外部插件可以读取文件、发起网络请求、读取同进程内其它服务状态，甚至直接删除文件绕过补偿链。CordClean 的目标是「故障隔离 + 能力收窄 + 风险提示」，不是插件沙箱；生产使用应只安装签名/可信来源插件（签名校验尚未实现）。

## 4. 删除安全链与威胁覆盖

删除路径：`扫描 → 用户选择 → clean/start(itemIds) → 补偿链七步 → 执行器 recheck → 隔离区/回收站/永久删除`。

| 威胁 | 覆盖方式 |
| --- | --- |
| 界面被篡改、回传任意路径 | `clean/start` 只接受 `itemIds`，从最近一次扫描结果按 id 解析，不信任回传内容 |
| 插件越权删未声明目录 | 辖区白名单（`addRoot`）+ 路径策略判定 |
| 误删系统/用户重要目录 | 保护根 + 名称黑名单 + 拒绝盘符根/保护根祖先 + 尾点/短名/长路径/UNC 规范化（fail-closed） |
| 辖区内 junction/symlink 穿透 | 扫描期标记 + 执行前链接祖先复核 + `findLinkAncestor` |
| 清理过程中文件被改/删（预览失真） | 预览一致性检查（大小/存在性；不一致比例 > 5% 整批中止） |
| 一次性清空范围过大 | 预算上限 + 高风险默认不勾选 + 高风险项强制隔离 + 确认摘要 |
| 计划任务被静默用于自动删除 | `clean` 模式需显式授权；授权指纹绑定 `taskIds`/`mode`/`everyMinutes`；`revoke` 清空计划授权 |
| 撤销/恢复被误触发 | 只有隔离区项显示为可撤销；全部恢复成功后才清空撤销凭据 |
| 设置被原型链污染 | `settings` 拒绝 `__proto__`/`prototype`/`constructor` 与未知段，异常段自愈 |

**已知残余风险**

- **TOCTOU（检查与删除之间）**：路径策略、链接祖先检查与预览一致性都是在删除前读取；同用户恶意程序可在检查与 `fs.rm` 之间的窗口替换文件/目录或插入 junction。缓解：执行器删除前再次 `lstat`/复核链接祖先，窗口被压缩但不为零；无法在纯 Node 层完全消除（需要文件句柄/事务型删除）。
- **隔离区可被本机用户篡改**：`manifest.jsonl` 是普通文本，同用户可改恢复路径；恢复接口按 manifest 路径移动文件，若 manifest 被伪造，恢复可能移动到意外位置（仅在用户主动点恢复时触发）。
- **撤销凭据**：`.undo/last-clean.json` 明文记录路径；同用户可读（本机同用户攻击面的一部分）。
- **AI Key 明文**：`config.json` 中 `apiKey` 明文（本机同用户可读）；环境变量方式同样明文。未做 DPAPI/凭据管理器加密。
- **日志/导出**：日志与 AI 脱敏画像不含路径/文件名，但清理历史、错误信息与导出文件可能包含本机路径。
- **规则库自身可被改**：`catalog.json`/`extra.json` 或用户自定义规则被本机用户修改后，可能产生新的清理目标（仍受路径策略/清空白名单/补偿链约束）。
- **回收站删除依赖系统脚本**：回收站批量删除由 PowerShell 脚本执行，虽用参数化/JSON 清单传递路径（无命令拼接），仍依赖系统 PowerShell 的可用性与正确性。
- **管理员权限**：需要管理员的清理（Prefetch、HKLM、系统日志）在非提权时降级/报错，但提权后误操作影响面更大。

## 5. 披露与负责任使用

- 本工具是本地个人项目，不提供远程服务、不上传文件（AI 功能只发送脱敏画像）；
- 发现安全问题请通过仓库 Issue/课程渠道反馈，不要直接公开可利用细节；
- 修改安全相关代码时务必运行 `pnpm test:security` 与 `tests/host-server.test.ts`、`tests/batch1-hardening.test.ts`、`tests/paths-normalize.test.ts` 回归。
