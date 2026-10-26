/**
 * 生成源码发布包：把 git 跟踪的文件复制到 `CordClean-v<version>/`。
 *
 * 约定（与 v0.5.18 发布包一致）：
 * - 只包含源码/文档/启动脚本，不含 `node_modules`、构建产物、`.git`；
 * - 启动脚本（根目录 *.bat）与 README/docs 都在跟踪列表里，会被自动带上；
 * - 若上级目录存在项目介绍 HTML，会一并复制（可选）。
 *
 * 用法：node scripts/package-release.mjs [--out <dir>]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
const argIndex = process.argv.indexOf('--out')
const outRoot = argIndex >= 0 ? path.resolve(process.argv[argIndex + 1]) : path.resolve(repoRoot, '..')
const target = path.join(outRoot, `CordClean-v${version}`)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

let copied = 0
let bytes = 0
for (const relative of tracked) {
  const source = path.join(repoRoot, relative)
  const destination = path.join(target, relative)
  if (!existsSync(source)) continue
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  copied += 1
  bytes += statSync(source).size
}

// 项目介绍 HTML 是带截图的营销页；只有显式传 --intro 才复制，避免把旧版本页面混进新包
const intro = path.join(outRoot, 'CordClean-项目介绍.html')
if (process.argv.includes('--intro') && existsSync(intro)) {
  copyFileSync(intro, path.join(target, 'CordClean-项目介绍.html'))
  console.log('copied project intro html')
}

console.log(`release dir: ${target}`)
console.log(`files: ${copied}, size: ${(bytes / 1024 / 1024).toFixed(2)} MB`)
