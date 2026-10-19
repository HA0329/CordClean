# 测试设计（全量测试分层）

## 分层

| 层 | 目录/文件 | 关注点 |
|---|---|---|
| 安全 | path-policy / path-attack / fs-safety / compensate / capabilities | 路径逃逸、保护目录、票据与授权、插件能力 |
| 平台 | plugins / plugins-robust / worker-host / external-proxy / external-install / architecture | 插件生命周期、worker 隔离、跨线程协议、依赖边界 |
| 引擎 | engine / engine-robust / rules / plugin-rules / quarantine / sessions / scheduler / undo / in-use | 扫描清理、规则、隔离恢复、会话中断、调度、占用预检 |
| AI | ai / ai-shapes / ai-robust / ai-context / ai-selection | 三种接口形态、重试、隐私脱敏、选择项校验 |
| 传输/API | rpc / validation / api-flow | 鉴权、参数校验、真实 handler 全链路 |
| 界面 | scripts/e2e-ui.mjs | 6 页面渲染、扫描链路、主题/折叠 |

## 命令

```bash
pnpm test              # 全量（构建 UI + vitest）
pnpm test:security     # 安全层
pnpm test:platform     # 平台/隔离层
pnpm test:engine       # 清理引擎层
pnpm test:ai           # AI 层
pnpm test:api          # 传输与 API 全链路
node scripts/e2e-ui.mjs
```

## 设计原则

1. **测试真实路径**：API 测试走真实 `startHostServer` + handlers，不 mock 传输；
2. **安全属性优先**：每一条删除相关改动必须配保护目录/路径逃逸用例；
3. **隐私断言**：AI 请求体不得包含真实路径、文件名、Key；
4. **隔离可验证**：worker 崩溃/超时必须有独立用例；
5. **失败可诊断**：断言失败信息包含路径、方法名或 sessionId。

## 已知缺口

- 没有真实文件锁的句柄占用测试（依赖只读文件模拟）；
- E2E 只覆盖主流程，未覆盖 AI 工坊/规则试运行弹窗的点击；
- 没有性能回归门禁（bench 需手动跑）。
