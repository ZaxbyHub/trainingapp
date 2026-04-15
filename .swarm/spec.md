# Feature Specification: Offline-First Hardening & Model Upgrade

## Problem Statement

The Document Q&A Assistant is a desktop application (customtkinter, Windows 11, Python) designed to be **fully offline** — no internet access is ever required. The bundled LLM model answers questions against a local document corpus using RAG (Retrieval-Augmented Generation).

An enhancement review identified 52 findings across architecture, code quality, performance, resilience, and UI/UX. Additionally, the current bundled model (phi3-mini-int4) should be upgraded to Gemma 4 E2B (Q5_K_M GGUF) for better quality-to-speed ratio, and the OpenVINO backend should be removed in favor of the existing llama-cpp-python GGUF backend.

## Constraints

- **Fully offline**: No internet access ever. No HuggingFace downloads, no API calls, no telemetry.
- **Hardware target**: 11th gen Intel i5 (no dedicated GPU), 16GB RAM, SSD.
- **Desktop-only**: customtkinter on Windows 11. No web mode, no macOS, no Linux.
- **Read-only analysis artifacts**: The enhancement report (`.swarm/enhancement-report.md`) documents all findings. This spec references findings by ID but does not repeat their details.

---

## User Scenarios

### US-1: First Launch After Model Upgrade
**Given** the application is installed with Gemma 4 E2B bundled
**When** the user launches the application
**Then** the GGUF model is detected automatically from the `models/` directory, the embedding model loads from the bundled path, and the app is ready within 10 seconds without any network attempt

### US-2: Developer Mode Without Bundled Model
**Given** the embedding model is not found at the bundled path
**When** the developer launches the app outside PyInstaller
**Then** the app shows a clear error message ("Embedding model not found at: {path}. Place the model directory and restart.") instead of silently attempting a HuggingFace download

### US-3: User Opens Settings
**Given** the user clicks Settings
**When** the Settings dialog opens
**Then** only offline-relevant settings are shown: GGUF model path (with bundled auto-detection), chunk size, results count, max tokens, temperature, hybrid search toggle, reranking toggle. No Ollama URL, no API key, no Test Connection buttons.

### US-4: User Asks a Question
**Given** the RAG pipeline is ready with Gemma 4 E2B
**When** the user types a question and presses Ctrl+Enter
**Then** the model generates a response using the chat template natively, without thinking mode overhead, at approximately 40–60 tokens/second

### US-5: Large Document Corpus Startup
**Given** the user has previously ingested 500+ documents
**When** the application starts
**Then** BM25 index rebuild is deferred until first search, and the embedding model is lazy-loaded, keeping startup under 10 seconds regardless of corpus size

---

## Functional Requirements

### Model & Backend (FR-100 series)

**FR-101** The application MUST use Gemma 4 E2B (Q5_K_M GGUF, `gemma-4-E2B-it-Q5_K_M.gguf`) as the default bundled LLM model.

**FR-102** The bundled model MUST be placed in `models/gemma-4-E2B-it-Q5_K_M.gguf` in the project directory and included in the PyInstaller bundle.

**FR-103** A `DEFAULT_BUNDLED_GGUF` constant MUST be defined in `app_paths.py` with the value `"gemma-4-E2B-it-Q5_K_M.gguf"`. The bundled model auto-detection in `app_gui.py` (lines 402-406) and `engine_factory.py` (lines 223-227) MUST be unified into a single function in `app_paths.py` named `get_bundled_model_path()`. This function MUST reference `DEFAULT_BUNDLED_GGUF` and search for it first, then fall back to legacy paths (`phi3-mini-int4.gguf`, `phi3.5-mini-instruct-int4-cw-ov`, `test_model.gguf`) for backward compatibility.

**FR-104** The `OpenVINOLLM` class in `llm_interface.py` (lines 83-144) MUST be removed entirely. All LLM inference MUST go through `GGUFBackend` using llama-cpp-python.

**FR-105** The `OllamaLLM` class in `llm_interface.py` (lines 305-403) MUST be removed entirely.

**FR-106** The `OpenAICompatibleLLM` class in `llm_interface.py` (lines 406-517) MUST be removed entirely.

**FR-107** The `SmartLLM` class in `llm_interface.py` (lines 551-733) MUST be simplified to only support `GGUFBackend`. The multi-backend fallback chain, Ollama/API parameters, and backend iteration loop MUST be removed.

**FR-108** The `GGUFBackend` class MUST detect Gemma 4 models by checking for `"gemma-4"` or `"gemma_4"` in the model filename. When a Gemma 4 model is detected, the `<|think|>` token MUST be added to the `stop` parameter in `chat_complete()` and `generate()` to suppress thinking mode for RAG use.

**FR-109** The `RAGEngine.__init__()` constructor parameters `ollama_model`, `ollama_url`, `api_url`, `api_model`, and `device` (lines 148-158 in rag_engine.py) MUST be removed. The `device` parameter (used only for OpenVINO NPU/GPU selection) has no purpose in a GGUF-only CPU backend.

**FR-110** The `engine_factory.py` functions `create_engine()`, `create_engine_from_settings()`, and `create_engine_from_env()` MUST have all Ollama/API parameters removed (`ollama_model`, `ollama_url`, `api_url`, `api_model`). The `model_path` backward-compatibility parameter and `RAG_MODEL_PATH` environment variable handling MUST also be removed (replaced by `DEFAULT_BUNDLED_GGUF` from `app_paths.py`). Old bundled model filename references (`phi3-mini-int4.gguf`, etc.) in inline lists MUST be replaced with references to `get_bundled_model_path()`.

**FR-111** The `main.py` CLI argument parser MUST have the following arguments removed: `--model-path`, `--ollama-url`, `--ollama-model`, `--api-url`. The `RAG_MODEL_PATH` environment variable MUST no longer be read or passed to any engine constructor.

**FR-112** The `api_server.py` lifespan function MUST have the following environment variable validations removed: `RAG_MODEL_PATH`, `RAG_OLLAMA_MODEL`, `RAG_OLLAMA_URL`, `RAG_API_URL`, `RAG_API_MODEL`, `RAG_DEVICE`. The `model_path` and `device` parameters in the `RAGEngine()` construction call (line 463) MUST be removed. The `model_path` backward-compatibility parameter and `RAG_MODEL_PATH` environment variable handling MUST also be removed (replaced by `DEFAULT_BUNDLED_GGUF` from `app_paths.py`). Old bundled model filename references (`phi3-mini-int4.gguf`, etc.) in inline lists MUST be replaced with references to `get_bundled_model_path()`.

### Dependencies (FR-200 series)

**FR-201** `openvino` and `openvino-genai` MUST be removed from `requirements.txt` (lines 13-14).

**FR-202** No Ollama-specific or OpenAI-specific dependencies need removal (both use stdlib `urllib` only).

**FR-203** The `llama-cpp-python` version constraint MUST be updated to `>=0.2.30` to ensure Gemma 4 chat template support.

### Embedding Model Hardening (FR-300 series)

**FR-301** The `EmbeddingModel.__init__()` in `vector_store.py` MUST be modified so that in BOTH PyInstaller mode and development mode, the `SentenceTransformer` constructor is ALWAYS called with `local_files_only=True`.

**FR-302** When the embedding model is not found at the expected path (neither bundled nor local), the error MUST be a clear `FileNotFoundError` with the message: "Embedding model not found. Expected at: {expected_path}. For bundled mode, ensure the model is included in the PyInstaller data files."

**FR-303** A secondary search path for development mode MUST be added: `./models/bge-small-en-v1.5/` (checked before the HuggingFace cache path).

### Settings UI Cleanup (FR-400 series)

**FR-401** The `SettingsDialog` in `app_gui.py` MUST have all Ollama-related widgets removed: `ollama_url_entry`, `ollama_model_entry`, and the `_test_ollama()` button/method. Additionally, the backend priority label text at line 103 ("GGUF → Ollama → OpenAI-Compatible" or similar) MUST be removed entirely, as only the GGUF backend remains.

**FR-402** The `SettingsDialog` MUST have all API-related widgets removed: `api_url_entry`, and the `_test_api()` button/method.

**FR-403** The `_populate_fields()` method (line 278) MUST stop reading/writing `ollama_url`, `ollama_model`, and `api_url` from the settings dict.

**FR-404** The `_save()` method (line 302) MUST stop writing `ollama_url`, `ollama_model`, and `api_url` to the settings dict.

**FR-405** The `_initialize_engine()` method in `app_gui.py` (lines 592-649) MUST use `engine_factory.create_engine_from_settings()` instead of directly constructing `RAGEngine` with Ollama/API parameters. This is the same bypass identified in the enhancement report — it must route through the factory like every other entry point.

### Startup Performance (FR-500 series)

**FR-501** The `VectorStore.__init__()` MUST defer BM25 index rebuild until the first search operation (lazy initialization). The `_rebuild_bm25_index()` method MUST be called on first `bm25_search()` invocation rather than in `__init__()`.

**FR-502** The `EmbeddingModel` instance in `VectorStore` MUST be lazily initialized. The `SentenceTransformer` model MUST NOT be loaded during `VectorStore.__init__()`. It MUST be loaded on first call to `encode()` or `encode_single()`.

**FR-503** The `_load_settings()` method in `app_gui.py` MUST be deferred with `self.after(50, self._load_settings_and_init)` to allow the first render to complete before blocking file I/O.

### Resilience (FR-600 series)

**FR-601** The `query_transformer.py` MUST wrap its LLM call in a try/except. On failure, it MUST log a warning and return the original query unchanged.

**FR-602** All `print()` calls in `llm_interface.py` MUST be replaced with `logger.warning()` or `logger.info()` using the module-level logger.

**FR-603** `document_processor.py` MUST add structured logging at the start and completion of document processing (file name, chunk count, duration).

**FR-604** When BM25 rebuild fails in `VectorStore.__init__()` (now deferred to first search), the `bm25_index` MUST be set to an empty `BM25Index` instance rather than `None`, with a warning logged.

**FR-605** The reranker initialization in `rag_engine.py` MUST be wrapped in try/except. On failure, the reranker MUST be set to `None` and a warning logged.

**FR-606** BM25 search failure in `vector_store.py` MUST log at warning level rather than returning empty silently.

**FR-607** The `_save_config()` method in `rag_engine.py` MUST be wrapped in try/except with a user-facing error message.

### UI/UX Quick Wins (FR-700 series)

**FR-701** Keyboard shortcuts MUST be added: Ctrl+Enter (submit question), Ctrl+L (clear chat), Ctrl+, (open settings).

**FR-702** The Clear Chat button MUST show a confirmation dialog before clearing.

**FR-703** The Ask button MUST be styled as primary (prominent color/size). The Clear button MUST be styled as secondary.

**FR-704** The Save button in SettingsDialog MUST be styled as primary (accent color).

**FR-705** The progress bar MUST display percentage and phase labels (e.g., "Loading embedding model... 45%").

**FR-706** The "Thinking..." state MUST show animated ellipsis ("Thinking..." → "Thinking.." → "Thinking.").

**FR-707** The application MUST handle WM_DELETE_WINDOW by confirming before closing during active operations.

**FR-708** All CTkButton widgets MUST have a minimum height of 44px for WCAG 2.5.5 compliance, applied globally via theme or custom widget class.

**FR-709** The SettingsDialog MUST call `focus_set()` on the first focusable widget when opened.

**FR-710** The application MUST specify "Segoe UI" as the font family explicitly for Windows consistency.

### Architecture & Code Quality (FR-800 series)

**FR-801** The `validate_model_path()` and `validate_directory()` functions in `api_server.py` MUST share their duplicated path-resolution logic via an extracted `_resolve_and_validate_path()` helper.

**FR-802** The `_log_init_banner()` helper MUST be extracted from `RAGEngine.__init__()` to eliminate the duplicated logger.info banner blocks.

**FR-803** The `from collections import defaultdict` import in `utils.py` MUST be moved to module level (currently inside `rrf_fuse()`).

**FR-804** The `from query_transformer import STOP_WORDS` import in `vector_store.py` MUST be moved to module level (currently inside `_tokenize()`).

**FR-805** The `RAGConfig` class MUST gain a `query_transformation_enabled` field (currently exists at line 78 as `query_transformation_enabled: bool = False` — verified). The `query_transformer.py` call in `rag_engine.py` MUST be gated on this flag.

**FR-806** The `_SettingsProxy` in `config.py` MUST wrap `AttributeError` with a more informative message indicating whether the attribute is a settings field or a code bug.

### Security Simplification (FR-900 series)

**FR-901** The `security.py` URL validation MUST be simplified: retain path containment checks (`validate_model_path`, `validate_directory`) and replace the domain blocklist with a single rule rejecting any non-local URL scheme.

### Build System (FR-1000 series)

**FR-1001** The `build.py` script MUST be updated to accept the Gemma 4 E2B GGUF file as the default model for bundling (`--model-path models/gemma-4-E2B-it-Q5_K_M.gguf`).

**FR-1002** The PyInstaller spec generation in `build.py` MUST include the embedding model directory in the bundled data files.

**FR-1003** The `run_api.bat` script MUST be updated to remove Ollama-specific environment variables.

**FR-1004** The `scripts/build.py` script MUST be updated to validate the Gemma 4 E2B GGUF model path and remove any OpenVINO-specific build steps. The `scripts/build_installer.py` script MUST have all references to "Qwen3-1.7B" or other non-Gemma model names updated to "Gemma 4 E2B" (particularly the README generation at lines 134-156).

**FR-1005** The `AFOMIS.spec` PyInstaller spec file MUST include `models/` directory in the `datas` list. Currently it only includes `bundled_models` and `seed_data` — the `models/` directory containing `gemma-4-E2B-it-Q5_K_M.gguf` MUST be explicitly listed.

### Documentation Updates (FR-1200 series)

**FR-1201** The `ARCHITECTURE.md` file MUST have all OpenVINO backend references removed. The architecture description MUST reflect a GGUF-only backend using llama-cpp-python.

**FR-1202** The `CONFIGURATION.md` file MUST have all OpenVINO configuration references removed (lines 49, 298, 322, 326, 479, 496 and any others). Configuration examples MUST use only GGUF settings.

**FR-1203** The `INSTALL.md` file MUST have OpenVINO installation instructions removed (lines 31-32 and any related sections). Installation steps MUST reference only llama-cpp-python and GGUF.

**FR-1204** The `README.md` file MUST have OpenVINO backend documentation removed. Any model references to phi3-mini or Qwen MUST be updated to Gemma 4 E2B.

**FR-1205** The `CHANGELOG.md` file SHOULD have an entry added documenting the model upgrade from phi3-mini-int4 to Gemma 4 E2B and the removal of OpenVINO/Ollama/OpenAI backends.

### Test Updates (FR-1100 series)

**FR-1101** All test files that mock or import `OllamaLLM`, `OpenAICompatibleLLM`, or `OpenVINOLLM` MUST be updated to use `GGUFBackend` instead.

**FR-1102** Test files that patch these classes (e.g., `test_phase1_fixes.py`, `test_workflows.py`, `integration/conftest.py`) MUST be updated to remove the patches and use GGUFBackend mocks.

**FR-1103** The `test_llm_interface.py` file MUST gain dedicated tests for GGUFBackend, including: Gemma 4 detection, thinking mode suppression, and error handling.

---

## Success Criteria

**SC-101** The application starts and is ready for use within 10 seconds on target hardware (i5, 16GB, SSD) with a corpus of 500+ documents.

**SC-102** Zero network requests are made at any point during application lifecycle (verified via network monitoring tools).

**SC-103** The Settings dialog contains no references to Ollama, OpenAI, API URLs, or "Test Connection" functionality.

**SC-104** The Gemma 4 E2B Q5_K_M GGUF model is automatically detected and used without manual configuration.

**SC-105** The embedding model loads from the bundled path without attempting any download, even when the bundled model is missing (error shown instead).

**SC-106** The application produces coherent, accurate answers to document questions using the Gemma 4 E2B model via llama-cpp-python.

**SC-107** The total PyInstaller bundle size does not exceed the current size by more than 2 GB (accounting for the larger model file minus OpenVINO removal savings).

**SC-108** All existing tests pass after the changes (test suite runs green).

**SC-109** No `import openvino`, `OpenVINOLLM`, `OllamaLLM`, or `OpenAICompatibleLLM` references remain in any Python file.

**SC-110** The `requirements.txt` does not contain `openvino` or `openvino-genai`.

---

## Key Entities

- **GGUF Model File**: `gemma-4-E2B-it-Q5_K_M.gguf` — the primary LLM, bundled in `models/`
- **Embedding Model**: `BAAI/bge-small-en-v1.5` — document chunk embeddings, bundled via PyInstaller
- **VectorStore**: ChromaDB + BM25 hybrid search engine
- **RAG Pipeline**: Document ingestion → chunking → embedding → vector/BM25 indexing → retrieval → reranking → LLM generation
- **Settings**: JSON file storing user preferences (no online backend config)
