#!/usr/bin/env python3
"""
Script to prepare files for Inno Setup installer creation.
This script prepares the necessary files and directories for bundling
the application with Python embeddable, wheels, models, and app source.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

# Build configuration
BUILD_DIR = "build_installer"
REQUIREMENTS_FILE = "requirements.txt"
WHEELS_DIR = "wheels"
MODELS_DIR = "models"
EMBEDDINGS_DIR = "embeddings"
APP_DIR = "app"
README_FILE = "README.txt"
INNO_SCRIPT = "setup.iss"

# Determine project root (parent of scripts/ directory)
SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = SCRIPT_DIR.parent.resolve()


def create_directories():
    """Create the required directory structure for the installer."""
    base_dir = PROJECT_ROOT / BUILD_DIR
    dirs = [
        base_dir / WHEELS_DIR,
        base_dir / MODELS_DIR,
        base_dir / EMBEDDINGS_DIR,
        base_dir / APP_DIR,
    ]

    for directory in dirs:
        directory.mkdir(parents=True, exist_ok=True)
        print(f"Created directory: {directory}")


def download_wheels():
    """Download all required packages as wheels to build_installer/wheels/"""
    print("Downloading wheels...")

    wheels_dir = PROJECT_ROOT / BUILD_DIR / WHEELS_DIR
    requirements_file = PROJECT_ROOT / REQUIREMENTS_FILE

    try:
        # Run pip download to get all requirements as wheels
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "download",
                "--dest",
                str(wheels_dir),
                "--no-deps",
                "-r",
                str(requirements_file),
            ],
            check=True,
        )
        print(f"Successfully downloaded wheels to {wheels_dir}/")
    except subprocess.CalledProcessError as e:
        print(f"Error downloading wheels: {e}")
        raise


def copy_app_files():
    """Copy application source files to build_installer/app/"""
    print("Copying application files...")

    # Get list of all Python files in the root directory
    app_files = []
    build_dir_path = PROJECT_ROOT / BUILD_DIR
    for file in PROJECT_ROOT.rglob("*.py"):
        # Exclude build directories and cache files using proper path comparison
        if file.is_relative_to(build_dir_path):
            continue
        if "__pycache__" in str(file) or ".git" in str(file):
            continue
        app_files.append(file)

    # Add requirements.txt
    requirements_file = PROJECT_ROOT / REQUIREMENTS_FILE
    if requirements_file.exists():
        app_files.append(requirements_file)

    # Copy files to build_installer/app/ preserving directory structure
    app_dir = PROJECT_ROOT / BUILD_DIR / APP_DIR
    for file in app_files:
        relative_path = file.relative_to(PROJECT_ROOT)
        destination = app_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, destination)
        print(f"Copied {file} to {destination}")


def prepare_embedding_model():
    """Instructions for preparing the sentence-transformers model"""
    print("Preparing embedding model...")

    # Create a README with instructions
    readme_content = """
# Embedding Model Preparation

The BAAI/bge-small-en-v1.5 model needs to be manually downloaded and placed in this directory.

Instructions:
1. Download the model from Hugging Face: https://huggingface.co/BAAI/bge-small-en-v1.5
2. Extract the model files and place them in this directory
3. The model files should include:
   - config.json
   - pytorch_model.bin (or model.safetensors)
   - tokenizer.json
   - tokenizer_config.json
   - vocab.txt
   - etc.

This model is used for embedding documents for semantic search.
"""

    readme_path = PROJECT_ROOT / BUILD_DIR / EMBEDDINGS_DIR / README_FILE
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(readme_content)

    print("Created README.txt with instructions for embedding model")


def prepare_gguf_model():
    """Instructions for preparing the GGUF model"""
    print("Preparing GGUF model...")

    # Create a README with instructions
    readme_content = """
# GGUF Model Preparation

The Gemma 4 E2B GGUF model needs to be manually downloaded and placed in this directory.

Instructions:
1. Download the GGUF model file (gemma-4-E2B-it-Q5_K_M.gguf) from a trusted source
2. Place the .gguf file in this directory
3. The model file should be: gemma-4-E2B-it-Q5_K_M.gguf (~3.1 GB)

This model is used for LLM inference with llama-cpp-python.
"""

    readme_path = PROJECT_ROOT / BUILD_DIR / MODELS_DIR / README_FILE
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(readme_content)

    print("Created README.txt with instructions for GGUF model")


def create_inno_setup_script():
    """Create Inno Setup script template"""
    print("Creating Inno Setup script...")

    inno_script = f"""
; Inno Setup script for Document QA App installer
; Generated by build_installer.py

[Setup]
AppName=Document QA Application
AppVersion=1.0.0
AppPublisher=Document Q&A Assistant Project
AppPublisherURL=https://github.com/CHANGE_ME/doc-qa-app  ; TODO: Update with actual repository URL
AppSupportURL=https://github.com/CHANGE_ME/doc-qa-app/issues  ; TODO: Update with actual issues URL
AppUpdatesURL=https://github.com/CHANGE_ME/doc-qa-app/releases  ; TODO: Update with actual releases URL
DefaultDirName={{pf}}\\DocumentQAApp
DisableDirPage=yes
DisableProgramGroupPage=yes
LicenseFile=LICENSE.txt
OutputDir=.
OutputBaseFilename=DocumentQAInstaller
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest

[Files]
; Python embeddable distribution files
Source: "python_embeddable\\*"; DestDir: "{{app}}"; Flags: ignoreversion recursesubdirs createallsubdirs

    ; Wheels
    Source: "{BUILD_DIR}\\{WHEELS_DIR}\\*"; DestDir: "{{app}}\\{WHEELS_DIR}"; Flags: ignoreversion recursesubdirs createallsubdirs

    ; App files
    Source: "{BUILD_DIR}\\{APP_DIR}\\*"; DestDir: "{{app}}"; Flags: ignoreversion recursesubdirs createallsubdirs

    ; Models
    Source: "{BUILD_DIR}\\{MODELS_DIR}\\*"; DestDir: "{{app}}\\{MODELS_DIR}"; Flags: ignoreversion recursesubdirs createallsubdirs

    ; Embedding models
    Source: "{BUILD_DIR}\\{EMBEDDINGS_DIR}\\*"; DestDir: "{{app}}\\{EMBEDDINGS_DIR}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{{commondesktop}}\\Document QA App"; Filename: "{{app}}\\main.py"; WorkingDir: "{{app}}"

[Run]
Filename: "{{app}}\\main.py"; Description: "Launch Document QA App"; Flags: nowait postinstall skipifsilent

[Code]
; Add any custom code here if needed
"""

    setup_iss_path = PROJECT_ROOT / BUILD_DIR / INNO_SCRIPT
    with open(setup_iss_path, "w", encoding="utf-8") as f:
        f.write(inno_script)

    print(f"Created Inno Setup script: {setup_iss_path}")


def main():
    """Main function that orchestrates the preparation steps."""
    print("Starting installer preparation...")

    # Create directories
    create_directories()

    # Download wheels
    download_wheels()

    # Copy application files
    copy_app_files()

    # Prepare models
    prepare_embedding_model()
    prepare_gguf_model()

    # Create Inno Setup script
    create_inno_setup_script()

    print("Installer preparation complete!")
    print("Next steps:")
    print(f"1. Manually place the GGUF model file in {BUILD_DIR}/{MODELS_DIR}/")
    print(
        f"2. Manually download and place BAAI/bge-small-en-v1.5 model in {BUILD_DIR}/{EMBEDDINGS_DIR}/"
    )
    print(
        "3. Download Python embeddable distribution and place in python_embeddable/ directory"
    )
    print(f"4. Run Inno Setup with {BUILD_DIR}/{INNO_SCRIPT} to create installer")


if __name__ == "__main__":
    main()
