# 侧边栏与功能区域导航（基底设计 + 分区域升级清单）

> 目标：把「左侧功能区域」从一份写死在 `App.vue` 的数组，升级成**唯一事实来源、可测试、可扩展**的导航基底；
> 然后按区域逐个达标：好用、实用、方便未来改造、无安全风险、无 bug。
>
> 本文是这套基底的说明书，也是后续「每个功能区独立完成」的验收清单。

## 1. 设计原则

1. **单一事实来源**：区域、分组、图标、快捷键、标题全部来自 `packages/ui/src/navigation.ts`，
   `App.vue`、侧边栏组件、e2e 脚本、后续新页面都不再各自维护一份。
2. **不规则使用优先**：用户可能从搜索、键盘、深链接、浏览器前进/后退、扫描中途切页面等任何路径进来。
   所有入口统一经过 `resolvePage()`：未知页面回概览，非活动瞬态页回清理页，绝不白屏。
3. **进行中永远可见**：扫描/清理进行中时，侧边栏会多出「扫描进行中 / 清理进行中」入口，
   清理区域还有状态徽标；用户切走再切回不会丢失进度页。
4. **可测试**：导航模型是纯函数（无 DOM、无 localStorage 依赖），
   `tests/ui-navigation.test.ts` 覆盖解析、快捷键、过滤、偏好容错与徽标。
5. **安全边界不扩大**：侧边栏不引入 `v-html`、不拼 HTML、不请求网络；localStorage 只存折叠/分组/上次页面；
   CSP 与现有外壳配置不变。

## 2. 区域与分组

顺序即 `Alt+1` … `Alt+7` 的顺序。

| # | 区域 id | 标签 | 分组 | 图标 |
| --- | --- | --- | --- | --- |
| 1 | `overview` | 概览 | 开始 | home |
| 2 | `clean` | 扫描与清理 | 清理 | broom |
| 3 | `plugins` | 插件 | 扩展 | puzzle |
| 4 | `workshop` | AI 插件工坊 | 扩展 | flask |
| 5 | `ai` | AI 清理顾问 | 智能 | sparkles |
| 6 | `history` | 历史与隔离区 | 记录 | clock |
| 7 | `settings` | 设置 | 系统 | gear |

瞬态页（不是稳定区域，只在对应任务进行中出现）：

| 页面 id | 标签 | 父区域 | 进入条件 |
| --- | --- | --- | --- |
| `scanning` | 扫描进行中 | clean | `state.scanning === true` |
| `cleaning` | 清理进行中 | clean | `state.cleaning === true` |

## 3. 路由规则（Robustness）

- hash 是唯一深链接形式：`#overview`、`#clean` …… `#scanning` / `#cleaning`。
- 首次挂载：**hash 优先** → 其次 `cordclean.nav.lastPage` → 最后概览。
- 浏览器前进/后退监听 `hashchange`，与点击侧边栏走同一套 `resolvePage()`。
- 瞬态页深链接：任务不在进行中时自动回落到 `clean`，不会出现「进度页空转」。
- 每次页面变化：同步 hash、更新 `document.title`（`CordClean · 概览` 等）、记录 lastPage、内容区滚回顶部。

## 4. 交互规则

| 交互 | 行为 |
| --- | --- |
| 点击区域 | 切换页面，清理搜索词 |
| `Ctrl/Cmd + K` | 聚焦侧边栏搜索；折叠时自动展开 |
| 搜索框 `↓` / `↑` | 把焦点移到结果列表 |
| 搜索框 `Enter` | 打开第一个/高亮结果 |
| 搜索框 `Esc` | 清空搜索；再按失焦 |
| `Alt + 1..7` | 直接切换对应区域（不用 Ctrl+数字，避免和浏览器标签页冲突） |
| `Alt + ↑/↓` | 按区域顺序循环切换（纯键盘也能逛完） |
| `↑/↓/Home/End` | 在侧边栏按钮间移动焦点 |
| 折叠按钮 | 232px ↔ 68px 图标轨；折叠状态持久化 |
| 分组标题 | 折叠/展开分组（持久化；搜索时自动只显示命中分组） |

## 5. 状态徽标

| 区域 | 徽标 | 来源 |
| --- | --- | --- |
| 清理 | 扫描中 / 清理中 | `state.scanning` / `state.cleaning` |
| 插件 | `N 异常` | `state.plugins[].status === 'error'` |
| 历史与隔离区 | 待恢复数量（>999 显示 999+） | `state.quarantineStats.count` |
| AI 清理顾问 | 未配置 | `state.aiStatus.configured` |

## 6. 持久化键

| key | 内容 | 容错 |
| --- | --- | --- |
| `cordclean.nav.collapsed` | `'1'` / `'0'` | 非法值按展开处理 |
| `cordclean.nav.groups` | `{"extend":false}` 等分组展开状态 | 坏 JSON/未知分组/非布尔值全部丢弃 |
| `cordclean.nav.lastPage` | 上次停留的稳定区 id | 非法值回概览 |
| `cordclean.theme` | 亮/暗主题（历史键） | 非法值按亮色 |

## 7. 新增一个功能区域（未来改造步骤）

1. `packages/ui/src/navigation.ts`：在 `NavAreaId` 加 id，`NAV_AREAS` 加一条（标签/分组/图标/关键词/说明）。
2. `packages/ui/src/components/AreaIcon.vue`：若用新图标，补一个 `<template v-else-if>` 分支。
3. 新建 `views/XxxView.vue`，页面顶部统一使用 `cc-page-title > h1` 结构（e2e 依赖）。
4. `App.vue` 的 `views` 映射加一行。
5. `scripts/e2e-ui.mjs` 的 `expected` 加 `{ page: 'xxx', title: '...' }`；`tests/ui-navigation.test.ts` 的覆盖数量会自动校验。
6. 运行：`pnpm typecheck:ui`、`pnpm exec vitest run tests/ui-navigation.test.ts`、`pnpm build:ui`、`node scripts/e2e-ui.mjs`。

## 8. 各功能区独立升级清单（长期任务）

> 每个区域独立完成，验收标准统一：
> **三态（空/加载/错误）齐全 + 鼠标/键盘混合操作可达 + 操作失败有明确原因 + 无 console 报错 + e2e 截图通过。**

| 区域 | 本轮状态 | 待独立完成 |
| --- | --- | --- |
| 概览 | ✅ 已升级（2026-11-23） | 完成：骨架屏/错误重试/有缓存时失败不白屏；快捷动作统一（刷新/复制摘要/一键扫描，不可用给原因）；磁盘 ≥90% 主动提醒并直达清理；最近清理摘要 + 空状态引导（一键扫描/去清理页）；自动采样只在窗口可见时进行、切回立即补采；系统摘要可一键复制 |
| 扫描与清理 | 扫描/结果/选择/清理链路完整 | 扫描中离开再回来的上下文恢复、结果筛选记忆、异常项汇总、空扫描结果引导 |
| 插件 | 启停/配置/外部插件安装 | 插件异常详情、依赖关系可视化、批量启停、安装/卸载失败回滚提示 |
| AI 插件工坊 | 生成/校验/安装链路 | 草稿历史、重新生成/对比、失败原因结构化、配置缺失引导 |
| AI 清理顾问 | 分析/建议/应用链路 | 未配置时的引导页、建议分组与批量勾选、请求失败的降级说明 |
| 历史与隔离区 | 历史列表/隔离区恢复 | 历史详情、按任务/时间筛选、批量恢复/清空确认、撤销失败原因 |
| 设置 | 分区配置完整 | 分组内搜索、修改未保存提示、恢复默认、危险项二次确认 |

## 9. 验证命令

```bash
pnpm typecheck:ui                                   # Vue 类型
pnpm exec vitest run tests/ui-navigation.test.ts    # 导航模型单测
pnpm build:ui                                       # 生产构建
node scripts/e2e-ui.mjs                             # Electron 真机点 7 个区域 + 真实扫描
```
