# 发布流程（每次更新必须有说明）

> 目标：用户/评审能看到**每个版本改了什么**，而不是只有一个版本号。

## 必做清单

1. **版本号**：同步 `package.json`（根与各 workspace 包）与 `packages/core/src/kernel.ts` 的 `APP_VERSION`；
2. **更新说明**：新增 `docs/release-notes-vX.Y.Z.md`，写清：
   - 新增/改进/修复；
   - 兼容性与升级注意事项；
   - 验证结果（类型检查、测试数、构建、基准）；
   - 已知限制；
3. **Changelog**：在根目录 [CHANGELOG.md](../CHANGELOG.md) 追加 vX.Y.Z 摘要，并链接更新说明；
4. **文档同步**：README 版本/统计、架构/测试计划/论文大纲、导师简报、基准文档；
5. **验证**：
   ```bash
   npx tsc -p tsconfig.json --noEmit
   npx vue-tsc -p tsconfig.ui.json --noEmit
   pnpm test
   pnpm build
   pnpm bench:logging   # 涉及日志/性能时
   ```
6. **发布包**：`node scripts/package-release.mjs --intro`，压缩为 `CordClean-vX.Y.Z.zip`；
7. **提交**：提交信息包含版本与更新摘要；
8. **Tag**：annotated tag，消息写本次更新摘要 + 更新说明路径：
   ```bash
   git tag -a vX.Y.Z -m "CordClean vX.Y.Z：本次更新摘要（详见 docs/release-notes-vX.Y.Z.md）"
   ```
9. **推送**：`git push origin main`、`git push origin vX.Y.Z`；
10. **GitHub Release**：以 tag 创建 Release，正文使用 `docs/release-notes-vX.Y.Z.md`；
11. **清理旧版本**：删除本地旧版本发布目录与 zip，只保留最新版本（Git 历史与 tag 不删除）；
12. **确认 CI**：GitHub Actions 通过后再宣布发布完成。

## 版本与分支

- 版本号遵循语义化版本；本项目当前 `0.x` 阶段，功能更新升 minor；
- tag 指向发布提交，不改写已推送历史；
- 更新说明与 CHANGELOG 随代码一起提交，禁止“只打 tag 不写说明”。

## 本仓库约定

- `docs/release-notes-v0.6.0.md` ～ `release-notes-v0.6.3.md` 已按此流程补齐；
- 每次更新说明至少包含：**变更内容、验证结果、兼容/升级、已知限制**。
