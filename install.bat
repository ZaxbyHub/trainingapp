@echo off
REM ========================================
REM Document Q&A Assistant - Installer
REM ========================================

echo.
echo ========================================
echo Document Q&A Assistant - Setup
echo ========================================
echo.

cd /d "%~dp0"

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found!
    echo.
    echo Please install Python 3.10 or later from:
    echo   https://www.python.org/downloads/
    echo.
    echo Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

echo [1/4] Python found:
python --version
echo.

echo [2/4] Upgrading pip...
python -m pip install --upgrade pip
echo.

echo [3/4] Installing dependencies...
echo This may take several minutes on first install.
echo.
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install dependencies.
    echo Try running: pip install -r requirements.txt --break-system-packages
    pause
    exit /b 1
)
echo.

echo [4/4] Verifying installation...
python -c "import chromadb; import sentence_transformers; print('Core packages OK')"
if errorlevel 1 (
    echo.
    echo [WARNING] Some packages may not be installed correctly.
    echo The application may still work with limited functionality.
)
echo.

echo ========================================
echo Installation Complete!
echo ========================================
echo.
echo To run the application:
echo   - Double-click run_gui.bat for the desktop app
echo   - Double-click run_api.bat for the API server
echo   - Run "python main.py --help" for all options
echo.
echo First run will download the embedding model (~80MB).
echo.

pause
