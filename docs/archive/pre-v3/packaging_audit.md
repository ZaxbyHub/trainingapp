# Packaging Audit Report

**Date:** 2026-03-11
**Auditor:** Architect
**Scope:** AFOMIS.spec, build scripts, repository layout

## Findings Summary

| # | Component | Status | Notes |
|---|-----------|--------|-------|
| 1 | Entry point (ui/app.py) | ✅ CORRECT | Matches main.py import |
| 2 | bundled_models/ | ✅ EXISTS | Contains embedding model |
| 3 | seed_data/ | ✅ EXISTS | Contains seed chunks |
| 4 | ui/ package | ✅ EXISTS | Contains GUI code |
| 5 | models/ | ✅ EXISTS | Contains GGUF model |
| 6 | Hidden imports | ⚠️ INCOMPLETE | Missing engine_factory |

## Detailed Findings

### 1. Entry Point: CORRECT ✅
- **AFOMIS.spec line 15:** `['ui/app.py']`
- **main.py line 121:** `from ui.app import main as run_gui`
- **Status:** Entry point correctly references the module imported by main.py

### 2. Data Directories: ALL EXIST ✅
All data directories referenced in AFOMIS.spec exist:
- bundled_models/bge-small-en-v1.5/ - Embedding model
- seed_data/ - Seed chunks and manifest
- ui/ - UI package
- models/ - GGUF model file

### 3. Hidden Imports: NEEDS UPDATE ⚠️
**Missing:** `engine_factory` module
- Created in Phase 15 (Task 15.4)
- Used by rag_engine.py for unified engine construction
- Must be included as hidden import for PyInstaller to bundle

## Required Fix

**AFOMIS.spec line 24-29:** Add `engine_factory` to hiddenimports list.

**Current:**
```python
hiddenimports=[
    'chromadb',
    'sentence_transformers',
    'rank_bm25',
    'llama_cpp',
],
```

**Updated:**
```python
hiddenimports=[
    'chromadb',
    'sentence_transformers',
    'rank_bm25',
    'llama_cpp',
    'engine_factory',
],
```

## Action Items

- [ ] Task 19.1: Update AFOMIS.spec with engine_factory hidden import
- [ ] Task 19.2: Verify build_exe.bat prerequisites
- [ ] Task 19.3: Perform clean build
- [ ] Task 19.4: Execute smoke test
