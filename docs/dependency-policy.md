# 依赖与升级策略（2026-10-20）

> 结论：**论文定稿/答辩前锁定当前版本，只做安全补丁与依赖声明清理；不做 major 升级。**
> 原因：Electron / Vite / Vitest 跨 major 升级会同时影响 IPC、构建产物与测试基建，回归成本高、演示风险大；本项目当前 `pnpm audit --prod` 为 0 漏洞。

## 1. 当前锁定版本（root 依赖）

| 依赖 | 当前版本 | 最新版本（2026-10-20） | 策略 |
| --- | --- | --- | --- |
| electron | 38.8.6 | 44.9.1 | **锁定 38**；38 可能已进入 EOL，升级需回归 IPC/preload/CDP/E2E，答辩后再做 |
| vite | 7.3.7 | 8.3.4 | 锁定；UI 构建工具，升级与 Vue/Element Plus 兼容性需一起验证 |
| vitest | 3.2.7 | 5.0.5 | 锁定；跨 2 个 major（pool/reporter/config 变更），升级后需重跑 346 用例 |
| typescript | 5.9.3 | 7.0.2 | 锁定；7.x 为原生编译器，破坏性大，暂缓 |
| vue | 3.5.44 | 3.5.44 | 已最新 |
| element-plus | 2.14.7 | 2.14.7 | 已最新 |
| cordis | 4.0.0-rc.12 | 4.0.0-rc.12 | 已升级到 rc.12；Windows 盘符路径/HMR 修复对桌面外壳有益，全部测试通过 |
| schemastery | 3.18.0 | 3.18.0 | 已最新 |
| zod | 4.6.7 | 4.6.7 | 已最新 |
| ws | 8.22.0 | 8.22.0 | 已最新 |
| esbuild | 0.25.12 | 0.28.2 | 低风险，可在答辩后升级（主进程/preload 打包） |
| tsx | 4.23.15 | 4.23.15 | 已最新 |

## 2. 已做的依赖清单清理（批次2）

- root 删除未使用的 `zod`、`vite`、`@vitejs/plugin-vue`；`cordis`/`schemastery` 因测试与根级类型解析需要保留，`ws` 因 e2e/mock 脚本需要保留；
- apps/web 删除未使用的 `@cordclean/shared`；apps/desktop 删除未使用的 `@cordclean/shared`/`@cordclean/utils`；
- `schemastery` 统一 `^3.18.0`、`ws` 统一 `^8.22.0`；
- 8 个私有 workspace 包版本统一 `0.2.1`（插件包保留自身能力版本 1.x/2.0.0）；
- `pnpm-lock.yaml` 同步更新，`pnpm install --frozen-lockfile` 通过。

## 3. 升级检查清单（答辩后执行）

1. 新建分支，独立提交升级；先升 esbuild（低风险）→ 再评估 vite+vitest 组合 → 最后 electron；
2. 每步执行：`pnpm install` → `pnpm typecheck` → `pnpm vitest run` → `pnpm build:ui` → `pnpm build:desktop` → `node scripts/e2e-ui.mjs`；
3. electron 升级重点回归：preload/sandbox、IPC 参数克隆、CSP、窗口导航拦截、CDP 截图脚本；
4. 升级后重新生成 `docs/benchmark.md` 与 `docs/screenshots/`，同步 README/论文性能数字；
5. 若时间不足，保持锁定并在论文「未来工作」中说明 EOL 风险与升级路径。

## 4. 安全补丁

- 关注 `pnpm audit --prod` 与 Electron 安全公告；出现 high/critical 漏洞时，仅做补丁级升级（不跨 major），并重跑上述清单。
- 当前（2026-10-20）`pnpm audit --prod`：**0 个已知漏洞**（51 个生产依赖）。
