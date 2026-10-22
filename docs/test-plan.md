# 测试设计（全量测试分层）

当前规模：**48 个测试文件 / 357 个用例**（2026-10-20）；总耗时约 50 s（`pool: 'forks'`）。

## 分层

| 层 | 目录/文件 | 关注点 |
|---|---|---|
| 安全/路径 | path-policy / path-attack / paths-normalize / fs-safety / compensate / capabilities | 路径逃逸、保护目录、长路径/UNC/设备路径 fail-closed、票据与授权、插件能力边界、清空白名单 |
| 传输/鉴权 | rpc / host-server / validation / api-flow | token、Host（DNS rebinding）、Origin、WS maxPayload、畸形 URL、参数校验、真实 handler 全链路 |
| 安全回归 | batch1-hardening | settings 原型污染/自愈、`addClearRoot` 放大、清理会话收尾、旧扫描覆盖、撤销凭据 |
| 平台/插件 | plugins / plugins-robust / worker-host / external-proxy / external-install / architecture | 插件生命周期、worker 故障隔离、外部插件信任边界（fsRoots/env/clearRoot）、依赖方向 |
| 引擎/规则 | engine / engine-robust / rules / rule-pack-evaluator / plugin-rules / quarantine / sessions / scheduler / undo / in-use | 扫描清理、规则与 protected 语义、隔离恢复、会话中断、调度授权、占用预检 |
| AI | ai / ai-shapes / ai-robust / ai-context / ai-selection | 三种接口形态、推理等级、重试、隐私脱敏、选择项校验 |
| 选择交互 | selection | 推荐/分组/筛选/排序/汇总纯函数与千条级性能 |
| 界面 | `scripts/e2e-ui.mjs`、`scripts/verify-clean-ui.mjs` | 6 页面渲染、扫描链路、v2 选择交互、无头 Edge 千条级验收 |
| 审计/基准 | `scripts/audit-plugins.ts`、`scripts/audit-rules.ts`、`bench/scan.bench.ts` | 插件契约审计（只读）、规则库审计、性能基准 |

## 命令

```bash
pnpm test              # 全量（先构建 UI，再 vitest）
pnpm test:security     # 安全/路径层
pnpm test:platform     # 平台/插件边界层
pnpm test:engine       # 清理引擎/规则层
pnpm test:ai           # AI 层
pnpm test:api          # 传输与 API 全链路
pnpm typecheck         # tsc 类型检查（TS 源码；不含 .vue 模板）
pnpm build:desktop && node scripts/e2e-ui.mjs
node scripts/verify-clean-ui.mjs   # 需先 pnpm build:ui
pnpm bench && pnpm exec tsx scripts/audit-plugins.ts
```

## 设计原则

1. **测试真实路径**：API 测试走真实 `startHostServer` + handlers，不 mock 传输；
2. **安全属性优先**：每一条删除相关改动必须配保护目录/路径逃逸用例；涉及传输层的改动必须配 Host/Origin/token 回归；
3. **隐私断言**：AI 请求体不得包含真实路径、文件名、Key；
4. **隔离可验证**：worker 崩溃/超时必须有独立用例；
5. **失败可诊断**：断言失败信息包含路径、方法名或 sessionId；
6. **边界写测试**：批次1 起新增的信任边界（`clean/start` 只认 itemIds、settings 段校验、外部插件 fsRoots/clearRoot）必须有对应用例，见 `tests/batch1-hardening.test.ts`、`tests/external-install.test.ts`。

## 已知缺口

- 没有真实文件锁的句柄占用测试（依赖只读文件模拟）；
- `app/open-path` 命令注入修复（D-25）暂无专门单测，目前靠代码审阅 + E2E 覆盖；
- Electron 外壳的 CSP / `sandbox: true` / 导航拦截（批次1）缺少自动化断言，依赖人工/E2E；
- E2E 只覆盖主流程，未覆盖 AI 工坊、规则试运行弹窗的点击；
- UI 无组件级单测（仅 CDP 端到端）；Vue 模板/脚本类型由 `pnpm typecheck:ui`（vue-tsc）覆盖并已接入 CI，但还没有 UI 组件渲染测试；
- 没有性能回归门禁（bench 需手动跑，参考 `docs/benchmark.md`）。
