@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title CordClean 一键启动

echo.
echo  ============================================
echo    CordClean 模块化电脑清理工具 - 一键启动
echo  ============================================
echo.

rem ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有检测到 Node.js。
  echo        请先安装 Node.js 22 或更高版本：https://nodejs.org/
  echo        安装后重新双击本文件。
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
set "NODE_MAJOR=%NODE_VERSION:v=%"
set "NODE_MAJOR=%NODE_MAJOR:~0,2%"
if %NODE_MAJOR% LSS 20 (
  echo [错误] 当前 Node.js 版本 %NODE_VERSION% 过低，需要 20 以上（推荐 22/24）。
  pause
  exit /b 1
)
echo [1/3] Node.js %NODE_VERSION%  OK

rem ---------- 2. 检查 pnpm ----------
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [提示] 没有检测到 pnpm，尝试用 corepack 启用...
  call corepack enable >nul 2>nul
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [提示] corepack 不可用，改用 npm 全局安装 pnpm...
    call npm install -g pnpm
    if errorlevel 1 (
      echo [错误] pnpm 安装失败。请手动执行：npm install -g pnpm
      pause
      exit /b 1
    )
  )
)
for /f "delims=" %%v in ('pnpm -v') do set "PNPM_VERSION=%%v"
echo [2/3] pnpm %PNPM_VERSION%  OK

rem ---------- 3. 检查依赖（已安装则跳过下载） ----------
set "NEED_INSTALL="
if not exist "node_modules\.bin\tsx.cmd" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\vite.cmd" set "NEED_INSTALL=1"
if /i "%~1"=="desktop" (
  if not exist "node_modules\electron\dist\electron.exe" set "NEED_INSTALL=1"
)

if defined NEED_INSTALL (
  echo [3/3] 首次运行或依赖缺失：开始安装依赖（只需一次）...
  if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call pnpm install --prefer-offline
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。可尝试：
    echo        1^) 设置代理后重试
    echo        2^) 删除 node_modules 后重新双击本文件
    pause
    exit /b 1
  )
) else (
  echo [3/3] 依赖已就绪，跳过 pnpm install
)

rem ---------- 4. 启动 ----------
echo.
if /i "%~1"=="desktop" (
  echo 正在启动桌面版（首次构建约 10 秒）...
  echo 关闭窗口即可退出 CordClean。
  echo.
  call pnpm start:desktop
) else (
  echo 正在启动浏览器版...
  echo 浏览器会自动打开 http://127.0.0.1:7801/ ，关闭本窗口即可退出。
  echo 想启动桌面版：把 desktop 作为参数传进来（或使用「启动-桌面版.bat」）。
  echo.
  call pnpm start:web
)

if errorlevel 1 (
  echo.
  echo [错误] CordClean 退出异常，请看上方日志。
  pause
  exit /b 1
)

echo.
echo CordClean 已退出。
timeout /t 3 >nul
endlocal
