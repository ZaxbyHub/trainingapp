@echo off
setlocal

echo ==========================================
echo AFOMIS Installer Build Script
echo ==========================================
echo.
echo NOTE: Run build_exe.bat first to create the application bundle.
echo.

REM Check 1: dist\AFOMIS\AFOMIS.exe exists
if not exist "dist\AFOMIS\AFOMIS.exe" (
    echo ERROR: dist\AFOMIS\AFOMIS.exe not found.
    echo Please run build_exe.bat first to build the application.
    exit /b 1
)

REM Find ISCC.exe
set ISCC_PATH=
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" (
    set ISCC_PATH="%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
) else if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" (
    set ISCC_PATH="%ProgramFiles%\Inno Setup 6\ISCC.exe"
) else if exist "C:\InnoSetup6\ISCC.exe" (
    set ISCC_PATH="C:\InnoSetup6\ISCC.exe"
)

if not defined ISCC_PATH (
    echo ERROR: Inno Setup compiler ^(ISCC.exe^) not found.
    echo Please install Inno Setup 6 from https://jrsoftware.org/isinfo.php
    exit /b 1
)

echo Found ISCC: %ISCC_PATH%

REM Compile installer
echo Compiling installer...
%ISCC_PATH% installer.iss
if errorlevel 1 (
    echo Build failed!
    exit /b 1
)

echo Installer created: AFOMIS-Setup-1.0.0.exe

endlocal
exit /b 0
