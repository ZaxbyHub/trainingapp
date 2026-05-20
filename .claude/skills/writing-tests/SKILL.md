---
name: writing-tests
description: >
  Apply when writing tests, modifying test files, fixing test failures, debugging CI failures,
  adding test coverage, creating adversarial tests, or reviewing any file under tests/.
  Also apply when implementing features or fixes that require corresponding test changes.
  Enforces pytest framework rules, mock isolation, cross-platform compatibility (Linux,
  macOS, Windows), and CI pipeline awareness. Load this skill before touching any test file.
  For CI failure debugging specifically, also load the ci-failure-resolver skill.
effort: medium
applicable_languages: [python]
---

# Writing Tests for Python/pytest

## Core Principle: Test Contracts, Not Implementations

> **A test that fails when you refactor code without changing behavior is a broken test.**

Tests should survive refactoring. If extracting a helper method, renaming a variable, or reorganizing code causes your test to fail — the test was asserting on *implementation details*, not *behavioral contracts*.

Common anti-patterns that break on refactoring:

| Anti-pattern | Why it breaks | What to do instead |
|---|---|---|
| `inspect.getsource()` checking for inline strings | Refactoring moves/changes text | Test behavior: call the function, assert the output |
| Asserting on log *format* strings | Logging refactoring changes text | Assert on log *content* (presence of key facts) |
| Asserting on internal method call order | Internal refactoring changes order | Assert on final state, not call sequence |
| Asserting on private attrs (`_internal_cache`) | Private API refactoring destroys test | Test the public behavior the private attr influences |
| Checking that `.destroy()` appears inline in source | Helper extraction moves the call elsewhere | Test that the frame is destroyed as a side effect of the action |

### The Source-Pattern Anti-Pattern (Critical Warning)

This project has **272+ instances** of `inspect.getsource()` across test files. This is the single most dangerous testing pattern here.

```python
# WRONG — fragile source-pattern test
source = inspect.getsource(app_gui.DocumentQAApp._ask_question)
assert "_streaming_finalized = False" in source
assert source.find("_streaming_finalized = False") < source.find("threading.Thread")

# RIGHT — behavioral test
app = DocumentQAApp()
app._streaming_finalized = True  # simulate post-streaming state
# Simulate a new query
app._streaming_finalized = False  # the reset we're testing
# Now verify tokens ARE processed (not discarded)
app._handle_streaming_token("hello")  # should not return early
assert app._streaming_message_ref is not None  # widget was created
```

**Rule:** Use `inspect.getsource()` ONLY when testing that a decorator is applied, a class inherits from another, or some immutable structural property. NEVER use it to check that code "does something."

---

## Framework: pytest

### pytest Configuration

**pytest.ini** (at project root):
```ini
[pytest]
asyncio_mode = auto
markers =
    integration: integration tests (require running services)
    unit: unit tests (no external dependencies)
    slow: tests that take >5 seconds
    regression: regression tests for fixed defects
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
```

### Fixtures (conftest.py hierarchy)

```python
# tests/conftest.py — shared for ALL tests
@pytest.fixture(scope="session")
def mock_llm():
    """Session-scoped mock LLM for all tests."""
    ...

@pytest.fixture
def vector_store(tmp_path):
    """Per-test isolated vector store."""
    ...
```

**Scope rules:**
- `scope="session"` — expensive setup (embedding model loading). WARNING: leaks state between tests unless you have explicit cleanup.
- `scope="function"` (default) — safe, isolated per test.
- Prefer `yield` fixtures with cleanup over `addfinalizer`.

### Mock Patterns

**Pre-registered optional imports (tests/conftest.py):**
```python
# llm_interface.py uses `from llama_cpp import Llama` which may not be installed.
# conftest.py already does: sys.modules.setdefault("llama_cpp", MagicMock())
# Do NOT re-mock these in individual tests.
```

**unittest.mock basics:**
```python
from unittest.mock import patch, MagicMock, AsyncMock

# Patch in a `with` block — automatic cleanup
with patch("app_gui.smart_llm_load") as mock_load:
    mock_load.return_value = MagicMock()
    result = my_function()
    assert result is not None

# Async mocks
async with patch("app_gui.async_engine") as mock_engine:
    mock_engine.return_value = AsyncMock()
    result = await my_async_function()

# DO NOT double-patch: if conftest.py already patches EmbeddingModel,
# do NOT add @patch("vector_store.EmbeddingModel") in a test using the vector_store fixture.
# Nested patches shadow each other unpredictably.
```

**Engine factory pattern (canonical way to create testable RAGEngine):**
```python
def make_engine(mock_llm=None):
    """Create a RAGEngine with fully mocked dependencies."""
    with patch("vector_store.EmbeddingModel"), \
         patch("llm_interface.SmartLLM"), \
         patch("rag_engine._save_config"):
        engine = RAGEngine()
        engine.llm = mock_llm or MagicMock()
        engine.vector_store = MagicMock()
    return engine
```

### caplog (logging assertions)

**WARNING: caplog retains state across tests in the same module.** Always clear:
```python
def test_error_logged(caplog, app_instance):
    caplog.clear()  # CRITICAL: clear before test
    with caplog.at_level(logging.ERROR, logger="app_gui"):
        app_instance._save_config()  # triggers error
    assert any("Failed to save" in r.message for r in caplog.records)
```

### parametrize

```python
@pytest.mark.parametrize("input_val,expected", [
    ("", None),
    ("single", "single"),
    ("a" * 10000, None),  # oversized
    ("with\ttab", "with tab"),
])
def test_sanitize(input_val, expected):
    assert sanitize(input_val) == expected
```

### asyncio

pytest.ini has `asyncio_mode = auto`. Async test functions run automatically:
```python
async def test_query_async(rag_engine):
    result = await rag_engine.query("test question")
    assert result.answer is not None
```

---

## File Placement

| Test type | Location | When to use |
|-----------|----------|-------------|
| Unit tests | `tests/test_<module>.py` | Testing a module in isolation |
| Integration tests | `tests/integration/test_<feature>.py` | Cross-module workflows |
| Regression tests | `tests/regression/test_defect_NNN_<slug>.py` | Tests for fixed defects |
| Adversarial tests | `tests/test_<module>_adversarial.py` | Attack vectors, not covered by base test |
| Security tests | `tests/security/` | Adversarial input, injection resistance |

### Naming

- Unit test: `test_<module>.py` (e.g., `test_rag_engine.py`)
- Integration test: `test_<feature>.py` in `tests/integration/`
- Regression test: `test_defect_NNN_<slug>.py` in `tests/regression/`
- Adversarial variant: `test_<module>_adversarial.py`

---

## Test Quality Standards

### DO

- Test **real behavior**: call the actual function with real inputs, assert on real outputs.
- Test **error paths**: what happens with `None`, `""`, empty list, oversized input?
- Use `tmp_path` fixture for file I/O tests (auto-cleanup on teardown).
- Assert on **specific values**, not just truthiness: `assert result.status == "pending"` not `assert result`.
- Use `parametrize` for data-driven tests rather than repeating test functions.

### DO NOT

- **Do not test type hints.** `assert isinstance(x, str)` tests Python's runtime, not your code.
- **Do not test framework behavior.** "pytest fixture runs" tests pytest, not your code.
- **Do not mock everything.** If every dependency is mocked, you're testing the mock setup. Prefer real dependencies for pure functions and only mock I/O boundaries (filesystem, network, timers).
- **Do not hardcode version numbers.** Version bumps are automated — `assert version == "1.2.3"` breaks on every release.
- **Do not use `time.sleep` for synchronization.** Use `threading.Event`, `asyncio.wait_for`, or `pytest.mark.timeout`.
- **Do not use `inspect.getsource()` to verify behavior.** It tests source structure, not runtime behavior.
- **Do not hard-code absolute paths.** Use `tmp_path`, `pathlib.Path`, or `os.path.join`.

---

## Ghost Frame Tests (Permanently Skipped Tests)

> A test with `@pytest.mark.skip(reason="...")` or `@pytest.mark.xfail(reason="...")` that has been skipped for more than 2 PRs is dead weight.

**Rules:**
- `@pytest.mark.skip` is for **temporary** conditions (CI environment missing, optional dependency not installed). If skipped for >2 PRs: either fix the infrastructure or **delete the test**.
- `@pytest.mark.xfail` is for **known bugs with an expected fix date**. Permanently xfail'd tests should be moved to `TODO.md`, not left in the test suite.
- **Never batch-skip an entire test class.** If all tests in a class are skipped, delete the class.

---

## Regression Tests (Review-Surfaced Bugs)

Place in `tests/regression/`. One file per defect.

```python
# tests/regression/test_defect_001_gui_streaming_persistence.py
class TestDefect001StreamingPersistence:
    """Defect 001: stream_end destroys frame without persisting message.

    Fixed in Phase 1 (PR #13). Tokens streamed but never appeared as
    chat bubbles because stream_end called destroy() before _add_message().
    """

    def test_stream_end_persists_accumulated_tokens(self, app_instance):
        # Before fix: stream_end destroyed frame, tokens vanished
        # After fix: tokens appear in chat history after stream_end
        app_instance.simulate_stream(["hello", " ", "world"])
        app_instance.simulate_stream_end()
        chat_history = app_instance.get_chat_history()
        assert "helloworld" in chat_history
```

**Rules:**
- One file per defect (`test_defect_NNN_<slug>.py`)
- Class docstring explains the defect, when it was fixed, and the concrete bug behavior
- Behavioral assertions only — no `inspect.getsource()`
- If the test infrastructure is missing, create a minimal mock that proves the fix — don't skip

---

## Cross-Platform Requirements

All tests must pass on Linux, macOS, and Windows unless explicitly gated.

### Skipping tests on specific platforms

```python
import sys
import pytest

@pytest.mark.skipif(sys.platform == "win32", reason="Windows-specific behavior")
def test_windows_only():
    ...

@pytest.mark.skipif(sys.version_info < (3, 10), reason="Requires Python 3.10+")
def test_python_310_feature():
    ...
```

### Path handling

```python
from pathlib import Path
import os

# WRONG — platform-specific
path = "C:\\Users\\test\\file.txt"  # Windows only
path = "/tmp/test"  # Unix only

# RIGHT — portable
path = tmp_path / "test.txt"  # pytest's tmp_path fixture
path = Path(os.environ.get("HOME", ".")) / ".config"  # resolves to user dir

# Use pathlib for path operations — works on all platforms
resolved = Path(path).resolve()  # always use resolve() before comparison
```

### Permissions (`os.chmod`)

```python
import os
import sys

if sys.platform != "win32":
    os.chmod(file_path, 0o000)
    # ... test permission error behavior ...
    os.chmod(file_path, 0o644)  # restore
else:
    pytest.skip(" chmod not meaningful on Windows")
```

### Symlinks

```python
import os

def can_create_symlinks():
    try:
        os.symlink(__file__, tmp_path / ".symlink_test")
        os.unlink(tmp_path / ".symlink_test")
        return True
    except (OSError, NotImplementedError):
        return False

@pytest.mark.skipif(not can_create_symlinks(), reason="requires symlink support")
def test_with_symlink():
    ...
```

### Process spawning

```python
import subprocess
import sys

# Use shell=False always — avoids shell injection and platform differences
result = subprocess.run(
    [sys.executable, "-c", "print('hello')"],
    capture_output=True,
    text=True,
    timeout=10,
)
assert result.returncode == 0
assert "hello" in result.stdout
```

### Timestamps

Avoid comparing strings with embedded `datetime.now()`:
```python
import re

# WRONG — sequential calls can span millisecond boundary
def strip_timestamp(s):
    return s  # no stripping

# RIGHT — normalize volatile parts
def strip_timestamp(s):
    return re.sub(r"at \d{4}-\d{2}-\d{2}T[\d:.]+Z", "at <FROZEN>", s)
```

---

## Running Tests

```bash
# Full suite (all tests)
pytest

# Single file
pytest tests/test_rag_engine.py

# Single class or function
pytest tests/test_rag_engine.py::TestCancellationBackwardCompatible

# By marker
pytest -m "not slow"
pytest -m integration
pytest -m regression

# Stop on first failure
pytest -x

# Only last-failed (rerun failed from last session)
pytest --lf

# Parallel (if pytest-xdist installed)
pytest -n auto

# With verbose output and short traceback
pytest -v --tb=short

# Capture output
pytest --capture=no  # show print statements
pytest -s           # alias for --capture=no
```

---

## Debugging CI Failures

When CI reports a test failure:

1. **Reproduce the exact failure locally first.** Don't assume it's pre-existing:
   ```bash
   pytest tests/test_specific_file.py -x -v --tb=short
   ```
2. **Check if it fails on `master` too.** If yes, it's pre-existing — document in PR.
   ```bash
   git checkout master && pytest tests/test_specific_file.py
   ```
3. **For Windows-only failures:** check `sys.platform == "win32"` guards, `os.chmod` guards, and symlink capability checks.
4. **For slow tests:** use `pytest --durations=10` to find the slowest tests.

---

## Before Submitting

1. Run `pytest tests/test_<your_module>.py -v` for your changed files
2. Run `pytest -m "not slow"` to catch regressions quickly
3. Verify no `inspect.getsource()` was added — it tests structure, not behavior
4. Verify no hardcoded `C:\...` or `/tmp/` paths — use `tmp_path` fixture
5. Verify no permanently skipped tests were added
6. Verify `caplog.clear()` is called before logging assertions
7. Verify no `time.sleep` was added for synchronization
8. Run `pytest --lf` to catch any newly failing tests from your changes
