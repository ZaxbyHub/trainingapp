# Configuration Guide

> **Scope note (issue #89):** this guide documents the **legacy Python harness** (`api_server.py` / `config.py`, the CI conformance surface), not the shipped v3 Electron desktop app. The desktop app is configured in-app (settings surface; profile model per docs/adr/0006-profile-model.md) and packages its models per ADR-0002 — no `RAG_*` environment variables are involved. Reranking here defaults to `cross-encoder/ms-marco-MiniLM-L6-v2` with `RAG_RERANKING_ENABLED=False` (config.py:66-72); the shipped v3 surfaces use `cross-encoder/ettin-reranker-32m-v1` (ADR-0001).

Comprehensive guide to configuring the Document Q&A Assistant, including environment variables, GUI settings, and RAG pipeline tuning.

## Table of Contents

1. [Overview](#overview)
2. [Environment Variables](#environment-variables)
3. [GUI Settings](#gui-settings)
4. [Provider Server (OpenAI-compatible)](#provider-server-openai-compatible)
5. [LLM Backend Configuration](#llm-backend-configuration)
6. [RAG Pipeline Configuration](#rag-pipeline-configuration)
7. [Performance Tuning](#performance-tuning)
8. [Advanced Features](#advanced-features)
9. [Configuration File Formats](#configuration-file-formats)
10. [Troubleshooting Configuration](#troubleshooting-configuration)

## Overview

The Document Q&A Assistant offers multiple configuration options through:
- **GUI Settings Dialog**: User-friendly interface for most settings
- **Environment Variables**: Command-line and automation
- **Configuration Files**: JSON-based persistence
- **Command-Line Arguments**: Runtime overrides

**Configuration Storage**:
- GUI settings: `%LOCALAPPDATA%\\AFOMIS Help and Support\\settings.json`
- RAG config: `doc_qa_db/rag_config.json`
- Database: `doc_qa_db/` (ChromaDB storage)

## Environment Variables

Set environment variables before running the application or in your system's environment configuration.

### Core Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `RAG_DB_PATH` | Vector database location | `./doc_qa_db` | No |
| `RAG_GGUF_PATH` | Path to GGUF model file | None | Yes for GGUF backend |
| `RAG_CHUNK_SIZE` | Document chunk size (words) | `512` | No |
| `RAG_CHUNK_OVERLAP` | Chunk overlap (words) | `50` | No |
| `RAG_N_RESULTS` | Context chunks to retrieve | `3` | No |
| `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |

### LLM Backend Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `RAG_GGUF_PATH` | Path to GGUF model file | Bundled Gemma 4 E2B | No |
| `RAG_FAST_PROFILE_PATH` | Optional smaller fallback GGUF loaded when the primary model fails the RAM gate | None (fallback disabled) | No |

### Performance Variables

| Variable | Description | Default | Recommended |
|----------|-------------|---------|-------------|
| `RAG_MAX_TOKENS` | Max response tokens | `1024` | 512-1024 |
| `RAG_TEMPERATURE` | LLM temperature | `0.3` | 0.1-0.5 |
| `API_PORT` | API server port | `8080` | 8080 |
| `API_HOST` | API server bind address. Defaults to `127.0.0.1` (loopback only); set `0.0.0.0` to expose on your LAN — enable `ENABLE_AUTH=true` if you do | `127.0.0.1` | 127.0.0.1 |

### API Authentication Variables

| Variable | Description | Default | Required for Production |
|----------|-------------|---------|------------------------|
| `ENABLE_AUTH` | Enable API authentication | `false` | YES |
| `API_KEY` | API key for authentication | None | YES |
| `JWT_SECRET` | Secret for JWT token signing | Random | Recommended |
| `JWT_EXPIRATION_HOURS` | JWT token lifetime in hours | `24` | Optional |

#### Security Warning

⚠️ **Critical**: Leaving `ENABLE_AUTH=false` in production is a severe security risk. This disables authentication on your API, allowing unrestricted access to your application and potentially sensitive data. Always enable authentication in production environments.

#### Generating Secure API Keys

**Linux/macOS (OpenSSL)**:
```bash
# Generate a secure 64-character API key
openssl rand -hex 32

# Or generate a URL-safe base64 string
openssl rand -base64 32
```

**Windows (PowerShell)**:
```powershell
# Generate a secure 64-character API key
-[Convert]::ToBase64String((New-Object byte[] 32))

# Or generate a hex string (requires .NET 5+)
-([Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes((New-Object byte[] 32))
-b2a
```

### RAG Advanced Variables

| Variable | Description | Default | Recommended |
|----------|-------------|---------|-------------|
| `RAG_RETRIEVAL_WINDOW` | Window expansion (chunks) | `1` | 0-2 |
| `RAG_HYBRID_SEARCH` | Enable BM25+Vector search | `True` | True |
| `RAG_RERANKING_ENABLED` | Enable cross-encoder reranking | `True` | True |
| `RAG_RERANKER_MODEL` | Reranker model name | `cross-encoder/ms-marco-MiniLM-L6-v2` | Same |
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
C:\Models\gemma-4-e2b-it\model.gguf
```

**File Requirements**:
- Must start with "GGUF" magic bytes
- Size: 1-4 GB for 2B-8B models
- Format: Q4_K_M (the quant packaged by ADR-0002 / issue #84; ~2.9 GB nominal per PACKAGING.md; 2,620,370,976 bytes (~2.6 GB) measured per bench/RESULTS.md)

**Bundled Model**:
The application uses `gemma-4-e2b-it/model.gguf` (Q4_K_M, ADR-0002) staged under `models/`. This model is automatically detected on first run if no custom model is configured.

**Troubleshooting**:
```
Error: Invalid GGUF file
Solution: Check file integrity and magic bytes
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

**Model**: `cross-encoder/ms-marco-MiniLM-L6-v2` (Python-harness default, disabled by default; shipped v3 surfaces use `cross-encoder/ettin-reranker-32m-v1` per ADR-0001)

**Impact**:
- Increases accuracy (~10-20%)
- Slower retrieval (~2x time)

**Recommendation**:
- Enable if quality is critical
- Disable for speed


## Provider Server (OpenAI-compatible)

The web/desktop app can send its chat directly to a locally served LLM that speaks the
standard OpenAI wire format — llama-server (`llama-server`), LM Studio, Ollama's compat
endpoint, or vLLM. **This release accepts loopback servers only**
(`http://127.0.0.1:<port>`): the packaged desktop app's content-security policy permits only
the IPv4 loopback, and the app validates this up front. (IPv6 loopback `[::1]` is NOT
supported: Chromium cannot parse it as a CSP source-list entry, so a `[::1]` server would be
network-blocked at runtime in the packaged build.) Serving on a LAN address? Bind the
server to loopback for now — widening to LAN/remote hosts is a deliberate desktop-CSP decision
flagged for maintainers.

**Setup (Settings → Inference Mode → "Provider server (OpenAI-compatible)")**:

1. **Base URL** — the server root, e.g. `http://127.0.0.1:8080`. Loopback only in this
   release. A `/v1` suffix is optional (the app appends it when missing); pasting the full
   `.../v1/chat/completions` or `.../v1/models` also works, and a pasted query/fragment or
   `user:pass@` prefix is stripped.
2. **Model id** — the model name the server exposes (e.g. the loaded GGUF id llama-server
   reports on `/v1/models`).
3. **API key (optional)** — sent as `Authorization: Bearer <key>`. Stored locally in plain
   text in the app's profile storage; it is sent ONLY to the configured server. Local servers
   usually need no key.
4. **Test Connection** — probes `{base}/v1/models` (sending the configured API key, when
   one is set, so key-protected servers exercise their real auth path); it never requires the
   project's own `/auth/status` route, so a standard OpenAI-compatible server probes green.
   Editing any connection field clears a previous result, and a result that lands after the
   URL changed is discarded.
5. **First token** — chat waits up to 10 minutes for the first streamed byte (cold model
   loads and CPU prompt evaluation over bounded history legitimately take minutes; the bound
   clears on first byte and does not cap total generation length).

**What provider mode does and does not do**:

- Chat is DIRECT generation: your question plus bounded recent conversation context is POSTed
  to `{base}/v1/chat/completions` (streamed). **Your conversation context is sent to that
  server**, and responses are NOT grounded in your documents — provider mode is plain chat,
  not RAG. Document Q&A stays available in the other modes.
- The server must allow browser requests from the app origin (CORS). This varies by server:
  llama-server and vLLM typically accept browser origins out of the box, while LM Studio and
  Ollama may require enabling a CORS toggle or allow-listing origins — if Test Connection
  fails on a healthy server, check its CORS/origins setting first.
- In the desktop app the selection persists across restarts (the built-in backend does not
  override it); the quick mode toggle in the chat header is hidden in provider mode — switch
  modes from Settings.
- The old "API Server" option is different: in the desktop app it means the app's OWN built-in
  backend; in the browser build it points at this project's Python `api_server.py` (the
  `/ask` contract), not at an OpenAI endpoint.

## LLM Backend Configuration

### Supported Backends

Only GGUF models are supported through the GUI Settings dialog. The application uses the GGUF model specified in the settings.

### GGUF Configuration

**Advantages**:
- CPU-only, no GPU required
- Fast inference
- Offline capability
- No dependencies beyond llama-cpp-python

**Parameters**:
```
n_ctx=4096                            # Context window size
n_threads=min(os.cpu_count() or 4, 8) # CPU threads (all CPUs up to 8; 4 if cpu_count unavailable)
```

**Model Load RAM Gate**:
Before loading a GGUF model the app estimates the free RAM requirement as
`model file size + ~1 GB KV cache + ~1 GB runtime overhead` (about 5-6 GB for
the bundled ~2.9 GB (nominal) Gemma 4 E2B model). If the estimate exceeds available
RAM the load is refused with a diagnostic naming the model, the required and
available memory. The `RAG_FAST_PROFILE_PATH` fallback fires only when the
primary model is refused by this RAM gate AND the fast-profile file exists
on disk — not for corrupt files, a missing `llama-cpp` install, a missing
primary path, or a fast profile that itself fails to load (those surface the
diagnostic directly) — through the GUI error message and the API 503
`detail`.

**Model Selection**:
- Gemma 4 2B (2GB, recommended - bundled)
- Qwen2.5-1.5B (1.5GB)
- Qwen2.5-7B (7GB, better quality)
- Llama3-8B (4.8GB, general purpose)

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
reranker_model="cross-encoder/ms-marco-MiniLM-L6-v2"
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
chunk_size=512
n_results=3
max_tokens=1024
temperature=0.3
hybrid_search=True
window=1
```

**Performance**:
- Inference: 5-10 tokens/sec
- Retrieval: 100-200 ms
- Overall: ~1-2 seconds per query

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

**Model**: MS MARCO MiniLM-L6-v2 (harness default; shipped surfaces: ettin-reranker-32m-v1)

**Configuration**:
```python
reranking_enabled=True
reranker_model="cross-encoder/ms-marco-MiniLM-L6-v2"
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

**Location**: `%LOCALAPPDATA%\\AFOMIS Help and Support\\settings.json`

**Example**:
```json
{
  "gguf_path": "C:\\Models\\gemma-4-e2b-it\\model.gguf",
  "chunk_size": 512,
  "n_results": 3,
  "max_tokens": 1024,
  "temperature": 0.3,
  "db_path": "C:\\Users\\User\\AppData\\Local\\AFOMIS Help and Support\\data\\vector_db",
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
  "chunk_size": 512,
  "chunk_overlap": 50,
  "n_results": 3,
  "min_similarity": 0.3,
  "max_tokens": 1024,
  "temperature": 0.3,
  "embedding_model": "BAAI/bge-small-en-v1.5",
  "retrieval_window": 1,
  "hybrid_search": true,
  "reranking_enabled": false,
  "reranker_model": "cross-encoder/ms-marco-MiniLM-L6-v2",
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
  --gguf-path "C:\Models\gemma-4-e2b-it\model.gguf" \
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
dir C:\path\to\gemma-4-e2b-it\model.gguf

# Check file size (should be ~2.9 GB nominal / 2,620,370,976 bytes (~2.6 GB) measured per bench/RESULTS.md for Q4_K_M)

# If using custom model, set RAG_GGUF_PATH
set RAG_GGUF_PATH=C:\Models\your-model.gguf
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

## Knowledge Pack Recency (packs.recency.*)

Ranking of hybrid-retrieval results (issue #71 / C4) applies a linear recency
prior to fused scores, per ADR-0004: `multiplier = 1.0 - (1.0 - floor) *
min(1.0, age_months / floorMonths)` with `age_months = (now -
published_at) / 30.44 days`. Chunks from inactive/superseded pack versions
are excluded from ranking, and identical content across active packs is
deduped deterministically. Unpackaged documents are neutral (multiplier 1.0).

| Key (logical) | Env variable (Python `RAG_*` / desktop `TRAININGAPP_*`) | Default | Meaning |
| --- | --- | --- | --- |
| `packs.recency.floor` | `RAG_PACKS_RECENCY_FLOOR` / `TRAININGAPP_PACKS_RECENCY_FLOOR` | `0.85` | Multiplier floor reached at `floorMonths` age |
| `packs.recency.floorMonths` | `RAG_PACKS_RECENCY_FLOOR_MONTHS` / `TRAININGAPP_PACKS_RECENCY_FLOOR_MONTHS` | `18` | Age (30.44-day months) at which the floor is reached |
| `packs.recency.halfLifeMonths` | `RAG_PACKS_RECENCY_HALF_LIFE_MONTHS` / `TRAININGAPP_PACKS_RECENCY_HALF_LIFE_MONTHS` | `9` | Reserved for the optional exponential variant; NOT wired — the linear form ships in both backends |

The same three keys are exposed via `GET/PUT /settings`
(`packs_recency_*` / `rag_packs_recency_*` fields) on the Python API.

## Knowledge Pack Install Security (packs.security.*)

Install-time hardening gates for Knowledge Packs (issue #75 / C8): resolved-path
containment, zip bomb / entry-count / compression-ratio caps, mandatory doc
sha256 verification, embedding-model and schema compatibility gates, and opt-in
ed25519 signature verification. Threat model: `docs/security/packs.md`.

| Key (logical) | Env variable (Python `RAG_*` / desktop `TRAININGAPP_*`) | Default | Meaning |
| --- | --- | --- | --- |
| `packs.security.maxUncompressedBytes` | `RAG_PACKS_SECURITY_MAX_UNCOMPRESSED_BYTES` / `TRAININGAPP_PACKS_MAX_UNCOMPRESSED_BYTES` | `2147483648` | Declared + written-bytes cap; ZIP64 archives are refused outright on the Node verify path |
| `packs.security.maxEntries` | `RAG_PACKS_SECURITY_MAX_ENTRIES` / `TRAININGAPP_PACKS_MAX_ENTRIES` | `5000` | Entry-count cap |
| `packs.security.maxCompressionRatio` | `RAG_PACKS_SECURITY_MAX_COMPRESSION_RATIO` / `TRAININGAPP_PACKS_MAX_COMPRESSION_RATIO` | `100` | Declared ratio cap, enforced only for archives >= 16 MiB uncompressed (small archives are bounded by the byte cap) |
| `packs.security.requireSignature` | `RAG_PACKS_SECURITY_REQUIRE_SIGNATURE` / `TRAININGAPP_PACKS_REQUIRE_SIGNATURE` | `false` | Refuse unsigned packs (opt-in until E5 ships trusted-key distribution) |
| `packs.security.trustedKeys` | `RAG_PACKS_SECURITY_TRUSTED_KEYS` / `TRAININGAPP_PACKS_TRUSTED_KEYS` | `[]` | JSON array of `{"key_id","public_key"}` (public_key = base64 DER SPKI) |
| `packs.security.embeddingModelId` | — / `TRAININGAPP_PACKS_EMBEDDING_MODEL_ID` | `bge-small-en-v1.5` | Canonical embedding-model gate target (desktop config/env override) |

Note: an empty-string value for a numeric `RAG_PACKS_SECURITY_*` variable fails
Pydantic parsing at Python startup (set an explicit value or unset the
variable); the desktop `TRAININGAPP_PACKS_*` reader falls back to defaults
instead. Set `packs.security.requireSignature=true` only together with a
`trustedKeys` entry, or every install is refused.

## Update Channel (updates.*, E5)

Signed update channel for the app binary and knowledge packs (issue #88, ADR-0010).
Desktop-only (Electron main process); there is no Python-side update surface. Checks are
**disabled by default** — a fresh install makes zero update-related network calls until the
user opts in (Settings → Updates).

| Key (logical) | Where | Default | Meaning |
| --- | --- | --- | --- |
| `updates.optIn` | `<profileDir>/updates.json` (`desktopApi.setUpdateOptIn`) | `false` | Master gate; corruption fails closed to disabled. Enabling triggers one check |
| `updates.feedUrl` | `<profileDir>/updates.json` (hand-edit) | baked default | Feed document URL; must be `https:` |
| feed location (baked) | `DEFAULT_UPDATE_FEED_URL` in `desktop/main/update-checker.ts` | `https://github.com/ZaxbyHub/trainingapp/releases/latest/download/pack-feed.json` | GitHub Releases "latest" asset pattern |
| trust anchor (baked) | `UPDATE_FEED_PUBLIC_KEY` in `desktop/main/update-checker.ts` | `trainingapp-update-feed-2026-09` | Ed25519 public key; every feed entry's sha256 signature must verify against it (no unsigned fallback) |

Notes: checks run at app start (opted in) and via "Check for updates now" — no background timer.
`<profileDir>` is the directory holding `store.sqlite` (e.g.
`%APPDATA%/trainingapp-desktop/profiles/default/` - the runtime folder follows the package
name `trainingapp-desktop`, not the installer's display name). Publishing/signing a feed: `docs/updates.md`;
decision record: `docs/adr/0010-update-channels.md`.
