# 内置插件独立验证记录（2026-11-23）

> 对应「插件区逐个插件独立完成」：每个插件单独做真实扫描审计 + 独立契约测试 + 单独提交，
> 验证通过后再进入下一个插件。审计脚本：`scripts/audit-plugin.ts`（只读；默认禁用插件会临时启用；
> large-files/duplicates/empty-dirs 等按分析范围扫描的插件限定在临时沙箱目录，避免全盘遍历）。

## 如何复现

```bash
# 单个插件真实扫描审计（只读，不清理）
pnpm exec tsx scripts/audit-plugin.ts <plugin-id>

# 该插件的独立契约测试
pnpm exec vitest run tests/plugin-<plugin-id>-contract.test.ts
```

## 结果汇总

| # | 插件 id | 名称 | 真实扫描审计（任务/清理项/错误/违例） | 契约测试 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | `rule-pack` | 规则库 | 汇总：任务 31，清理项 468，体积 3804.6 MB，扫描错误 72，契约违例 0 | `tests/plugin-rule-pack-contract.test.ts` | 通过（0 违例） |
| 2 | `scheduler` | 定时扫描 | 汇总：任务 0，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-scheduler-contract.test.ts` | 通过（0 违例） |
| 3 | `shortcuts` | 失效快捷方式 | 汇总：任务 1，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-shortcuts-contract.test.ts` | 通过（0 违例） |
| 4 | `recycle` | 回收站 | 汇总：任务 1，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-recycle-contract.test.ts` | 通过（0 违例） |
| 5 | `large-files` | 大文件扫描 | 汇总：任务 1，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-large-files-contract.test.ts` | 通过（0 违例） |
| 6 | `duplicates` | 重复文件查找 | 汇总：任务 1，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-duplicates-contract.test.ts` | 通过（0 违例） |
| 7 | `empty-dirs` | 空目录清理 | 汇总：任务 1，清理项 1，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-empty-dirs-contract.test.ts` | 通过（0 违例） |
| 8 | `leftovers` | 应用残留分析 | 汇总：任务 1，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-leftovers-contract.test.ts` | 通过（0 违例） |
| 9 | `startup` | 启动项 | 汇总：任务 1，清理项 92，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-startup-contract.test.ts` | 通过（0 违例） |
| 10 | `registry` | 注册表问题 | 汇总：任务 1，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-registry-contract.test.ts` | 通过（0 违例） |
| 11 | `ai-workshop` | AI 插件工坊 | 汇总：任务 0，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-ai-workshop-contract.test.ts` | 通过（0 违例） |
| 12 | `ai` | AI 清理顾问 | 汇总：任务 0，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0 | `tests/plugin-ai-contract.test.ts` | 通过（0 违例） |

## 契约测试覆盖

- 插件在清单中存在，**默认启用状态**与清单一致（scheduler/shortcuts/ai/ai-workshop 默认禁用）；
- 默认禁用插件可通过 `plugins.enable` 临时启用并进入 `active`（验证启用路径）；
- 插件注册的任务数量与 `plugins/list` 的任务清单一致；
- 任务元数据合法：id/名称非空、risk 合法、描述类型合法；高风险任务不得默认勾选（字段存在时）。

## 已知边界

- 审计是「只读扫描」，不执行清理/删除；清理链路的正确性由删除安全链测试覆盖（见 `docs/test-plan.md`）。
- 部分插件在无对应系统对象时项数为 0（如当前机器没有失效快捷方式），这是正常结果，不是跳过验证。
- scheduler/ai/ai-workshop 不注册清理任务；它们的验证点是「启用路径 + 状态 + 任务清单一致性」。