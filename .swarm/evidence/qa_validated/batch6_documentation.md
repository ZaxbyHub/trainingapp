# Reviewer Batch 6: Validation Results
**Validated**: 2026-04-09T00:05:00Z
**Scope**: 9 candidates from Batch 6 (Documentation)
**Reviewer**: paid_reviewer
**Results**: 7 confirmed, 1 disproved, 1 overturned (duplicate)

---

## HIGH Finding (1) — Routed to Critic

### CANDIDATE-002 → CONFIRMED HIGH
```
VALIDATED_FINDING
  id: batch6-002
  provisional_severity: HIGH
  final_severity: HIGH
  status: CONFIRMED
  file: USAGE.md
  line: 788-809
  title: Streaming API example documents non-existent functionality
  problem: |
    USAGE.md:788-809 shows `requests.post(..., stream=True)` and `iter_lines()` pattern, 
    but api_server.py `/ask` endpoint (line 590-612) returns standard JSONResponse with 
    QuestionResponse model. No streaming support exists in codebase.
  fix: |
    Remove the "Real-time Streaming" section entirely, or replace with a clarification 
    that streaming is not currently supported.
  evidence: |
    USAGE.md: "response = requests.post(f'{BASE_URL}/ask', json={'question': '...'}, stream=True)"
    USAGE.md: "for line in response.iter_lines():"
    api_server.py: No matches for "stream", "StreamingResponse", "iter_lines"
  ai_pattern: Confident Stub
  size: M
END
```

---

## MEDIUM Findings (4) — Finalized Inline

### CANDIDATE-001 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch6-001
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: README.md
  line: 22, 43, 50, 56
  title: Performance token/sec claims lack empirical evidence
  problem: |
    README.md lines 22,43,50,56 contain unverified performance claims (~5-10, ~5-7, 
    ~10-15, 20-30+ tokens/sec) with no empirical benchmarks cited. This is a common 
    pattern for AI-generated docs.
  fix: |
    Remove specific throughput numbers and replace with qualitative guidance, or 
    add reproducible benchmark methodology.
  evidence: |
    "~5-10 tokens/second on standard CPU" (README.md:22)
    "**Performance**: ~5-7 tokens/second" (README.md:43)
    "**Performance**: ~10-15 tokens/second" (README.md:50)
    "**Performance**: 20-30+ tokens/second" (README.md:56)
  ai_pattern: Performance Claim Unverified
  size: S
END
```

### CANDIDATE-003 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch6-003
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: CONFIGURATION.md
  line: 43
  title: RAG_MIN_SIMILARITY env var documented but not implemented
  problem: |
    CONFIGURATION.md:43 documents `RAG_MIN_SIMILARITY` env var, but grep confirms 
    zero matches in engine_factory.py. The RAGConfig class has min_similarity field 
    but create_engine_from_env() never reads RAG_MIN_SIMILARITY from os.environ.
  fix: |
    Add min_similarity=float(os.environ.get("RAG_MIN_SIMILARITY", "0.3")) to 
    create_engine_from_env and update docstring.
  evidence: |
    CONFIGURATION.md: "| `RAG_MIN_SIMILARITY` | Minimum similarity threshold | `0.3` | No |"
    engine_factory.py: No grep match for "RAG_MIN_SIMILARITY"
  ai_pattern: Configuration Drift
  size: S
END
```

### CANDIDATE-004 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch6-004
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: CONFIGURATION.md
  line: 545
  title: context_truncation documented as configurable but not in codebase
  problem: |
    CONFIGURATION.md:545 documents `max_context_length=2000` as configurable parameter, 
    but grep confirms no such variable in codebase. rag_engine.py:19 hardcodes 
    `_SAFE_CONTEXT_CHARS = 6000`.
  fix: |
    Either add context_truncation parameter to RAGConfig and wire from env var, 
    or remove the "Context Truncation" section from CONFIGURATION.md.
  evidence: |
    CONFIGURATION.md: "max_context_length=2000  # characters"
    rag_engine.py:19 "_SAFE_CONTEXT_CHARS = 6000"
  ai_pattern: Configuration Drift
  size: S
END
```

### CANDIDATE-005 → CONFIRMED MEDIUM
```
VALIDATED_FINDING
  id: batch6-006
  provisional_severity: MEDIUM
  final_severity: MEDIUM
  status: CONFIRMED
  file: USAGE.md
  line: 479
  title: /search endpoint response format documented as tuples, actual API returns objects
  problem: |
    USAGE.md:479 shows `for doc, meta, score in matches:` tuple unpacking from API 
    response, but api_server.py:623-626 transforms results into SearchResult Pydantic 
    objects. The documented example would fail against actual API.
  fix: |
    Update USAGE.md to show correct response parsing with SearchResult object attributes.
  evidence: |
    USAGE.md: "for doc, meta, score in matches:"
    api_server.py: "return [SearchResult(text=doc, source=meta.get('source', 'Unknown'), similarity=sim) for ...]"
  ai_pattern: API Doc Drift
  size: S
END
```

---

## LOW Findings (2) — Finalized Inline

### CANDIDATE-007 → CONFIRMED LOW
```
VALIDATED_FINDING
  id: batch6-005
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: CONFIGURATION.md
  line: 26, 559
  title: AFOMIS product name embedded in paths, inconsistent with project branding
  problem: |
    CONFIGURATION.md:26,559 show `%LOCALAPPDATA%\AFOMIS Help and Support\` path, 
    but app_gui.py:289 displays `APP_NAME = "Document Q&A Assistant"`. Stale branding 
    inconsistent with actual app naming.
  fix: |
    Update app_paths.py to use "Document QA Assistant" and update CONFIGURATION.md 
    path examples to match.
  evidence: |
    app_paths.py: "user_data_dir = Path(local_app_data) / 'AFOMIS Help and Support'"
    app_gui.py:289 "APP_NAME = 'Document Q&A Assistant'"
  ai_pattern: Stale Architecture
  size: S
END
```

### CANDIDATE-008 → CONFIRMED LOW
```
VALIDATED_FINDING
  id: batch6-008
  provisional_severity: LOW
  final_severity: LOW
  status: CONFIRMED
  file: ARCHITECTURE.md, USAGE.md
  line: 584-585 (ARCHITECTURE.md), 897-898 (USAGE.md)
  title: Version numbers stale — docs at 1.0.0 while README.md shows 1.1.0
  problem: |
    Version discrepancies confirmed: app_gui.py:290 = "1.0.0", README.md:58 = "1.1.0", 
    ARCHITECTURE.md:584 = "1.0.0", USAGE.md:897 = "1.0.0". Four docs + app_gui.py all disagree.
  fix: |
    Update all four docs to Version 1.1.0 and last-updated 2026-03-01. Consider 
    consolidating version info into a single shared VERSION constant.
  evidence: |
    ARCHITECTURE.md: "**Version**: 1.0.0" + "**Last Updated**: 2026-02-28"
    USAGE.md: "**Version**: 1.0.0" + "**Last Updated**: 2026-02-28"
    README.md: "**Version**: 1.1.0" + "**Last Updated**: 2026-03-01"
    app_gui.py:290 "VERSION = '1.0.0'"
  ai_pattern: Stale Scaffold
  size: S
END
```

---

## Disproved Findings (1)

### CANDIDATE-006 → DISPROVED
```
DISPROVED_FINDING
  id: batch6-007
  provisional_severity: MEDIUM
  status: DISPROVED
  file: USAGE.md
  line: 370
  title: RAG_RETRIEVAL_WINDOW env var documented but not in create_engine_from_env docstring
  reason: |
    engine_factory.py:167 in create_engine_from_env docstring explicitly lists 
    `RAG_RETRIEVAL_WINDOW: Retrieval window (default: 1)`. The candidate claim that 
    it's missing from docstring is incorrect.
  disprove_basis: |
    Line 167 of engine_factory.py docstring: "RAG_RETRIEVAL_WINDOW: Retrieval window (default: 1)"
    The env var is correctly documented in the docstring.
END
```

---

## Overturned Findings (1)

### CANDIDATE-009 → OVERTURNED (Duplicate)
```
OVERTURNED_FINDING
  id: batch6-009
  provisional_severity: LOW
  status: OVERTURNED — DUPLICATE
  file: CONFIGURATION.md, README.md
  line: 25-28 (CONFIGURATION.md), 139-153 (README.md)
  title: Settings storage path differs between CONFIGURATION.md and actual app_paths.py
  reason: |
    Same root issue as CANDIDATE-007 — CONFIGURATION.md shows AFOMIS path while 
    app_gui.py uses "Document Q&A Assistant". CANDIDATE-007 and CANDIDATE-009 are 
    identical findings at different doc locations. Should be merged.
  resolution: |
    Merge with CANDIDATE-007 (batch6-005). Do not enter as separate finding.
END
```

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Total Reviewed | 9 |
| Confirmed | 7 |
| Disproved | 1 |
| Overturned | 1 |

### Final Severity Distribution
- **HIGH**: 1 finding (entering Critic challenge)
- **MEDIUM**: 4 findings (finalized)
- **LOW**: 2 findings (finalized)

### Routing Decisions

**To Critic (HIGH)**: batch6-002 (Streaming API stub)

**Finalized (MEDIUM)**: batch6-001, batch6-003, batch6-004, batch6-006

**Finalized (LOW)**: batch6-005, batch6-008

**Excluded**: batch6-007 (disproved), batch6-009 (duplicate of batch6-005)

---

## Key Patterns Confirmed

1. **Configuration Drift**: 3 MEDIUM findings (RAG_MIN_SIMILARITY, context_truncation, API response format)
2. **Unverified Claims**: 1 MEDIUM finding (performance numbers)
3. **Stale Branding**: 1 LOW finding (AFOMIS vs Document Q&A Assistant)
4. **Version Drift**: 1 LOW finding (inconsistent version numbers)
5. **Fabricated Features**: 1 HIGH finding (streaming API section is complete fabrication)
