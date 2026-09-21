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
venv_site_packages = os.path.join(ROOT, 'spike', 'python-sidecar', '.venv-sidecar', 'Lib', 'site-packages')

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules, collect_data_files

block_cipher = None

def _unused_llama_cpp_runtime_files():
    """llama_cpp ships as REAL on-disk files (venv layout preserved) and is
    excluded from the PYZ below: the PyInstaller-frozen copy access-violates
    inside llama_model_load under every mitigation, while the identical venv
    layout works. Ship the venv condition verbatim."""
    pairs = []
    pkg = os.path.join(venv_site_packages, 'llama_cpp')
    for root, dirs, files in os.walk(pkg):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for f in files:
            src = os.path.join(root, f)
            dst = os.path.relpath(src, venv_site_packages)
            pairs.append((src, dst))
    return pairs

datas = [
    (os.path.join(ROOT, 'models', 'bge-small-en-v1.5'), os.path.join('bundled_models', 'bge-small-en-v1.5')),
    # chromadb reads its migrations SQL through importlib.resources, which
    # needs the package's real data files on disk in the frozen build
    # (app_gui.spec precedent).
] + collect_data_files('chromadb')
# llama_cpp ships its llama.dll under llama_cpp/lib and loads it relative to
# its package dir; flattening it into _internal (collect_dynamic_libs) makes
# the frozen load access-violate. Bundle the lib dir WITH its layout instead.
binaries = []
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
    'diskcache',
    'typing_extensions',
    'llama_cpp',
    'engine_factory',
    'chromadb.telemetry.product.posthog',
    'chromadb.migrations',
    'chromadb.migrations.embeddings_queue',
    # chromadb resolves its executor plugins via importlib.import_module at
    # runtime; collect_submodules misses these (dynamic walk), name them.
    'chromadb.execution.executor',
    'chromadb.execution.executor.local',
    'chromadb.execution.executor.distributed',
    'chromadb.execution.expression',
]
# chromadb 0.6 resolves many plugins via importlib.import_module at runtime
# and collect_submodules misses them (its walk skips the executor/segment
# plugin trees); walk the package dir on disk instead.
def _walk_package_modules(pkg_dir):
    mods = []
    parent = os.path.dirname(pkg_dir)
    for root, _dirs, files in os.walk(pkg_dir):
        if '__pycache__' in root:
            continue
        for f in files:
            if f.endswith('.py'):
                rel = os.path.relpath(os.path.join(root, f), parent)
                mods.append(rel[:-3].replace(os.sep, '.'))
    return mods

hiddenimports += _walk_package_modules(os.path.join(ROOT, 'spike', 'python-sidecar', '.venv-sidecar', 'Lib', 'site-packages', 'chromadb'))

a = Analysis(
    [os.path.join(ROOT, 'api_server.py')],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[os.path.join(SPECPATH, 'pyi_rth_omp.py')],
    excludes=['tkinter', 'customtkinter', 'matplotlib', 'IPython', 'llama_cpp'],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='spike-api-server',
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
    name='spike-sidecar',
)
