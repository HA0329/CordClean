# AI 插件工坊真实模型验收（2026-10-26）

- 运行时间：2026-10-26T09:39:09.942Z ~ 2026-10-26T09:41:33.816Z
- 使用隔离数据目录（真实 API Key；测试插件安装到临时 dataDir，结束后卸载）
- 结果：**4/4 个可安装用例通过**；另有 1 个 desktop 草稿生成+校验通过（Web 外壳无 window 服务，不安装）

## cleaner：cleaner：扫描 %TEMP% 下超过 7 天的 .log

- 需求：写一个 cleaner 插件，插件 id 用 test-temp-logs，任务 id 用 test-temp-logs-task：只扫描 %TEMP% 下超过 7 天的 .log 文件并报告大小，绝不删除文件，只 emit 候选。
- 草稿：name=`test-temp-logs`，kind=`cleaner`，format=`package`，files=index.mjs，代码 2074 B
- 校验：ok=true，errors=0，warnings=1
- 安装：`external:test-temp-logs`
  - ✅ multi-file-output：files=1
  - ✅ plugin-list：enabled=true status=active manifest=test-temp-logs
  - ✅ tasks：test-temp-logs-task/过期临时日志文件（>7 天）
  - ✅ ui-contributions：（cleaner 插件无需 UI 贡献）
  - ✅ scan：items=0 bytes=0 errors=0 elapsedMs=206
  - ✅ uninstall：已移除

## widget：widget：概览卡片显示时间与 C 盘可用空间

- 需求：写一个 widget 插件，插件 id 用 test-widget-clock：在概览页用 overviewCards 显示两行信息（当前时间、C 盘可用空间），提供“刷新数据”命令；数据通过 ctx.ui.resolve 返回，只读系统信息，不修改文件。
- 草稿：name=`test-widget-clock`，kind=`widget`，format=`package`，files=index.mjs，代码 2896 B
- 校验：ok=true，errors=0，warnings=1
- 安装：`external:test-widget-clock`
  - ✅ multi-file-output：files=1
  - ✅ plugin-list：enabled=true status=active manifest=test-widget-clock
  - ✅ tasks：（无新增任务）
  - ✅ ui-contributions：pages=0 cards=2 status=0 commands=1
  - ✅ resolve:clock-now：{"text":"2026-10-26 17:39:39"}
  - ✅ resolve:disk-free：{"value":"105","unit":"GB"}
  - ✅ command:refresh-data：{"time":"2026-10-26 17:39:39","disk":{"value":"105","unit":"GB"}}
  - ✅ uninstall：已移除

## active：active：命令 + 通知自检

- 需求：写一个 active 插件，插件 id 用 test-active-selfcheck：注册“运行自检”命令，执行时用 ctx.ui.notify 发送一条通知并返回自检结果；不要创建常驻定时器，不要访问文件系统。
- 草稿：name=`test-active-selfcheck`，kind=`active`，format=`package`，files=index.mjs，代码 2021 B
- 校验：ok=true，errors=0，warnings=1
- 安装：`external:test-active-selfcheck`
  - ✅ multi-file-output：files=1
  - ✅ plugin-list：enabled=true status=active manifest=test-active-selfcheck
  - ✅ tasks：（无新增任务）
  - ✅ ui-contributions：pages=0 cards=0 status=1 commands=1
  - ✅ command:run-selfcheck：{"ok":true,"message":"全部 4 项检查通过","checks":[{"id":"plugin-loaded","label":"插件已加载","ok":true},{"id":"ui-service","label":"ctx.ui 服务可用","ok":true},{"id":"no-timer","label":"未创建常驻定时器","ok":true},{"id":"n
  - ✅ uninstall：已移除

## page：多文件插件包：client/index.html 独立页面

- 需求：写一个多文件插件包：插件 id 用 test-page-disk，kind widget，入口 index.mjs；client/index.html 是自包含页面，通过 postMessage 的 cordclean/plugin-page 协议 resolve 数据，展示磁盘使用表格；manifest.client 写 {"mode":"page","entry":"client/index.html"}。
- 草稿：name=`test-page-disk`，kind=`widget`，format=`package`，files=index.mjs, client/index.html，代码 4810 B
- 校验：ok=true，errors=0，warnings=1
- 安装：`external:test-page-disk`
  - ✅ multi-file-output：index.mjs, client/index.html
  - ✅ plugin-list：enabled=true status=active manifest=test-page-disk
  - ✅ tasks：（无新增任务）
  - ✅ ui-contributions：pages=0 cards=1 status=0 commands=1
  - ✅ resolve:disk-usage：{"value":51.9,"max":100}
  - ✅ command:refresh-disks：{"ok":true,"updatedAt":1793007679362,"count":2,"error":null}
  - ✅ client-page：url=/plugin-assets/test-page-disk/index.html status=200 bytes=11033
  - ✅ uninstall：已移除

## desktop-draft：desktop 悬浮窗插件（仅生成+校验）

- 需求：写一个 desktop 插件，插件 id 用 test-desktop-clock：用 ctx.window.open 打开一个小悬浮窗显示当前时间，提供“刷新时间”命令；只读系统时间，不访问文件。
- 草稿：name=`test-desktop-clock`，kind=`desktop`，format=`package`，files=index.mjs
- 校验：ok=true，errors=0，warnings=2
  - ✅ 生成：desktop 类型识别正确
  - ✅ 校验：入口源码与清单通过静态契约
  - ⚠️ widget/active/desktop 插件应至少提供一个 commands 按钮（如刷新/运行）并在 apply 中用 ctx.ui.command 注册，否则插件页没有手动入口
- 安装：按设计跳过（Web 外壳没有 window 服务；desktop 插件需在 Electron 外壳中验证悬浮窗）

## 过程中发现并修复的问题

- `ui/contributions` / `ai/workshop/status` 对空参数 `{}` 误报“参数校验失败”：已放宽为接受空对象；
- 模型有时把完整插件包 JSON 放在 message content 而不是 tool_calls：已增加“文本 JSON → 工具参数”的兼容提取；
- 模型清单字段不完整（缺 id/name/version/entry、engines 写成 >=1.0.0、permissions.network 写成字符串、fsRoots 含盘符根、client 非对象）：已对 AI 生成包做字段补齐、engines 修正、权限清洗、client 修正；
- 模型漏写 `inject`（如 cleaner 用了 ctx.cleaner/system 却没声明）：已按实际使用自动补全 inject；
- 模型漏导出 `contributes.commands`（active 插件只有命令实现、没有按钮入口）：已自动补全 commands 贡献；
- 强制多文件后，`page` 用例稳定输出 `index.mjs + client/index.html`，并能通过 `plugins/client-url` 加载页面（11 KB HTML）。
