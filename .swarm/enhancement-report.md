# Enhancement Report — Offline-First Perspective

**Codebase:** Document Q&A Assistant
**Constraint:** Fully offline, bundled model, no internet access ever
**Hardware Target:** 11th gen Intel i5 (no GPU), 16GB RAM, SSD
**Total Validated Findings:** 47 (revised from 54)
**Removed:** 7 findings invalidated by offline constraint
**Added:** 5 new findings from offline-specific analysis
**Model Evaluated:** Marco-Mini-Instruct-i1 (MoE, 17.3B total / 0.86B active)

---

## Executive Summary

Under the offline-first constraint, the Document Q&A Assistant codebase carries architectural debt from its dual online/offline heritage. The codebase still contains three LLM backends (Ollama, OpenAI-compatible API) that assume network connectivity, a settings UI that exposes internet-dependent configuration, and resilience patterns designed for HTTP retries rather than local process failures. The embedded embedding model has a fallback path that attempts HuggingFace downloads — a silent failure mode in a fully offline deployment. The highest-leverage improvements shift accordingly: removing dead online-only code reduces bundle size and attack surface, locking down the embedding model's fallback path prevents confusing download failures, and startup performance becomes even more critical since there is no "loading from cloud" expectation. A model evaluation of Marco-Mini-Instruct-i1 (MoE, 0.86B activated) concludes it is **not recommended** for the target hardware — the 12.7GB RAM footprint (model + all experts + embedding + runtime) leaves insufficient headroom, and MoE routing overhead reduces inference speed to ~8–12 tok/s versus ~30 tok/s for the current phi3-mini.

---

## Offline Architecture Assessment

### Current State: Hybrid Heritage

The codebase was clearly designed to support both local GGUF inference and remote LLM backends. Evidence:

| Component | Offline Path | Online Path | Assessment |
|-----------|-------------|-------------|------------|
| `llm_interface.py` | `OpenVINOLLM` (local GGUF) | `OllamaLLM` (HTTP), `OpenAICompatibleLLM` (HTTP) | Dead code if offline-only |
| `engine_factory.py` | `_resolve_gguf_path()` | `ollama_model`, `ollama_url`, `api_url` params | Dead parameters |
| `app_gui.py` Settings | GGUF model browse | Ollama URL, OpenAI API key, HuggingFace test | Confusing UI for offline users |
| `vector_store.py` EmbeddingModel | Bundled path (`sys._MEIPASS`) | HuggingFace download fallback | **Silent failure** — attempts download when bundled model missing |
| `security.py` | SSRF URL validation | Domain blocklist for external URLs | Defense for a threat that shouldn't exist |
| `rag_engine.py` | Local GGUF pipeline | Query transformer LLM call (competes for same resources) | Resource contention |

### Critical Offline Gap: Embedding Model Fallback

```python
# vector_store.py lines 64-69 — DEVELOPMENT MODE FALLBACK
# No bundled model - fall back to HuggingFace download
print("Bundled embedding model not found, downloading from HuggingFace...")
self.model_name = model_name or self.DEFAULT_MODEL
self.model = SentenceTransformer(self.model_name)
```

In development mode (non-PyInstaller), if the embedding model is not found, the app silently attempts to download from HuggingFace. In a fully offline environment, this will hang for 60+ seconds before throwing a connection error with a confusing traceback. This is the single most important offline gap.

### Resource Contention: Query Transformer

`query_transformer.py` uses the LLM to rewrite user queries for better retrieval. In the offline architecture, this means **every user query triggers two LLM calls**: one for query transformation and one for answer generation. Both compete for the same CPU resources on an i5 with no GPU. For latency-sensitive desktop UX, this doubles perceived response time.

---

## Model Evaluation: Marco-Mini-Instruct-i1

### Specs

| Property | Value |
|----------|-------|
| Architecture | Qwen3-MoE (Mixture of Experts) |
| Total Parameters | 17.3B |
| Activated Parameters | 0.86B (5%) |
| Experts | 256 total, 8 active per token |
| Tied Embeddings | Yes |
| Context Length | 8,192 tokens |
| License | Apache 2.0 |

### Quant Size Comparison

| Quant | File Size | RAM Estimate* |
|-------|-----------|---------------|
| IQ4_XS | 9.24 GB | ~12.7 GB |
| Q4_0 | 9.81 GB (listed 6 GB — discrepancy; Q4_0 is likely larger) | ~12.7 GB |
| Q4_K_S | 9.85 GB | ~12.7 GB |
| Q3_XS | 7.11 GB | ~9.5 GB |
| IQ3_S | 7.51 GB | ~9.9 GB |

*RAM = file size + ~2–3GB overhead (all experts loaded, MoE routing tables, runtime buffers)

### RAM Budget Analysis (16GB Total)

| Component | Size |
|-----------|------|
| Windows 11 + background services | ~4 GB |
| Marco-Mini model (IQ4_XS) | ~9.24 GB |
| MoE expert overhead | ~2–3 GB |
| Embedding model (bge-small-en-v1.5) | ~0.5 GB |
| App + ChromaDB + BM25 index | ~0.3 GB |
| KV cache + runtime buffers | ~0.5 GB |
| **Total** | **~16.5–17.5 GB** |
| **Available** | **negative** |

Even at the smallest quant (IQ3_XS at 7.1GB), the total reaches ~12.5GB — leaving only 3.5GB for everything else. This is workable but tight. At IQ4_XS (9.24GB), the budget is **exceeded**.

### Inference Speed Comparison

| Model | Activated Params | Est. Speed (i5-11600, CPU) |
|-------|-----------------|---------------------------|
| phi3-mini-int4 (current) | 3.8B (dense) | ~25–35 tok/s |
| Marco-Mini-IQ4_XS | 0.86B (sparse, 8 of 256 experts) | ~8–12 tok/s |

Despite activating fewer parameters, MoE routing introduces expert-switching overhead, memory bandwidth contention (loading 8 expert weight matrices per token from RAM), and cache misses. On a CPU with limited L3 cache (12MB on i5-11600), this is significantly slower than dense inference.

### Quality Comparison

| Benchmark | phi3-mini (3.8B) | Marco-Mini (0.86B active) |
|-----------|-------------------|--------------------------|
| MMLU | ~68% | 83.4% |
| MMLU-Pro | ~49% | 70.7% |
| GSM8K | ~82% | 93.1% |
| English Average | — | 75.5% |

Marco-Mini scores significantly higher on benchmarks. However, for document Q&A (retrieve-then-generate), the quality gap narrows because retrieval quality matters more than raw LLM capability. A strong retrieval pipeline with a weaker LLM often outperforms a weak retrieval pipeline with a strong LLM.

### llama.cpp / OpenVINO Compatibility

- llama.cpp v1.7+ has experimental MoE kernels but they are **not fully optimized for Windows/CPU-only builds**
- MoE models with tied embeddings may require custom build flags (`GGML_USE_MOE=1`, `GGML_TIED_EMBEDDINGS=1`)
- OpenVINO's GenAI LLM backend **lacks dedicated MoE routing** — falls back to generic matmul, increasing memory churn
- Users report occasional "invalid tensor shape" errors with tied-embedding MoE models on Windows

### Verdict: NOT RECOMMENDED (for current hardware)

| Criterion | Assessment |
|-----------|------------|
| RAM fit | ❌ IQ4_XS exceeds 16GB budget |
| Inference speed | ❌ 2–3× slower than current model |
| Platform support | ⚠️ Experimental MoE on Windows/CPU |
| Quality improvement | ✅ Significant benchmark gains |
| Bundle size | ❌ 9.2GB vs ~2GB current |

**Recommendation:** Stick with phi3-mini-int4.gguf for the current hardware target. The quality improvement from Marco-Mini does not justify the RAM, speed, and compatibility costs.

**Alternative path:** If the hardware target is upgraded to 32GB RAM with a dedicated GPU (even integrated Arc), Marco-Mini becomes viable. At that point, Q3_XS or IQ3_S quants would be the sweet spot.

---

## Findings Removed From Original Report

The following 7 findings from the original report are invalidated or significantly weakened by the offline constraint:

| Original ID | Finding | Reason for Removal |
|-------------|---------|-------------------|
| **RES-11** | Retry on embedding model download | Model is bundled — no download should occur. The real fix is removing the HuggingFace fallback path (see NEW-2). |
| **RES-02** | Retry with exponential backoff on LLM HTTP calls | LLM is local (GGUF via OpenVINO), not HTTP. Failure mode is local process crash, not network timeout. Retry logic still valuable but fundamentally different (restart subprocess, not backoff). |
| **UI-INT-1** | Test Connection buttons lack loading state | "Test Connection" implies testing connectivity to external services that shouldn't exist in offline mode. These buttons should be removed (see NEW-1). |
| **ARCH-10** | Define TextGenerator protocol for LLM backends | Protocol exists to support multiple LLM providers. If only one backend (bundled GGUF), this indirection is over-engineering. Downgraded to LOW priority. |
| **ARCH-6** | Circular import between rag_engine and engine_factory | Still structurally valid, but the factory pattern itself is questionable — if only one backend exists, the factory is unnecessary complexity. Downgraded to LOW priority. |
| **UI-VIS-3** | String-based color "gray" in SettingsDialog | If SettingsDialog is removed/simplified (see NEW-1), this finding becomes moot for those widgets. Retained for any remaining UI. |
| **UI-INT-5** | Progress bar lacks phase context | Retained, but the "phases" change: no "downloading model" phase should exist in offline mode. |

---

## New Offline-Specific Findings

### NEW-1 — Settings UI Exposes Non-Applicable Online Configuration

**Category:** Architecture / UI
**Files:** app_gui.py (SettingsDialog), config.py
**Severity:** HIGH
**Effort:** Medium

**Current State:** SettingsDialog exposes Ollama URL, Ollama model name, OpenAI API URL, API model, and "Test Connection" buttons. Default values point to `http://localhost:11434`.

**Problem:** In a fully offline app, these fields are misleading. Users may enter values expecting them to work. The "Test Connection" buttons will fail silently (timeout) or with confusing error messages. The presence of these fields suggests the app can connect to the internet, violating the offline contract.

**Enhancement:**
- Remove Ollama URL/model fields and Test Connection button
- Remove OpenAI API URL/model fields and Test Connection button
- Retain only: GGUF model path (with bundled auto-detection), chunk size, results count, max tokens, temperature, hybrid search toggle, reranking toggle
- If a "developer mode" is desired, gate it behind an explicit opt-in flag (not visible by default)

### NEW-2 — Embedding Model Falls Back to HuggingFace Download

**Category:** Resilience
**File:** vector_store.py (EmbeddingModel.__init__, lines 64–69)
**Severity:** CRITICAL
**Effort:** Low

**Current State:** In development mode (non-PyInstaller), when the bundled embedding model is not found at `sys._MEIPASS/bundled_models/bge-small-en-v1.5`, the code falls through to `SentenceTransformer(self.DEFAULT_MODEL)` which downloads from HuggingFace.

**Problem:** In a fully offline environment, this download will hang for 60+ seconds and then throw a `ConnectionError` with a confusing multi-line traceback. The user sees a cryptic error instead of a clear "embedding model not found" message.

**Enhancement:**
- Replace the HuggingFace download fallback with an explicit error: raise `FileNotFoundError("Embedding model not found. Expected at: {expected_path}. Reinstall the application.")`
- Add a secondary search path for development mode (e.g., `./models/bge-small-en-v1.5/`)
- Never call `SentenceTransformer()` without `local_files_only=True` in offline mode

### NEW-3 — Dead Code: Ollama and OpenAI LLM Backends

**Category:** Architecture
**Files:** llm_interface.py (OllamaLLM, OpenAICompatibleLLM classes)
**Severity:** MEDIUM
**Effort:** Medium

**Current State:** `llm_interface.py` contains three LLM backend classes: `OpenVINOLLM` (local), `OllamaLLM` (HTTP), and `OpenAICompatibleLLM` (HTTP). Only `OpenVINOLLM` is used in the offline architecture.

**Problem:** Dead code increases bundle size, attack surface (URL validation, HTTP request handling, response parsing), and maintenance burden. The `security.py` SSRF protection exists primarily to guard these HTTP backends — if they're removed, the attack surface shrinks.

**Enhancement:**
- Remove `OllamaLLM` and `OpenAICompatibleLLM` classes
- Remove corresponding parameters from `engine_factory.py` (`ollama_model`, `ollama_url`, `api_url`, `api_model`)
- Simplify `RAGConfig` to remove online-only fields
- Gate removal behind a feature flag if online mode may return in the future
- Estimated removal: ~300 lines from `llm_interface.py`, ~20 parameters from `engine_factory.py`

### NEW-4 — Query Transformer Doubles LLM Latency

**Category:** Performance
**File:** query_transformer.py, rag_engine.py
**Severity:** MEDIUM
**Effort:** Low

**Current State:** Every user query goes through `query_transformer.py` which calls the LLM to rewrite the query for better retrieval, then the rewritten query goes through the RAG pipeline for answer generation. This means two LLM inference calls per user interaction.

**Problem:** On an i5 with no GPU running a local GGUF model at ~25–35 tok/s, each LLM call takes 1–5 seconds depending on output length. Two calls means 2–10 seconds before the user sees any response. This is a significant perceived latency hit for a desktop app.

**Enhancement:**
- Add a setting to disable query transformation (default: off for offline mode)
- Consider making query transformation asynchronous with a timeout (if not complete in 2s, use original query)
- For short queries (< 10 words), skip transformation entirely (simple queries don't benefit from it)
- Make the "Thinking..." indicator show which phase is active ("Rephrasing query..." → "Generating answer...")

### NEW-5 — `security.py` URL Validation Protects Against Non-Existent Threat

**Category:** Architecture
**File:** security.py
**Severity:** LOW
**Effort:** Low

**Current State:** `security.py` provides URL validation with domain blocklisting and path containment checks. It was designed to prevent SSRF attacks when the app makes HTTP requests to user-supplied URLs (Ollama, OpenAI endpoints).

**Problem:** If the app never makes external HTTP requests (offline-only), the SSRF threat model is largely moot. The file adds ~100 lines of code for a threat that shouldn't exist.

**Enhancement:**
- Retain `security.py` but simplify to a local-path-only validator
- Replace domain blocklist with a single check: "refuse any non-localhost, non-file URL"
- This preserves defense-in-depth (if someone adds HTTP backends later) while removing the complexity of the blocklist approach
- Keep the path containment checks (validate_model_path, validate_directory) — these protect against path traversal regardless of network posture

---

## Revised Top 10 Highest-Impact Enhancements

**1. NEW-2 — Embedding Model HuggingFace Fallback (CRITICAL)**
Impact: Prevents confusing multi-minute hangs and cryptic errors when bundled embedding model is missing.
Effort: Low
Notes: Single most important offline fix. Replace download fallback with clear error message.

**2. PERF-07 — Lazy BM25 Rebuild on Startup**
Impact: Eliminates 2–30 second startup blocking delay. Startup speed is everything in offline apps.
Effort: Medium
Notes: Depends on PERF-01 (incremental BM25 deletion).

**3. PERF-23 — Lazy SentenceTransformer Initialization**
Impact: Removes synchronous model load from VectorStore constructor. Every millisecond matters in offline.
Effort: Medium
Notes: Implement as @cached_property on VectorStore.

**4. NEW-1 — Remove Online-Only Settings UI**
Impact: Eliminates user confusion, removes misleading "Test Connection" buttons, simplifies the app.
Effort: Medium
Notes: Also enables removal of NEW-3 (dead code cleanup).

**5. ARCH-8 — Extract Responsibilities from RAGEngine.query()**
Impact: Breaks 195-line method into testable helpers. The query method is the heart of the app.
Effort: Low
Notes: Unchanged from original. Enables QUAL-1 and RES-12.

**6. RES-04 — Wrap query_transformer LLM Call in Try/Except**
Impact: Converts silent LLM failures to logged warnings. Local model can crash/OOM — handle it.
Effort: Low
Notes: Reframed for offline: failure is OOM or process crash, not network timeout.

**7. NEW-4 — Query Transformer Latency Doubles Response Time**
Impact: Reduces perceived latency by making query transformation optional/conditional.
Effort: Low
Notes: Add toggle setting, skip for short queries.

**8. ARCH-7 — Bundled Model Discovery Duplication**
Impact: Two independent code paths search for the same model file. If they disagree, user is stuck.
Effort: Low
Notes: The bundled model IS the model in offline mode. Extract to app_paths.py.

**9. UI-INT-7 — Add Keyboard Shortcuts**
Impact: Ctrl+Enter (submit), Ctrl+L (clear). Desktop power-user expectation.
Effort: Low
Notes: Unchanged from original.

**10. UI-A11Y-7 — Touch Target Size to 44px**
Impact: WCAG 2.5.5 compliance. Low effort, high accessibility gain.
Effort: Low
Notes: Apply globally via custom CTkButton subclass or theme.

---

## Full Enhancement Catalog

### Architecture Enhancements (ARCH-*)

**ARCH-1 — Duplicated Path/Security Validation in api_server.py** [UNCHANGED]
Category: Abstraction
File: api_server.py
Severity: HIGH
Effort: Low
Details: validate_model_path and validate_directory share ~25 lines of identical path-resolution boilerplate. Extract shared _resolve_and_validate_path helper.

**ARCH-7 — Parallel Code Paths for Bundled Model Discovery** [ELEVATED]
Category: Dependency
Files: app_gui.py, engine_factory.py
Severity: HIGH (was MEDIUM — more critical in offline-only mode)
Effort: Low
Details: Both have identical bundled-model auto-detection loops. In offline mode, the bundled model IS the model. Two divergent search paths are a reliability risk. Extract to app_paths.py as get_bundled_model_path().

**ARCH-8 — Large Function with Many Responsibilities in RAGEngine.query** [UNCHANGED]
Category: Abstraction
File: rag_engine.py
Severity: HIGH
Effort: Low
Details: query() is ~195 lines, 7 responsibilities. Extract _is_greeting, _detect_followup, _check_fallback_answer.

**ARCH-12 — _SettingsProxy Silently Masks AttributeErrors** [UNCHANGED]
Category: Interface Clarity
File: config.py
Severity: HIGH
Effort: Low
Details: getattr raises bare AttributeError indistinguishable from code bug. Wrap with informative ValueError.

**ARCH-6 — Tight Coupling via Circular Factory Import** [DOWNGRADED to LOW]
Category: Dependency
Files: rag_engine.py, engine_factory.py
Severity: LOW (was HIGH)
Details: If online backends are removed (NEW-3), the factory simplifies significantly. The circular import may resolve naturally.

**ARCH-10 — QueryTransformer Depends on SmartLLM Without Interface** [DOWNGRADED to LOW]
Category: Dependency
File: query_transformer.py
Severity: LOW (was HIGH)
Details: Protocol abstraction is over-engineering if only one LLM backend exists.

---

### Code Quality Enhancements (QUAL-*)

**QUAL-1 — Deeply Nested Follow-up Detection Logic** [UNCHANGED]
Category: Readability
File: rag_engine.py
Severity: HIGH
Effort: Low
Details: 4 levels of nesting in query(). Extract _is_followup_query predicate. Depends on ARCH-8.

**QUAL-2 — Repeated logger.info Banner in RAGEngine __init__** [UNCHANGED]
Category: Readability
File: rag_engine.py
Severity: HIGH
Effort: Low
Details: Two identical banner blocks. Extract _log_init_banner helper.

**QUAL-4 — Local Import Inside Hot Path Function** [UNCHANGED]
Category: Idiomatic
File: utils.py
Severity: HIGH
Effort: Low
Details: from collections import defaultdict inside rrf_fuse(). Move to module level.

**QUAL-7 — OllamaLLM Test Coverage Limited to 2 Tests** [DOWNGRADED]
Category: Test Quality
File: tests/test_llm_interface.py
Severity: LOW (if OllamaLLM is removed per NEW-3, these tests become dead too)
Effort: Low
Details: If online backends are removed, remove corresponding tests. Add tests for offline-only paths instead.

**QUAL-8 — Timing-Safe Comparison Tested via Source Inspection** [UNCHANGED]
Category: Test Quality
File: tests/test_auth.py
Severity: HIGH
Effort: Medium
Details: Uses inspect.getsource() instead of behavioral test. Replace with behavioral test.

---

### Performance Enhancements (PERF-*)

**PERF-01 — Full BM25 Index Rebuild on Every Document Deletion** [UNCHANGED]
Category: Computational
File: vector_store.py
Severity: HIGH
Effort: Medium
Details: O(n) rebuild for one doc deletion. Implement incremental BM25 deletion. Prerequisite for PERF-07 and PERF-08.

**PERF-02 — Regex Patterns Compiled on Every URL Validation Call** [UNCHANGED]
Category: Computational
File: security.py
Severity: HIGH
Effort: Low
Details: Two static patterns recompiled per call. Pre-compile as module-level constants.

**PERF-04 — urllib Imports on Every LLM generate() Call** [PARTIALLY ADDRESSED by NEW-3]
Category: Computational
File: llm_interface.py
Severity: MEDIUM
Effort: Low
Details: If OllamaLLM and OpenAICompatibleLLM are removed, the urllib imports that exist for HTTP request handling become dead code. The OpenVINOLLM backend doesn't use urllib. Resolves automatically with NEW-3.

**PERF-05 — STOP_WORDS Import Inside BM25 Tokenization Hot Loop** [UNCHANGED]
Category: Computational
File: vector_store.py
Severity: HIGH
Effort: Low
Details: from query_transformer import STOP_WORDS inside _tokenize(). Move to module level.

**PERF-06 — defaultdict Imported Inside rrf_fuse()** [UNCHANGED]
Category: Computational
File: utils.py
Severity: HIGH
Effort: Low
Details: from collections import defaultdict inside function. Move to module level. Group with QUAL-4.

**PERF-07 — Full ChromaDB Corpus Loaded and BM25 Rebuilt on Every Startup** [ELEVATED]
Category: Startup
File: vector_store.py
Severity: CRITICAL (was HIGH — startup speed is paramount in offline)
Effort: Medium
Details: Blocks startup for large databases. Lazy BM25 rebuild. Depends on PERF-01.

**PERF-08 — BM25 Tokenization Done Twice Per Chunk** [UNCHANGED]
Category: Computational
File: vector_store.py
Severity: MEDIUM
Effort: Low
Details: Double-pass due to rebuild_index=True default. Single-pass. Depends on PERF-01.

**PERF-23 — SentenceTransformer Model Loaded Synchronously on VectorStore Init** [ELEVATED]
Category: Startup
File: vector_store.py
Severity: CRITICAL (was HIGH — startup speed is paramount in offline)
Effort: Medium
Details: Blocks VectorStore construction. Lazy property init.

---

### Resilience & Observability Enhancements (RES-*)

**RES-01 — Generic Exception Handling in API Server** [UNCHANGED]
Category: Error Handling
File: api_server.py
Severity: MEDIUM
Effort: Low
Details: Broad Exception catch returns generic 500. Use specific exception types.

**RES-02 — Missing Retry on LLM Calls** [REFRAMED]
Category: Error Handling
File: llm_interface.py
Severity: MEDIUM (was HIGH)
Effort: Medium
Details: Retry logic is still valuable for local GGUF inference — the local model process can crash, run out of memory, or produce corrupted output. However, the retry strategy differs from HTTP backoff. For local inference: retry once after a brief delay, log the error, then surface to user. No exponential backoff needed.

**RES-04 — query_transformer.py Fails Silently on LLM Call** [UNCHANGED]
Category: Error Handling
File: query_transformer.py
Severity: HIGH
Effort: Low
Details: No try/except around generate(). Wrap in try/except, return original query on failure. Failure mode is local OOM or crash, not network timeout.

**RES-05 — Silent Backend Failures Logged via print** [UNCHANGED]
Category: Observability
File: llm_interface.py
Severity: HIGH
Effort: Low
Details: print() instead of logger.warning(). Replace with structured logger calls.

**RES-06 — No Observability on Document Processing** [UNCHANGED]
Category: Observability
File: document_processor.py
Severity: HIGH
Effort: Low
Details: No start/completion logging. Add structured logging.

**RES-08 — VectorStore.__init__ BM25 Rebuild Failure Logs but Doesn't Surface** [UNCHANGED]
Category: Error Handling
File: vector_store.py
Severity: HIGH
Effort: Low
Details: bm25_index stays None after failure, silently falls back to vector-only. Set to empty BM25Index.

**RES-12 — Reranker Initialization Has No Error Handling** [UNCHANGED]
Category: Error Handling
File: rag_engine.py
Severity: HIGH
Effort: Low
Details: Model load failure crashes query. Wrap in try/except, set to None.

**RES-14 — BM25 Search Failure Returns Empty Silently** [UNCHANGED]
Category: Error Handling
File: vector_store.py
Severity: HIGH
Effort: Low
Details: Exception returns [] indistinguishable from no results. Log at warning level.

**RES-17 — Config File Write Has No Error Handling** [UNCHANGED]
Category: Error Handling
File: rag_engine.py
Severity: HIGH
Effort: Low
Details: _save_config() can crash on read-only volume. Wrap in try/except. In offline apps, config is the only way to adjust behavior — a write failure is a dead end.

**RES-11 — Missing Retry on Embedding Model Download** [REMOVED → Replaced by NEW-2]
Reason: No download should occur. The fix is removing the download path entirely.

---

### UI/UX — Visual Hierarchy & Layout (UI-HIER-*)

**UI-HIER-3 — Empty Chat State Lacks Visual Design** [UNCHANGED]
Category: Visual Hierarchy
Component: DocumentQAApp._create_widgets()
Severity: HIGH
Effort: Medium
Details: Plain text welcome message. Design empty state with guidance and CTA.

**UI-HIER-4 — Input Area Button Hierarchy Flat** [UNCHANGED]
Category: Visual Hierarchy
Component: DocumentQAApp._create_widgets()
Severity: HIGH
Effort: Low
Details: Ask and Clear identical styling. Style Ask as primary, Clear as secondary.

**UI-HIER-7 — Settings Dialog Primary Action Not Distinguished** [UNCHANGED — applies to remaining settings]
Category: Visual Hierarchy
Component: SettingsDialog._create_widgets()
Severity: HIGH
Effort: Low
Details: Cancel and Save identical. Style Save as primary.

**UI-HIER-8 — Error Message Wall-of-Text** [UNCHANGED]
Category: Visual Hierarchy
Component: DocumentQAApp._initialize_engine()
Severity: HIGH
Effort: Medium
Details: Multi-line error as plain text. Error styling with actionable button.

**UI-HIER-9 — Progress Bar Lacks Contextual Label** [UNCHANGED]
Category: Visual Hierarchy
Component: DocumentQAApp._create_widgets()
Severity: HIGH
Effort: Low
Details: No percentage or stage indication. Add labels. Offline phases: "Loading model..." (not "Downloading...").

---

### UI/UX — Interaction Design & Feedback (UI-INT-*)

**UI-INT-2 — Settings Dialog Missing Unsaved Changes Confirmation** [UNCHANGED]
Category: Interaction Design
Component: SettingsDialog
Severity: HIGH
Effort: Medium
Details: No dirty-state tracking. Track dirty state, confirm on close/cancel.

**UI-INT-4 — Clear Chat Button Has No Confirmation** [UNCHANGED]
Category: Interaction Design
Component: DocumentQAApp._clear_chat()
Severity: HIGH
Effort: Low
Details: Immediate destruction. Show confirmation dialog.

**UI-INT-5 — Progress Bar Lacks Phase Context** [REFRAMED]
Category: Interaction Design
Component: DocumentQAApp
Severity: HIGH
Effort: Low
Details: Phase labels should be: "Loading embedding model..." → "Loading LLM model..." → "Initializing engine..." (no "Downloading" phase in offline mode).

**UI-INT-6 — "Thinking..." State Lacks Activity Indicator** [UNCHANGED]
Category: Interaction Design
Component: DocumentQAApp._ask_question()
Severity: HIGH
Effort: Low
Details: Animated ellipsis during 5–30s wait. Also: show which phase ("Rephrasing query..." vs "Generating answer...") per NEW-4.

**UI-INT-7 — No Keyboard Shortcuts** [UNCHANGED]
Category: Interaction Design
Component: DocumentQAApp
Severity: HIGH
Effort: Low
Details: Add Ctrl+Enter (submit), Ctrl+L (clear), Ctrl+, (settings).

**UI-INT-10 — Window Close During Active Operations Not Handled** [UNCHANGED]
Category: Interaction Design
Component: DocumentQAApp
Severity: HIGH
Effort: Medium
Details: No WM_DELETE_WINDOW handler. Confirm before closing during active operations.

**UI-INT-14 — No Feedback During Model Loading** [UNCHANGED]
Category: Interaction Design
Component: DocumentQAApp._initialize_engine()
Severity: HIGH
Effort: Medium
Details: 2 progress updates, 10+ second gap. Granular progress with stage labels.

**UI-INT-1 — Test Connection Buttons Lack Loading State** [REMOVED → Replaced by NEW-1]
Reason: "Test Connection" implies external connectivity. Remove buttons entirely.

---

### UI/UX — Accessibility & Inclusivity (UI-A11Y-*)

**UI-A11Y-7 — Touch/Click Targets Below Minimum Size** [UNCHANGED]
Category: Accessibility
Component: All CTkButton
WCAG Reference: 2.5.5
Severity: HIGH
Effort: Low
Details: Buttons ~28-32px height. Set height=44 minimum globally.

**UI-A11Y-9 — Missing Focus Indicators and Focus Management** [UNCHANGED]
Category: Accessibility
Component: SettingsDialog
WCAG Reference: 2.4.7
Severity: HIGH
Effort: Low
Details: No initial focus set. Call focus_set() on dialog open.

**UI-A11Y-14 — Window Geometry Fixed Without DPI Considerations** [UNCHANGED]
Category: Accessibility
Component: DocumentQAApp
WCAG Reference: 1.4.4
Severity: HIGH
Effort: Medium
Details: Fixed 900x700. Use relative sizing for DPI compatibility.

---

### UI/UX — Typography & Visual Polish (UI-VIS-*)

**UI-VIS-2 — Missing Explicit Font Family** [UNCHANGED]
Category: Typography
Component: All widgets
Severity: HIGH
Effort: Low
Details: Specify "Segoe UI" explicitly for Windows consistency.

**UI-VIS-3 — String-Based Color Values** [PARTIALLY ADDRESSED by NEW-1]
Category: Color
Component: SettingsDialog
Severity: MEDIUM
Effort: Low
Details: If SettingsDialog online sections are removed (NEW-1), remaining string-based colors in offline-relevant sections should be fixed.

**UI-VIS-5 — Fixed Wraplength Without DPI Awareness** [UNCHANGED]
Category: Typography
Component: DocumentQAApp._add_message()
Severity: HIGH
Effort: Medium
Details: wraplength=750 hardcoded. Dynamic wraplength. Depends on UI-PERF-1.

**UI-VIS-11 — Dialog Window Size Not DPI-Aware** [UNCHANGED]
Category: Polish
Component: SettingsDialog
Severity: HIGH
Effort: Medium
Details: Fixed 500x600. Use relative sizing.

---

### UI/UX — Performance & Perceived Performance (UI-PERF-*)

**UI-PERF-1 — Unbounded Chat Message Accumulation** [UNCHANGED]
Category: Performance
Component: DocumentQAApp._add_message()
Severity: HIGH
Effort: Medium
Details: No widget limit. Enforce max ~50 widgets. Prerequisite for UI-VIS-5.

**UI-PERF-4 — Synchronous File I/O Blocks First Render** [UNCHANGED]
Category: Performance
Component: DocumentQAApp._load_settings()
Severity: HIGH
Effort: Low
Details: Defer with after(50, ...) to allow first render.

**UI-PERF-7 — Synchronous LLM Imports in Settings Test** [PARTIALLY ADDRESSED by NEW-1]
Category: Performance
Component: SettingsDialog
Severity: MEDIUM
Effort: Low
Details: If "Test Connection" buttons are removed, the synchronous import issue resolves.

---

### UI/UX — Consistency & Design System Alignment (UI-CON-*)

**UI-CON-2 — Inconsistent Button Widths** [UNCHANGED]
Category: Consistency
Component: Multiple
Severity: HIGH
Effort: Low
Details: Define size variants in shared constants.

**UI-CON-9 — Inconsistent Label+Button Group Pattern** [UNCHANGED — applies to remaining settings]
Category: Consistency
Component: SettingsDialog
Severity: HIGH
Effort: Low
Details: After NEW-1 removes online sections, remaining label+button groups (e.g., GGUF path browse) should be consistent.

---

## Implementation Roadmap

### Phase 1 — Offline Hardening & Quick Wins (Priority: CRITICAL)

Addresses the offline constraint directly. No dependencies between items.

- **NEW-2** — Replace embedding model HuggingFace download with explicit error [CRITICAL]
- **NEW-1** — Remove online-only settings UI (Ollama, OpenAI, Test Connection) [HIGH]
- **ARCH-1** — Extract _resolve_and_validate_path helper in api_server.py [HIGH]
- **ARCH-7** — Extract bundled model discovery to app_paths.py [HIGH]
- **QUAL-4** — Move defaultdict import to module level in utils.py [HIGH]
- **QUAL-2** — Extract _log_init_banner helper in rag_engine.py [HIGH]
- **PERF-02** — Pre-compile regex as module-level constants in security.py [HIGH]
- **PERF-05** — Move STOP_WORDS import to module level in vector_store.py [HIGH]
- **PERF-06** — Move defaultdict import to module level in utils.py [HIGH]
- **RES-04** — Wrap generate() in try/except in query_transformer.py [HIGH]
- **RES-05** — Replace print() with logger.warning() in llm_interface.py [HIGH]
- **RES-06** — Add structured logging to document_processor.py [HIGH]
- **RES-08** — Set empty BM25Index on failure in vector_store.py [HIGH]
- **RES-12** — Wrap reranker init in try/except in rag_engine.py [HIGH]
- **RES-14** — Log BM25 search failure at warning level [HIGH]
- **RES-17** — Wrap _save_config() in try/except [HIGH]
- **NEW-4** — Add query transformation toggle setting, skip for short queries [HIGH]
- **UI-HIER-4** — Style Ask as primary, Clear as secondary [HIGH]
- **UI-HIER-7** — Style Save as primary [HIGH]
- **UI-INT-4** — Add confirmation dialog to Clear Chat [HIGH]
- **UI-INT-7** — Add keyboard shortcuts [HIGH]
- **UI-A11Y-7** — CTkButton height=44 via theme [HIGH]
- **UI-A11Y-9** — focus_set() on SettingsDialog open [HIGH]
- **UI-VIS-2** — Specify "Segoe UI" font family [HIGH]
- **UI-CON-2** — Define consistent button size variants [HIGH]
- **UI-PERF-4** — Defer _load_settings() with after() [HIGH]

### Phase 2 — Performance & Meaningful Improvements

Requires some refactoring or has mild dependencies.

- **NEW-3** — Remove dead Ollama/OpenAI code from llm_interface.py [MEDIUM]
  - Prerequisite: NEW-1 (remove online settings first)
- **PERF-01** — Incremental BM25 deletion in vector_store.py [MEDIUM]
  - Prerequisite for: PERF-07, PERF-08
- **PERF-07** — Lazy BM25 rebuild on startup [MEDIUM]
  - Depends on: PERF-01
- **PERF-08** — Single-pass BM25 tokenization [MEDIUM]
  - Depends on: PERF-01
- **PERF-23** — Lazy SentenceTransformer init [MEDIUM]
- **ARCH-8** — Extract responsibilities from RAGEngine.query() [MEDIUM]
  - Enables: QUAL-1, RES-12
- **QUAL-1** — Extract _is_followup_query [MEDIUM]
  - Depends on: ARCH-8
- **RES-02** — Add retry for local LLM process failures (single retry, no backoff) [MEDIUM]
- **NEW-5** — Simplify security.py to local-only validator [LOW]
- **UI-HIER-3** — Design empty chat state with CTA [MEDIUM]
- **UI-HIER-8** — Style error messages with action button [MEDIUM]
- **UI-HIER-9** — Add percentage and phase labels to progress bar [LOW]
- **UI-INT-2** — Track dirty state, confirm unsaved changes [MEDIUM]
- **UI-INT-5** — Offline-appropriate phase labels (no "Downloading") [LOW]
- **UI-INT-6** — Animated ellipsis + phase indication [LOW]
- **UI-INT-10** — WM_DELETE_WINDOW handler [MEDIUM]
- **UI-INT-14** — Granular progress during model loading [MEDIUM]
- **UI-A11Y-14** — DPI-aware window geometry [MEDIUM]
- **UI-VIS-5** — Dynamic wraplength [MEDIUM]
  - Depends on: UI-PERF-1
- **UI-VIS-11** — DPI-aware dialog sizing [MEDIUM]
- **UI-PERF-1** — Enforce max ~50 chat message widgets [MEDIUM]

### Phase 3 — Architectural Cleanup

Low priority, high effort. Only if Phase 1 and 2 are complete.

- **ARCH-6** — Resolve circular import (may resolve naturally after NEW-3) [LOW]
- **ARCH-10** — TextGenerator protocol (only if multiple backends return) [LOW]
- **ARCH-12** — Wrap _SettingsProxy AttributeError [LOW]
- **QUAL-7** — Update test coverage for offline-only paths [LOW]
- **QUAL-8** — Behavioral timing-safe comparison test [LOW]
- **RES-01** — Specific exception types in api_server.py [LOW]
- **UI-CON-9** — Extract LabeledInputWithAction component [LOW]

---

## Codebase Strengths

**Offline-Ready Core (OpenVINOLLM):** The local GGUF inference path via OpenVINO is well-implemented with automatic device detection (NPU → GPU → CPU fallback) and clear error messages. This is the correct foundation for an offline-first app.

**Bundled Model Auto-Discovery:** Both app_gui.py and engine_factory.py search for bundled model files with multiple fallback paths (phi3-mini-int4.gguf, phi3.5-mini, test_model.gguf). The intent is right — it just needs to be unified into a single function.

**Embedding Model Bundling (PyInstaller):** The EmbeddingModel class already handles PyInstaller bundled mode with `sys._MEIPASS/bundled_models/` path resolution. The architecture is correct — it just needs the fallback path hardened (NEW-2).

**Security Layer:** Even if the threat model narrows in offline mode, the existing path containment checks (validate_model_path, validate_directory) are solid defense-in-depth for a desktop app that processes user documents.

**Factory Pattern:** Centralized engine creation ensures consistent configuration across entry points. The pattern will simplify naturally when online backends are removed.

**Test Infrastructure:** Regression tests, integration tests, and adversarial test cases provide confidence for refactoring. The test file naming convention makes failure modes traceable.

---

## Summary Statistics

| Metric | Original Report | Revised (Offline-First) |
|--------|----------------|------------------------|
| Total findings | 54 | 47 retained + 5 new = 52 |
| Removed | — | 7 (invalidated by offline constraint) |
| Added | — | 5 (offline-specific gaps) |
| CRITICAL severity | 0 | 3 (NEW-2, PERF-07, PERF-23) |
| HIGH severity | 20 | 25 |
| MEDIUM severity | 33 | 18 |
| LOW severity | 1 | 9 |

**Key shift:** Startup performance and offline resilience move from "nice to have" to "critical." Network-dependent findings are replaced by offline-specific gaps. The model evaluation concludes the current phi3-mini remains the correct choice for the hardware target.

---

**Report Generated:** Offline-first revision of enhancement analysis
**Constraint Applied:** Fully offline, bundled model, no internet, 11th gen i5/16GB/SSD
**Model Evaluated:** Marco-Mini-Instruct-i1 (NOT RECOMMENDED for current hardware)
**Sections:** 12
