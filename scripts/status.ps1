$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root '.run\cordclean.pid'
$port = if ($env:CORDCLEAN_PORT) { $env:CORDCLEAN_PORT } else { '7801' }
$url = "http://127.0.0.1:$port/"
$running = $false
if (Test-Path $pidFile) {
  $value = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($value -match '^\d+$' -and (Get-Process -Id ([int]$value) -ErrorAction SilentlyContinue)) { $running = $true }
}
$respond = $false
try { $r = Invoke-WebRequest "$($url)api/ping" -UseBasicParsing -TimeoutSec 2; $respond = $r.StatusCode -eq 200 } catch {}
Write-Host ''
if ($running -and $respond) {
  Write-Host '状态：运行中' -ForegroundColor Green
  Write-Host "界面：$url"
  Write-Host '退出：双击 关闭.bat，或点界面右上角电源按钮'
} elseif ($running) {
  Write-Host '状态：正在启动（进程在，但服务尚未就绪）' -ForegroundColor Yellow
} else {
  Write-Host '状态：未运行' -ForegroundColor DarkGray
  Write-Host '启动：双击 启动.bat'
}
Write-Host ''