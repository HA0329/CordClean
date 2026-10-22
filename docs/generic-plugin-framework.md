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

## 4. 当前进度（P1.1）

- [x] 通用插件类型/UI 贡献类型（`packages/shared/src/plugin-api.ts`）
- [x] `ctx.ui` 贡献注册服务（`packages/core/src/domains/kernel/ui.ts`）
- [x] 原生外部 Cordis 插件加载、持久化、启停/卸载
- [x] `ui/contributions`、`ui/resolve`、`plugins/install-native` RPC
- [ ] UI 概览渲染贡献卡片（P1.2）
- [ ] 插件页面/iframe 沙箱（P1.3）
- [ ] AI 工坊生成通用插件包（P1.4）
- [ ] 主动生命周期/通知/窗口能力（后续阶段）

## 5. 安全边界

原生外部插件拥有完整 Node 权限，这是“和 DeepSeek Harness 一样的可信插件模型”：

- 安装前必须展示来源/权限/代码审阅；
- UI 贡献只接受声明式结构，iframe 页面后续用 sandbox；
- 不把“外部插件”误当作安全沙箱；真正的权限隔离需要进程级沙箱，不在 P1。
