# -*- mode: python ; coding: utf-8 -*-
"""
LEGACY (pre-v3): PyInstaller spec for the retired Python desktop app.
Superseded for the shipped product by the Electron packaging pipeline
(desktop/electron-builder.yml, issue #84). Retained only because
build_exe.bat and the skip-gated tests/regression/test_defect_006_build_path.py
reference it, and the legacy Python surface remains the CI conformance target
(.github/workflows/conformance.yml runs --asgi api_server:app). Note: the
seed_data entry below packages a directory that no longer exists in the
repository (gitignored; its loader was deliberately deleted).

Build command: pyinstaller AFOMIS.spec --clean
"""

import os
from PyInstaller.building.build_main import Analysis
from PyInstaller.building.api import PYZ, EXE, COLLECT
from PyInstaller.utils.hooks import collect_dynamic_libs

# Analysis configuration
a = Analysis(
    ['main.py'],  # Entry point
    pathex=[os.getcwd()],
    binaries=collect_dynamic_libs('llama_cpp'),  # Include llama-cpp-python native DLLs
    datas=[
        ('bundled_models', 'bundled_models'),  # Bundled embedding model
        ('seed_data', 'seed_data'),            # Seed chunks and manifest
        ('models', 'models'),                  # GGUF model files
    ],
    hiddenimports=[
        'chromadb',
        'sentence_transformers',
        'rank_bm25',
        'llama_cpp',
        'engine_factory',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],  # SENTENCE_TRANSFORMERS_HOME is set in code via app_paths
    excludes=['magic', 'python-magic'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    noarchive=False,
)

# Create the PYZ archive (compressed Python bytecode)
pyz = PYZ(
    a.pure,
    a.zipped_data,
    cipher=None,
)

# Create the EXE
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # Required for onedir mode
    name='DocumentQA',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # Windowed application (no console window)
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# Collect all files into the output directory (onedir mode)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='DocumentQA',
)
