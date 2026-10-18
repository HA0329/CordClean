/**
 * 桌面外壳构建脚本：用 esbuild 把主进程与 preload 各自打包成单文件。
 *
 * - main.mjs：ESM，externals 只保留 electron；
 * - preload.cjs：CJS（Electron 的 preload 仍要求 CommonJS）。
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'apps', 'desktop', 'src')
const outdir = path.join(root, 'apps', 'desktop', 'dist')

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
  sourcemap: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
}

await build({
  ...shared,
  entryPoints: [path.join(entry, 'main.ts')],
  outfile: path.join(outdir, 'main.mjs'),
  format: 'esm',
  banner: {
    js: "import { createRequire as __cc_createRequire } from 'node:module';const require = __cc_createRequire(import.meta.url);",
  },
})

await build({
  ...shared,
  entryPoints: [path.join(entry, 'preload.ts')],
  outfile: path.join(outdir, 'preload.cjs'),
  format: 'cjs',
})

console.log('desktop build finished →', outdir)
