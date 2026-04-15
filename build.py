"""
Build Script for Document Q&A Assistant
Creates standalone Windows executable using PyInstaller.
"""

import os
import sys
import shutil
import subprocess
from pathlib import Path


def check_dependencies():
    """Check that required packages are installed."""
    required = [
        "pyinstaller",
        "customtkinter",
        "chromadb",
        "sentence_transformers",
        "pypdf",
        "python-docx",
        "python-pptx"
    ]
    
    missing = []
    for pkg in required:
        try:
            __import__(pkg.replace("-", "_"))
        except ImportError:
            missing.append(pkg)
    
    if missing:
        print(f"Missing packages: {', '.join(missing)}")
        print("Install with: pip install " + " ".join(missing))
        return False
    
    return True


def create_spec_file(include_model: bool = False, model_path: str = None):
    """Create PyInstaller spec file."""
    
    spec_content = '''# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Collect all required data files
datas = []
datas += collect_data_files('customtkinter')
datas += collect_data_files('sentence_transformers')
datas += collect_data_files('chromadb')

# Hidden imports
hiddenimports = []
hiddenimports += collect_submodules('sentence_transformers')
hiddenimports += collect_submodules('chromadb')
hiddenimports += ['tiktoken_ext.openai_public', 'tiktoken_ext']

'''
    
    if include_model and model_path:
        spec_content += f'''
# Include GGUF model
gguf_model_path = r"{model_path}"
if os.path.exists(gguf_model_path):
    datas += [(gguf_model_path, 'models')]
'''
    
    spec_content += '''
a = Analysis(
    ['app_gui.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'scipy', 'pandas'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='DocumentQA',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
'''
    
    return spec_content


def build_executable(include_model: bool = False, model_path: str = None):
    """Build the executable."""
    
    print("=" * 60)
    print("Building Document Q&A Assistant")
    print("=" * 60)
    
    print("\n[1/5] Checking dependencies...")
    if not check_dependencies():
        sys.exit(1)
    print("✓ All dependencies found")
    
    print("\n[2/5] Creating spec file...")
    spec_content = create_spec_file(include_model, model_path)
    spec_path = Path("DocumentQA.spec")
    spec_path.write_text(spec_content, encoding='utf-8')
    print(f"✓ Created {spec_path}")
    
    print("\n[3/5] Cleaning previous builds...")
    for folder in ["build", "dist"]:
        if Path(folder).exists():
            shutil.rmtree(folder)
            print(f"  Removed {folder}/")
    print("✓ Clean")
    
    print("\n[4/5] Running PyInstaller...")
    result = subprocess.run(
        [sys.executable, "-m", "PyInstaller", str(spec_path), "--clean"],
        capture_output=False
    )
    
    if result.returncode != 0:
        print("✗ PyInstaller failed")
        sys.exit(1)
    
    print("\n[5/5] Verifying output...")
    exe_path = Path("dist") / "DocumentQA.exe"
    if exe_path.exists():
        size_mb = exe_path.stat().st_size / (1024 * 1024)
        print(f"✓ Created: {exe_path} ({size_mb:.1f} MB)")
    else:
        print("✗ Executable not found")
        sys.exit(1)
    
    print("\n" + "=" * 60)
    print("BUILD SUCCESSFUL")
    print("=" * 60)
    print(f"\nExecutable: {exe_path.absolute()}")
    print("\nTo run: double-click DocumentQA.exe")
    print("\nNote: The embedding model and GGUF model must be placed in the models/ directory before first run.")


def create_installer_script():
    """Create a batch file for easy installation."""
    
    batch_content = '''@echo off
echo ========================================
echo Document Q&A Assistant - Installer
echo ========================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo Python not found. Please install Python 3.10+ from python.org
    pause
    exit /b 1
)

echo Installing dependencies...
pip install -r requirements.txt

echo.
echo Building executable...
python build.py

echo.
echo Done! Check the dist folder for DocumentQA.exe
pause
'''
    
    Path("install.bat").write_text(batch_content)
    print("Created install.bat")


def create_run_script():
    """Create batch files for running the app."""
    
    gui_batch = '''@echo off
cd /d "%~dp0"
python app_gui.py
pause
'''
    
    api_batch = '''@echo off
cd /d "%~dp0"
set API_PORT=8080
echo Starting API server on port %API_PORT%...
python api_server.py
pause
'''
    
    Path("run_gui.bat").write_text(gui_batch)
    Path("run_api.bat").write_text(api_batch)
    print("Created run_gui.bat and run_api.bat")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Build Document Q&A Assistant")
    parser.add_argument("--include-model", action="store_true", 
                       help="Include GGUF model in build")
    parser.add_argument("--model-path", type=str,
                       help="Path to GGUF model file")
    parser.add_argument("--create-scripts", action="store_true",
                       help="Only create helper scripts, don't build")
    
    args = parser.parse_args()
    
    if args.create_scripts:
        create_installer_script()
        create_run_script()
    else:
        build_executable(args.include_model, args.model_path)
