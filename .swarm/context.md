# Context
Swarm: modelrelay

## Project Context
- Language: TypeScript (new web_ui/ SPA) + Python (existing FastAPI backend)
- Framework: FastAPI (backend), React + Vite + TypeScript (frontend)
- Build command: TBD (Vite for frontend, existing Python for backend)
- Test command: pytest (backend), vitest (frontend)
- Lint command: TBD (eslint for frontend, ruff for backend)
- Entry points: main.py (backend), web_ui/src/main.tsx (frontend)

## Status
Active session — RFC Issue Ingest (Issue #14: HTML5 Web Version)

## Decisions
- OFFLINE-FIRST: Browser-local mode is the default. Full RAG pipeline MUST work offline on 12th-gen i5 / 16GB RAM after initial load. Server API mode is an optional enhancement.
- Dual-mode architecture: Browser-local (primary, WebLLM + Transformers.js) + API mode (optional, existing FastAPI)
- Browser mode is the highest-risk area: in-browser RAG parity (embeddings, vector search, reranking)
- SME recommends EdgeVec for in-browser HNSW; alternative: hnswlib-wasm
- Timeline realistic estimate: 50-70 days (RFC's 28-43 days is optimistic)
- GGUF → MLC conversion via official MLC path (HF → MLC, not direct GGUF)
- Model artifacts served from application origin (self-hosted), not external CDN or HF Hub
- PPTX included in v1 with text-only extraction (presentations are common Q&A documents)
- SmolLM3-3B Q4_K_M (~1.9GB) should be the shipping default model; Gemma 4 E2B as opt-in "high quality" download
- Memory pressure detection required — primary model + embeddings + vector index + browser heap must fit in 16GB

## SME Cache
### web-architecture, browser-ml, in-browser-inference
- Dual-mode (server + browser inference) is a proven pattern; main risk is RAG output parity between backends
- WebLLM (v0.2.83+) is production-viable with fallbacks; variable tokens/sec (30-80% of native)
- EdgeVec (Rust/WASM HNSW) preferred for in-browser vector search; hnswlib-wasm as fallback
- Client-side security manageable with SRI, strict CSP, worker isolation, user consent for heavy GPU use
- PDF.js/mammoth extraction quality lower than Python equivalents; chunking differences possible
- Cross-encoder reranker may be too heavy for browser; consider lighter alternative or server-only

## Patterns
- Existing FastAPI backend abstracts all ML behind REST endpoints; browser becomes thin client in API mode
- RAGEngine orchestrates: query transform; hybrid retrieval (ChromaDB + BM25 + RRF); reranking; context assembly; LLM generation
- Theme system (ColorTokens, TypeScale, Spacing) maps directly to CSS custom properties

## Codebase Map
- api_server.py (599 lines): 12 FastAPI endpoints with auth, CORS, file upload
- rag_engine.py (~600 lines): RAG orchestration
- llm_interface.py (539 lines): GGUF backend via llama-cpp-python, SmartLLM facade, streaming
- document_processor.py (425 lines): PDF/DOCX/PPTX/XLSX/TXT extraction, semantic chunking
- vector_store.py (1339 lines): ChromaDB + BM25Index + RRF fusion + window expansion
- reranking.py (117 lines): Cross-encoder MS MARCO MiniLM (singleton)
- config.py (167 lines): Pydantic BaseSettings with validation
- theme.py (136 lines): ColorTokens (dark/light), TypeScale, Spacing
- app_gui.py (~2500 lines): CustomTkinter GUI (to be replaced)

## Phase Metrics
- total_tool_calls: 0
- coder_revisions: 0
- reviewer_rejections: 0
- test_failures: 0
- security_findings: 0
- integration_issues: 0

## QA Gate Profile (applied)
- reviewer: true, test_engineer: true, sme_enabled: true, critic_pre_plan: true, sast_enabled: true
- council_mode: true, drift_check: true, final_council: true
- hallucination_guard: false, mutation_test: false, council_general_review: false

## Parallelization (locked)
- parallelization_enabled: true, max_concurrent_tasks: 3, council_parallel: false

## Agent Activity

| Tool | Calls | Success | Failed | Avg Duration |
|------|-------|---------|--------|--------------|
| read | 2168 | 2168 | 0 | 15ms |
| bash | 495 | 495 | 0 | 3716ms |
| edit | 480 | 480 | 0 | 9ms |
| glob | 466 | 466 | 0 | 48ms |
| task | 297 | 297 | 0 | 210722ms |
| search | 261 | 261 | 0 | 26796ms |
| grep | 260 | 260 | 0 | 172ms |
| write | 214 | 214 | 0 | 289ms |
| test_runner | 112 | 112 | 0 | 284ms |
| update_task_status | 91 | 91 | 0 | 36ms |
| declare_scope | 71 | 71 | 0 | 3ms |
| pre_check_batch | 46 | 46 | 0 | 59ms |
| syntax_check | 38 | 38 | 0 | 27ms |
| web_search | 23 | 23 | 0 | 2457ms |
| todowrite | 23 | 23 | 0 | 2ms |
| phase_complete | 18 | 18 | 0 | 78ms |
| placeholder_scan | 15 | 15 | 0 | 43ms |
| suggest_patch | 14 | 14 | 0 | 2ms |
| submit_phase_council_verdicts | 12 | 12 | 0 | 5ms |
| symbols | 12 | 12 | 0 | 1ms |
| webfetch | 11 | 11 | 0 | 226ms |
| diff | 10 | 10 | 0 | 6ms |
| write_retro | 9 | 9 | 0 | 11ms |
| write_drift_evidence | 8 | 8 | 0 | 11ms |
| get_approved_plan | 7 | 7 | 0 | 3ms |
| sast_scan | 6 | 6 | 0 | 20ms |
| skill | 6 | 6 | 0 | 51ms |
| lint | 6 | 6 | 0 | 2ms |
| swarm_command | 5 | 5 | 0 | 3ms |
| build_check | 5 | 5 | 0 | 314ms |
| save_plan | 4 | 4 | 0 | 68ms |
| imports | 4 | 4 | 0 | 3ms |
| batch_symbols | 4 | 4 | 0 | 3ms |
| spec_write | 3 | 3 | 0 | 4ms |
| retrieve_summary | 3 | 3 | 0 | 1ms |
| write_final_council_evidence | 3 | 3 | 0 | 16ms |
| lint_spec | 2 | 2 | 0 | 4ms |
| completion_verify | 2 | 2 | 0 | 2ms |
| skill_improve | 1 | 1 | 0 | 32050ms |
| skill_generate | 1 | 1 | 0 | 3ms |
| set_qa_gates | 1 | 1 | 0 | 2ms |
| todo_extract | 1 | 1 | 0 | 20ms |
| secretscan | 1 | 1 | 0 | 51ms |
| write_mutation_evidence | 1 | 1 | 0 | 2ms |
