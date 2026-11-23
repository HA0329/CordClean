# E8 实验设计：插件依赖响应验证

> 对应论文设计属性：**Cordis `inject` 的响应式依赖 → provider 服务变化时 consumer 自动挂起/恢复**。
> 实验代码：[tests/e8-dependency.test.ts](../../tests/e8-dependency.test.ts)（自动化，可重复运行）。
> 首次执行日期：2026-11-14；实验执行版本：CordClean 0.6.9；当前发布版本：0.6.11。

## 1. 实验目标

验证 Cordis 的依赖注入不是“启动时拿到一次服务引用”，而是运行时响应依赖：

> 当 consumer 插件通过 `inject` 依赖 provider 提供的服务时，provider 被禁用后 consumer 应自动进入挂起状态（effect 清理、任务/服务不可用）；provider 重新启用后 consumer 应自动恢复，无需手动启用 consumer。

E8 与 E7 互补：

- E7：插件**自身卸载**时，`ctx.effect` 登记的资源是否回收；
- E8：**依赖提供者变化**时，依赖者是否被 Cordis 自动挂起/恢复。

## 2. 研究假设

| 编号 | 假设 | 判定 |
| --- | --- | --- |
| H8-1 | provider 启用后，服务可被访问；consumer 启用后 fiber 为 ACTIVE、任务存在 | 服务可用，consumer ACTIVE |
| H8-2 | 运行中禁用 provider，consumer 自动挂起（fiber PENDING），其 effect 被清理，任务消失、服务不可用 | PENDING + task=false + service=false |
| H8-3 | 重新启用 provider，consumer 自动重新 setup 并恢复；不需要手动 enable consumer | consumer ACTIVE、setup 计数增加、任务与 ping 恢复 |
| H8-4 | 观察兼容性：插件管理器的运行时 status 是否与 Cordis fiber 状态一致 | 记录差异（不作为期望行为） |

## 3. 实验变量

### 自变量

- provider 的运行状态：启用 / 禁用 / 重新启用；
- consumer 始终声明 `inject: ['e8Service', 'cleaner']`，不手动重载。

### 因变量

| 指标 | 采集方式 |
| --- | --- |
| provider / consumer 运行时状态 | `app.ctx.plugins` 的管理记录 `status` |
| Cordis fiber 状态 | `fiber.state`（PENDING / ACTIVE / DISPOSED 等） |
| consumer 任务是否注册 | `ctx.cleaner.list()` 是否含 `e8-consumer-task` |
| 服务是否可用 | `ctx.e8Service.ping()` 是否可调用 |
| setup / teardown 次数 | 夹具内计数器 + 生命周期日志 |
| 状态迁移序列与时间 | 每次操作后快照 `atMs`、状态、任务、服务、计数器 |

### 控制变量

- 同一个 `createApp`、同一个临时数据目录；
- 两个插件默认禁用，显式按 provider → consumer 顺序启用；
- provider 和 consumer 使用相同的启用/禁用 API；
- 每次状态变化后等待 30ms 再快照，保证 Cordis 依赖传播完成。

## 4. 夹具设计

### 4.1 Provider

```ts
const provider = {
  name: 'e8-provider',
  apply(ctx) {
    const service = { ping: () => 'pong' }
    ctx.effect(() => ctx.reflect.provide('e8Service', service), 'e8/provider')
  },
}
```

Provider 的服务通过 Cordis 反射 `provide` 注册，并挂在 `ctx.effect` 中；禁用 provider 时服务与 fiber 一并回收。

### 4.2 Consumer

```ts
const consumer = {
  name: 'e8-consumer',
  inject: ['e8Service', 'cleaner'],
  apply(ctx) {
    ctx.effect(() => ctx.cleaner.define({ id: 'e8-consumer-task', ... }), 'e8/consumer')
  },
}
```

consumer 依赖 provider 的 `e8Service`；任务只是可观测的副作用，用来确认 consumer 的 effect 是否随依赖变化被清理/重建。

## 5. 实验步骤

1. `createApp`，两个插件默认禁用；记录初始状态；
2. 启用 provider；确认 provider ACTIVE、服务可用、consumer 仍 stopped；
3. 启用 consumer；确认 consumer ACTIVE、任务存在、`ping()` 可用；
4. **禁用 provider**；等待 30ms；记录 provider、consumer 管理状态、consumer fiber 状态、任务、服务、setup/teardown 计数；
5. **重新启用 provider**；等待 30ms；记录 consumer 是否自动恢复、是否重新 setup、任务/服务是否恢复；
6. `app.dispose()`，清理临时目录。

## 6. 判定标准

| 检查项 | 通过标准 |
| --- | --- |
| provider 启用 | provider ACTIVE，`e8Service.ping()` 可调用 |
| consumer 启用 | consumer fiber ACTIVE，任务存在，ping 返回 pong-1 |
| 禁用 provider 后 | consumer fiber PENDING；任务消失；服务不可用；consumer teardown +1 |
| 重新启用 provider 后 | consumer 自动恢复 ACTIVE；任务重新出现；ping 返回 pong-2；consumer setup 第二次 |
| 生命周期顺序 | provider setup → consumer setup → consumer teardown → provider teardown → provider setup → consumer setup |
| 管理器状态 | 记录实际值；若与 fiber 不一致，作为发现单独报告，不修改依赖响应断言 |

## 7. 实测结果（2026-11-14）

命令：

```powershell
pnpm exec vitest run tests/e8-dependency.test.ts --reporter=verbose
```

测试日志 `E8_RESULT` 的关键快照（测试进程内相对时间，包含 app 启动耗时）：

```text
initial                 @97ms   provider=stopped  consumer=stopped  service=false task=false
provider-enabled        @99ms   provider=active   consumer=stopped  service=true  task=false
both-active             @100ms  provider=active   consumer=ACTIVE   service=true  task=true   consumerSetup=1
after-disable-provider  @132ms  provider=stopped  consumer=suspended(fiber PENDING) service=false task=false  consumerTeardown=1 providerTeardown=1
after-reenable          @163ms  provider=active   consumer=active(ACTIVE) service=true  task=true   consumerSetup=2 consumerTeardown=1
```

### 7.1 生命周期序列

```
provider:setup
consumer:setup
consumer:teardown      ← 禁用 provider，Cordis 自动清理 consumer effect
provider:teardown
provider:setup         ← 重新启用 provider
consumer:setup         ← consumer 自动恢复（没有手动 enable consumer）
```

### 7.2 关键断言

- provider 禁用后：consumer fiber **PENDING**，`e8-consumer-task` 消失，`e8Service` 不可用；
- provider 重新启用后：consumer fiber 自动回到 **ACTIVE**，任务重新注册，`ping()` 返回 `pong-2`，consumer setup 计数从 1 变为 2；
- 全程没有对 consumer 调用 `enable`/`reload`。

### 7.3 修复：插件管理器 status 与 Cordis fiber 状态同步

provider 禁用后，Cordis 会把 consumer fiber 置为 **PENDING**；插件管理器现在从 fiber 状态派生 effective status：

- `PluginInfo.status` 新增 `suspended`；
- `PluginManager.list()` / `find()` 对运行中的插件读取 `fiber.state`：ACTIVE → `active`，PENDING → `suspended`，DISPOSED/UNLOADING → `stopped`；
- `enabled` 对 suspended 仍为 true（插件仍处于启用状态，依赖恢复后会自动回来，不能把开关显示成关闭）；
- 插件管理页显示「等待依赖」而不是「运行中」；CSS 增加 `.status-suspended`；
- E8 测试已改为断言：禁用 provider 后 `plugins.list()` 的 consumer status 必须为 `suspended`，重新启用 provider 后恢复 `active`。

修复后快照：

```json
{
  "managerStatus": "suspended",
  "fiberState": "PENDING"
}
```

> 说明：这不会改变 Cordis 的依赖响应行为，只是把宿主管理器的 UI 口径与 fiber 的真实状态对齐。

## 8. 效度与局限

- **单平台、单进程**：Windows 11，Cordis 4；未做跨平台；
- **一次采样**：状态判定是 PENDING/ACTIVE 的离散值，不依赖毫秒精度；时间仅作参考；
- **夹具简化**：provider 服务是内存对象；真实插件可能依赖外部资源（文件、网络、子进程），依赖挂起时这些资源的清理仍应由 provider 的 `ctx.effect` 负责；
- **管理器差异（已修复）**：`PluginManager.list()` 已从 fiber 状态派生 effective status，suspended 会显示为“等待依赖”；本实验同时保留修复前后的对照说明；
- **未覆盖**：多个 provider/consumer、循环依赖、依赖服务可选注入（若 Cordis 支持）等场景。

## 9. 论文使用建议

- 用第 7 节的快照与生命周期序列作为 E8 证据；
- 明确写出“consumer 未手动重启”，这是响应式依赖与静态启动注入的核心区别；
- 可把「manager status 从 fiber 状态派生」写成宿主 UI 状态同步设计，而不是把差异归因于 Cordis；
- E7/E8 可合并为“设计属性验证”，E8 不单独宣称清理安全性，只验证生命周期语义。
