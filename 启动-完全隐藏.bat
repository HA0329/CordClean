@echo off
chcp 65001 >nul
cd /d "%~dp0"
wscript "%~dp0scripts\launch-hidden.vbs"
exit /b 0
