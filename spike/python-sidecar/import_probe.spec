# -*- mode: python ; coding: utf-8 -*-
# Issue #57 spike slice 2: PyInstaller onedir build of the existing post-#51
# api_server.py (the Electron-hosted Python sidecar option). Throwaway -
# deleted after ADR-0003 merges. Run from anywhere:
#   pyinstaller spike/python-sidecar/api_server_sidecar.spec --noconfirm
#
# Single-entry onedir (no multi-entry COLLECT precedent exists in this repo;
# the reranker probe is its own spec). Bundles the bge-small embedding model
# (the DocumentQAApp.spec 'bundled_models' pattern) and deliberately does NOT
# bundle the HF reranker cache - the probe build tests that separately.
import os

# PyInstaller injects SPECPATH = the directory containing this spec.
ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))

block_cipher = None

datas = [
    (os.path.join(ROOT, 'models', 'bge-small-en-v1.5'), os.path.join('bundled_models', 'bge-small-en-v1.5')),
]
from PyInstaller.utils.hooks import collect_dynamic_libs, collect_all
venv_sp = os.path.join(ROOT, 'spike', 'python-sidecar', '.venv-sidecar', 'Lib', 'site-packages')
binaries = []
datas = [(os.path.join(venv_sp, 'llama_cpp', 'lib'), os.path.join('llama_cpp', 'lib'))]
hiddenimports = [
    # uvicorn's dynamically-loaded pieces (classic PyInstaller gap)
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.loops.asyncio',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'sse_starlette',
    'anyio._backends._asyncio',
    # pipeline stack with dynamic imports
    'sentence_transformers',
    'chromadb',
    'chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2',
    'rank_bm25',
    'llama_cpp',
    'engine_factory',
]

a = Analysis(
    [os.path.join(SPECPATH, 'import_probe.py')],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[os.path.join(SPECPATH, 'pyi_rth_omp.py')],
    excludes=['tkinter', 'customtkinter', 'matplotlib', 'IPython'],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='spike-import-probe',
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
    name='spike-import-sidecar',
)
