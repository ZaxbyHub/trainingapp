# -*- mode: python ; coding: utf-8 -*-
# Issue #57 spike: separate one-entry PyInstaller build for the reranker
# packaging-risk probe (plan-critic blocker 3 fix: two single-entry builds,
# no multi-entry COLLECT). Throwaway - deleted after ADR-0003 merges.
#
# Bundles the STAGED reranker model files (populated before the build by
# stage_reranker.py) as bundled_reranker/ so probe leg B can load them by
# local path with local_files_only=True.
import os

# PyInstaller injects SPECPATH = the directory containing this spec.
SPECDIR = SPECPATH
ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))

block_cipher = None

datas = [
    (os.path.join(SPECDIR, 'staged_reranker'), 'bundled_reranker'),
]
hiddenimports = [
    'sentence_transformers',
    'transformers',
    'torch',
    'tokenizers',
]

a = Analysis(
    [os.path.join(SPECDIR, 'probe_reranker.py')],
    pathex=[SPECDIR, ROOT],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[os.path.join(SPECPATH, 'pyi_rth_omp.py')],
    excludes=['tkinter', 'matplotlib', 'IPython'],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='spike-probe-reranker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='spike-probe',
)
