# Explorer Batch 4: Tests Part 1 — Candidate Findings
**Generated**: 2026-04-08T23:35:00Z
**Scope**: 10 test files
**Explorer**: paid_explorer
**Total Findings**: 17 (4 CRITICAL, 6 HIGH, 5 MEDIUM, 2 LOW)

---

## CRITICAL (4)

### CRITICAL-1 — Silent Pass on Missing Dependency
```
CANDIDATE_FINDING
  id: batch4-001
  group: 8
  provisional_severity: CRITICAL
  confidence: HIGH
  file: tests/test_llm_interface.py
  line: 230-235
  title: Test Passes Without Testing Anything When Dependency Missing
  problem: |
    When llama_cpp is not installed, patch("llama_cpp.Llama") exits cleanly,
    then try/except catches ImportError and silently skips with pytest.skip().
    Test passes without testing anything — classic false positive.
  fix: |
    Fail test when dependency missing (don't skip), or mock at lower level.
  evidence: |
    with patch("llama_cpp.Llama"):
        try:
            backend = GGUFBackend(gguf_path=str(gguf_path))
        except ImportError:
            pytest.skip("llama-cpp-python not installed")  # Silent skip
  disprove_attempt: |
    Install without llama-cpp-python, run test — it passes (skipped) rather than failing.
    UNDISPROVED — false positive exists.
  ai_pattern: over-mocked-test
  size: M
END
```

### CRITICAL-2 — Over-Mocked API Tests
```
CANDIDATE_FINDING
  id: batch4-002
  group: 8
  provisional_severity: CRITICAL
  confidence: HIGH
  file: tests/test_api.py
  line: 45-63, 79-101, 136-153, 168-188, 212-225, 251-260
  title: All API Endpoint Tests Mock Engine — No Real RAG Pipeline Tested
  problem: |
    Every endpoint test mocks api_server.engine entirely. Tests verify FastAPI routing
    layer but never exercise actual RAG pipeline. Tests would pass even if entire
    RAG pipeline were broken.
  fix: |
    Add integration tests with real engine (in-memory or test fixtures).
    Or use dependency injection to test with real components.
  evidence: |
    def test_get_stats_success(self):
        with patch('api_server.engine') as mock_engine:
            mock_engine.get_stats.return_value = {...}
            response = client.get("/stats")
            assert data["document_count"] == 5  # Asserted against mock
    
    # All 15+ endpoint tests follow same pattern — mock engine, assert mock values
  disprove_attempt: |
    Introduce bug in RAGEngine.query() that always raises exception —
    all endpoint tests still pass because they mock engine.
    UNDISPROVED — tests don't test real behavior.
  ai_pattern: over-mocked-test
  size: L
END
```

### CRITICAL-3 — Over-Mocked GGUF Wiring Tests
```
CANDIDATE_FINDING
  id: batch4-003
  group: 8
  provisional_severity: CRITICAL
  confidence: HIGH
  file: tests/test_gguf_path_wiring_final.py
  line: 11-120 (entire file)
  title: GGUF Path Wiring Tested Against Mocks, Not Real Code
  problem: |
    Every test patches SmartLLM and only asserts mock calls were made.
    None verify actual wiring behavior — that engine initializes with right GGUF path,
    that create_engine_from_env() reads env var and passes it through.
  fix: |
    Add integration tests that verify real wiring with test fixtures.
    Or test at lower level with dependency injection.
  evidence: |
    def test_rag_engine_accepts_gguf_path_parameter(self):
        with patch('rag_engine.SmartLLM') as mock_smart_llm:
            mock_smart_llm.return_value = MagicMock()
            engine = RAGEngine(gguf_path="/path/to/model.gguf")
            mock_smart_llm.assert_called_once()  # Only verifies mock
            assert call_args[1]['gguf_path'] == "/path/to/model.gguf"
    
    # All 8 tests in file follow same pattern — only test mock interface
  disprove_attempt: |
    Break RAGEngine.__init__ so it ignores gguf_path — all 8 tests still pass.
    UNDISPROVED — tests don't test real behavior.
  ai_pattern: over-mocked-test
  size: L
END
```

### CRITICAL-4 — Over-Mocked RAG Engine Tests
```
CANDIDATE_FINDING
  id: batch4-004
  group: 8
  provisional_severity: CRITICAL
  confidence: HIGH
  file: tests/test_rag_engine.py
  line: 139-226
  title: RAG Engine Tests Mock All Dependencies, Query Returns Canned Data
  problem: |
    VectorStore, SmartLLM, and _save_config all mocked. Test asserts answer string
    from mock appears in result. Tests that mock data flows through, not that engine's
    query logic works correctly. Real vector search, chunk retrieval, context assembly,
    and LLM invocation never exercised.
  fix: |
    Add integration tests with real components (in-memory vector store, mock LLM).
  evidence: |
    def test_query_returns_answer(self):
        with patch("rag_engine.VectorStore") as mock_vector_store:
            with patch("rag_engine.SmartLLM") as mock_llm:
                mock_llm_instance.answer_question.return_value = "This is the answer..."
                engine = RAGEngine()
                result = engine.query("What is this about?")
                assert "This is the answer based on context." in result.answer
    
    # Only tests mock data flow, not real engine behavior
  disprove_attempt: |
    Break actual RAGEngine.query() logic — test still passes because it mocks everything.
    UNDISPROVED — tests don't test real behavior.
  ai_pattern: over-mocked-test
  size: L
END
```

---

## HIGH (6)

### HIGH-1 — Path Traversal Validation Bypassed by Mock
```
CANDIDATE_FINDING
  id: batch4-005
  group: 8
  provisional_severity: HIGH
  confidence: MEDIUM
  file: tests/test_api.py
  line: 190-197
  title: Path Traversal Test Doesn't Actually Test validate_directory
  problem: |
    Test claims to verify path-traversal protection but rejection comes from Pydantic
    model layer, not validate_directory(). Test doesn't actually test that
    validate_directory() rejects path traversal.
  fix: |
    Test should verify validate_directory() is called and rejects traversal,
    not rely on Pydantic validation.
  evidence: |
    def test_ingest_directory_invalid_path(self):
        with patch('api_server.engine') as mock_engine:
            request = IngestRequest(directory="../etc/passwd")
            response = client.post("/ingest", json=request.model_dump())
            assert response.status_code == 400  # From Pydantic, not validate_directory
  disprove_attempt: |
    Change IngestRequest to accept any string — test may fail because mock_engine
    path may not reject traversal. UNDISPROVED — test doesn't test what it claims.
  ai_pattern: test-bypasses-validation
  size: M
END
```

### HIGH-2 — Test for Nonexistent Function Logic
```
CANDIDATE_FINDING
  id: batch4-006
  group: 8
  provisional_severity: HIGH
  confidence: HIGH
  file: tests/test_main_gguf_path.py
  line: 22-60
  title: Test Creates Its Own Argparse Parser — Never Tests Real main.py
  problem: |
    Test defines its own argparse.ArgumentParser and manually sets env var —
    never parses real main.py arguments or calls any function from main.py.
    Import of main on line 35 and main_module on line 38 are never used.
    Test completely disconnected from code under test.
  fix: |
    Test should call main.main() with patched sys.argv and verify env var is set.
  evidence: |
    def test_argument_value_sets_env_var(self):
        with patch('sys.argv', ['main.py', '--gguf-path', test_gguf_path]):
            from main import main   # never called
            import main as main_module  # never used
            # Creates its OWN parser:
            parser = argparse.ArgumentParser()
            parser.add_argument("--gguf-path", ...)
            args = parser.parse_args(test_args)
            if args.gguf_path:
                os.environ["RAG_GGUF_PATH"] = args.gguf_path
            assert os.environ.get("RAG_GGUF_PATH") == test_gguf_path
  disprove_attempt: |
    Delete --gguf-path argument handling from main.py — test still passes.
    UNDISPROVED — test doesn't test real code.
  ai_pattern: test-disconnected-from-code
  size: M
END
```

### HIGH-3 — No Assertions on Behavior (Structural Checks Only)
```
CANDIDATE_FINDING
  id: batch4-007
  group: 8
  provisional_severity: HIGH
  confidence: HIGH
  file: tests/test_vector_store.py
  line: 294-304, 264-281, 317-327
  title: Tests Only Check Return Types, Not Actual Behavior
  problem: |
    Multiple tests only verify return type is correct, not that behavior
    (similarity filtering, window expansion, high-threshold filtering) actually works.
    Tests pass regardless of whether underlying logic is implemented or broken.
  fix: |
    Add behavioral assertions — verify actual filtering/expansion occurred.
  evidence: |
    def test_get_context_filters_by_similarity(self, vector_store):
        context, sources = vector_store.get_context("Python programming", n_results=5, min_similarity=0.5)
        assert isinstance(context, str)   # Only checks type, not filtering
    
    def test_window_expansion_with_chunks(self, vector_store):
        chunks = vector_store.get_chunks("Chunk", n_results=1)
        if chunks:
            assert len(chunks) >= 1   # Only checks chunks exist
    
    def test_get_context_high_similarity(self, vector_store):
        context, sources = vector_store.get_context("Python", n_results=3, min_similarity=0.8)
        assert isinstance(context, str)   # Only checks type
        assert isinstance(sources, list)   # Only checks type
  disprove_attempt: |
    Break underlying filtering/expansion logic — tests still pass.
    UNDISPROVED — tests don't test behavior.
  ai_pattern: non-behavioral-assertion
  size: M
END
```

### HIGH-4 — Non-Behavioral Assertions on Static Strings
```
CANDIDATE_FINDING
  id: batch4-008
  group: 8
  provisional_severity: HIGH
  confidence: MEDIUM
  file: tests/test_api.py
  line: 29-37
  title: Health Check Test Only Verifies Hardcoded Strings
  problem: |
    Test checks two hardcoded string values. If service name changed, test fails
    but actual health check behavior (endpoint accessible) is not validated
    beyond HTTP 200. No assertion tests that health endpoint reflects engine state.
  fix: |
    Test should verify health check reflects actual engine initialization state.
  evidence: |
    def test_root_health_check(self):
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"           # Hardcoded string
        assert data["service"] == "Document Q&A API"   # Hardcoded string
  disprove_attempt: |
    Change service name to "Document Q&A Service" — test fails but behavior is same.
    UNDISPROVED — test checks strings, not behavior.
  ai_pattern: static-string-assertion
  size: S
END
```

### HIGH-5 — Unstable Test with Real Network Call
```
CANDIDATE_FINDING
  id: batch4-009
  group: 8
  provisional_severity: HIGH
  confidence: HIGH
  file: tests/test_llm_interface.py
  line: 302-305
  title: Test Makes Real TCP Connection Without Mocking
  problem: |
    Test makes real TCP connection to localhost:9999 without mocking
    urllib.request.urlopen. In environments where port 9999 is open or localhost
    resolves unexpectedly, test produces false failures. Should use @patch.
  fix: |
    Mock urllib.request.urlopen to simulate connection failure.
  evidence: |
    def test_ollama_connection_error(self):
        """Test OllamaLLM with unreachable server."""
        with pytest.raises(ConnectionError, match="Cannot connect to Ollama"):
            OllamaLLM(base_url="http://localhost:9999")  # Real network call
  disprove_attempt: |
    Port 9999 may be open in some environments — test becomes unstable.
    UNDISPROVED — real network call makes test unstable.
  ai_pattern: real-network-call-in-test
  size: S
END
```

### HIGH-6 — Deprecated Pydantic v2 Method
```
CANDIDATE_FINDING
  id: batch4-010
  group: 8
  provisional_severity: HIGH
  confidence: HIGH
  file: tests/test_api.py
  line: 92, 107, 118, 144, 159, 181
  title: Tests Use Deprecated .dict() Instead of .model_dump()
  problem: |
    Pydantic v2 deprecated Model.dict() in favor of Model.model_dump().
    Tests use deprecated method throughout. Will break when migrating to
    Pydantic v2 fully or may already emit deprecation warnings.
  fix: |
    Replace all .dict() calls with .model_dump().
  evidence: |
    response = client.post("/ask", json=request.dict())   # Line 92 — deprecated
    response = client.post("/search", json=request.dict())  # Line 107 — deprecated
    # Multiple occurrences throughout file
  disprove_attempt: |
    Pydantic v2 documentation confirms .dict() is deprecated.
    UNDISPROVED — deprecated method usage.
  ai_pattern: deprecated-api-usage
  size: M
END
```

---

## MEDIUM (5)

### MEDIUM-1 — conftest.py Silent Failure with Shadow Stubs
```
CANDIDATE_FINDING
  id: batch4-011
  group: 8
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: tests/conftest.py
  line: 12-30
  title: Module-Level Imports Fail Silently and Create Shadow Stubs
  problem: |
    Module-level imports in conftest.py fail silently and create shadow stub
    classes if dependencies missing. pytest collection succeeds even with broken
    dependencies, and fixture stubs silently override real classes — masking
    import errors until runtime.
  fix: |
    Fail fast on import errors or use explicit pytest.skip() with clear message.
  evidence: |
    try:
        from document_processor import DocumentChunk
        from vector_store import VectorStore
        MODULES_AVAILABLE = True
    except ImportError:
        MODULES_AVAILABLE = False
        @dataclass
        class DocumentChunk:   # shadow stub
            ...
  disprove_attempt: |
    Missing dependencies cause silent stub usage instead of clear failure.
    UNDISPROVED — silent failure pattern exists.
  ai_pattern: silent-failure-with-stub
  size: M
END
```

### MEDIUM-2 — Missing Public API Coverage
```
CANDIDATE_FINDING
  id: batch4-012
  group: 8
  provisional_severity: MEDIUM
  confidence: HIGH
  file: tests/
  line: N/A
  title: Many Public APIs Have No Test Coverage
  problem: |
    Multiple public APIs have no test coverage:
    - sanitize_filename() — NOT TESTED
    - engine_factory.create_engine() — NOT TESTED
    - engine_factory._resolve_gguf_path() — NOT TESTED
    - SmartLLM.answer_question() — NOT TESTED (only mocked)
    - SmartLLM.generate() — NOT TESTED
    - SmartLLM.get_info() — NOT TESTED
    - SmartLLM.backends — NOT TESTED
    - BaseLLM abstract interface — NOT TESTED
    - RAGEngine.list_documents() — NOT TESTED
    - RAGEngine.clear_documents() — NOT TESTED (only mocked)
    - DocumentProcessor.clean_text() — NOT TESTED
    - DocumentProcessor.extract_document() — NOT TESTED
  fix: |
    Add tests for all public APIs or document why not tested.
  evidence: |
    # Verified by searching test files for function names — no tests found
  disprove_attempt: |
    N/A — coverage gap is factual.
  ai_pattern: missing-coverage
  size: L
END
```

### MEDIUM-3 — Missing Error/Edge-Case Coverage
```
CANDIDATE_FINDING
  id: batch4-013
  group: 8
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: tests/
  line: N/A
  title: Missing Error and Edge-Case Test Coverage
  problem: |
    Multiple error and edge cases not tested:
    - /ask with n_results=0 or negative n_results
    - /search with n_results exceeding store size
    - ingest_directory with no read permissions
    - query with empty engine (no VectorStore)
    - concurrent add_chunks calls (race condition)
    - extremely large chunk text (overflow)
    - GGUFBackend with unreadable file
    - SmartLLM with incompatible GGUF parameters
    - extremely long query with special characters
    - concurrent validation requests
  fix: |
    Add tests for all error and edge cases.
  evidence: |
    # Verified by reviewing test files — no tests for these cases
  disprove_attempt: |
    N/A — coverage gap is factual.
  ai_pattern: missing-edge-case-coverage
  size: L
END
```

### MEDIUM-4 — Fixture Cleanup Issues
```
CANDIDATE_FINDING
  id: batch4-014
  group: 8
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: tests/conftest.py
  line: 181-216
  title: Fixture vector_store Has No Explicit Cleanup
  problem: |
    No explicit del store or store.clear() in fixture teardown.
    While temp_chroma_db cleanup handles directory, in-memory ChromaDB
    client connection not explicitly closed. Can accumulate open connections.
  fix: |
    Add explicit cleanup: yield store; store.clear(); del store
  evidence: |
    @pytest.fixture
    def vector_store(temp_chroma_db, mock_llm, sample_chunks):
        store = VectorStore(db_path=str(temp_chroma_db), ...)
        store.add_chunks(sample_chunks)
        yield store
        # no explicit cleanup — relies on temp_chroma_db cleanup
  disprove_attempt: |
    Connection accumulation possible in large test suites.
    UNDISPROVED — cleanup gap exists.
  ai-pattern: incomplete-cleanup
  size: S
END
```

### MEDIUM-5 — Test Greeting Variations Incomplete
```
CANDIDATE_FINDING
  id: batch4-015
  group: 8
  provisional_severity: MEDIUM
  confidence: MEDIUM
  file: tests/test_rag_engine.py
  line: 254-270
  title: Test Greeting Variations Has No Assertion on Real Behavior
  problem: |
    Test asserts sources == [] but never asserts that greeting actually
    bypassed vector store (get_context was not called). Mock's get_context
    never verified. Bug where greetings always go through RAG would pass test.
  fix: |
    Add assertion that get_context was NOT called for greetings.
  evidence: |
    def test_greeting_variations(self):
        for greeting in greetings:
            with patch(...):
                mock_llm_instance.answer_question.return_value = "Hello!"
                engine = RAGEngine()
                result = engine.query(greeting)
                assert result.sources == []   # Only checks sources
                # Never verifies get_context was NOT called
  disprove_attempt: |
    Bug where greetings go through RAG — test still passes.
    UNDISPROVED — incomplete assertion.
  ai-pattern: incomplete-behavior-verification
  size: S
END
```

---

## LOW (2)

### LOW-1 — BM25 Tests Silently Pass When Library Unavailable
```
CANDIDATE_FINDING
  id: batch4-016
  group: 8
  provisional_severity: LOW
  confidence: LOW
  file: tests/test_vector_store.py
  line: 87-158
  title: BM25 Tests Pass Whether Library Installed or Not
  problem: |
    When rank_bm25 not installed, bm25_index is None and assertions become
    conditional. Tests pass in both states, providing no signal about whether
    BM25 functionality works. No pytest.skip() indicates library absent.
  fix: |
    Add explicit pytest.skip() when rank_bm25 not installed,
    or fail test if BM25 expected but not available.
  evidence: |
    def test_bm25_index_build(self, sample_chunks):
        index = BM25Index()
        index.build_index(sample_chunks)
        assert index.chunks == sample_chunks
        if index.bm25_index is not None:  # Conditional assertion
            assert len(index.chunks) == len(sample_chunks)
    # Test passes whether bm25_index is None or not
  disprove_attempt: |
    Test provides no signal about BM25 functionality.
    UNDISPROVED but LOW severity appropriate.
  ai-pattern: conditional-assertion
  size: S
END
```

### LOW-2 — Test __init__.py Not Needed
```
CANDIDATE_FINDING
  id: batch4-017
  group: 8
  provisional_severity: LOW
  confidence: LOW
  file: tests/__init__.py
  line: 1
  title: tests/__init__.py Is Empty and Unnecessary
  problem: |
    tests/__init__.py is empty. Python 3.3+ doesn't require __init__.py
    for namespace packages. File is unnecessary.
  fix: |
    Remove empty tests/__init__.py
  evidence: |
    # File is empty — no content
  disprove_attempt: |
    N/A — trivial finding.
  ai-pattern: unnecessary-file
  size: S
END
```

---

## SUMMARY BY SEVERITY

| Severity | Count | Primary Pattern |
|----------|-------|----------------|
| CRITICAL | 4 | Over-mocked tests; false-positive pass on missing dependency |
| HIGH | 6 | Bypassed validation; mock-only wiring tests; non-behavioral assertions; real network call |
| MEDIUM | 5 | Missing API coverage; missing edge cases; fixture issues; incomplete assertions |
| LOW | 2 | Conditional assertions; unnecessary file |

**Total**: 17 findings across 10 test files
