# Remediation Report
Date: 2026-03-24

## Fixes Applied

| ID | File | Description | Status |
|----|------|-------------|--------|
| A1 (main-001) | `main.py` | Fixed broken GUI import: `from ui.app import main as run_gui` → `from app_gui import main as run_gui`; updated comment | ✅ Applied |
| A2 (gui-001) | `app_gui.py` | Added `self.conversation_history = []`, wired `conversation_history=` into `engine.query()`, appended turns, capped at 20 entries | ✅ Applied |
| B1 (vs-001) | `vector_store.py` | Replaced `pickle.load`/`pickle.dump` in `BM25Index.save()`/`load()` with JSON serialization using `dataclasses.asdict()`; BM25Okapi rebuilt on load; `.pkl` → `.json` path translation for compatibility | ✅ Applied |
| B2 (api-001) | `api_server.py` | Changed `allow_origins=["*"]` to explicit localhost origins; changed `allow_credentials=True` to `False` | ✅ Applied |
| B3 (api-002) | `api_server.py` | Replaced 7 `raise HTTPException(...)` calls inside `lifespan` with `raise RuntimeError("Startup failed: ...")`; updated catch-all handler | ✅ Applied |
| C1 (vs-004) | `vector_store.py` | Fixed `delete_document`: `chunk[0].startswith(prefix)` → `chunk.source.startswith(prefix)`; `self.bm25_index.bm25 = None` → `self.bm25_index.bm25_index = None` | ✅ Applied |
| C2 (vs-005) | `vector_store.py` | Fixed `add_chunks_with_embeddings`: moved duplicate-ID check to a single batch `collection.get(ids=all_ids)` call before any `collection.add()` | ✅ Applied |
| C3 (seed-001) | `seed_loader.py` | Fixed `_import_doc`: replaced `c["chunk_id"]` direct access with `c.get("chunk_id") or f"{doc_id}_chunk_{i}"` fallback; removed `doc_id` from top-level dict, moved into metadata | ✅ Applied |
| C4 (paths-001) | `app_paths.py` | Fixed `get_user_data_dir()`: replaced `os.path.expandvars('%LOCALAPPDATA%')` fallback with `os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')` | ✅ Applied |
| C5 (paths-002) | `app_gui.py`, `app_paths.py` | Unified settings path: `app_gui._get_settings_path()` now delegates to `app_paths.get_settings_path()`; added `import app_paths` to `app_gui.py` | ✅ Applied |
| D1 (vs-002) | `vector_store.py` | Fixed `get_chunks_by_source()`: added `where={"source": source}` to `collection.get()`; removed redundant Python-level filter | ✅ Applied |
| D2 (vs-003) | `vector_store.py` | Fixed `add_chunks()`: replaced full BM25 rebuild (scanning entire collection) with incremental `bm25_index.add_document()` calls per new chunk | ✅ Applied |
| D3 (rag-002) | `rag_engine.py` | Replaced 3 `print(f"[DEBUG]...")` calls in `query()` with `logger.debug(...)`; added `import logging` and `logger = logging.getLogger(__name__)` | ✅ Applied |
| D4 (llm-001) | `llm_interface.py` | Added `timeout=120` to `OllamaLLM.generate()` and `OpenAICompatibleLLM.generate()` urlopen calls | ✅ Applied |
| E1 (test-001) | `test_gguf_path_wiring.py` | Deleted duplicate test file (confirmed identical to `test_gguf_path_wiring_final.py`) | ✅ Applied |
| E2 (test-003) | `test_coverage_verification.md` | Deleted stale manual coverage log | ✅ Applied |
| E3 (doc-001) | `main.py` | Updated `--model-path` argparse help string from `"Path to OpenVINO model"` to `"Path to GGUF model file (legacy alias for --gguf-path)"` | ✅ Applied |
| E4 (xp-001) | `app_paths.py` | Changed `-> Path \| None` to `-> Optional[Path]`; added `from typing import Optional` import | ✅ Applied |
| E6 (smell-002) | `rag_engine.py` | Added `warnings.warn("create_engine_from_env() is deprecated...", DeprecationWarning, stacklevel=2)` in `create_engine_from_env()` | ✅ Applied |

## QA Results

### Syntax check — all modified Python files
```
OK: main.py
OK: app_gui.py
OK: app_paths.py
OK: vector_store.py
OK: rag_engine.py
OK: llm_interface.py
OK: api_server.py
OK: seed_loader.py
OK: engine_factory.py
```

### Security regression checks
```
OK: No pickle references in .py files
OK: No .pkl references in .py files (except .pkl→.json compatibility translation in save/load)
OK: allow_origins — no wildcard ("*") present
OK: allow_credentials=False
OK: No HTTPException raises inside lifespan
```

### Path resolution sanity check
```
Data dir: C:\Users\zaxby\AppData\Local\AFOMIS Help and Support
Settings path: C:\Users\zaxby\AppData\Local\AFOMIS Help and Support\settings.json
```
No `%` characters. Paths resolve correctly.

### Test suite
```
51 collected — 50 passed, 1 failed, 2 warnings
```

The 2 warnings are expected `DeprecationWarning` from Fix E6, surfaced by tests that call `create_engine_from_env()`.

## Files Modified

| File | Change summary |
|------|----------------|
| `main.py` | Fixed GUI import (`ui.app` → `app_gui`); updated argparse help string for `--model-path` |
| `app_gui.py` | Added conversation history tracking; unified settings path via `app_paths` |
| `app_paths.py` | Fixed `%LOCALAPPDATA%` fallback; added `Optional` type annotation |
| `vector_store.py` | Replaced pickle with JSON; fixed `delete_document` AttributeError; batch duplicate-ID check; ChromaDB `where` filter in `get_chunks_by_source`; incremental BM25 updates in `add_chunks` |
| `api_server.py` | Fixed CORS wildcard/credentials; replaced `HTTPException` in lifespan with `RuntimeError` |
| `seed_loader.py` | Fixed `_import_doc` schema mismatch: safe `chunk_id` fallback, `doc_id` moved to metadata |
| `rag_engine.py` | Converted DEBUG prints to `logger.debug`; added `DeprecationWarning` to `create_engine_from_env()` |
| `llm_interface.py` | Added `timeout=120` to two `urlopen` calls |

## Files Deleted

| File | Reason |
|------|--------|
| `test_gguf_path_wiring.py` | Exact duplicate of `test_gguf_path_wiring_final.py` |
| `test_coverage_verification.md` | Stale hand-written coverage log, not automated output |

## Known Limitations / Follow-Up Required

### Pre-existing test failure (not introduced by this sprint)
`test_phase1_adversarial.py::test_validate_url_rejects_non_standard_port_9999` fails with an assertion error. The test expects `match="URL must use standard ports"` but the `validate_url()` error message has always been `"URL port {port} is not in allowed ports: ... Use standard ports or explicitly configure the port."`. This regex mismatch predates this sprint — no changes were made to `validate_url()` or its error messages. Fix: update the test's `match=` string to `"Use standard ports"` or correct the error message in `api_server.py`.

### `.pkl` compatibility shim in BM25Index.save()/load()
`vector_store.py` `BM25Index.save()` and `load()` translate `.pkl` paths to `.json` for backward compatibility with call sites that pass `"bm25_index.pkl"`. This handles `tests/test_vector_store.py:145` which passes a `.pkl` path. No data is read from or written to actual `.pkl` files — only `.json`. This shim can be removed once all call sites are updated to pass `.json` paths.

### BM25 incremental add still rebuilds BM25Okapi internally
`BM25Index.add_document()` appends a chunk and then calls `BM25Okapi(tokenized_corpus)` on the full corpus. This is O(N) per add call. For production use with large corpora, consider implementing a true incremental BM25 or batching rebuilds.
