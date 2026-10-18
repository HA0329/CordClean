@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0scripts\launch.mjs" web --detach
exit /b 0
