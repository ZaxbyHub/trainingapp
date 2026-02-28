@echo off
REM ========================================
REM Document Q&A Assistant - GUI Launcher
REM ========================================

cd /d "%~dp0"

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo Python not found. Please install Python 3.10+ from python.org
    pause
    exit /b 1
)

REM Launch GUI
python main.py

pause
