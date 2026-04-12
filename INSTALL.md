# Installation Guide

Complete installation guide for the Document Q&A Assistant, including standard Python installation and offline bundle setup.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Standard Installation](#standard-installation)
3. [Offline Bundle Installation](#offline-bundle-installation)
4. [Model Downloads](#model-downloads)
5. [Windows-Specific Setup](#windows-specific-setup)
6. [Post-Installation](#post-installation)
7. [Uninstallation](#uninstallation)

## System Requirements

### Minimum Requirements
- **Operating System**: Windows 10 (64-bit) or later
- **CPU**: Any x64 processor (Intel/AMD)
- **RAM**: 4GB minimum (8GB recommended)
- **Storage**: 1GB free space for application, additional 5GB+ for models and database
- **Python**: 3.10 or higher (only for standard installation)

### Recommended Requirements
- **CPU**: Intel Core i5-10400 or equivalent
- **RAM**: 8GB minimum (16GB recommended)
- **Storage**: SSD recommended (faster loading and ingestion)
- **Python**: 3.11 or higher

### Optional Components
- **NVIDIA GPU**: For OpenVINO GPU acceleration (not required for GGUF backend)
- **Intel NPU**: For OpenVINO NPU acceleration (not required for GGUF backend)

## Standard Installation

### Step 1: Install Python

1. Download Python 3.11 from [python.org](https://www.python.org/downloads/)
2. Run the installer and check **"Add Python to PATH"**
3. Complete the installation

**Verify installation**:
```powershell
python --version
pip --version
```

### Step 2: Clone or Download the Repository

```powershell
# If using Git
git clone <repository-url>
cd doc_qa_app

# Or download and extract
cd doc_qa_app
```

### Step 3: Install Python Dependencies

```powershell
pip install -r requirements.txt
```

**Expected output**:
```
Collecting pypdf>=4.0.0
  Downloading pypdf-4.2.0-py3-none-any.whl (2.4 MB)
...
Successfully installed pypdf-4.2.0 ...
```

### Step 4: Download Required Models

#### GGUF Model (Required)

**Option A: Automatic Download**
- Run the application first
- Model will be downloaded on first use
- Stored in cache: `%LOCALAPPDATA%\huggingface\hub`

**Option B: Manual Download** (recommended for offline setup)
1. Download Qwen3-1.7B-Instruct-Q4_K from Hugging Face:
    - URL: https://huggingface.co/Qwen/Qwen3-1.7B-Instruct-GGUF
    - File: `qwen3-1.7b-instruct-q4_k_m.gguf` (~1.5 GB)

2. Save to a known location:
    - Example: `C:\Models\qwen3-1.7b-instruct-q4_k_m.gguf`
    - Or in the application directory: `C:\doc_qa_app\models\qwen3-1.7b-instruct-q4_k_m.gguf`

#### Embedding Model

**Option A: Automatic Download**
- First use will automatically download BAAI/bge-small-en-v1.5
- Size: ~80MB
- Stored in cache: `%LOCALAPPDATA%\sentence-transformers`

**Option B: Manual Download** (for offline bundle)
1. Download from Hugging Face:
   - URL: https://huggingface.co/BAAI/bge-small-en-v1.5
   - Files needed:
     - `config.json`
     - `pytorch_model.bin` or `model.safetensors`
     - `tokenizer.json`
     - `tokenizer_config.json`
     - `vocab.txt`

2. Extract to application directory:
   - Example: `C:\doc_qa_app\embeddings\bge-small-en-v1.5`

### Step 5: Run the Application

```powershell
# GUI Mode (default)
python main.py

# CLI Mode
python main.py --cli

# API Server
python main.py --api --port 8080
```

## Offline Bundle Installation

### Purpose
Create a standalone Windows installer that doesn't require internet access after setup. Perfect for:
- Air-gapped environments
- Airplane travel
- Offline deployments

### Prerequisites
- Windows 10/11
- 5GB+ free space
- Access to internet (for downloading dependencies once)

### Preparation Steps

#### 1. Install Dependencies (Single Time)

```powershell
pip install -r requirements.txt
pip install pyinstaller
```

#### 2. Prepare Application Files

```powershell
python scripts/build_installer.py
```

This script will:
- Download all Python packages as wheels
- Copy application source files
- Create directories for models

#### 3. Download Python Embeddable Distribution

1. Download Python embeddable ZIP from [python.org](https://www.python.org/downloads/):
   - Select "Windows embeddable package (64-bit)"
   - Download `python-3.11.x-amd64.zip` (smaller than full install)

2. Extract to `python_embeddable/` directory

#### 4. Download GGUF Model

Download Qwen3-1.7B-Instruct-Q4_K_M:
- From Hugging Face: https://huggingface.co/Qwen/Qwen3-1.7B-Instruct-GGUF
- Save as `qwen3-1.7b-instruct-q4_k_m.gguf`
- Place in `build_installer/models/`

#### 5. Download Embedding Model

Download BAAI/bge-small-en-v1.5:
- From Hugging Face: https://huggingface.co/BAAI/bge-small-en-v1.5
- Extract files to `build_installer/embeddings/`

#### 6. Download Inno Setup (to build installer)

1. Download Inno Setup from [jrsoftware.org/isdl.php](https://jrsoftware.org/isdl.php)
2. Install the "compiler" version

#### 7. Build the Installer

```powershell
iscc build_installer/setup.iss
```

This creates `DocumentQAInstaller.exe` in the root directory.

### Verify Offline Installation

1. Install the created `.exe` package
2. Run the application
3. Verify no internet connection is needed
4. Confirm models are loaded from local paths

## Model Downloads

### GGUF Model Details

**Recommended Model**: Qwen3-1.7B-Instruct-Q4_K_M

**Specifications**:
- Model Size: ~1.5 GB
- Architecture: Transformer-based
- Quantization: Q4_K_M (balanced quality/speed)
- Language: English (primary), Chinese (secondary)

**Alternative Models**:
- `qwen3-7b-instruct-q4_k_m` (7GB, better quality, slower) - larger variant available
- `llama3-8b-instruct-q4_k_m` (4.8GB, general purpose)
- `phi-3-mini-4k-instruct-q4_k_m` (2.3GB, fastest)

### Embedding Model Details

**Recommended Model**: BAAI/bge-small-en-v1.5

**Specifications**:
- Model Size: ~80MB
- Dimensions: 384
- Architecture: BERT-based
- License: Apache 2.0

**Alternative Models**:
- `all-MiniLM-L6-v2` (90MB, faster)
- `text-embedding-ada-002` (1.5GB, higher quality)

## Windows-Specific Setup

### Add to PATH (Optional)

1. **For Command Line Access**:
   ```powershell
   # Add Python to PATH (during installation)
   # Or manually edit: System Properties > Environment Variables
   ```

2. **Create Desktop Shortcut**:
   ```powershell
   # In GUI, click Settings, then create shortcut
   # Or manually create shortcut to main.py
   ```

### Firewall Settings

No special firewall rules needed. Application only communicates locally.

### Windows Services

Not required. Application runs as a standard executable.

### System Requirements for Power Users

**NVIDIA GPU Support**:
1. Install NVIDIA CUDA Toolkit
2. Install cuDNN
3. Install PyTorch with CUDA support
4. Use OpenVINO backend instead of GGUF

**Intel NPU Support**:
1. Install Intel OpenVINO Toolkit
2. Use OpenVINO backend
3. GGUF will automatically fallback to CPU

## Post-Installation

### Initial Setup

1. **Launch the application**
   ```powershell
   python main.py
   ```

2. **Ingest your first documents**
   - Click "Ingest" button
   - Select document folder
   - Wait for processing

3. **Verify models are loaded**
   - Check status bar for "Model: [filename] (size)"
   - Verify "Ready" status appears

### Configuration

Edit settings via GUI:
1. Click "Settings" button
2. Configure LLM backend (GGUF path)
3. Adjust RAG parameters
4. Save and restart

### First Run Speed

- First run may be slower due to model loading
- Subsequent runs will be much faster
- Embedding model (~80MB) loads on first use
- ChromaDB database initializes on first use

### Troubleshooting First Run

**Problem**: "No LLM backend available"

**Solution**:
```powershell
# Verify GGUF model exists
dir C:\path\to\qwen3-1.7b-instruct-q4_k_m.gguf

# Check file size (should be ~1.5GB)
```

**Problem**: "chromadb not installed"

**Solution**:
```powershell
pip install chromadb --break-system-packages
```

**Problem**: Slow first run

**Normal behavior**: Models load on first use
- GGUF model: ~30-60 seconds
- Embedding model: ~10-30 seconds
- Subsequent runs: ~2-5 seconds

## Uninstallation

### Standard Installation

1. **Stop the application**
   - Close GUI, CLI, or API server

2. **Remove application files**
   ```powershell
   rmdir /s /q C:\doc_qa_app
   ```

3. **Remove Python dependencies** (optional)
   ```powershell
   pip uninstall -y chromadb sentence-transformers llama-cpp-python pypdf python-docx python-pptx pdfplumber
   ```

4. **Clean up model cache** (optional)
   ```powershell
   # GGUF model cache
   rmdir /s /q %LOCALAPPDATA%\llama_cpp
   # Embedding model cache
   rmdir /s /q %LOCALAPPDATA%\sentence-transformers
   ```

### Offline Bundle

1. **Run uninstaller**
   - Standard Windows uninstaller created by Inno Setup

2. **Remove models** (manual)
   ```powershell
   rmdir /s /q C:\Program Files\DocumentQAApp\models
   rmdir /s /q C:\Program Files\DocumentQAApp\embeddings
   ```

3. **Remove application directory**
   ```powershell
   rmdir /s /q C:\Program Files\DocumentQAApp
   ```

## Support

For installation issues or questions:

1. Check the [README.md](README.md) troubleshooting section
2. Review [CONFIGURATION.md](CONFIGURATION.md)
3. Check application logs in `app_settings.json`
4. Verify all dependencies are installed

## Reinstall

If you need to reinstall:

```powershell
# Stop any running instances
taskkill /F /IM python.exe

# Remove old installation
rmdir /s /q C:\doc_qa_app

# Reinstall
cd C:\doc_qa_app
pip install -r requirements.txt
```

---

**Version**: 1.1.0
**Last Updated**: 2026-04-09
