# E7 实验设计：插件卸载无残留验证

> 对应论文设计属性：**Cordis `ctx.effect()` 的可逆副作用 → 插件卸载无残留**。
> 实验代码：[tests/e7-unload.test.ts](../../tests/e7-unload.test.ts)（自动化，可重复运行）。
> 首次执行日期：2026-11-14；当前版本：CordClean 0.6.9。

## 1. 实验目标

验证的不是“Cordis 提供了 `ctx.effect`”，而是：

> 当插件把应用级资源通过 `ctx.effect()` 登记后，插件 fiber 卸载时这些资源会按生命周期被回收，插件运行前后的应用可观测状态回到基线。

同时设置阴性对照：

> 等价的副作用如果不通过 `ctx.effect()` 登记，插件卸载后仍会留下任务、辖区、UI 贡献与定时器。

阴性对照用于避免把“框架能力”误写成“框架自动消灭一切副作用”。E7 要证明的是**登记机制的有效性**，以及**不登记的后果**。

## 2. 研究假设

| 编号 | 假设 | 判定 |
| --- | --- | --- |
| H7-1 | 正例插件的应用级副作用全部通过 `ctx.effect` 登记；卸载后任务集合、路径辖区、UI 贡献、事件监听、定时器全部回到基线 | 全部 delta=0 |
| H7-2 | 反例插件创建等价副作用但绕过 `ctx.effect`；卸载后上述资源仍存在 | 至少 3 类残留 >0 |
| H7-3 | 正例插件的 Cordis fiber 登记树在卸载后为空；反例登记树为空但仍有残留 | 正例 0；反例证明“空登记树 ≠ 无残留” |

## 3. 实验变量

### 自变量

- 副作用登记方式：
  - **正例**：`ctx.effect(() => resource / disposer)`；
  - **反例**：直接 `ctx.cleaner.define()`、`ctx.pathPolicy.addRoot()`、`ctx.ui.register()`、`setInterval()`。

### 因变量（应用可观测指标）

| 指标 | 采集方式 |
| --- | --- |
| 清理任务集合 | `ctx.cleaner.list().map(task => task.id)` |
| 路径辖区集合 | `ctx.pathPolicy.roots()` |
| UI 贡献 | `ctx.ui.list().map(entry => entry.pluginId)` |
| 事件监听是否存活 | 卸载后 `ctx.emit('e7/probe')`，观察计数器是否增加 |
| 定时器是否存活 | 卸载后等待 60ms，观察 interval 计数器增量 |
| Cordis 登记树 | 卸载前后 `fiber.getEffects()`（`EffectMeta.label`） |
| 插件状态 | `ctx.plugins.list()` 的 status / taskIds |

### 控制变量

- 同一个 `createApp` 实例、同一个临时数据目录；
- 两个插件默认都禁用，显式 `enable()`/`disable()`；
- 正例、反例使用完全相同的资源数量和类型；
- 计时观察窗口统一为 60ms；定时器周期 10ms；
- 测试结束手动清理反例资源，避免污染测试进程。

## 4. 夹具设计

### 4.1 正例插件 `e7-positive`

```ts
// 1) 受控定时器
ctx.effect(() => {
  const timer = setInterval(() => ticks++, 10)
  return () => clearInterval(timer)
}, 'e7/interval')

// 2) 任务 + 辖区 + UI + 事件监听，集中登记
ctx.effect(() => {
  const disposeTask = ctx.cleaner.define({ id: 'e7-positive-task', ... })
  const disposeRoot = ctx.pathPolicy.addRoot(root, 'e7-positive')
  const disposeUi = ctx.ui.register('e7-positive', { statusItems: [...] })
  const offProbe = ctx.on('e7/probe', () => probeEvents++)
  return () => { offProbe(); disposeUi(); disposeRoot(); disposeTask() }
}, 'e7/effects')
```

### 4.2 反例插件 `e7-negative`

与正例创建同样的四类资源，但**不放进 `ctx.effect`**，从而不受 fiber 生命周期管理。

## 5. 实验步骤

1. `createApp` 启动，两个插件默认禁用；记录基线（任务/辖区/UI）；
2. 启用正例，记录加载后快照与 `fiber.getEffects()` 标签；
3. 触发 `e7/probe`，等待 60ms，确认事件监听与定时器工作；
4. 停用正例，重新采集快照、等待 60ms、再次触发探针；
5. 启用反例，记录加载后快照与 `fiber.getEffects()`；
6. 停用反例，重新采集快照、等待 60ms、记录残留；
7. 手动清理反例资源，`app.dispose()`，删除临时目录。

## 6. 判定标准

| 检查项 | 通过标准 |
| --- | --- |
| 正例任务/辖区/UI | 卸载后与基线完全相等 |
| 正例事件监听 | 卸载后探针计数不再增加 |
| 正例定时器 | 卸载后 60ms 内计数增量为 0 |
| 正例 `getEffects()` | 卸载后为 `[]` |
| 正例插件状态 | `stopped`，`taskIds=[]` |
| 反例残留 | 任务、辖区、UI 至少 3 类仍存在，定时器仍增长 |
| 反例登记树 | 卸载前 `getEffects()` 为空（说明登记树不能替代应用级断言） |

## 7. 实测结果（2026-11-14）

命令：

```powershell
pnpm exec vitest run tests/e7-unload.test.ts --reporter=verbose
```

测试日志输出（临时路径已脱敏）：

```json
{
  "baseline": { "tasks": [], "roots": [], "ui": [] },
  "positiveAfterLoad": {
    "tasks": ["e7-positive-task"],
    "roots": ["<temp>/e7-positive-root"],
    "ui": ["e7-positive"]
  },
  "positiveEffects": 3,
  "positiveEffectLabels": ["e7/interval", "ctx.on(\"e7/probe\")", "e7/effects"],
  "positiveEffectsAfterUnload": 0,
  "positiveTimerTicksBeforeUnload": 6,
  "positiveTimerTicksAfterUnload": 0,
  "positiveProbeEventsAfterUnload": 1,
  "negativeEffectsBeforeUnload": 0,
  "negativeResidual": {
    "tasks": ["e7-negative-task"],
    "roots": ["<temp>/e7-negative-root"],
    "ui": ["e7-negative"],
    "timerTicksAfterUnload": 6
  }
}
```

### 对照表

| 指标 | 基线 | 正例加载后 | 正例卸载后 | 反例加载后 | 反例卸载后 |
| --- | --- | --- | --- | --- | --- |
| 任务数 | 0 | 1 | **0** | 1 | **1（残留）** |
| 辖区数 | 0 | 1 | **0** | 1 | **1（残留）** |
| UI 贡献数 | 0 | 1 | **0** | 1 | **1（残留）** |
| interval 增量（60ms） | — | 约 5~6 | **0** | 约 5~6 | **6（仍在跑）** |
| 探针事件数 | — | 1 | **1（不再增加）** | — | — |
| `fiber.getEffects()` | — | 3 | **0** | **0** | 0 |

> 定时器计数受调度影响，报告中“约 5~6”是合理范围；判定使用“增量为 0 / >0”，不依赖精确值。

### 结果解释

- H7-1 成立：正例的 3 个 effect（包括 Cordis 自动为 `ctx.on` 登记的监听 effect）在禁用后全部回收到基线；
- H7-2 成立：反例的 4 类资源在禁用后全部残留；
- H7-3 成立：反例的 `getEffects()` 为 0，但资源仍在，说明 **E7 不能只断言“登记树为空”**，必须同时断言应用可观测资源。

## 8. 效度与局限

- **单一平台**：本实验在 Windows 11 上执行；Cordis 生命周期逻辑应与平台无关，但未做跨平台重复；
- **一次采样**：结果来自一次运行；关键判定（0 vs >0）不依赖毫秒级精确值，测试可重复；
- **应用级观测**：没有枚举操作系统句柄/线程；插件运行在同一 Node 进程，Node 没有线程级插件隔离；
- **夹具简化**：正/反例只覆盖任务、辖区、UI、事件、定时器五类资源；真实插件还可能持有文件句柄、子进程、全局缓存等，这些应通过 `ctx.effect` 或显式 `dispose` 管理；
- **反例清理**：反例资源在测试 finally 中手动清理，避免测试进程被残留定时器污染；这恰好反证了“未登记 = 需要人工兜底”。

## 9. 论文使用建议

- 实验表使用第 7 节对照表；
- 图可画“正例：3 effects → 0 / 反例：0 effects 但 4 类残留”；
- 文字表述建议：

> E7 实验通过正例与阴性对照验证了 Cordis `ctx.effect()` 在插件生命周期中的回收作用：正例插件的任务、路径辖区、UI 贡献、事件监听和定时器在卸载后均回到基线；反例插件在相同副作用下因未登记而保留任务、辖区、UI 与定时器。结果同时表明，仅检查框架内部登记树不足以证明无残留，应以应用可观测资源为准。

- 与 E8（依赖响应）合并为“设计属性验证”一节；E8 已完成，见 [E8 依赖响应实验](e8-dependency-response.md)。
