# Configuration Guide

> **Scope note (issue #89):** this guide documents the **legacy Python harness** (`api_server.py` / `config.py`, the CI conformance surface), not the shipped v3 Electron desktop app. The desktop app is configured in-app (settings surface; profile model per docs/adr/0006-profile-model.md) and packages its models per ADR-0002 — no `RAG_*` environment variables are involved. Reranking here defaults to `cross-encoder/ms-marco-MiniLM-L6-v2` with `RAG_RERANKING_ENABLED=False` (config.py:66-72); the shipped v3 surfaces use `cross-encoder/ettin-reranker-32m-v1` (ADR-0001).

Comprehensive guide to configuring the Document Q&A Assistant, including environment variables, GUI settings, and RAG pipeline tuning.

## Table of Contents

1. [Overview](#overview)
2. [Environment Variables](#environment-variables)
3. [GUI Settings](#gui-settings)
4. [External model (OpenAI- and Anthropic-compatible endpoints)](#external-model-openai--and-anthropic-compatible-endpoints)
5. [App Settings (desktop and browser app)](#app-settings-desktop-and-browser-app)
6. [LLM Backend Configuration](#llm-backend-configuration)
7. [RAG Pipeline Configuration](#rag-pipeline-configuration)
8. [Performance Tuning](#performance-tuning)
9. [Advanced Features](#advanced-features)
10. [Configuration File Formats](#configuration-file-formats)
11. [Troubleshooting Configuration](#troubleshooting-configuration)

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
| `RAG_CHUNK_OVERLAP` | Chunk overlap (words) | `100` | No |
| `RAG_N_RESULTS` | Context chunks to retrieve | `4` | No |
| `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |

### LLM Backend Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `RAG_GGUF_PATH` | Path to GGUF model file | Bundled Gemma 4 E2B | No |
| `RAG_FAST_PROFILE_PATH` | Optional smaller fallback GGUF loaded when the primary model fails the RAM gate | None (fallback disabled) | No |

### Performance Variables

| Variable | Description | Default | Recommended |
|----------|-------------|---------|-------------|
| `RAG_MAX_TOKENS` | Max response tokens | `512` | 512-1024 |
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
| `RAG_RERANKING_ENABLED` | Enable cross-encoder reranking | `False` | True |
| `RAG_RERANKER_MODEL` | Reranker model name | `cross-encoder/ms-marco-MiniLM-L6-v2` | Same |
| `RAG_QUERY_TRANSFORM_ENABLED` | Enable query transformation | `False` | False |
| `RAG_INITIAL_RETRIEVAL_TOP_K` | Initial retrieval count | `12` | 10-30 |

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


## External model (OpenAI- and Anthropic-compatible endpoints)

The browser app and the desktop app can send answer generation to a model served somewhere
else instead of the local model: a server on this computer (LM Studio, Ollama, llama-server,
vLLM), a server on your LAN, or a cloud provider with an API key (OpenAI, Anthropic,
OpenRouter). The decision and its security consequences are recorded in
`docs/adr/0011-external-model-endpoints.md`.

- **Off by default and opt-in.** A fresh install never contacts an external model. Nothing is
  sent until you turn on "Use external model" and enter a base URL.
- **Grounded by default.** Retrieval over your documents still runs locally. Only the
  question, the retrieved passages and a bounded window of recent conversation are sent to the
  endpoint, and answers keep their citations and sources. Because the retrieved passages are
  document text, that text leaves your machine for the endpoint you configured.
- **Direct chat is a separate opt-in.** "Direct chat (no document grounding)" is off by
  default. When on, the question and recent conversation are sent with no retrieval, and the
  answer is labelled "General knowledge".
- The old "Provider server (OpenAI-compatible)" inference-mode choice is gone. A stored
  provider configuration from the previous release is migrated once automatically: in the
  browser app into the External model settings (as Direct chat, as before); in the desktop app
  into the desktop backend's settings, with the legacy renderer copy, including its key,
  deleted.

### Setup (Settings → External model)

The same controls appear in the browser app and the desktop app:

1. **Use external model** — the switch.
2. **Protocol** — "OpenAI-compatible" or "Anthropic-compatible".
3. **Base URL** — the server root, for example `http://localhost:1234`. See the URL rules
   below.
4. **API key** — a password field. Local servers usually need none.
5. **Model** — type the model id, or pick it from the list that "Test connection" fills in.
6. **Test connection** — lists the server's models and checks the chosen model. In the desktop
   app it tests the draft values without saving anything.
7. **Direct chat (no document grounding)** — the toggle described above.
8. **Remember API key in this browser** — browser app only (see Key storage).

### URL rules

One policy applies in both apps (`web_ui/src/lib/llm/endpoint-policy.ts`,
`desktop/main/security/endpoint-policy.ts`; shared vectors in
`contracts/endpoint-policy-vectors.json` and
`contracts/endpoint-policy-vectors.supplemental.json`):

- **Loopback** (127.0.0.0/8, `::1`, `localhost`) and **private network** (10.0.0.0/8,
  172.16.0.0/12, 192.168.0.0/16; IPv6 ULA fc00::/7; names ending `.local`, `.lan`,
  `.home.arpa` or `.internal`) may use `http` or `https`.
- **Every other host is public and requires `https`.** This includes 100.64.0.0/10
  carrier-grade NAT addresses such as Tailscale: use `https`, or a `.lan` / `.internal` name
  that you control. A single-label name such as `http://gpu-box` also counts as public: use
  `gpu-box.lan` or the IP address.
- **Always refused:** cloud metadata (169.254.169.254, `fd00:ec2::254`,
  `metadata.google.internal`), link-local (169.254.0.0/16, fe80::/10), `0.0.0.0` and `::`,
  multicast and broadcast addresses, URLs containing `user:password@`, and any scheme other
  than `http` or `https`.
- Numeric IPv4 spellings (decimal, octal, hex, short forms such as `127.1`) and IPv6 forms that
  embed an IPv4 address (`::ffff:...`, SIIT `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96`, local-use
  NAT64 `64:ff9b:1::/48`, 6to4 `2002::/16`) are classified by the embedded address. Teredo
  (`2001::/32`) and local-use NAT64 addresses whose embedded address cannot be located are
  treated as private network, never public, and are refused when an embedded address is.

In the desktop app a refused URL is a 422 whose message names the rule.

### Providers and base URLs

Each entry gives the protocol and a base URL example. Pick the protocol first; the base URL is
the server root.

- **OpenAI** — OpenAI-compatible protocol, base URL `https://api.openai.com`. Needs an API
  key.
- **Anthropic** — Anthropic-compatible protocol, base URL `https://api.anthropic.com`. Needs
  an API key. From the browser app the header `anthropic-dangerous-direct-browser-access: true`
  is sent automatically.
- **OpenRouter** — OpenAI-compatible protocol, base URL `https://openrouter.ai/api`. Needs an
  API key.
- **LM Studio** — OpenAI-compatible protocol, base URL `http://localhost:1234`. For the browser
  app, enable CORS in LM Studio's server settings.
- **Ollama** — OpenAI-compatible protocol, base URL `http://localhost:11434`. For the browser
  app, set `OLLAMA_ORIGINS` to the app's origin if it is not one of Ollama's default allowed
  origins.
- **llama-server** — OpenAI-compatible protocol, base URL `http://localhost:8080`. For the
  browser app, allow the app origin with `--cors-origins` or the equivalent option your
  llama-server version supports.
- **vLLM** — OpenAI-compatible protocol, base URL `http://localhost:8000`. A server on your
  LAN works the same way, for example `http://192.168.1.20:8000`.

A `/v1` suffix on the base URL is optional.

### CORS

- **Browser app:** the browser calls the endpoint directly, so the endpoint must allow the
  app's origin (CORS). If "Test connection" fails against a server you know is running, check
  the server's CORS or allowed-origins setting first; the error is reported as a network/CORS
  error. Cloud providers differ: Anthropic accepts browser calls only with the header above;
  check your provider's documentation for the others.
- **Desktop app:** CORS does not apply. The desktop backend makes the request, not the
  renderer, so no server-side CORS setting is needed.

### Airgap builds

Airgap builds refuse public hosts; loopback and private-network endpoints still work.

- Browser app: the build made with `npm run build:airgap` (`VITE_AIRGAP=1`).
- Desktop app: when the installer resources manifest (`installer-resources/manifest.json`,
  field `"airgap": true`, staged by `desktop:build`) says so, or when the environment variable
  `TRAININGAPP_AIRGAP=1` is set. The environment variable can only tighten the restriction.
  To produce an air-gapped desktop build, set `TRAININGAPP_INSTALLER_AIRGAP=1` for
  `npm run desktop:build` (or pass `--airgap` to `desktop/scripts/build-installer-manifest.mjs`);
  every build writes the field explicitly as `true` or `false`.
  The manifest flag is not signed: it is protected only by write access to the install
  directory (administrator for per-machine installs, none for portable builds).

### Key storage

- **Browser app:** the key is stored in this browser. While "Remember API key in this browser"
  is on it is kept in `localStorage` (`external-provider-apikey`); otherwise it is kept in
  `sessionStorage` and cleared when the browser session ends. The rest of the configuration
  (never the key) is in `localStorage` (`external-provider-config`). Clear Cache removes both.
  Any script running in the page can read a browser-stored key.
- **Desktop app:** the key is encrypted with Electron `safeStorage` (Windows DPAPI, macOS
  Keychain, Linux secret service) in the profile directory (`secrets.bin`). If the operating
  system offers no encryption the key is kept for the current session only and the panel says
  "Key kept for this session only". The renderer never sees or stores the key; it is never
  written to `settings.json` or `external.json`, never returned by any endpoint and never
  logged.
- **Both apps: the key is bound to its origin.** A saved key is bound to the endpoint origin
  (`scheme://host:port`, compared case-insensitively with default ports dropped, so
  `https://api.example.com` and `https://api.example.com:443` are the same origin while
  `http://localhost:1234` and `http://127.0.0.1:1234` are not) it was entered for. If you point
  the base URL at a different origin the key is NOT sent there (neither for answers nor for
  "Test connection"); the panel says "Your saved key is for <origin>. Enter the key for this
  server to use it." Entering the key again binds it to the new origin. Changing or clearing
  the base URL never moves the key to another origin, and pointing back uses it again. The
  browser app keeps the bound origin next to the key (`external-provider-apikey-origin`, in the
  same storage); a key saved by an earlier version without an origin is bound to the base URL
  saved with it, or discarded if there is none.

### Browser app transport limits

The browser app uses `redirect: 'error'` (redirects are never followed, so a key is never
replayed to another host) and omits credentials. A browser cannot resolve DNS, so it cannot
check what a name resolves to; the desktop app does. When a key would be sent over plain
`http` to a network (non-loopback) host the panel warns.

### Desktop app transport

The desktop backend (Node main process) makes all external calls
(`desktop/main/backend/net/guarded-request.ts`); the renderer's content-security policy is
unchanged. For each request it resolves the host name and refuses if any resolved address is
cloud metadata, link-local or unspecified; requires the answers to match the name's class (a
private name may resolve only to private or loopback addresses, a loopback name only to
loopback); connects to the validated address with the lookup pinned; and follows no redirects.

- **Timeouts:** 10 minutes for the first byte (cold model loads and long prompt evaluation
  legitimately take minutes) and 2 minutes of silence between streamed chunks. Stop cancels the
  request.
- **Certificates:** Node's bundled CAs plus the operating system's certificate store are
  trusted; `NODE_EXTRA_CA_CERTS` is also honoured, which is the way to trust a corporate or
  private CA.
- **Proxies:** not used in this release. A public endpoint reachable only through a mandatory
  HTTP proxy will not work; loopback and LAN endpoints are never proxied.
- **Settings channel:** `PUT /settings` accepts `external.enabled`, `external.protocol`
  (`openai` or `anthropic`), `external.baseUrl`, `external.model`, `external.apiKey`
  (write-only; an empty string clears it) and `external.grounded`. `GET /settings` returns the
  same fields without the key, plus `external.apiKeySet`, `external.apiKeyPersisted`,
  `external.apiKeyBoundOrigin` and `external.airgap`. The non-secret settings are saved in
  `<profile dir>/external.json`, not `settings.json`, so older app versions still load
  `settings.json`. `POST /settings/external/test` tests a draft connection without saving.
- **No local model files needed:** with the external model on, the desktop app does not need
  the local GGUF model files (no missing-model overlay, no local warm-up), and
  `GET /status/models` reports engine `external`.

### Errors

Errors name the fix: authentication (401/403: check the API key), unknown model (404 or not in
the list: pick a model from the list), network/CORS (cannot reach the server: check that it is
running, the base URL and, in the browser app, the server's CORS setting) and timeout.

### What this does not change

The Python `api_server.py` has no external backend and is unchanged. The desktop app's
"API Server" inference mode is different: it means the desktop app's own built-in backend
(the `/ask` contract), not an external endpoint. The browser app has no API-server mode.

## App Settings (desktop and browser app)

This section covers the Settings page of the shipped app (`web_ui/src/pages/SettingsPage.tsx`)
in both the desktop app (Electron) and the browser build. Every control either takes effect on
the path the app is actually using or is hidden with a one-line reason.

### Inference modes

- **Browser-local**: the model runs in the browser (wllama on the CPU, or WebLLM on WebGPU).
- **API Server**: the desktop app's own built-in backend. It exists **only in the desktop app**.
  The browser build has no API-server mode: a browser profile that stored the old
  `mode: "api"` is migrated once to Browser-local on load, its stored server URL is dropped,
  and its engine, response-quality and external model choices are kept. The migration is one-way.
External endpoints are not an inference mode: they are the External model setting (see the
section above), which you can use from either mode.

Mode-specific controls are shown only where they can act: Browser Engine, browser memory use
and Hardware Capability only in Browser-local mode; the desktop inference profile only in the
desktop app's API Server mode.

### Response Quality presets (desktop backend)

In the desktop app each preset is a backend setting: choosing one PUTs its full patch to the
desktop backend (`PUT /settings`), in any inference mode
(`web_ui/src/lib/rag/rag-presets.ts`, `DESKTOP_PRESET_SETTINGS`):

| Preset   | `rag_n_results` | `rag_reranking_enabled` | `rag_max_tokens` | `rag_temperature` |
|----------|-----------------|-------------------------|------------------|-------------------|
| Fast     | 5               | false                   | 384              | 0.3               |
| Balanced | 8               | true                    | 512              | 0.3               |
| Quality  | 10              | true                    | 1024             | 0.2               |

In the browser build the preset applies to browser-local chat only (there is no backend to
write).

**Precedence.** For `rag_reranking_enabled`, `rag_max_tokens` and `rag_temperature` an
**explicitly set** value wins. Otherwise reranking follows the retrieval environment default
(`TRAININGAPP_RETRIEVAL_RERANK`, default on — `desktop/main/backend/retrieval/config.ts`) and
answer length/temperature follow the inference profile (Quality 1024 / 0.2, Fast 384 / 0.3 —
`desktop/main/backend/inference/llama-engine.ts`). A fresh install sets nothing explicitly, so
it behaves exactly as before. An explicit preset value keeps winning over the inference
profile until it is reset. Reranking can only run when a reranker was built at startup; when
none was, the preset cards say "Reranking unavailable on this installation" and reranking is
effectively off. In particular, with `TRAININGAPP_RETRIEVAL_RERANK=false` no reranker is built at
startup, so an explicit `rag_reranking_enabled: true` has no effect and the UI shows "Reranking
unavailable on this installation".

**Reset.** "Reset to defaults" sends `PUT /settings {"reset": ["rag_n_results",
"rag_reranking_enabled", "rag_max_tokens", "rag_temperature"]}`. `reset` is a request
directive, never a stored key: it must be the only property of the request, it restores the
named `rag_*` keys to their defaults, removes them from the explicit set and from the persisted
`settings.json` sidecar, and is never replayed at startup. Unknown keys are rejected with 422
and nothing is committed.

**What GET /settings reports (desktop backend).** The flat keys keep their names but carry
**effective** values — what the next query uses — so the desktop's flat `max_tokens`,
`temperature` and `reranking_enabled` are profile- and environment-dependent and differ from
the Python backend's flat defaults by design. Optional properties explain the values
(`desktop/main/backend/engine.ts`; `contracts/api.openapi.yaml` `SettingsResponse`):

- `explicit_keys` — the `rag_*` keys a client explicitly set;
- `requested` — the explicit preset values (`null` when not set);
- `effective` — the preset values the next query uses;
- `reranking_available` — whether a reranker can run;
- `not_applied` — every stored keyspace key with no desktop reader. Today that includes
  `rag_chunk_size`, `rag_chunk_overlap`, `rag_min_similarity`, `rag_hybrid_search`,
  `rag_context_truncation`, `rag_retrieval_window`, `rag_initial_retrieval_top_k`,
  `rag_rerank_top_k` and the stored `rag_packs_recency_*` values (pack recency comes from the
  `TRAININGAPP_PACKS_RECENCY_*` environment variables). These keys are validated and saved
  but do not change desktop behavior; `rag_min_similarity` and `rag_hybrid_search` stay
  unwired on purpose (the calibrated relevance floor of ADR-0007 governs, and fused scores are
  not cosine similarities).

The Settings page derives the selected preset from these values: a preset is shown only when
every explicitly set preset key matches it; otherwise it shows "Custom server settings", or
"Using server defaults" when nothing is set. When `rag_n_results` is the only explicit key
(settings saved before presets wrote all four keys), the matching preset is shown with "Re-select
a preset to apply its reranking and answer settings": the backend is then not applying that
preset's reranking, answer length or temperature, and selecting the preset again applies them.

### Clear Cache

Clear Cache removes, in this browser profile: the document library and its keyword/vector
indexes, downloaded WebLLM weights, orphaned data from earlier sessions, and every saved
setting registered in `web_ui/src/lib/storage/persisted-keys.ts` (inference mode, browser
engine and response-quality choices, theme, external model connection and API key, sidebar state,
last-opened course). It keeps your chat history (conversations, stored separately from the
document library) and the internal profile id, migration marker and re-index notice flag, then
reloads the page. The desktop app removes the same browser-side data from its app window (the
browser-side document and index databases, downloaded browser-model files and saved settings);
it also keeps chat history and does **not** touch documents or settings stored by the desktop
backend — remove those documents from the Documents page.

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
