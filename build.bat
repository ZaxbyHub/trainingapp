@echo off
REM Build script for DocumentQA - includes post-build VC++ DLL fix
REM Run: build.bat

echo [1/3] Building with PyInstaller...
python -m PyInstaller app_gui.spec --clean --noconfirm --distpath dist --workpath build_v120
if %ERRORLEVEL% neq 0 (
    echo PyInstaller failed!
    exit /b %ERRORLEVEL%
)

echo [2/3] Fixing VC++ runtime DLL version mismatch...
set "DIST=dist\DocumentQA_v120\_internal"
for %%d in (msvcp140.dll vcruntime140.dll vcruntime140_1.dll) do (
    copy /Y %%SystemRoot%%\System32\%%d "%DIST%\%%d" >nul
    echo   Fixed %%d
)

echo [3/3] Build complete: dist\DocumentQA_v120\DocumentQA.exe
