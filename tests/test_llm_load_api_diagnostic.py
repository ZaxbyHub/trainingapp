"""
Acceptance checks for issue #53 (AC6): the API's 503 responses for /ask and
/ask/stream must include the engine's llm_init_error diagnostic (RAM numbers)
when no LLM could be loaded, instead of the bare "No LLM backend available".

DISCRIMINATING check: at base both endpoints return
detail == "No LLM backend available" and ignore engine.llm_init_error, so
the RAM-number assertions fail with that string visible in the log.

Harness mirrors tests/test_api.py: module-level TestClient, per-test patch of
api_server.engine. All engine interaction is mocked; nothing loads a model.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import api_server
from api_server import app

# Mark all tests in this module as unit tests
pytestmark = pytest.mark.unit

# Create a test client
client = TestClient(app)


def _patch_engine(mock_engine):
    """Patch engine on the EXACT module object that owns this file's app.

    Other test modules (test_auth) evict api_server from sys.modules and
    re-import it; a string target like patch("api_server.engine", ...) would
    then patch the NEW module while this file's app endpoints still read the
    ORIGINAL module's global. patch.object pins the module identity.
    """
    return patch.object(api_server, "engine", mock_engine)


RAM_DIAGNOSTIC = (
    "Insufficient RAM to load GGUF model: need ~5.2GB, but only 4.0GB available"
)


def _engine_without_llm() -> MagicMock:
    mock_engine = MagicMock()
    mock_engine.llm = None
    mock_engine.llm_init_error = RAM_DIAGNOSTIC
    return mock_engine


@pytest.fixture
def bypass_auth():
    """Bypass authentication so this check is order-independent.

    Pre-existing auth tests elsewhere in the suite can leave auth enabled;
    without this override the 503 assertions would observe a 401 instead.
    """
    from auth import authenticate

    app.dependency_overrides[authenticate] = lambda: {
        "authenticated": True,
        "method": "test",
    }
    yield
    if authenticate in app.dependency_overrides:
        del app.dependency_overrides[authenticate]


class TestAskNoLlmDiagnostic:
    """503 detail for /ask and /ask/stream must carry the RAM diagnostic."""

    def test_ask_503_detail_includes_ram_diagnostic(self, bypass_auth):
        """POST /ask with engine.llm None -> 503 detail includes RAM numbers."""
        with _patch_engine(_engine_without_llm()):
            response = client.post("/ask", json={"question": "q"})

        assert response.status_code == 503
        detail = response.json()["detail"]
        assert "5.2GB" in detail, (
            f"/ask 503 detail must include the required-RAM figure from "
            f"engine.llm_init_error; got detail: {detail!r}"
        )
        assert "4.0GB" in detail, (
            f"/ask 503 detail must include the available-RAM figure from "
            f"engine.llm_init_error; got detail: {detail!r}"
        )

    def test_ask_stream_503_detail_includes_ram_diagnostic(self, bypass_auth):
        """POST /ask/stream with engine.llm None -> 503 detail includes RAM numbers."""
        if not any(
            getattr(route, "path", None) == "/ask/stream" for route in app.routes
        ):
            pytest.skip("/ask/stream route not registered (no sse-starlette)")
        with _patch_engine(_engine_without_llm()):
            response = client.post("/ask/stream", json={"question": "q"})

        assert response.status_code == 503
        detail = response.json()["detail"]
        assert "5.2GB" in detail, (
            f"/ask/stream 503 detail must include the required-RAM figure "
            f"from engine.llm_init_error; got detail: {detail!r}"
        )
        assert "4.0GB" in detail, (
            f"/ask/stream 503 detail must include the available-RAM figure "
            f"from engine.llm_init_error; got detail: {detail!r}"
        )
