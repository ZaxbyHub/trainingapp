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

# Build configuration
APP_NAME = "DocumentQAApp"
DIST_DIR = "dist"
ENTRY_POINT = "main.py"
LOG_LEVEL = "WARN"
MODELS_DIR = "models"


def main():
    print("Building Document Q&A App...")

    # Check Python version
    if sys.version_info < (3, 10):
        print("ERROR: Python 3.10 or higher required")
        return 1

    # Clean previous build
    dist_dir = Path(DIST_DIR)
    if dist_dir.exists():
        shutil.rmtree(dist_dir)
        print("Cleaned previous build")

    # Build command with all dependencies
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onedir",
        "--name",
        APP_NAME,
        "--add-data",
        f"{MODELS_DIR}{os.pathsep}{MODELS_DIR}",
        "--collect-all",
        "customtkinter",
        "--collect-all",
        "chromadb",
        "--collect-all",
        "sentence_transformers",
        "--collect-all",
        "pypdf",
        "--collect-all",
        "markdown_it",
        "--collect-all",
        "pygments",
        "--collect-all",
        "bleach",
        "--collect-all",
        "torch",
        "--collect-all",
        "torchaudio",
        "--collect-all",
        "torchvision",
        "--collect-all",
        "tokenizers",
        "--hidden-import",
        "transformers",
        "--hidden-import",
        "transformers.agents",
        "--hidden-import",
        "transformers.agents.prompts",
        "--exclude-module",
        "transformers.models.auto.pipeline_image_classification",
        "--log-level",
        LOG_LEVEL,
        ENTRY_POINT,
    ]

    print("Running PyInstaller...")
    result = subprocess.run(cmd, capture_output=True, check=False)

    if result.returncode != 0:
        print(f"Build failed with code {result.returncode}")
        return result.returncode

    # Fix torch DLLs - copy to root app directory for Windows one-dir builds
    app_dir = Path(DIST_DIR) / APP_NAME
    internal_dir = app_dir / "_internal"
    torch_lib = internal_dir / "torch" / "lib"

    if torch_lib.exists():
        print("Fixing torch DLLs...")
        for dll in torch_lib.glob("*.dll"):
            dest = app_dir / dll.name
            if not dest.exists():
                shutil.copy2(dll, dest)
                print(f"  Copied {dll.name}")

    print("\nBuild complete!")
    output_path = os.path.join(DIST_DIR, APP_NAME, f"{APP_NAME}.exe")
    print(f"Output: {output_path}")
    dist_folder = os.path.join(DIST_DIR, APP_NAME)
    print(
        f"\nTo create installer, use Inno Setup or create a zip archive of {dist_folder}/"
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
