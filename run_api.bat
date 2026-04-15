@echo off
REM ========================================
REM Document Q&A Assistant - API Server
REM ========================================

cd /d "%~dp0"

REM Configuration - Edit as needed
set API_PORT=8080

echo ========================================
echo Document Q&A API Server
echo ========================================
echo.
echo Configuration:
echo   API Port: %API_PORT%
echo.
echo Starting server...
echo API will be available at: http://localhost:%API_PORT%
echo.

python main.py --api --port %API_PORT%

pause
