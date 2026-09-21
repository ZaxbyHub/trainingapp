# Patches the PE SizeOfStackReserve of PyInstaller-built exes (default
# ~2 MB bootloader stack; frozen llama.cpp model loads are known to blow it).
# Usage: python patch_stack.py <exe> [mb]
import sys

import pefile

path = sys.argv[1]
mb = int(sys.argv[2]) if len(sys.argv) > 2 else 16
pe = pe = pefile.PE(path)
old = pe.OPTIONAL_HEADER.SizeOfStackReserve
pe.OPTIONAL_HEADER.SizeOfStackReserve = mb * 1024 * 1024
pe.write(path)
pe.close()
print(f"patched {path}: stack reserve {old} -> {mb * 1024 * 1024} bytes")
