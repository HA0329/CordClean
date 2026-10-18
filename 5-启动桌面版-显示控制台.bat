@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0scripts\launch.mjs" desktop & if errorlevel 1 pause
