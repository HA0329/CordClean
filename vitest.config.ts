import { defineConfig } from 'vitest/config'
import path from 'node:path'

const root = process.cwd()
const alias = [
  { find: /^@cordclean\/shared$/, replacement: path.join(root, 'packages/shared/src/index.ts') },
  { find: /^@cordclean\/utils$/, replacement: path.join(root, 'packages/utils/src/index.ts') },
  { find: /^@cordclean\/core$/, replacement: path.join(root, 'packages/core/src/index.ts') },
  { find: /^@cordclean\/host$/, replacement: path.join(root, 'packages/host/src/index.ts') },
  { find: /^@cordclean\/plugin-(.+)$/, replacement: path.join(root, 'packages/plugins/$1/src/index.ts') },
]

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    reporters: ['default'],
  },
})
