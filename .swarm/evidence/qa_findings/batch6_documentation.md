# Explorer Batch 6: Documentation — Candidate Findings
**Generated**: 2026-04-09T00:00:00Z
**Scope**: 4 documentation files (README.md, ARCHITECTURE.md, USAGE.md, CONFIGURATION.md)
**Explorer**: paid_explorer
**Total Findings**: 9 (0 CRITICAL, 1 HIGH, 5 MEDIUM, 3 LOW)

---

## HIGH (1)

### CANDIDATE-001 — Streaming API Stub
```
CANDIDATE_FINDING
  id: batch6-002
  group: 2
  provisional_severity: HIGH
  confidence: HIGH
  file: USAGE.md
  line: 788-809
  title: Streaming API example documents non-existent functionality
  problem: |
    The "Real-time Streaming" section shows a requests.post() call with
    stream=True and iter_lines() usage. This pattern implies SSE or
    chunked transfer encoding. grep across the entire codebase confirms
    zero matches for "stream", "StreamingResponse", or "iter_lines"
    in api_server.py. The API does not support streaming responses —
    this is a stub/placeholder section.
  fix: |
    Remove the "Real-time Streaming" section entirely, or replace with
    a clarification that streaming is not currently supported and link
    to a feature request tracker.
  evidence: |
    "response = requests.post(f'{BASE_URL}/ask', json={'question': 'Tell me about the project'}, stream=True)"
    "for line in response.iter_lines():"
    "if data.get('type') == 'chunk':"
  disprove_attempt: |
    Grepped api_server.py for "stream|StreamingResponse|SSE|iter_lines"
    — zero matches. No streaming endpoint exists. The /ask endpoint
    returns a complete JSON response (QuestionResponse model).
  ai_pattern: Confident Stub
  size: M
END
```

---

## MEDIUM (5)

### CANDIDATE-002 — Unverified Performance Claims
```
CANDIDATE_FINDING
  id: batch6-001
  group: 1
  provisional_severity: MEDIUM
  confidence: HIGH
  file: README.md
  line: 22, 43, 50, 56
  title: Performance token/sec claims lack empirical evidence
  problem: |
    Multiple specific token-per-second performance numbers are presented as factual
    across different hardware tiers (5-10, 10-15, 20-30+ tokens/sec) but no
    benchmarks or measurement methodology are cited. CONFIGURATION.md lines 441-477
    also reproduces the same unverifiable claims. These numbers cannot be verified
    without controlled benchmarking on each hardware configuration.
  fix: |
    Remove specific throughput numbers and replace with qualitative guidance
    (e.g., "actual speed depends on CPU model and document complexity; expect
    slower speeds for longer documents"). Or add a benchmarks section citing
    reproducible test methodology.
  evidence: |
    "~5-10 tokens/second on standard CPU" (README.md:22)
    "**Performance**: ~5-7 tokens/second" (README.md:43)
    "**Performance**: ~10-15 tokens/second" (README.md:50)
    "**Performance**: 20-30+ tokens/second" (README.md:56)
  disprove_attempt: |
    No grep match for any benchmark data, performance test results, or
    measurement scripts in the codebase. Grepped: "tokens.*second",
    "Performance.*tokens", "benchmark" — zero matches.
  ai_pattern: Performance Claim Unverified
  size: S
END
```

### CANDIDATE-003 — RAG_MIN_SIMILARITY Not Wired
```
CANDIDATE_FINDING
  id: batch6-003
  group: 3
  provisional_severity: MEDIUM
  confidence: HIGH
  file: CONFIGURATION.md
  line: 43
  title: RAG_MIN_SIMILARITY env var documented but not implemented in engine_factory
  problem: |
    CONFIGURATION.md documents RAG_MIN_SIMILARITY as a Core Variable with
    default 0.3. The RAGConfig dataclass has a min_similarity field defaulting
    to 0.3 (rag_engine.py:54), but engine_factory.py (the central env-var
    reader) never reads RAG_MIN_SIMILARITY from os.environ. Only RAGConfig's
    default value is used — the documented env var has no effect.
  fix: |
    Add to engine_factory.py:
    min_similarity=float(os.environ.get("RAG_MIN_SIMILARITY", "0.3")),
    And add "RAG_MIN_SIMILARITY: Minimum similarity threshold (default: 0.3)"
    to the create_engine_from_env docstring.
  evidence: |
    CONFIGURATION.md: "| `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |"
    engine_factory.py: No grep match for "RAG_MIN_SIMILARITY" in the
    create_engine_from_env function body or docstring.
  disprove_attempt: |
    Grepped engine_factory.py for "RAG_MIN_SIMILARITY" — zero matches.
    The field exists in RAGConfig.to_dict() and RAGConfig.from_dict() but
    the env-var wiring in create_engine_from_env (lines 193-204) does not
    include min_similarity.
  ai_pattern: Configuration Drift
  size: S
END
```

### CANDIDATE-004 — context_truncation Not Configurable
```
CANDIDATE_FINDING
  id: batch6-004
  group: 3
  provisional_severity: MEDIUM
  confidence: HIGH
  file: CONFIGURATION.md
  line: 539-549
  title: context_truncation documented as configurable but not in codebase
  problem: |
    CONFIGURATION.md describes context_truncation with default 2000 characters
    (~500 tokens) as a configurable parameter under "Context Truncation".
    grep for "context_truncation" across all .py files returns zero matches.
    The actual safe context limit is hardcoded as _SAFE_CONTEXT_CHARS = 6000
    in rag_engine.py:19 with no public configuration mechanism.
  fix: |
    Either: (a) Add context_truncation parameter to RAGConfig and wire it
    from env var RAG_CONTEXT_TRUNCATION, or (b) remove the "Context Truncation"
    section from CONFIGURATION.md and update rag_engine.py comment to document
    the hardcoded 6000-char limit.
  evidence: |
    CONFIGURATION.md: "max_context_length=2000  # characters"
    "Default: 2000 characters (~500 tokens)"
    grep "context_truncation|max_context_length" in *.py — zero matches.
  disprove_attempt: |
    Confirmed rag_engine.py:19 hardcodes _SAFE_CONTEXT_CHARS = 6000.
    No env var, no constructor param, no CLI arg exposes this value.
    The truncation logic exists but is fixed at 6000 chars.
  ai_pattern: Configuration Drift
  size: S
END
```

### CANDIDATE-005 — API Response Format Mismatch
```
CANDIDATE_FINDING
  id: batch6-006
  group: 3
  provisional_severity: MEDIUM
  confidence: HIGH
  file: USAGE.md
  line: 471-481
  title: /search endpoint response format documented as tuples, actual API returns objects
  problem: |
    USAGE.md shows: "for doc, meta, score in matches: print(f'[{score:.3f}] {doc}')"
    implying a tuple unpack from the /search response. The actual API
    (api_server.py:621-626) returns a list of SearchResult Pydantic objects
    with fields: text, source, similarity. Tuple unpacking will raise TypeError.
    The documented response array format also doesn't match — it shows tuples,
    actual API returns JSON objects with named fields.
  fix: |
    Update USAGE.md API section to show correct response parsing:
    "matches = response.json()  # List[SearchResult]
    for item in matches:
        print(f'[{item.similarity:.3f}] {item.text} (source: {item.source}')"
  evidence: |
    USAGE.md: "for doc, meta, score in matches:"
    api_server.py: "return [SearchResult(text=doc, source=meta.get('source', 'Unknown'), similarity=sim) for ...]"
    The SearchRequest model (api_server.py:367) also lacks documentation in USAGE.md.
  disprove_attempt: |
    Grepped api_server.py for SearchResult — confirmed Pydantic model at line 380.
    The endpoint returns a list of SearchResult objects, not tuples.
    USAGE.md line 479 uses "doc, meta, score" tuple unpacking which will fail.
  ai_pattern: API Doc Drift
  size: S
END
```

### CANDIDATE-006 — RAG_RETRIEVAL_WINDOW Missing from Docstring
```
CANDIDATE_FINDING
  id: batch6-007
  group: 3
  provisional_severity: MEDIUM
  confidence: HIGH
  file: USAGE.md
  line: 370
  title: RAG_RETRIEVAL_WINDOW env var documented but not in CLI or create_engine_from_env docstring
  problem: |
    USAGE.md line 370 shows usage of $env:RAG_RETRIEVAL_WINDOW for enabling
    window expansion. engine_factory.py docstring (lines 160-175) lists many
    env vars but does NOT list RAG_RETRIEVAL_WINDOW. It is listed under
    "RAG Advanced Variables" in CONFIGURATION.md, and it IS wired in code
    (engine_factory.py:202), but the missing entry in the docstring creates
    a discoverability gap for developers reading create_engine_from_env.
  fix: |
    Add "RAG_RETRIEVAL_WINDOW: Retrieval window (default: 1)" to the
    create_engine_from_env docstring in engine_factory.py alongside the
    other RAG_* env vars that are already documented there.
  evidence: |
    USAGE.md: "$env:RAG_RETRIEVAL_WINDOW='2'"
    engine_factory.py:202 "retrieval_window=int(os.environ.get('RAG_RETRIEVAL_WINDOW', '1'))"
    engine_factory.py docstring (lines 160-175): lists RAG_HYBRID_SEARCH but
    does NOT list RAG_RETRIEVAL_WINDOW.
  disprove_attempt: |
    Grepped engine_factory.py docstring (lines 160-175) — RAG_HYBRID_SEARCH
    and RAG_RERANKING_ENABLED are listed but RAG_RETRIEVAL_WINDOW is absent.
    The code at line 202 correctly reads it, but the documentation omits it.
  ai_pattern: Configuration Drift
  size: S
END
```

---

## LOW (3)

### CANDIDATE-007 — AFOMIS Product Name Legacy
```
CANDIDATE_FINDING
  id: batch6-005
  group: 4
  provisional_severity: LOW
  confidence: HIGH
  file: CONFIGURATION.md
  line: 26, 559
  title: AFOMIS product name embedded in paths, inconsistent with project branding
  problem: |
    CONFIGURATION.md documents settings storage as
    %LOCALAPPDATA%\AFOMIS Help and Support\settings.json — the "AFOMIS"
    product name appears in app_paths.py user_data_dir path. However, the
    application self-identifies as "Document Q&A Assistant" (app_gui.py:289
    APP_NAME = "Document Q&A Assistant", VERSION = "1.0.0"). The AFOMIS name
    is an orphaned legacy product reference that creates confusion.
  fix: |
    Update app_paths.py to use "Document QA Assistant" in the path
    (%LOCALAPPDATA%\Document QA Assistant\). Update CONFIGURATION.md
    path examples to match. Search codebase for all AFOMIS references
    and determine whether this is a rename or separate product.
  evidence: |
    app_paths.py:2 "Centralized Windows path resolver for AFOMIS Help and Support"
    app_paths.py:23 "user_data_dir = Path(local_app_data) / 'AFOMIS Help and Support'"
    app_gui.py:289 "APP_NAME = 'Document Q&A Assistant'"
  disprove_attempt: |
    Grepped codebase for "AFOMIS" — appears in app_paths.py, verify_remediation.py,
    and test_defect_006_build_path.py. No other product code references AFOMIS.
    This appears to be an unreferenced legacy path constant.
  ai_pattern: Stale Architecture
  size: S
END
```

### CANDIDATE-008 — Version Number Drift
```
CANDIDATE_FINDING
  id: batch6-008
  group: 9
  provisional_severity: LOW
  confidence: HIGH
  file: ARCHITECTURE.md, USAGE.md
  line: 584-585 (ARCHITECTURE.md), 897-898 (USAGE.md)
  title: Version numbers stale — docs at 1.0.0 while README.md shows 1.1.0
  problem: |
    ARCHITECTURE.md and USAGE.md both declare "Version: 1.0.0" with last-updated
    dates of 2026-02-28. README.md declares "Version: 1.1.0" with last-updated
    2026-03-01. The version discrepancy makes it unclear which is authoritative.
    README.md lists Phase 6 & 7 features (Settings, Chat improvements) introduced
    in 1.1.0, but ARCHITECTURE.md and USAGE.md do not reference these features.
  fix: |
    Update all four docs to Version 1.1.0 and last-updated 2026-03-01.
    Consider consolidating version info into a single shared VERSION constant
    referenced by all docs via a build step, to prevent drift.
  evidence: |
    ARCHITECTURE.md: "**Version**: 1.0.0" + "**Last Updated**: 2026-02-28"
    USAGE.md: "**Version**: 1.0.0" + "**Last Updated**: 2026-02-28"
    README.md: "**Version**: 1.1.0" + "**Last Updated**: 2026-03-01"
    app_gui.py: "VERSION = '1.0.0'" (also stale)
  disprove_attempt: |
    app_gui.py line 290 also has VERSION = "1.0.0" — even the running app
    reports 1.0.0 while README.md claims 1.1.0. All four doc files plus
    app_gui.py are out of sync.
  ai_pattern: Stale Scaffold
  size: S
END
```

### CANDIDATE-009 — Path Name Inconsistency
```
CANDIDATE_FINDING
  id: batch6-009
  group: 8
  provisional_severity: LOW
  confidence: MEDIUM
  file: CONFIGURATION.md, README.md
  line: 25-28 (CONFIGURATION.md), 139-153 (README.md)
  title: Settings storage path differs between CONFIGURATION.md and actual app_paths.py
  problem: |
    CONFIGURATION.md documents settings storage as
    "%LOCALAPPDATA%\AFOMIS Help and Support\settings.json" and
    "doc_qa_db/rag_config.json". The actual paths in app_paths.py are
    "%LOCALAPPDATA%\Document QA Assistant\settings.json" and
    "%LOCALAPPDATA%\Document QA Assistant\doc_qa_db\rag_config.json" —
    "AFOMIS" vs "Document QA Assistant". The path structure itself (nested
    under user_data_dir) is correct, but the product name directory is wrong.
  fix: |
    Update CONFIGURATION.md path examples to use "Document QA Assistant"
    instead of "AFOMIS Help and Support". Also fix app_paths.py line 2
    and the module docstring to remove "AFOMIS" branding.
  evidence: |
    CONFIGURATION.md: "%LOCALAPPDATA%\AFOMIS Help and Support\settings.json"
    app_paths.py:23 "user_data_dir = Path(local_app_data) / 'AFOMIS Help and Support'"
    app_gui.py:289 "APP_NAME = 'Document Q&A Assistant'"
  disprove_attempt: |
    Cross-reference confirms AFOMIS appears in app_paths.py path constant
    AND in CONFIGURATION.md examples, creating a self-consistent (but
    wrong) documentation. The app displays "Document Q&A Assistant" as
    its APP_NAME, making the AFOMIS path invisible to users who don't
    inspect %LOCALAPPDATA%.
  ai_pattern: Hardcoded Assumptions
  size: S
END
```

---

## Summary by Severity

| Severity | Count | Primary Pattern |
|----------|-------|----------------|
| CRITICAL | 0 | — |
| HIGH | 1 | Confident Stub (streaming API) |
| MEDIUM | 5 | Configuration Drift (4), Performance Claims (1), API Doc Drift (1) |
| LOW | 3 | Stale Architecture (2), Hardcoded Assumptions (1) |

**Total**: 9 findings across 4 documentation files

**Key Pattern**: Documentation-Code drift is the dominant issue — 4 of 9 findings involve documented configuration options or API behavior that doesn't match implementation. The streaming API section is a complete fabrication (no streaming support exists).

**Files Affected**:
- CONFIGURATION.md: 5 findings (most drift)
- USAGE.md: 3 findings
- README.md: 2 findings
- ARCHITECTURE.md: 1 finding
