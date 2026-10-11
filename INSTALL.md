# Installation Guide

> **Scope note (issue #89):** this guide installs the **legacy Python harness** (`api_server.py` / `config.py`), which survives as the CI conformance surface — it is NOT the shipped product's install path. The v3 desktop app ships as an Electron installer with a first-run wizard; see the README "Installation" section. The desktop app's bundled LLM lineup is the LFM pair per ADR-0002 as amended by #156 (Quality: lfm2.5-2.6b Q4_K_M, Fast: lfm2-1.2b-rag Q4_K_M — both LFM Open License v1.0); the legacy Python harness keeps its own Gemma 4 E2B artifact, which #156 leaves out of scope. Packaging facts reflect issue #84.


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
- **NVIDIA GPU**: not required. The GGUF backend uses a working Vulkan device when one is
  present and falls back to CPU inference otherwise

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
1. Download the LFM GGUFs from Hugging Face (the desktop app's bundled lineup, ADR-0002
   as amended by #156; both LFM Open License v1.0):
    - Quality: https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF
      File: `LFM2.5-2.6B-Q4_K_M.gguf` (1,674,455,040 bytes, ~1.7 GB) — stage as
      `models/lfm2.5-2.6b/model.gguf`
    - Fast: https://huggingface.co/LiquidAI/LFM2-1.2B-RAG-GGUF
      File: `LFM2-1.2B-RAG-Q4_K_M.gguf` (730,894,048 bytes, ~0.73 GB) — stage as
      `models/lfm2-1.2b-rag/model.gguf`

2. Save to a known location:
    - Example: `C:\Models\lfm2.5-2.6b\model.gguf`
    - Or in the application directory: `C:\doc_qa_app\models\lfm2.5-2.6b\model.gguf`

Note: the legacy Python harness itself still defaults to its own bundled Gemma 4 E2B
artifact (out of #156's scope); any GGUF works via `RAG_GGUF_PATH`.

#### Embedding Model

**Option A: Open from local cache — no download** (legacy-harness path only; the shipped desktop bundles this model)
- The harness opens BAAI/bge-small-en-v1.5 with `local_files_only=True` — it does NOT download; if the model is absent it fails closed with manual-install instructions (use Option B)
- Size: ~134 MB fp32 weights (the repo's measured bge-small artifact is 134,098,874 bytes per bench/RESULTS.md; full-precision — no q8 variant ships)
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

The API server binds to `127.0.0.1` (loopback) by default. To expose it on your LAN, set `API_HOST=0.0.0.0` — see CONFIGURATION.md for the security implications before doing so.

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

The legacy harness bundles its own Gemma 4 E2B artifact in the `models/` directory
(unchanged by #156's desktop LFM swap). To use a custom model:

Download any GGUF format model:
- From Hugging Face: https://huggingface.co/models?search=gguf
- Save as `your-model.gguf`
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

**Bundled Model**: LFM2.5-2.6B (Q4_K_M — ADR-0002 as amended by #156; the quant packaged by issue #84). The desktop app bundles the LLM lineup from ADR-0002's #156 amendment: Quality `lfm2.5-2.6b` (LFM2.5-2.6B) and Fast `lfm2-1.2b-rag` (LFM2-1.2B-RAG), both Q4_K_M GGUFs, both text-only — no multimodal projector ships on any surface. The legacy Python harness separately keeps its own Gemma 4 E2B artifact (its default bundled GGUF, out of #156's scope), which remains Apache-2.0 licensed under the Gemma 4 license.

**Specifications**:
- Model Size: 1,674,455,040 bytes (~1.7 GB)
- Architecture: LFM2.5 (Liquid AI); Fast tier: LFM2-1.2B-RAG (730,894,048 bytes, ~0.73 GB)
- Quantization: Q4_K_M (ADR-0002 decision)
- Language: English (primary)
- License: LFM Open License v1.0 (non-OSI) for BOTH LFM tiers — commercial use by a
  Legal Entity at or above the $10,000,000 revenue threshold is not licensed
  (Section 5(b)); see [docs/licenses.md](docs/licenses.md) for the review and
  [docs/licenses/LFM-OPEN-LICENSE-v1.0.txt](docs/licenses/LFM-OPEN-LICENSE-v1.0.txt)
  for the full verbatim text

**Alternative Models**:
- Any GGUF format model from Hugging Face
- Recommended: LFM2-1.2B-RAG (the Fast tier), Qwen2.5 1.5B, Llama 3 3B

### Embedding Model Details

**Recommended Model**: BAAI/bge-small-en-v1.5

**Specifications**:
- Model Size: ~134 MB fp32 (staged embedding footprint 134,098,874 bytes per bench/RESULTS.md; full-precision — no q8 variant ships)
- Dimensions: 384
- Architecture: BERT-based
- License: MIT (see [docs/licenses.md](docs/licenses.md))

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

The application runs GGUF models on a GPU when a probe finds a working Vulkan device, and on
the CPU otherwise. GPU acceleration is optional; no particular GPU or NPU is required.

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
- Embedding model (bge-small-en-v1.5, 134 MB fp32 ONNX, bundled — no runtime download) loads on first use
- ChromaDB database initializes on first use

### Troubleshooting First Run

**Problem**: "No LLM backend available"

**Solution**:
```powershell
# Verify GGUF model exists (e.g. the staged LFM quality model)
dir C:\path\to\lfm2.5-2.6b\model.gguf

# Check file size (should be 1,674,455,040 bytes (~1.7 GB) for the Q4_K_M LFM2.5-2.6B;
# the legacy harness's own Gemma 4 E2B default artifact is unchanged by #156)
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
