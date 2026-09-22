# PyInstaller runtime hook: runs before the frozen app's imports.
#
# 1. torch (libiomp5md.dll) and onnxruntime (its own OpenMP runtime) collide
#    in onedir builds -> instant loader segfault with no Python output.
#    KMP_DUPLICATE_LIB_OK lets the first-loaded runtime win; adequate for the
#    issue #57 spike package where both libs must coexist in one sidecar.
# 2. torch's DLLs (in _MEIPASS/torch/lib) are not on the loader search path
#    when torch imports late -> WinError 1114 "A dynamic link library
#    initialization routine failed" (same failure hook_torch_dll.py solves
#    for the repo's GUI builds).
import os
import sys

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

# The llama_cpp package ships as real on-disk files (excluded from the PYZ).
# PyInstaller's FrozenImporter RAISES for excluded modules before PathFinder
# runs, so pre-import it explicitly from its real location.
if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
    meipass = sys._MEIPASS  # noqa: SLF001
    if meipass not in sys.path:
        sys.path.insert(0, meipass)
    if "llama_cpp" not in sys.modules:
        _init_py = os.path.join(meipass, "llama_cpp", "__init__.py")
        if os.path.isfile(_init_py):
            try:
                import importlib.util

                _spec = importlib.util.spec_from_file_location(
                    "llama_cpp",
                    _init_py,
                    submodule_search_locations=[os.path.join(meipass, "llama_cpp")],
                )
                _mod = importlib.util.module_from_spec(_spec)
                sys.modules["llama_cpp"] = _mod
                _spec.loader.exec_module(_mod)
            except Exception as exc:
                # Diagnosable, not silent: the packaged app's log shows why.
                print(f"[pyi_rth] llama_cpp pre-import failed: {exc}", flush=True)

if getattr(sys, "frozen", False):
    base = getattr(sys, "_MEIPASS", None)
    if base:
        torch_lib = os.path.join(base, "torch", "lib")
        if os.path.isdir(torch_lib):
            try:
                os.add_dll_directory(torch_lib)
            except OSError:
                pass
            os.environ["PATH"] = torch_lib + os.pathsep + os.environ.get("PATH", "")
            # Preload torch's OpenMP so onnxruntime's own copy (bundled for the
            # chromadb default-embedding import chain) finds one already
            # resident instead of double-initializing at boot (boot segfault).
            try:
                import ctypes

                ctypes.CDLL(os.path.join(torch_lib, "libiomp5md.dll"))
            except OSError:
                pass
