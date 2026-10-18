# 一键关闭 CordClean：结束启动器及其子进程（pnpm / node / electron）
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$pidFile = Join-Path $root '.run\cordclean.pid'
$killed = @()

if (Test-Path $pidFile) {
  $target = (Get-Content $pidFile -Raw).Trim()
  if ($target -match '^\d+$') {
    & taskkill /PID $target /T /F 2>$null | Out-Null
    $killed += "pid $target (含子进程)"
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# 兜底：按命令行匹配本项目进程
$needles = @('apps\web\src\main.ts', 'apps/desktop/dist/main.mjs', 'apps\desktop\dist\main.mjs')
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and ($_.CommandLine -like '*cordclean*' -or $_.CommandLine -like '*deepseek-harness-wokplace*') -and
  ($needles | Where-Object { $_.CommandLine -like "*$_*" } | Select-Object -First 1)
}
foreach ($p in $procs) {
  & taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
  $killed += "pid $($p.ProcessId) ($($p.Name))"
}

if ($killed.Count -gt 0) {
  Write-Host 'CordClean 已关闭：'
  $killed | ForEach-Object { Write-Host "  - $_" }
} else {
  Write-Host '没有发现正在运行的 CordClean（可能已经退出）。'
}
Write-Host '如果浏览器页面还开着，可以直接关闭标签页。'