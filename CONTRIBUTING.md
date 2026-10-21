# 贡献指南

感谢你愿意改进 CordClean。这个项目优先保证**安全**与**可测试**，其次才是功能数量。

## 开发环境

- Windows 10/11
- Node.js 22+
- pnpm 12+（`corepack enable` 或 `npm i -g pnpm`）

```bash
pnpm install
pnpm exec tsc -p tsconfig.json --noEmit
pnpm test
```

测试使用临时数据目录（`CORDCLEAN_DATA`），不会碰你的真实清理历史。

## 提交规范

- 一个提交只做一件事，提交信息用中文或英文均可，建议 `type(scope): subject`；
- 新功能必须带测试；修复 bug 先写能复现的用例；
- 不要提交 `node_modules/`、`dist/`、`.run/`、日志、`docs/screenshots/`。

## 加清理能力

优先加**规则数据**（`packages/plugins/rule-pack/catalog/*.json`），而不是写新插件：

1. 确认目标目录是「可重建缓存」，不是用户数据；
2. 使用 `clear_dir` / `glob_dirs` 等受支持的目标类型；
3. 本地跑一次「设置 → 定时任务 → 立即运行」或清理页扫描，确认命中合理；
4. 规则会被安全策略过滤，受保护目录与盘符根会被拒绝。

## 写插件

- 只通过 `ctx.cleaner.define` 注册任务，`scan` 只 `emit` 候选；
- 不要直接删除文件、不要起子进程、不要发网络请求；
- 路径必须来自配置或 `ctx.system.env`，不得硬编码用户名；
- 在 `package.json` 声明依赖，在 `packages/core/src/manifest.ts` 注册懒加载项。

## 安全相关问题

删除逻辑相关改动请附上：

- 威胁场景（会误删什么）；
- 现有防护为什么不够；
- 新增的校验点与测试用例。

## 行为准则

保持友善、就事论事。对安全边界有分歧时，以「默认拒绝、可恢复优先」为准。
