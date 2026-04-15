# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs

# Collect torch binaries (torch/lib/) — runtime hook handles DLL path
_torch_bins = collect_dynamic_libs('torch')

a = Analysis(
    ['app_gui.py'],
    pathex=[],
    binaries=_torch_bins,
    datas=(
        collect_data_files('customtkinter')
        + collect_data_files('sentence_transformers')
        + collect_data_files('chromadb')
    ),
    hiddenimports=(
        collect_submodules('sentence_transformers')
        + collect_submodules('chromadb')
        + ['tiktoken_ext.openai_public', 'tiktoken_ext']
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['hook_torch_dll.py'],
    excludes=['magic'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='DocumentQA',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='DocumentQA_v120',
)
