@echo off
setlocal EnableDelayedExpansion

echo ==========================================
echo AFOMIS Build Script
echo ==========================================
echo.

REM Check 1: bundled_models\bge-small-en-v1.5\
if not exist "bundled_models\bge-small-en-v1.5\" (
    echo ERROR: bundled_models\bge-small-en-v1.5\ not found.
    echo Please run: python scripts\bundle_embedding_model.py
    exit /b 1
)
echo [OK] bundled_models\bge-small-en-v1.5\ found

REM Check 2: seed_data\chunks.json
if not exist "seed_data\chunks.json" (
    echo ERROR: seed_data\chunks.json not found.
    echo Please ensure the seed data file is present.
    exit /b 1
)
echo [OK] seed_data\chunks.json found

REM Check 3: models\*.gguf
set GGUF_FOUND=0
for %%f in ("models\*.gguf") do (
    set GGUF_FOUND=1
    goto :gguf_check_done
)
:gguf_check_done
if %GGUF_FOUND%==0 (
    echo ERROR: No .gguf files found in models\ directory.
    echo Please place at least one GGUF model file in the models\ folder.
    exit /b 1
)
echo [OK] At least one .gguf file found in models\
echo.

REM Activate venv if exists
if exist ".venv\Scripts\activate.bat" (
    echo Activating virtual environment...
    call .venv\Scripts\activate.bat
    echo [OK] Virtual environment activated
    echo.
) else (
    echo [WARN] Virtual environment not found at .venv\Scripts\activate.bat
    echo Continuing with system Python...
    echo.
)

REM Run pyinstaller
echo Building AFOMIS...
pyinstaller AFOMIS.spec --clean --noconfirm
if errorlevel 1 (
    echo.
    echo ==========================================
    echo Build failed!
    echo ==========================================
    exit /b 1
)

echo.
echo ==========================================
echo Build complete: dist\AFOMIS\AFOMIS.exe
echo ==========================================

endlocal
exit /b 0
