@echo off
title Document Q&A - Offline Server
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0start.ps1"
if %ERRORLEVEL% neq 0 pause
