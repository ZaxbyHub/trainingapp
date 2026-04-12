# Document Q&A Assistant

A fully offline RAG-based document question answering system optimized for Windows PCs. Features semantic search, hybrid retrieval, and CPU-based LLM inference with GGUF models.

## 🚀 Features

### Core Capabilities
- **Offline-First Design**: No internet required after initial setup
- **Multi-format Support**: PDF, DOCX, PPTX, TXT, MD documents
- **Hybrid Retrieval**: BM25 + Vector search with Reciprocal Rank Fusion (RRF)
- **Window Expansion**: Automatically fetches adjacent context chunks
- **Smart Chunking**: Paragraph and sentence boundary aware
- **Cross-Encoder Reranking**: Optional MS MARCO MiniLM for precise ranking

### LLM Backends (Priority Order)
The application tries backends in this priority order:

1. **GGUF (Primary)** - CPU-only inference with llama-cpp-python
   - Set via: `RAG_GGUF_PATH` environment variable or `--gguf-path` CLI option
   - Model: Qwen2.5-1.5B-Instruct-Q4_K_M (lightweight, high performance)
   - No GPU required
   - ~5-10 tokens/second on standard CPU

2. **OpenVINO** - NPU/GPU/CPU acceleration (Intel)
   - Set via: `--model-path` CLI option
   - Falls back to GGUF if not configured

3. **OpenAI-compatible API** - External API integration
   - Set via: `RAG_API_URL` environment variable or `--api-url` CLI option
   - Falls back to previous backends if not configured

4. **Ollama** - Local LLM runtime
   - Set via: `RAG_OLLAMA_URL` environment variable or `--ollama-url` CLI option
   - Fallback option when other backends unavailable

### Hardware Requirements
#### Minimum (Intel 11th Gen i5, 16GB RAM)
- Windows 11 (64-bit)
- Intel Core i5 11th generation or newer (or equivalent AMD Ryzen 5000+)
- Intel integrated graphics (present on all 11th gen+ Intel CPUs) — no discrete GPU required
- 16GB RAM
- ~4GB free storage for model + app
- **Performance**: ~5-7 tokens/second

#### Recommended (Intel 12th Gen i7, 32GB RAM)
- Intel Core i7 12th generation or newer (or equivalent AMD Ryzen 7000+)
- Intel Iris Xe integrated graphics or discrete GPU
- 32GB RAM
- SSD for vector database
- **Performance**: ~10-15 tokens/second

#### High-Performance (Intel 13th Gen i9, 64GB RAM)
- High-end CPU (Intel Core i9 or AMD Ryzen 9)
- 64GB RAM
- Intel Arc or NVIDIA discrete GPU for OpenVINO acceleration
- **Performance**: 20-30+ tokens/second

## 🆕 New Features (Version 1.1.0)

### Settings (Phase 6)
- **Real-time UI Updates**: Font size slider now applies to all widgets immediately when saved
- **Debug Mode**: Toggle debug-level logging for troubleshooting
- **Log File Persistence**: Customizable log file path with automatic persistence
- **Auto-Reconfiguration**: RAG settings (chunk size, n_results, etc.) trigger engine reinitialization when changed

### Chat Improvements (Phase 7)
- **Thinking Indicator**: Animated "Thinking..." with dots while LLM generates responses
- **Smart Regeneration**: "Regenerate" button replaces the last assistant message instead of creating duplicates
- **Feedback System**: Working thumbs up/down buttons that persist to database
- **Conversation Context Menu**: Right-click options to delete or rename conversations
- **Time Display**: Relative timestamps in sidebar (e.g., "2 min ago", "Yesterday")

## 📦 Installation

### Method 1: Standard Python Installation

#### Prerequisites
- Windows 10 or later
- Python 3.10+
- pip package manager

#### Installation Steps

1. **Clone or download the repository**
   ```powershell
   cd doc_qa_app
   ```

2. **Install dependencies**
   ```powershell
   pip install -r requirements.txt
   ```

3. **Download required models**

   **GGUF Model (Required for LLM inference)**
   ```powershell
   # Download Qwen2.5-1.5B-Instruct-Q4_K_M model
   # From Hugging Face: https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF
   # Save as: qwen2.5-1.5b-instruct-q4_k_m.gguf
   ```

   **Embedding Model (Required for search)**
   ```powershell
   # BAAI/bge-small-en-v1.5 is automatically downloaded on first use
   # Can be manually downloaded if needed for offline installation
   ```

4. **Run the application**

   **GUI Mode** (default):
   ```powershell
   python main.py
   ```

   **CLI Mode**:
   ```powershell
   python main.py --cli
   ```

   **API Server**:
   ```powershell
   python main.py --api --port 8080
   ```

### Method 2: Offline Bundle Installation (Recommended for Enterprises)

1. **Download the offline installer bundle**
   - Includes Python embeddable, wheels, and model files

2. **Extract the bundle**
   - Unzip to a directory on your machine

3. **Install**
   - Run the provided installer or execute `main.py`

4. **No internet required** after installation

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RAG_DB_PATH` | Vector database location | `./doc_qa_db` |
| `RAG_GGUF_PATH` | Path to GGUF model file | - |
| `RAG_CHUNK_SIZE` | Document chunk size (words) | `512` |
| `RAG_N_RESULTS` | Context chunks to retrieve | `3` |
| `RAG_MAX_TOKENS` | Max response tokens | `1024` |
| `RAG_TEMPERATURE` | LLM temperature | `0.3` |
| `API_PORT` | API server port | `8080` |

## 🔐 API Authentication (Production Required)

⚠️ **Warning**: Authentication is **disabled by default** for development convenience. **MUST be enabled** for any production or shared environment.

### Enabling Authentication

Set both environment variables to enable authentication:

| Variable | Description | Example |
|----------|-------------|---------|
| `ENABLE_AUTH` | Enable authentication (any value enables) | `true` |
| `API_KEY` | Secret API key for authentication | `your-secure-api-key` |

#### Linux/macOS
```bash
export ENABLE_AUTH=true
export API_KEY="your-secure-api-key"
python main.py --api --port 8080
```

#### Windows PowerShell
```powershell
$env:ENABLE_AUTH=$true
$env:API_KEY="your-secure-api-key"
python main.py --api --port 8080
```

### Using Authentication

All API requests require authentication headers:

- **API Key**: `X-API-Key: <your-api-key>`
- **JWT Bearer Token**: `Authorization: Bearer <jwt-token>`

### Python Example

```python
import requests
import os

# Configure authentication
os.environ["ENABLE_AUTH"] = "true"
os.environ["API_KEY"] = "your-secure-api-key"

# Make authenticated request
headers = {
    "X-API-Key": os.environ["API_KEY"]
}

response = requests.post("http://localhost:8080/ask", json={
    "question": "What are the main findings?",
    "n_results": 3
}, headers=headers)

print(response.json())
```

### Security Notes

- Always use HTTPS in production
- Rotate API keys regularly
- Store API keys in environment variables, never in code
- See [USAGE.md](USAGE.md) for complete authentication documentation

**Backend Selection:**
The application selects backends in priority order (GGUF → OpenVINO → API → Ollama).
If `RAG_GGUF_PATH` is set, GGUF is used. Otherwise, falls through to next available backend.

## 📖 Usage

### Ingest Documents

**GUI Mode**:
1. Click "Ingest" button
2. Select document folder (folder-based ingestion)
3. Wait for processing to complete

*Note: GUI supports folder-based batch ingestion. For single-file upload, use API or CLI mode.*

**CLI Mode**:
```powershell
# Ingest all documents in a directory
python main.py --ingest "C:\Documents\reports"

# Ingest a single file
python main.py --ingest "C:\Documents\report.pdf"
```

**API Mode**:
```python
import requests

# Ingest entire directory
response = requests.post("http://localhost:8080/ingest", json={
    "directory": "C:/Documents/reports"
})
print(response.json())

# Upload and ingest single file
with open("C:/Documents/report.pdf", "rb") as f:
    response = requests.post(
        "http://localhost:8080/ingest/file",
        files={"file": ("report.pdf", f, "application/pdf")}
    )
print(response.json())
```

### Ask Questions

**GUI Mode**:
1. Type your question in the input field
2. Press Enter or click "Ask"
3. View the answer with source citations

**CLI Mode**:
```powershell
# Single question
python main.py --query "What are the main findings?"

# Interactive mode
python main.py --cli
```

**API Mode**:
```python
import requests

response = requests.post("http://localhost:8080/ask", json={
    "question": "What are the main findings?",
    "n_results": 3
})
print(response.json())
```

### Advanced Features

#### Hybrid Search (Default: Enabled)
Combines BM25 keyword search with vector semantic search using RRF fusion:
- BM25: Fast keyword matching
- Vector: Semantic understanding
- RRF Fusion: Combines both for optimal results

#### Window Expansion
Automatically fetches adjacent chunks around retrieved results:
- Configurable window size (default: 1 chunk)
- Ensures context continuity
- Improves answer quality for multi-part questions

#### Cross-Encoder Reranking
MS MARCO TinyBERT reranker (enabled by default):
- Ranks retrieved chunks by relevance after initial retrieval
- Higher accuracy than pure hybrid search
- Lightweight (~85MB) — optimized for minimum-spec hardware
- Can be disabled via Settings dialog

#### Step-back Query Transform
Keyword-based query expansion (disabled by default):
- Extracts key terms from questions to improve retrieval
- Note: The LLM-based step-back transformation is not wired (latency cost too high for minimum-spec hardware)

## ⚙️ Configuration

### GUI Settings Dialog

**LLM Settings**:
- GGUF Model Path: Path to `.gguf` model file
- Ollama URL: Local Ollama server endpoint
- Ollama Model: Ollama model name
- API URL: OpenAI-compatible API endpoint

**RAG Settings**:
- Chunk Size: Number of words per chunk
- Results to Retrieve: Number of chunks for context
- Max Tokens: Maximum response length
- Temperature: Response creativity (0.0-1.0)

**Advanced Settings**:
- Hybrid Search: Enable/disable BM25+Vector search
- Window Expansion: Number of adjacent chunks to fetch
- Cross-Encoder Reranking: Enable/disable reranking

### Command-Line Options

```powershell
python main.py [OPTIONS]

Options:
  --api                         Run API server
  --cli                         Run in interactive CLI mode
  --ingest PATH                 Ingest documents from directory
  --query QUESTION              Ask a question
  --db-path PATH                Path to vector database (default: ./doc_qa_db)
  --model-path PATH             Path to GGUF model file (legacy alias for --gguf-path)
  --gguf-path PATH              GGUF model path
  --ollama-url URL              Ollama server URL (default: http://localhost:11434)
  --ollama-model NAME           Ollama model name (default: phi3:mini)
  --api-url URL                 OpenAI-compatible API URL
  --port PORT                   API server port (default: 8080)
  --chunk-size SIZE             Chunk size in words (default: 512)
  --chunk-overlap N             Chunk overlap in words (default: 50)
```

## 🏗️ Architecture

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Document Q&A App                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Document     │    │ Vector Store │    │ LLM Interface│  │
│  │ Processor    │───▶│ (ChromaDB+   │    │ (GGUF/OpenVINO│  │
│  │              │    │  BM25+RRF)   │◀───│   /Ollama)   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                   │                    │          │
│         └───────────────────┴────────────────────┘          │
│                           │                                 │
│                    ┌──────▼──────┐                          │
│                    │ RAG Engine  │                          │
│                    │ (Query      │                          │
│                    │  Processing)│                          │
│                    └──────┬──────┘                          │
│                           │                                 │
│                    ┌──────▼──────┐                          │
│                    │ GUI / API   │                          │
│                    └─────────────┘                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Components

**Document Processor**
- Extracts text from PDF, DOCX, PPTX, TXT, MD
- Semantic chunking with paragraph/sentence boundaries
- Chunk overlap for context continuity

**Vector Store**
- ChromaDB for semantic vector storage
- BM25Index for keyword-based search
- Reciprocal Rank Fusion (RRF) for hybrid results
- Window expansion for context fetching

**LLM Interface**
- GGUF backend (primary): llama-cpp-python
- OpenVINO backend: Intel GenAI
- Ollama backend: Local LLM runtime
- OpenAI-compatible: External APIs

**RAG Engine**
- Query processing and routing
- Hybrid search orchestration
- Context assembly and answer generation
- Source citation tracking

## 🔧 Troubleshooting

### "No LLM backend available"

**Solution 1: GGUF Model Not Found**
```powershell
# Check if model file exists
dir qwen2.5-1.5b-instruct-q4_k_m.gguf

# If not, download from:
# https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF
```

**Solution 2: Wrong Model Path**
- Check Settings dialog for correct path
- Use "Browse" button to select model file

### "chromadb not installed"

```powershell
pip install chromadb --break-system-packages
```

### "sentence-transformers not installed"

```powershell
pip install sentence-transformers
```

### "llama-cpp-python not installed"

```powershell
# CPU-only build (recommended)
pip install llama-cpp-python

# With CUDA support (if you have NVIDIA GPU)
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121
```

### Slow First Run

- Embedding model (~80MB) downloads on first use
- Subsequent runs use cached model
- BM25 index is built on first ingestion

### Memory Errors with Large Documents

**Solution 1: Reduce chunk size**
```powershell
python main.py --chunk-size 128
```

**Solution 2: Increase chunk overlap**
```powershell
python main.py --chunk-size 256 --chunk-overlap 100
```

**Solution 3: Reduce number of results**
```powershell
$env:RAG_N_RESULTS=2
```

### Hybrid Search Not Working

**Check BM25 is enabled**:
```python
# In API, check config
from rag_engine import create_engine_from_env
engine = create_engine_from_env()
print(engine.config.hybrid_search)  # Should be True
```

**Verify both backends loaded**:
```python
# Check vector store stats
stats = engine.vector_store.get_stats()
print(f"Embedding model: {stats['embedding_model']}")
print(f"BM25 index: {'Ready' if engine.vector_store.bm25_index else 'Not built'}")
```

## 📚 API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/stats` | GET | Engine statistics |
| `/ask` | POST | Ask a question |
| `/search` | POST | Search documents |
| `/ingest` | POST | Ingest directory |
| `/ingest/file` | POST | Upload and ingest file |
| `/documents` | GET | List documents |
| `/documents` | DELETE | Clear all documents |

### Example: Ask a Question

```python
import requests
import json

# Configure the engine
os.environ["RAG_GGUF_PATH"] = "path/to/qwen2.5-1.5b-instruct-q4_k_m.gguf"

# Start API server in another terminal
# python main.py --api --port 8080

# Ask a question
response = requests.post("http://localhost:8080/ask", json={
    "question": "What are the main findings?",
    "n_results": 3
})

result = response.json()
print(f"Answer: {result['answer']}")
print(f"Sources: {result['sources']}")
print(f"Inference time: {result['inference_time']:.2f}s")
```

## 📦 Building Standalone Executable

### Prerequisites

```powershell
pip install pyinstaller
```

### Build

```powershell
python build.py
```

The executable will be created in `dist/DocumentQA.exe`.

### Including Models (Offline Bundle)

To create an offline installer:

```powershell
# Prepare installer files
python scripts/build_installer.py

# Manually download:
# 1. GGUF model to build_installer/models/
# 2. Embedding model to build_installer/embeddings/
# 3. Python embeddable to python_embeddable/

# Run Inno Setup
iscc build_installer/setup.iss
```

This creates an offline installer with all dependencies and models included.

## 📋 Project Structure

```
doc_qa_app/
├── main.py                 # Main entry point
├── app_gui.py              # GUI application (customtkinter)
├── api_server.py           # FastAPI REST server
├── rag_engine.py           # RAG orchestration
├── document_processor.py   # Document extraction & semantic chunking
├── vector_store.py         # Vector search (ChromaDB + BM25 + RRF)
├── llm_interface.py        # LLM backends (GGUF/OpenVINO/Ollama)
├── reranking.py            # Cross-encoder reranking
├── query_transformer.py    # Query transformation
├── utils.py                # Utility functions (RRF fusion)
├── requirements.txt        # Python dependencies
├── build.py                # PyInstaller build script
├── scripts/
│   └── build_installer.py  # Inno Setup preparation
└── README.md               # This file
```

## 🛡️ Security & Privacy

- **Offline-Only**: No data leaves your machine
- **No Cloud Services**: All processing is local
- **Model Bundling**: Models are stored locally
- **Portable**: Can be run from USB drive

## 📄 License

MIT License - See LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 🙏 Acknowledgments

- [ChromaDB](https://www.trychroma.com/) - Vector database
- [Sentence Transformers](https://www.sbert.net/) - Embedding models
- [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) - GGUF inference
- [OpenVINO](https://docs.openvino.ai/) - Intel inference optimization
- [PyMuPDF](https://pymupdf.readthedocs.io/) - PDF processing
- [CustomTkinter](https://customtkinter.tomschimansky.com/) - Modern GUI toolkit

---
**Version**: 1.1.0
**Last Updated**: 2026-03-01
**Hardware**: CPU-only optimized for Intel 11th gen i5 and above (16GB RAM minimum)
