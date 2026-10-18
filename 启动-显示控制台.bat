@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0scripts\launch.mjs" web & if errorlevel 1 pause
