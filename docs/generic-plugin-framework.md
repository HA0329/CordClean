# 通用插件框架（P1 实施记录）

> 目标：外部插件与内置插件使用同一套 Cordis 契约，拥有完整 ctx（服务/事件/生命周期），
> 可以贡献声明式 UI；AI 工坊后续按这套契约生成“通用插件包”。
> P2（插件市场）暂不做。

## 1. 插件形态

原生外部插件是标准 ESM 模块：

```js
export const name = 'hello-widget'
export const inject = ['ui']          // 需要用到 ctx.ui 时必须声明
export const kind = 'widget'          // cleaner | widget | active | desktop | integration
export const contributes = {
  overviewCards: [{ id: 'hello', title: 'Hello', type: 'text' }],
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.ui.resolve('hello-widget', 'hello', () => ({ value: 42 })),
  )
}
```

- 通过 `ctx.plugin()` 加载，拥有 Cordis 完整生命周期：
  - `inject` 依赖服务；
  - `ctx.effect()` 自动清理定时器/监听；
  - `ctx.on/emit` 事件；
  - 启停/卸载由 PluginManager fiber 管理。
- 与内置插件同权（可信代码）；安装时提示风险。
- 旧式 cleaner worker 插件继续兼容，不影响现有插件。

## 2. UI 贡献契约

插件可以声明：

```ts
interface PluginUiContributions {
  overviewCards?: UiCardContribution[]
  pages?: UiPageContribution[]
  statusItems?: UiStatusItemContribution[]
  commands?: UiCommandContribution[]
}
```

- `overviewCards`：`metric/text/list/progress` 四种宿主固定组件；
- 卡片/状态项通过 `ctx.ui.resolve(pluginName, id, fn)` 提供数据；
- 宿主只渲染声明式结构，不让插件直接注入 DOM；
- 贡献与解析器随插件禁用/卸载自动清理。

宿主 RPC：

- `ui/contributions`：列出全部贡献；
- `ui/resolve`：读取一个解析器结果（限制 256KB）。

## 3. 安装/持久化

- 原生插件通过 `plugins.installNativePlugin(filePath)` 安装；
- 记录 `externalPath` + `externalType: 'native'` 到 settings；
- 重启自动重新加载；
- 禁用保留文件和记录，启用时重新注册贡献；
- 卸载删除记录（工坊生成的文件由宿主一并清理）。

## 4. 当前进度（P1 完成）

- [x] 通用插件类型/UI 贡献类型（`packages/shared/src/plugin-api.ts`）
- [x] `ctx.ui` 贡献注册服务（`packages/core/src/domains/kernel/ui.ts`）
- [x] 原生外部 Cordis 插件加载、持久化、启停/卸载
- [x] `ui/contributions`、`ui/resolve`、`plugins/install-native` RPC
- [x] 概览页渲染插件声明式卡片（`packages/ui/src/components/PluginOverviewCards.vue`）
- [x] AI 工坊生成原生 Cordis 通用插件（kind/inject/contributes/apply + 依赖）
- [x] 插件 iframe 页面：sandbox + postMessage resolve 桥（P1.5）
- [x] 主动事件推送/通知：`ctx.ui.emit()` / `ctx.ui.notify()` → 事件桥 → UI 刷新
- [x] statusItems 顶栏渲染 + commands 插件页按钮 + `ui/command` RPC
- [x] Electron 窗口/托盘：`ctx.window.open()/createTray()`（仅桌面壳）
- [ ] 插件市场（P2，暂缓）

### 概览卡片渲染

- `OverviewView` 引入 `PluginOverviewCards`，从 `ui/contributions` 拉取卡片，从 `ui/resolve` 拉数据；
- 支持 metric / text / list / progress 四种类型；
- 每张卡片按 `refreshMs`（最小 1 秒）定时刷新，最多 12 张；
- 插件禁用/卸载后，贡献与刷新自动停止；
- 真实 Electron 自检：测试插件声明 `P1 卡片` + resolve 返回 123，概览正确渲染，0 JS 异常。

### AI 工坊生成通用插件

- `draftPlugin` 改用原生契约：`export const name/kind/inject/contributes` + `export function apply(ctx)`；
- 生成端与安装端共用 `checkPluginSource(..., { mode: 'native' })` 校验；
- `ai/plugin/install` 增加 `native` 模式，保存后走 `installNativePlugin`；
- UI 安装时显示插件类型，安装后提示“重启自动加载”；
- 真实 Electron 自检：AI 生成 widget 插件 → 安装 → 概览渲染 `AI 卡片 / ok`，0 JS 异常。

### iframe 插件页面

插件可贡献自包含 HTML 页面：

```js
export const contributes = {
  pages: [{
    id: 'my-page',
    title: '我的页面',
    mode: 'iframe',
    html: '<!doctype html><html><body><button id="b">取数据</button><pre id="out"></pre>'
      + '<script>const id=1; parent.postMessage({type:"cordclean/plugin-page",id,method:"resolve",resolverId:"my-data"},"*");</script>'
      + '</body></html>',
  }],
}
```

- 宿主用 `sandbox="allow-scripts"` 的 **data URL iframe** 加载，不给 same-origin，页面不能访问主界面 DOM/存储；
- 页面请求：
  ```js
  parent.postMessage({ type: 'cordclean/plugin-page', id, method: 'resolve', resolverId, params }, '*')
  ```
- 宿主响应：
  ```js
  { type: 'cordclean/plugin-page-result', id, ok: true, value } // 或 ok:false,error
  ```
- 插件页按钮在插件卡片出现为「插件页面」，打开弹窗沙箱运行；
- 页面 HTML 属于插件可信代码，安装前仍需审阅。

### 主动事件、状态栏与命令

- active 插件可调用：
  ```js
  ctx.ui.emit(name, 'data-changed', { value: 1 })      // 主动刷新 UI 卡片
  ctx.ui.notify(name, { title: '提醒', message: '...', level: 'success' })
  ```
- 事件经主进程事件桥（`plugin/ui-event`、`plugin/notify`）转发到客户端；
- 客户端概览卡片监听事件序号立即重新 resolve，不必等轮询；
- `contributes.statusItems` 渲染到顶栏，`commands` 渲染为插件页按钮；
- 命令由插件用 `ctx.ui.command(name, id, handler)` 注册，宿主通过 `ui/command` RPC 调用。

### Electron 窗口/托盘

- 仅桌面壳注入后端；浏览器壳 `ctx.window.available === false`；
- 插件：
  ```js
  export const inject = ['window']
  const { id } = await ctx.window.open(name, {
    id: 'pet', html: '<h1>pet</h1>', width: 200, height: 120,
    transparent: true, alwaysOnTop: true, clickThrough: true,
  })
  ctx.window.close(name, id)
  ctx.window.createTray(name, { tooltip, iconDataUrl, items, onSelect })
  ```
- 窗口是独立 `BrowserWindow`：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，禁止导航/新窗口；
- 插件停用/卸载时自动关闭该插件的全部窗口与托盘；
- 未提供具体插件；桌宠/悬浮窗只是能力演示方向。

## 5. 安全边界

原生外部插件拥有完整 Node 权限，这是“和 DeepSeek Harness 一样的可信插件模型”：

- 安装前必须展示来源/权限/代码审阅；
- 声明式卡片只接受固定组件结构；自定义页面走 sandbox iframe（无 same-origin、无宿主 DOM 访问）；
- 不把“外部插件”误当作安全沙箱；真正的权限隔离需要进程级沙箱，不在 P1。
