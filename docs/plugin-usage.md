# 插件怎么用：cleaner / active / widget / desktop

> 这份文档回答一个常见问题：插件装好之后，怎么真正用起来？
> 结论：插件是**能力提供者**。清理任务由扫描/定时任务驱动；active/widget/desktop 插件在启用后可以主动运行或贡献 UI。

## 1. 插件类型

| kind | 作用 | 怎么“启动” |
|---|---|---|
| `cleaner` | 注册清理任务，扫描时 emit 候选 | 清理页勾选任务扫描，或插件页「扫描此插件」 |
| `active` | 后台逻辑：定时器、事件监听、通知、主动刷新 UI | 插件页启用即运行，`apply(ctx)` 中的 `ctx.effect` 负责生命周期 |
| `widget` | 概览卡片、状态栏、命令、iframe 页面 | 启用后自动出现在概览/顶栏/插件页 |
| `desktop` | 悬浮窗、透明置顶窗口、托盘 | 插件命令触发 `ctx.window.open/createTray`（仅 Electron 桌面壳） |

所有插件都通过同一套原生 Cordis 契约加载；旧式 worker cleaner 插件仍兼容。

## 2. cleaner：扫描时运行

1. 打开「插件」页，确认插件是「运行中」；
2. 打开「清理」页，勾选该插件的任务（AI 生成插件默认 `defaultSelected: false`）；
3. 点「开始扫描」；
4. 在分组总览/逐项明细中确认结果，选择后清理。

从插件页也可以直接开始：

- 外部插件卡片点「**扫描此插件**」→ 跳到清理页并只扫描该插件的任务；
- 结果出来后仍按普通流程确认、清理。

清理任务只负责 emit 候选；真正删除始终由内核补偿链 + 回收站/隔离区执行。

## 3. active：启用即运行

active 插件在 `apply(ctx)` 里注册后台逻辑：

```js
export const name = 'my-active'
export const kind = 'active'
export const inject = ['ui']

export function apply(ctx) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      ctx.ui.emit(name, 'tick', { at: Date.now() })
    }, 1500)
    return () => clearInterval(timer)
  })
}
```

- 插件页启用后即运行；停用/卸载时 Cordis 自动执行 `ctx.effect` 的清理；
- 可用 `ctx.ui.emit()` 主动刷新概览卡片，用 `ctx.ui.notify()` 弹通知；
- 可用 `ctx.on/ctx.emit` 订阅内核事件；
- **仍然不能绕过删除安全链**：主动插件只能扫描/通知/展示，删除必须走用户确认与补偿链。

## 4. widget：界面贡献

启用后自动出现：

- `contributes.overviewCards` → 概览页卡片（metric/text/list/progress）；
- `contributes.statusItems` → 顶栏状态；
- `contributes.commands` → 插件页命令按钮；
- `contributes.pages` → 插件页「插件页面」按钮，打开 sandbox iframe；
- 数据通过 `ctx.ui.resolve(name, id, fn)` 提供，命令通过 `ctx.ui.command(name, id, fn)` 注册。

## 5. desktop：悬浮窗/托盘

仅在 Electron 桌面壳可用，浏览器壳 `ctx.window.available === false`。

```js
export const inject = ['window']
const { id } = await ctx.window.open(name, {
  id: 'pet', html: '<h1>pet</h1>', width: 200, height: 120,
  transparent: true, alwaysOnTop: true, clickThrough: true,
})
ctx.window.createTray(name, { tooltip: '我的插件', items: [{ id: 'show', label: '显示' }], onSelect })
```

- 窗口是独立 BrowserWindow（`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`）；
- 插件停用/卸载会自动关闭它的窗口和托盘。

## 6. 定时任务：驱动 cleaner

1. 插件页对目标插件点「**加入定时任务**」；
2. 自动跳到「设置 → 定时任务」，并把该插件的任务预选进当前计划；
3. 设置间隔/每天时间，选择“只扫描并通知”或“自动清理安全项”；
4. 点「保存」；
5. 自动清理模式还需要点「授权自动清理」（规则或任务范围变化会使授权失效）。

## 7. 持久化与卸载

- 安装成功后会记录插件路径、启用状态和配置；
- 重启应用会自动重新加载（文件位于数据目录 `generated-plugins/`）；
- **停用/关闭开关**只释放任务与辖区，**不删除文件**，可随时再启用；
- **卸载并删除**只对外部插件显示：删除工坊生成的插件文件与依赖目录，无法恢复；
- 内置插件没有“卸载”，只有「停用/启用」；
- 用户手工指定的外部 .mjs 文件在卸载时只解除加载，不删除用户文件（避免误删）；
- 安装失败、依赖下载失败、加载失败会自动回滚删除本次生成文件；
- 启动时会清理没有持久化记录的工坊残留。

## 8. 依赖型插件

AI 工坊可声明 npm 依赖（如 `fast-glob`、`yauzl`）：

- 安装前必须在弹窗确认依赖清单；
- 依赖安装到 `generated-plugins/<name>/node_modules`；
- 安装时禁用 lifecycle scripts，但仍请注意：**依赖代码在 import 时拥有完整 Node 权限**；
- 卸载插件会删除依赖目录；npm/pnpm 全局缓存会保留（共享缓存）。

## 9. 安全提醒

- 原生外部插件是**可信代码**，拥有完整 Node/Cordis 权限；
- UI 卡片/iframe 页面/悬浮窗只是 UI 隔离，不是插件沙箱；
- 安装前审阅代码，只安装可信来源插件；第三方依赖与插件同权。
