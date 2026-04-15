# hook_torch_dll.py — PyInstaller runtime hook: add torch/lib to DLL search path
import os
import sys
import ctypes

def _setup_torch_dll_path():
    """Add torch/lib to DLL search path on Windows (before torch loads)."""
    if sys.platform != 'win32':
        return
    # Only in frozen (PyInstaller) bundle
    if not getattr(sys, 'frozen', False):
        return

    base = getattr(sys, '_MEIPASS', None)
    if not base:
        return

    # torch DLLs are in _internal/torch/lib/
    torch_lib = os.path.join(base, 'torch', 'lib')
    if not os.path.exists(torch_lib):
        return

    # Method 1: os.add_dll_directory (Python 3.8+)
    try:
        handle = os.add_dll_directory(torch_lib)
        # Store handle at module level so it doesn't get garbage-collected
        sys._torch_dll_dir_handle = handle
    except (AttributeError, OSError):
        pass

    # Method 2: Prepend to PATH as fallback (torch itself also does this)
    current_path = os.environ.get('PATH', '')
    if torch_lib not in current_path:
        os.environ['PATH'] = torch_lib + os.pathsep + current_path

    # Method 3: SetDllDirectoryW (fallback for Python < 3.8 or if add_dll_directory failed)
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.SetDllDirectoryW(torch_lib)
    except Exception:
        pass

_setup_torch_dll_path()
