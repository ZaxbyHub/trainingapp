# Documentation Audit Report

**Date:** 2026-03-11
**Auditor:** Architect
**Scope:** README.md, API documentation, usage guides

## Findings Summary

| # | Issue | Severity | Location | Recommendation |
|---|-------|----------|----------|----------------|
| 1 | Upload capability mismatch | Medium | README lines 145, 410 | Add GUI single-file OR document gap |
| 2 | Backend precedence unclear | Low | README lines 307-311 | Document fallback order |
| 3 | API examples incomplete | Low | README lines 161-165 | Add file upload example |
| 4 | Env var fallback unclear | Low | README line 132 | Document backend fallback |

## Detailed Findings

### 1. Upload Capability Mismatch (DEFECT-005)
**Current State:**
- GUI Mode: "Select document folder" (folder-based ingestion only)
- API Mode: `/ingest/file` endpoint supports single-file upload

**Impact:**
Users expecting GUI to match API capabilities will be confused.

**Recommendation:**
Option A: Add single-file upload button to GUI
Option B: Document that GUI is folder-only, use API for single files

### 2. Backend Precedence Unclear
**Current State:**
README lists backends without specifying which takes precedence.

**Actual Precedence (from code):**
1. GGUF (if gguf_path provided)
2. OpenVINO (if model_path provided)
3. OpenAI-compatible API (if api_url provided)
4. Ollama (if ollama_url provided)

**Recommendation:**
Document the fallback order clearly in README.

### 3. API Examples Incomplete
**Current State:**
API Reference table includes `/ingest/file` but usage examples only show directory ingestion.

**Recommendation:**
Add example for single file upload via API.

### 4. Environment Variable Fallback Unclear
**Current State:**
RAG_GGUF_PATH documented but behavior when not set is not explained.

**Recommendation:**
Document what backend is used when GGUF path is not configured.

## Action Items

- [ ] Task 18.2: Document or align GUI/API upload capabilities
- [ ] Task 18.3: Update settings labels for consistency
- [ ] Task 18.4: Document backend precedence
