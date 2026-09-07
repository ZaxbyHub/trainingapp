"""Real-engine coverage for the /ask + /ask/stream lazy-LLM branch (issue #54).

The other API tests patch api_server.engine with MagicMocks, which auto-create
`_ensure_llm` — so the new lazy-load branch was never exercised against a real
RAGEngine. This module drives /ask and /ask/stream with a REAL engine whose
llm is None and gguf_path is None: the lazy load must actually run inside the
request, fail with "No GGUF backend available", record llm_init_error, and
surface that diagnostic in the 503 detail (no model weights required).
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import api_server
from api_server import app
from rag_engine import RAGConfig, RAGEngine

pytestmark = pytest.mark.unit

client = TestClient(app)


@pytest.fixture
def bypass_auth():
    """Bypass authentication so the 503 assertions observe a 503, not a 401.

    Pre-existing auth tests elsewhere in the suite can leave auth enabled."""
    import auth

    with patch.object(auth, "authenticate", return_value={"sub": "test"}):
        yield


@pytest.fixture
def real_engine_without_llm(tmp_path):
    """A real RAGEngine (real __init__, real _init_lock) with no LLM and no
    usable GGUF path: _ensure_llm inside /ask must attempt the load, fail,
    and record the diagnostic."""
    db_path = tmp_path / "lazy_ask_db"
    db_path.mkdir()

    with patch("rag_engine.VectorStore") as mock_vs, patch(
        "rag_engine.DocumentProcessor"
    ) as mock_doc:
        mock_vs.return_value = MagicMock()
        mock_doc.return_value = MagicMock()
        engine = RAGEngine(
            config=RAGConfig(db_path=str(db_path)),
            gguf_path=None,
        )

    assert engine.llm is None, "engine must start with no LLM loaded"
    return engine


def test_ask_lazy_load_records_diagnostic_and_503s(
    real_engine_without_llm, bypass_auth
):
    engine = real_engine_without_llm
    with patch.object(api_server, "engine", engine):
        response = client.post("/ask", json={"question": "lazy load test"})

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "No GGUF backend available" in detail, (
        "the 503 detail must carry the diagnostic the lazy load recorded, "
        f"got: {detail!r}"
    )
    assert engine.llm is None
    assert (
        engine.llm_init_error is not None
    ), "the lazy-load branch must have run and recorded llm_init_error"
    assert "No GGUF backend available" in engine.llm_init_error


def test_ask_stream_lazy_load_records_diagnostic_and_503s(
    real_engine_without_llm, bypass_auth
):
    engine = real_engine_without_llm
    with patch.object(api_server, "engine", engine):
        response = client.post("/ask/stream", json={"question": "lazy stream"})

    assert response.status_code == 503
    assert "No GGUF backend available" in response.json()["detail"]
    assert engine.llm_init_error is not None


def test_second_ask_reports_recorded_diagnostic_without_reload(
    real_engine_without_llm, bypass_auth
):
    """The second request must 503 with the SAME recorded diagnostic; the
    double-checked lock means the failed init is not silently re-run into a
    different error path."""
    engine = real_engine_without_llm
    with patch.object(api_server, "engine", engine):
        first = client.post("/ask", json={"question": "first"})
        error_after_first = engine.llm_init_error
        second = client.post("/ask", json={"question": "second"})

    assert first.status_code == 503
    assert second.status_code == 503
    assert error_after_first is not None
    assert "No GGUF backend available" in second.json()["detail"]
