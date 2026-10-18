param([string]$Mode = 'web')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$runDir = Join-Path $root '.run'
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$pidFile = Join-Path $runDir 'cordclean.pid'
$port = if ($env:CORDCLEAN_PORT) { $env:CORDCLEAN_PORT } else { '7801' }
$url = "http://127.0.0.1:$port/"

function Test-Running {
  if (-not (Test-Path $pidFile)) { return $false }
  $value = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($value -notmatch '^\d+$') { return $false }
  return $null -ne (Get-Process -Id ([int]$value) -ErrorAction SilentlyContinue)
}

if (Test-Running) {
  Write-Host 'CordClean 已经在运行，正在打开界面...'
  Start-Process $url
  Start-Sleep -Seconds 2
  exit 0
}

$PID | Set-Content -Path $pidFile -Encoding ascii -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ' ============================================'
Write-Host '   CordClean 模块化电脑清理工具 - 一键启动'
Write-Host ' ============================================'
Write-Host ''

try {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Write-Host '[错误] 没有检测到 Node.js，请安装 22+：https://nodejs.org/'; exit 1 }
  $nodeVersion = (& node -v).Trim()
  $major = [int](($nodeVersion.TrimStart('v') -split '\.')[0])
  if ($major -lt 20) { Write-Host "[错误] Node.js 版本过低：$nodeVersion"; exit 1 }
  Write-Host "[1/3] Node.js $nodeVersion  OK"

  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host '[提示] 未检测到 pnpm，尝试 corepack...'
    & corepack enable 2>$null
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { & npm install -g pnpm }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Write-Host '[错误] 请手动 npm install -g pnpm'; exit 1 }
  }
  Write-Host "[2/3] pnpm $(& pnpm -v)  OK"

  $desktop = $Mode -eq 'desktop'
  $needInstall = $false
  if (-not (Test-Path 'node_modules/.bin/tsx.cmd')) { $needInstall = $true }
  if (-not (Test-Path 'node_modules/.bin/vite.cmd')) { $needInstall = $true }
  if ($desktop -and -not (Test-Path 'node_modules/electron/dist/electron.exe')) { $needInstall = $true }
  if ($needInstall) {
    Write-Host '[3/3] 安装依赖（只需一次）...'
    if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
    & pnpm install --prefer-offline
    if ($LASTEXITCODE -ne 0) { Write-Host '[错误] 依赖安装失败'; exit 1 }
  } else {
    Write-Host '[3/3] 依赖已就绪，跳过 pnpm install'
  }

  Write-Host ''
  if ($desktop) {
    Write-Host '正在启动桌面版... 窗口出现即表示已启动'
    & pnpm start:desktop
  } else {
    Write-Host "正在启动浏览器版... 浏览器将自动打开 $url"
    Write-Host '状态：双击 状态.bat 查看；退出：界面右上角电源按钮或 关闭.bat'
    & pnpm start:web
  }
  if ($LASTEXITCODE -ne 0) { Write-Host "[错误] CordClean 异常退出（code=$LASTEXITCODE）"; exit $LASTEXITCODE }
} finally {
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
}