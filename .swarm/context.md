# Context — Document Q&A App
Swarm: local
Updated: 2026-02-27

---

## Project Summary
Fully offline Windows 11 RAG desktop app. No internet at runtime OR install time.
All deps, models, and embedding weights ship in the installer.
GUI: CustomTkinter. API: FastAPI. Vector DB: ChromaDB. LLM: llama-cpp-python (GGUF).

---

## Decisions

- **Primary LLM backend**: GGUF via llama-cpp-python (CPU-only wheel). Ollama kept for dev/testing only — not in production fallback chain.
- **Fallback order**: GGUF → OpenVINO → OpenAI-compatible API → Ollama (only if explicitly configured)
- **Bundled model**: Qwen3-1.7B-Instruct-Q4_K_M (~1.1GB). Thinking mode suppressed via `/no_think` in system prompt — required for Qwen3, prevents token overhead.
- **Embedding model**: BAAI/bge-small-en-v1.5 (133MB, 384 dims). Drop-in replacement for all-MiniLM-L6-v2. Supports BGE asymmetric query prefix. No ChromaDB schema change needed (same dims).
- **Package structure**: NOT a Python package (no `__init__.py`). All imports must be absolute, not relative. Files run as top-level scripts from the project root.
- **Chunker**: Replacing word-split with paragraph/sentence-aware chunker. No `unstructured` dep (too heavy). Pure Python implementation.
- **Hybrid search**: BM25 (`rank-bm25` pure Python) + ChromaDB vector, fused with RRF. `hybrid_search=True` by default in RAGConfig.
- **Window expansion**: Fetch N±1 adjacent chunks after retrieval. `retrieval_window=1` default.
- **Reranking**: `cross-encoder/ms-marco-MiniLM-L-2-v2` (67MB). `reranking_enabled=False` default (adds ~200ms CPU latency per query — user opt-in).
- **Step-back query transform**: Off by default (adds one full LLM call = ~10-20s on old HW). Configurable via `RAGConfig.query_transformation_enabled`.
- **Installer**: Inno Setup. Bundles: Python embeddable + pre-downloaded .whl files + GGUF model + embedding weights. `pip install --no-index --find-links=./wheels`.
- **LFM 2.5**: Excluded from bundled default due to uncertain llama.cpp GGUF support. Can be user-supplied.

---

## File Map

| File | Role |
|------|------|
| `main.py` | CLI entry point. Args: `--api`, `--cli`, `--ingest`, `--query`, `--gguf-path` |
| `app_gui.py` | CustomTkinter GUI. Settings dialog. GGUF file picker. |
| `api_server.py` | FastAPI REST server. No Ollama defaults on startup. |
| `rag_engine.py` | Orchestration: ingest → embed → query → LLM. |
| `document_processor.py` | Text extraction + semantic chunking. |
| `vector_store.py` | ChromaDB + BM25 index. Hybrid search via RRF. |
| `llm_interface.py` | LLM backends: GGUFBackend, OpenVINOLLM, OllamaLLM, OpenAICompatibleLLM, SmartLLM. |
| `reranking.py` | CrossEncoderReranker (new in Phase 3). |
| `query_transformer.py` | Step-back query transformer (new in Phase 3). |
| `utils.py` | rrf_fuse() and shared utilities (new in Phase 3). |
| `tests/` | pytest suite (Phase 4). |
| `scripts/build_installer.py` | Inno Setup build helper (Phase 2). |

---

## Known Bugs (Phase 1 targets)

1. `rag_engine.py:17-18` — relative imports `.document_processor`, `.vector_store` — no `__init__.py` exists
2. `vector_store.py:25` — relative import `.document_processor` — same
3. `rag_engine.py:138-142` — `SmartLLM(embedded_model=...)` — kwarg does not exist; `model_path`/`ollama_*` not passed through
4. `rag_engine.py:287` — `from llm_interface import PromptBuilder` — class is `RAGPromptBuilder`
5. `rag_engine.py:14-15` — `sys.path.insert(0, parent.parent)` — wrong dir; `llm_interface.py` is in same dir
6. `api_server.py:92-93` — hardcoded `ollama_model="phi3:mini"` + `ollama_url` default causes network connection attempt at startup

---

## RAGAPPv2 Techniques — Port Decision Log

| Technique | Decision | Reason |
|-----------|----------|--------|
| Semantic chunking (unstructured) | Port concept, own impl | `unstructured[all-docs]` too heavy; own paragraph/sentence splitter |
| Hybrid BM25 + RRF | Port fully | `rank-bm25` pure Python, <1ms overhead, high accuracy gain |
| Window expansion | Port fully | DB lookup only, negligible cost, high value |
| Cross-encoder reranking | Port (off default) | Use tiny model 67MB; ~200ms CPU per query |
| Step-back query transform | Port (off default) | Adds full LLM call; too slow by default on old HW |
| CRAG retrieval evaluation | Skip | Two extra LLM calls; marginal value for added latency |
| Contextual chunking | Skip | LLM call per chunk at ingest; 500 chunks = 500 LLM calls |
| LanceDB | Skip | Full rewrite; ChromaDB + our BM25 = equivalent hybrid search |
| Tri-vector BGE-M3 | Skip | Requires separate embedding server; too heavy |
| Multi-scale indexing | Skip | 3x storage + embedding time; marginal gain |
| Memory store | Skip | Out of scope for this phase |

---

## Hardware Budget (i5-10400, 16GB RAM, no GPU)

| Operation | Expected Latency |
|-----------|-----------------|
| Query embedding (BGE-small) | ~30-50ms |
| BM25 search | <1ms |
| ChromaDB vector search | ~50-100ms |
| RRF fusion | <1ms |
| Window expansion fetch | ~10-30ms |
| Cross-encoder rerank (67MB model) | ~150-300ms (opt-in) |
| GGUF inference (Qwen3-1.7B Q4_K_M) | ~1-3s for typical RAG answer |
| Total query (no reranking) | ~1.5-3.5s |
| Total query (with reranking) | ~2-4s |

---

## SME Cache

### llama-cpp-python
- Install CPU-only wheel: `pip install llama-cpp-python --prefer-binary`
- Windows CPU-only pre-built wheels exist on PyPI — no compilation needed
- GGUF magic bytes: first 4 bytes must be `GGUF` (0x47475546)
- Qwen3 `/no_think` suppression: prepend `/no_think` to system prompt content
- Context window: set `n_ctx` in `Llama()` constructor; 4096 is sufficient for RAG; 8192 is safe default
- Thread count: default to `os.cpu_count()` for CPU inference
- Key params: `n_ctx=8192`, `n_threads=os.cpu_count()`, `verbose=False`

### BGE-small-en-v1.5
- Asymmetric prefix: queries use `"Represent this sentence for searching relevant passages: "` prefix; documents use no prefix
- `SENTENCE_TRANSFORMERS_HOME` env var controls local cache path for offline bundling
- Model files to bundle: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `vocab.txt`, `pytorch_model.bin` (or `model.safetensors`)

### Qwen3 Thinking Mode
- All Qwen3 dense models (0.6B, 1.7B, 4B, etc.) have thinking enabled by default
- Suppression: add `/no_think` as first token of system prompt
- Without suppression: model generates `<think>...</think>` blocks before answering — wastes tokens, adds latency
- For RAG use case (extraction, not reasoning): thinking mode provides zero benefit

---

## Phase Metrics
phase_number: 0 | total_tool_calls: 0 | coder_revisions: 0 | reviewer_rejections: 0
test_failures: 0 | security_findings: 0 | integration_issues: 0

## Agent Activity

| Tool | Calls | Success | Failed | Avg Duration |
|------|-------|---------|--------|--------------|
| read | 201 | 201 | 0 | 8ms |
| bash | 157 | 157 | 0 | 1033ms |
| grep | 99 | 99 | 0 | 77ms |
| edit | 47 | 47 | 0 | 978ms |
| task | 38 | 38 | 0 | 114490ms |
| glob | 22 | 22 | 0 | 23ms |
| write | 18 | 18 | 0 | 1258ms |
| retrieve_summary | 11 | 11 | 0 | 3ms |
| test_runner | 11 | 11 | 0 | 16425ms |
| imports | 8 | 8 | 0 | 1ms |
| lint | 6 | 6 | 0 | 3046ms |
| pre_check_batch | 6 | 6 | 0 | 1917ms |
| apply_patch | 5 | 5 | 0 | 125ms |
| webfetch | 4 | 4 | 0 | 292ms |
| diff | 3 | 3 | 0 | 34ms |
| todo_extract | 3 | 3 | 0 | 1ms |
| todowrite | 1 | 1 | 0 | 13ms |
| invalid | 1 | 1 | 0 | 1ms |
| checkpoint | 1 | 1 | 0 | 6ms |
