/**
 * 测试专用类型补充（不改变运行时行为）。
 *
 * 部分内核服务实现带有「仅测试可调用」的注入方法（如回收站执行器替换、设置立即落盘），
 * 但对外契约（@cordclean/shared 的 *Like 接口）刻意不暴露这些方法。测试直接通过
 * `ctx.recycleBin` / `ctx.settings` 调用时需要类型可见，因此在这里用模块声明合并补充。
 *
 * 本文件只参与 `pnpm typecheck`（tsconfig include 中的 tests 目录），不打包、不影响产物。
 */
import type { RecycleRunner } from '@cordclean/core'

declare module '@cordclean/shared' {
  interface RecycleLike {
    /** 测试注入：替换真实的回收站 PowerShell 执行器（传 undefined 恢复真实实现） */
    setRunnerForTests(runner?: RecycleRunner): void
    /** 测试注入：强制回收站可用性，避免 CI 机器策略差异 */
    setAvailableForTests(value?: boolean): void
  }

  interface SettingsLike {
    /** 立即落盘（退出/测试断言前调用） */
    flush(): void
  }
}

export {}
