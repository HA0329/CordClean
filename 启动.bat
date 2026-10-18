@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" web
exit /b 0
