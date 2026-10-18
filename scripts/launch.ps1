# CordClean 启动器（由 启动*.bat 调用）
param(
  [string]$Mode = 'web'   # web | desktop
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$runDir = Join-Path $root '.run'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$pidFile = Join-Path $runDir 'cordclean.pid'
$logFile = Join-Path $runDir 'launch.log'

# 记录自身 PID，供 关闭.bat 结束整棵进程树
$PID | Set-Content -Path $pidFile -Encoding ascii
try { Start-Transcript -Path $logFile -Append | Out-Null } catch {}

Write-Host ''
Write-Host ' ============================================'
Write-Host '   CordClean 模块化电脑清理工具 - 一键启动'
Write-Host ' ============================================'
Write-Host ''

try {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host '[错误] 没有检测到 Node.js。请安装 Node.js 22+：https://nodejs.org/'
    exit 1
  }
  $nodeVersion = (& node -v).Trim()
  $major = [int](($nodeVersion.TrimStart('v') -split '\.')[0])
  if ($major -lt 20) {
    Write-Host "[错误] Node.js 版本过低：$nodeVersion（需要 20 以上，推荐 22/24）"
    exit 1
  }
  Write-Host "[1/3] Node.js $nodeVersion  OK"

  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host '[提示] 未检测到 pnpm，尝试用 corepack 启用...'
    & corepack enable 2>$null
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
      Write-Host '[提示] corepack 不可用，改用 npm 全局安装 pnpm...'
      & npm install -g pnpm
    }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
      Write-Host '[错误] pnpm 仍不可用，请手动执行：npm install -g pnpm'
      exit 1
    }
  }
  $pnpmVersion = (& pnpm -v).Trim()
  Write-Host "[2/3] pnpm $pnpmVersion  OK"

  $desktop = $Mode -eq 'desktop'
  $needInstall = $false
  if (-not (Test-Path 'node_modules/.bin/tsx.cmd')) { $needInstall = $true }
  if (-not (Test-Path 'node_modules/.bin/vite.cmd')) { $needInstall = $true }
  if ($desktop -and -not (Test-Path 'node_modules/electron/dist/electron.exe')) { $needInstall = $true }

  if ($needInstall) {
    Write-Host '[3/3] 首次运行或依赖缺失：开始安装依赖（只需一次）...'
    if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
    & pnpm install --prefer-offline
    if ($LASTEXITCODE -ne 0) {
      Write-Host '[错误] 依赖安装失败：请设置代理后重试，或删除 node_modules 后重新双击。'
      exit 1
    }
  } else {
    Write-Host '[3/3] 依赖已就绪，跳过 pnpm install'
  }

  Write-Host ''
  if ($desktop) {
    Write-Host '正在启动桌面版（首次构建约 10 秒）...'
    & pnpm start:desktop
  } else {
    Write-Host '正在启动浏览器版...'
    Write-Host '浏览器会自动打开 http://127.0.0.1:7801/'
    Write-Host '退出：点击界面右上角电源按钮，或双击 关闭.bat'
    & pnpm start:web
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] CordClean 退出异常（code=$LASTEXITCODE），日志：$logFile"
    exit $LASTEXITCODE
  }
} finally {
  try { Stop-Transcript | Out-Null } catch {}
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
}
