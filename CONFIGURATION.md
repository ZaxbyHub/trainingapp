# Configuration Guide

Comprehensive guide to configuring the Document Q&A Assistant, including environment variables, GUI settings, and RAG pipeline tuning.

## Table of Contents

1. [Overview](#overview)
2. [Environment Variables](#environment-variables)
3. [GUI Settings](#gui-settings)
4. [LLM Backend Configuration](#llm-backend-configuration)
5. [RAG Pipeline Configuration](#rag-pipeline-configuration)
6. [Performance Tuning](#performance-tuning)
7. [Advanced Features](#advanced-features)
8. [Configuration File Formats](#configuration-file-formats)
9. [Troubleshooting Configuration](#troubleshooting-configuration)

## Overview

The Document Q&A Assistant offers multiple configuration options through:
- **GUI Settings Dialog**: User-friendly interface for most settings
- **Environment Variables**: Command-line and automation
- **Configuration Files**: JSON-based persistence
- **Command-Line Arguments**: Runtime overrides

**Configuration Storage**:
- GUI settings: `AppData/DocumentQA/app_settings.json`
- RAG config: `doc_qa_db/rag_config.json`
- Database: `doc_qa_db/` (ChromaDB storage)

## Environment Variables

Set environment variables before running the application or in your system's environment configuration.

### Core Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `RAG_DB_PATH` | Vector database location | `./doc_qa_db` | No |
| `RAG_GGUF_PATH` | Path to GGUF model file | None | Yes for GGUF backend |
| `RAG_CHUNK_SIZE` | Document chunk size (words) | `256` | No |
| `RAG_CHUNK_OVERLAP` | Chunk overlap (words) | `50` | No |
| `RAG_N_RESULTS` | Context chunks to retrieve | `3` | No |
| `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |

### LLM Backend Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `RAG_MODEL_PATH` | OpenVINO model path | None | Yes for OpenVINO |
| `RAG_OLLAMA_URL` | Ollama server URL | `http://localhost:11434` | No |
| `RAG_OLLAMA_MODEL` | Ollama model name | `phi3:mini` | No |
| `RAG_API_URL` | OpenAI-compatible API URL | None | No |
| `RAG_API_MODEL` | API model name | `default` | No |

### Performance Variables

| Variable | Description | Default | Recommended |
|----------|-------------|---------|-------------|
| `RAG_MAX_TOKENS` | Max response tokens | `512` | 512-1024 |
| `RAG_TEMPERATURE` | LLM temperature | `0.3` | 0.1-0.5 |
| `RAG_TOP_P` | Top-p sampling | `0.9` | 0.9 |
| `RAG_DO_SAMPLE` | Enable sampling | `True` | True |
| `API_PORT` | API server port | `8080` | 8080 |

### RAG Advanced Variables

| Variable | Description | Default | Recommended |
|----------|-------------|---------|-------------|
| `RAG_RETRIEVAL_WINDOW` | Window expansion (chunks) | `0` | 0-2 |
| `RAG_HYBRID_SEARCH` | Enable BM25+Vector search | `True` | True |
| `RAG_RERANKING_ENABLED` | Enable cross-encoder reranking | `False` | False |
| `RAG_RERANKER_MODEL` | Reranker model name | `cross-encoder/ms-marco-MiniLM-L-2-v2` | Same |
| `RAG_QUERY_TRANSFORM_ENABLED` | Enable query transformation | `False` | False |
| `RAG_INITIAL_RETRIEVAL_TOP_K` | Initial retrieval count | `20` | 10-30 |

### Embedding Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `RAG_EMBEDDING_MODEL` | Embedding model name | `BAAI/bge-small-en-v1.5` | No |

## GUI Settings

### Accessing Settings

1. Launch the application
2. Click "⚙ Settings" button in the top bar
3. Configure options and click "Save"

### LLM Settings

#### GGUF Model Path

**Purpose**: Path to the GGUF format LLM model file

**Options**:
- Manual path entry with file browser
- Automatically detects models ending in `.gguf`

**Recommended Path**:
```
C:\Models\qwen2.5-1.5b-instruct-q4_k_m.gguf
```

**File Requirements**:
- Must start with "GGUF" magic bytes
- Size: 1-2 GB for 1.5B-8B models
- Format: Q4_K_M (recommended)

**Troubleshooting**:
```
Error: Invalid GGUF file
Solution: Check file integrity and magic bytes
```

#### Ollama Settings

**Purpose**: Connect to local Ollama runtime

**Ollama URL**:
```
http://localhost:11434
```

**Ollama Model**:
```
phi3:mini
# Or: qwen2.5:7b
```

**Prerequisites**:
1. Install Ollama: https://ollama.ai/download
2. Run `ollama serve`
3. Pull model: `ollama pull phi3:mini`

#### API Settings

**Purpose**: Connect to OpenAI-compatible API

**API URL**:
```
http://localhost:8000/v1  # Local server
https://api.openai.com/v1  # OpenAI
```

**API Model**:
```
gpt-4
gpt-3.5-turbo
```

### RAG Settings

#### Chunk Size

**Purpose**: Number of words per document chunk

**Ranges**:
- 128-256: Small chunks, more precise context
- 256-512: Balanced (recommended)
- 512-1024: Large chunks, less overhead

**Trade-offs**:
- Smaller chunks: Better for long documents
- Larger chunks: Faster processing

#### Results to Retrieve

**Purpose**: Number of context chunks to fetch

**Ranges**:
- 1-3: Fast, less context
- 3-5: Balanced (recommended)
- 5-10: More context, slower

**Combined with Window Expansion**:
```
n_results=3, window=1 → 5 chunks total
n_results=3, window=2 → 7 chunks total
```

#### Max Tokens

**Purpose**: Maximum response length

**Ranges**:
- 256-512: Short answers (recommended)
- 512-1024: Medium answers
- 1024-2048: Long answers

**Trade-offs**:
- Smaller: Faster, more focused
- Larger: More detail, slower

#### Temperature

**Purpose**: LLM response creativity

**Ranges**:
- 0.0-0.2: Deterministic, factual (recommended)
- 0.2-0.5: Balanced
- 0.5-1.0: Creative

**Recommended Values**:
- Factual tasks: 0.1
- Creative writing: 0.7
- General use: 0.3

### Advanced RAG Settings

#### Hybrid Search

**Purpose**: Enable BM25 + Vector search with RRF fusion

**Status**: Enabled by default

**How it works**:
1. BM25 scores keyword matches
2. Vector embeddings score semantic relevance
3. RRF combines both ranked lists
4. Returns top N results

**Performance Impact**:
- Small (~5% overhead)
- Improves accuracy

#### Window Expansion

**Purpose**: Automatically fetch adjacent chunks around retrieved results

**Range**: 0-3 chunks

**Example**:
```
Query retrieves: Chunk 5, 7
Window=1: Also fetches Chunk 4, 6, 8
Window=2: Also fetches Chunk 3, 6, 9
Window=0: No expansion
```

**Use Cases**:
- Multi-part questions
- Detailed explanations
- Context continuity

#### Cross-Encoder Reranking

**Purpose**: Rerank retrieved chunks for better relevance

**Model**: `cross-encoder/ms-marco-MiniLM-L-2-v2`

**Impact**:
- Increases accuracy (~10-20%)
- Slower retrieval (~2x time)

**Recommendation**:
- Enable if quality is critical
- Disable for speed

## LLM Backend Configuration

### Backend Priority

The application tries backends in this order:
1. **GGUF** (User-provided path)
2. **OpenVINO** (User-provided path)
3. **Ollama** (Local server)
4. **OpenAI API** (External API)

### GGUF Configuration

**Advantages**:
- CPU-only, no GPU required
- Fast inference
- Offline capability
- No dependencies beyond llama-cpp-python

**Parameters**:
```
n_ctx=8192        # Context window size
n_threads=4       # CPU threads
```

**Model Selection**:
- Qwen2.5-1.5B (1.5GB, recommended)
- Qwen2.5-7B (7GB, better quality)
- Llama3-8B (4.8GB, general purpose)
- Phi-3-Mini (2.3GB, fastest)

### OpenVINO Configuration

**Requirements**:
- Intel CPU, GPU, or NPU
- Install OpenVINO Toolkit

**Advantages**:
- Hardware acceleration
- Best performance

**Configuration**:
```
device=NPU         # Use NPU
device=GPU         # Use GPU
device=CPU         # Use CPU
```

### Ollama Configuration

**Requirements**:
- Install Ollama
- Run `ollama serve`

**Configuration**:
```bash
# Pull model
ollama pull phi3:mini

# Run server
ollama serve
```

### OpenAI API Configuration

**Requirements**:
- API key
- Network access

**Configuration**:
```
API URL: https://api.openai.com/v1
API Key: sk-...
Model: gpt-4
```

## RAG Pipeline Configuration

### Pipeline Flow

```
User Question
    ↓
1. Query Processing (optional transformation)
    ↓
2. Hybrid Search (BM25 + Vector + RRF)
    ↓
3. Window Expansion (optional)
    ↓
4. Reranking (optional)
    ↓
5. Context Assembly
    ↓
6. LLM Generation
    ↓
Answer + Sources
```

### Step-by-Step Configuration

#### Step 1: Query Processing

**Query Transformation** (Optional)
- Generates generalized queries
- Helps retrieve broader context
- Example: "What is max speed of Ford Mustang?" → "Ford Mustang specifications"

**Keyword Extraction** (Optional)
- Extracts key terms
- Improves BM25 search
- Removes stop words

#### Step 2: Hybrid Search

**Configuration**:
```python
hybrid_search=True      # Enable/disable
initial_top_k=20        # Total chunks to retrieve
```

**Output**:
- BM25 scores (keyword relevance)
- Vector scores (semantic relevance)
- RRF fusion scores (combined)

#### Step 3: Window Expansion

**Configuration**:
```python
window=1   # Fetch 1 chunk before and after
```

**Benefits**:
- Context continuity
- Better for multi-part questions
- Improved answer quality

#### Step 4: Reranking

**Configuration**:
```python
reranking_enabled=False
reranker_model="cross-encoder/ms-marco-MiniLM-L-2-v2"
```

**Benefits**:
- Ranks retrieved chunks by relevance
- Replaces initial hybrid results
- Higher accuracy

#### Step 5: Context Assembly

**Configuration**:
```python
min_similarity=0.3  # Filter low-relevance chunks
context_truncation=2000  # Max context length
```

**Format**:
```
Chunk 1
---

Chunk 2
---

Chunk 3
```

## Performance Tuning

### CPU-Only (GGUF Backend)

**Recommended Settings**:
```python
chunk_size=256
n_results=3
max_tokens=512
temperature=0.3
hybrid_search=True
window=1
```

**Performance**:
- Inference: 5-10 tokens/sec
- Retrieval: 100-200 ms
- Overall: ~1-2 seconds per query

### With NVIDIA GPU (OpenVINO)

**Recommended Settings**:
```python
chunk_size=512
n_results=5
max_tokens=1024
temperature=0.2
hybrid_search=True
window=2
```

**Performance**:
- Inference: 30-50 tokens/sec
- Retrieval: 50-100 ms
- Overall: ~0.3-0.5 seconds per query

### With Intel NPU (OpenVINO)

**Recommended Settings**:
```python
chunk_size=512
n_results=5
max_tokens=1024
temperature=0.2
hybrid_search=True
window=2
```

**Performance**:
- Inference: 25-35 tokens/sec
- Retrieval: 50-100 ms
- Overall: ~0.4-0.6 seconds per query

### Memory Optimization

**For Limited RAM**:
```python
chunk_size=128
n_results=2
max_tokens=256
temperature=0.3
hybrid_search=False
window=0
```

**Benefits**:
- Lower memory usage
- Faster processing
- Less accuracy

## Advanced Features

### Step-back Query Transform

**Purpose**: Generate more general queries

**Example**:
```
Specific: "What is the max speed of the Ford Mustang GT?"
General:  "Ford Mustang GT specifications"
```

**Configuration**:
```python
query_transform_enabled=True
```

**When to Use**:
- Multi-step questions
- Need broader context
- Improved retrieval

### Cross-Encoder Reranking

**Purpose**: Re-rank for higher accuracy

**Model**: MS MARCO MiniLM

**Configuration**:
```python
reranking_enabled=True
reranker_model="cross-encoder/ms-marco-MiniLM-L-2-v2"
```

**Performance Impact**:
- +10-20% accuracy
- +2x retrieval time

**When to Use**:
- Critical applications
- High accuracy requirements
- Can afford slower queries

### Context Truncation

**Purpose**: Limit context length for LLM

**Configuration**:
```python
max_context_length=2000  # characters
```

**Default**: 2000 characters (~500 tokens)

**Benefits**:
- Prevents out-of-context errors
- Reduces memory usage
- Faster generation

## Configuration File Formats

### GUI Settings (JSON)

**Location**: `AppData/DocumentQA/app_settings.json`

**Example**:
```json
{
  "gguf_path": "C:\\Models\\qwen2.5-1.5b-instruct-q4_k_m.gguf",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "phi3:mini",
  "api_url": "",
  "chunk_size": 512,
  "n_results": 3,
  "max_tokens": 512,
  "temperature": 0.3,
  "db_path": "C:\\Users\\User\\AppData\\Roaming\\DocumentQA\\doc_qa_db",
  "hybrid_search": true,
  "retrieval_window": 1,
  "reranking_enabled": false
}
```

### RAG Configuration (JSON)

**Location**: `doc_qa_db/rag_config.json`

**Example**:
```json
{
  "db_path": "./doc_qa_db",
  "chunk_size": 256,
  "chunk_overlap": 50,
  "n_results": 3,
  "min_similarity": 0.3,
  "max_tokens": 512,
  "temperature": 0.3,
  "embedding_model": "BAAI/bge-small-en-v1.5",
  "retrieval_window": 0,
  "hybrid_search": true,
  "reranking_enabled": false,
  "reranker_model": "cross-encoder/ms-marco-MiniLM-L-2-v2",
  "query_transformation_enabled": false,
  "initial_retrieval_top_k": 20
}
```

### Command-Line Overrides

**Format**:
```bash
python main.py [OPTIONS]
```

**Example**:
```bash
python main.py \
  --gguf-path "C:\Models\qwen2.5-1.5b-instruct-q4_k_m.gguf" \
  --chunk-size 512 \
  --n-results 5 \
  --max-tokens 1024 \
  --temperature 0.2 \
  --hybrid-search \
  --retrieval-window 2
```

## Troubleshooting Configuration

### Issue: "No LLM backend available"

**Possible Causes**:
1. GGUF model path incorrect
2. Model file corrupted
3. Backend not installed

**Solutions**:
```powershell
# Verify GGUF model
dir C:\path\to\qwen2.5-1.5b-instruct-q4_k_m.gguf

# Check file size (should be ~1.5GB)

# Try alternative backend
set RAG_MODEL_PATH=C:\AImodels\phi3.5-mini-instruct-int4-cw-ov
python main.py
```

### Issue: "chromadb not installed"

**Solution**:
```powershell
pip install chromadb --break-system-packages
```

### Issue: "sentence-transformers not installed"

**Solution**:
```powershell
pip install sentence-transformers
```

### Issue: "rank_bm25 not installed"

**Solution**:
```powershell
pip install rank-bm25
```

### Issue: Hybrid search not working

**Diagnosis**:
```python
# Check if BM25 is built
stats = engine.vector_store.get_stats()
print(f"BM25 index: {stats.get('bm25_index') is not None}")
print(f"Hybrid search: {engine.config.hybrid_search}")
```

**Common Issues**:
1. `rank-bm25` not installed
2. No documents ingested yet
3. BM25 index not built

**Fix**:
```powershell
pip install rank-bm25
# Re-ingest documents
python main.py --ingest "C:\Documents"
```

### Issue: Slow queries

**Possible Causes**:
1. High chunk count
2. Large context size
3. No GPU/NPU acceleration

**Optimizations**:
```python
# Reduce chunk size
chunk_size=128

# Reduce number of results
n_results=2

# Disable reranking
reranking_enabled=False

# Disable query transformation
query_transformation_enabled=False
```

### Issue: Low accuracy

**Possible Causes**:
1. Too few context chunks
2. Low similarity threshold
3. Poor model selection

**Optimizations**:
```python
# Increase results
n_results=5

# Increase window
window=2

# Enable reranking
reranking_enabled=True

# Use better model
gguf_path="path/to/larger_model.gguf"
```

### Issue: Memory errors

**Diagnosis**:
```python
# Check memory usage
import psutil
print(f"Memory: {psutil.virtual_memory().percent}%")
```

**Solutions**:
```python
# Reduce chunk size
chunk_size=128

# Reduce context length
max_tokens=256

# Disable heavy features
reranking_enabled=False
query_transformation_enabled=False
```

---

**Version**: 1.0.0
**Last Updated**: 2026-02-28
