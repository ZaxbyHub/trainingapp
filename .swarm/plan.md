<!-- PLAN_HASH: 3hcv9m1u5ke0g -->
# Document Q&A App — Offline RAG Upgrade
Swarm: local
Phase: COMPLETE | Updated: 2026-02-27T22:00:00.000Z

---
## Phase 1: Phase 1 [COMPLETE]
- [x] 1.1: Fix import structure — convert relative imports to absolute in `rag_engine.py` and `vector_store.py` [SMALL]
- [x] 1.2: Fix `SmartLLM` call in `rag_engine._init_llm` — wrong kwarg `embedded_model`, missing `model_path`/`ollama_model`/`ollama_url` passthrough [SMALL]
- [x] 1.3: Fix `PromptBuilder` import — rename reference to `RAGPromptBuilder` in `rag_engine.py` [SMALL]
- [x] 1.4: Remove broken `sys.path.insert` grandparent hack in `rag_engine.py` [SMALL]
- [x] 1.5: Fix `api_server.py` — remove hardcoded Ollama defaults that force a network connection on startup [SMALL]

---
## Phase 2: Phase 2 [COMPLETE]
- [x] 2.1: Add `GGUFBackend` class to `llm_interface.py` using llama [SMALL]
- [x] 2.2: Update `SmartLLM.__init__` — add `gguf_path` parameter; set fallback order to GGUF → OpenVINO → OpenAI [SMALL]
- [x] 2.3: Update `rag_engine.py` — wire `gguf_path` through `RAGEngine.__init__` and `_init_llm`; update `create_engine_from_env` for `RAG_GGUF_PATH` env var [SMALL] (depends: 2.2)
- [x] 2.4: Update `main.py` — add `--gguf-path` CLI argument [SMALL]
- [x] 2.5: Update `app_gui.py` Settings dialog — replace OpenVINO model path with GGUF file picker (`.gguf` filter); add active model name + file size to status bar; add hot [SMALL]
- [x] 2.6: Swap embedding model from `all-MiniLM-L6-v2` to `BAAI/bge-small-en-v1.5` [SMALL]
- [x] 2.7: Update `requirements.txt` — add `llama-cpp-python` [SMALL]
- [x] 2.8: Create `scripts/build_installer.py` — Inno Setup preparation script [SMALL]

---
## Phase 3: Phase 3 [COMPLETE]
- [x] 3.1: Replace word splitter with semantic chunker (paragraph/sentence boundaries) [SMALL]
- [x] 3.2: Add `BM25Index` class to `vector_store.py` using `rank-bm25` [SMALL]
- [x] 3.3: Add `rrf_fuse()` utility function to new `utils.py` module — pure [SMALL]
- [x] 3.4: Implement hybrid search in `vector_store.get_context()` — call both vector search and BM25 search, fuse via RRF; make hybrid toggle configurable via `RAGConfig.hybrid_search` [SMALL] (depends: 3.2, 3.3)
- [x] 3.5: Implement window expansion in `rag_engine.query()` — after retrieval fetch N±1 adjacent chunks by chunk_index; configurable via `RAGConfig.retrieval_window` (default 1) [SMALL] (depends: 1.2)
- [x] 3.6: Add `CrossEncoderReranker` class to new `reranking.py` — lazy load [SMALL]
- [x] 3.7: Add `QueryTransformer` class to new `query_transformer.py` — step-back transform [SMALL]
- [x] 3.8: Update `RAGConfig` — add all new fields: `hybrid_search` (bool, True), `retrieval_window` (int, 1), `reranking_enabled` (bool, False), `reranker_model` (str), `query_transformation_enabled` (bool, False), `initial_retrieval_top_k` (int, 20) [SMALL] (depends: 3.5, 3.6, 3.7)
- [x] 3.9: Update `app_gui.py` Settings dialog — add toggle controls for hybrid search, window expansion size, reranking enable/disable [SMALL]

---
## Phase 4: Phase 4 [COMPLETE]
- [x] 4.1: Create `tests/conftest.py` — shared pytest fixtures: temp ChromaDB dir, mock LLM returning canned responses, sample DocumentChunk list, sample PDF bytes [SMALL] (depends: Phase 1 complete)
- [x] 4.2: Create `tests/test_document_processor.py` — test PDF extraction, DOCX extraction, TXT extraction, chunking boundary behaviour, empty file handling, unsupported extension [SMALL] (depends: 4.1)
- [x] 4.3: Create `tests/test_vector_store.py` — test add_chunks dedup, BM25 index build/search, hybrid search output, RRF fusion scoring, window expansion, get_context with similarity threshold, clear() [SMALL] (depends: 3.4, 4.1)
- [x] 4.4: Create `tests/test_llm_interface.py` — test GGUFBackend instantiation with bad path (expect FileNotFoundError), SmartLLM fallback chain logic (mocked backends), GGUF magic [SMALL]
- [x] 4.5: Create `tests/test_rag_engine.py` — test ingest_directory stats, query() with mocked vector store + LLM, greeting bypass path, no [SMALL]
- [x] 4.6: Create `tests/test_api.py` — test all FastAPI endpoints via httpx TestClient: GET /, GET /stats, POST /ask, POST /search, POST /ingest, POST /ingest/file, GET /documents, DELETE /documents [SMALL] (depends: 4.1, 4.5)

---
## Phase 5: Documentation [COMPLETE]
- [x] 5.1: Update README.md — comprehensive overview of all new features [MEDIUM]
- [x] 5.2: Create INSTALL.md — installation guide with offline bundle instructions [MEDIUM]
- [x] 5.3: Create CONFIGURATION.md — detailed configuration reference [MEDIUM]
- [x] 5.4: Create ARCHITECTURE.md — technical architecture overview [MEDIUM]
- [x] 5.5: Create USAGE.md — user guide for GUI, CLI, and API [MEDIUM]

---
## Summary

**Total Tasks**: 28
**Completed**: 28
**Test Coverage**: 127 tests collected
**Documentation**: 5 comprehensive files (~2000 lines total)

### Key Deliverables:
1. GGUF backend with llama-cpp-python (primary LLM)
2. Hybrid search (BM25 + Vector with RRF fusion)
3. Window expansion for better context
4. Semantic chunking (paragraph/sentence boundaries)
5. Cross-encoder reranking (optional)
6. Query transformer (step-back queries)
7. Comprehensive test suite (127 tests)
8. Complete documentation (README, INSTALL, CONFIGURATION, ARCHITECTURE, USAGE)
9. Windows installer preparation script
10. Offline-first design with bundled models

### Files Created/Modified: 25+
- Core modules: 10 files enhanced
- Test suite: 6 files, 127 tests
- Documentation: 5 comprehensive guides
- Build scripts: 1 Inno Setup preparation script

### Project Status: ✅ COMPLETE
All QA gates passed. All documentation created. Ready for deployment.
