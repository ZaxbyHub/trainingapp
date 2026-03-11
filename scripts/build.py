#!/usr/bin/env python3
"""
Build script for Document Q&A App
Creates a distributable .exe with all dependencies

Usage:
    python scripts/build.py
"""

import subprocess
import sys
import os
import shutil
from pathlib import Path

def main():
    print("Building Document Q&A App...")
    
    # Check Python version
    if sys.version_info < (3, 10):
        print("ERROR: Python 3.10 or higher required")
        return 1
    
    # Clean previous build
    dist_dir = Path("dist")
    if dist_dir.exists():
        shutil.rmtree(dist_dir)
        print("Cleaned previous build")
    
    # Build command with all dependencies
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onedir",
        "--name", "DocumentQAApp",
        "--add-data", "models;models",
        "--collect-all", "customtkinter",
        "--collect-all", "chromadb",
        "--collect-all", "sentence_transformers",
        "--collect-all", "pypdf",
        "--collect-all", "markdown_it",
        "--collect-all", "pygments",
        "--collect-all", "bleach",
        "--collect-all", "torch",
        "--collect-all", "torchaudio",
        "--collect-all", "torchvision",
        "--collect-all", "tokenizers",
        "--hidden-import", "transformers",
        "--hidden-import", "transformers.agents",
        "--hidden-import", "transformers.agents.prompts",
        "--exclude-module", "transformers.models.auto.pipeline_image_classification",
        "--log-level", "WARN",
        "ui/app.py"
    ]
    
    print("Running PyInstaller...")
    result = subprocess.run(cmd)
    
    if result.returncode != 0:
        print(f"Build failed with code {result.returncode}")
        return result.returncode
    
    # Fix torch DLLs - copy to root _internal folder
    internal_dir = Path("dist/DocumentQAApp/_internal")
    torch_lib = internal_dir / "torch" / "lib"
    
    if torch_lib.exists():
        print("Fixing torch DLLs...")
        for dll in torch_lib.glob("*.dll"):
            dest = internal_dir / dll.name
            if not dest.exists():
                shutil.copy2(dll, dest)
                print(f"  Copied {dll.name}")
    
    print("\nBuild complete!")
    print("Output: dist/DocumentQAApp/DocumentQAApp.exe")
    print("\nTo create installer, use Inno Setup or create a zip archive of dist/DocumentQAApp/")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
