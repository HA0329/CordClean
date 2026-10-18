@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" desktop
exit /b 0
