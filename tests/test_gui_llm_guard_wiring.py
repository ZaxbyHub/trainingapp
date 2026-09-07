"""
Direct coverage for the two issue-#53 review-round-1 GUI fixes (PR #92).

1. ``_load_settings`` must honor ``RAG_FAST_PROFILE_PATH`` from the
   environment so the fast-profile fallback advised in RAM-gate errors is
   actionable on the desktop entry point (engine_factory reads this key).
2. The chat worker must route a failed LLM init through ``_classify_error``
   inside a ``message_queue.put`` payload — never a direct tkinter call from
   the worker thread.
"""

import inspect
import os
import re


def test_load_settings_honors_rag_fast_profile_path_env(tmp_path):
    from unittest.mock import patch

    from app_gui import DocumentQAApp

    app = DocumentQAApp.__new__(DocumentQAApp)
    env_value = str(tmp_path / "fast.gguf")
    with patch.object(
        DocumentQAApp,
        "_get_settings_path",
        return_value=str(tmp_path / "settings.json"),
    ), patch.dict(os.environ, {"RAG_FAST_PROFILE_PATH": env_value}):
        settings = app._load_settings()

    assert settings.get("fast_profile_path") == env_value, (
        "RAG_FAST_PROFILE_PATH must be injected into default_settings so the "
        "desktop entry point can reach the fast-profile fallback"
    )


def test_load_settings_without_env_has_no_fast_profile_key(tmp_path):
    from unittest.mock import patch

    from app_gui import DocumentQAApp

    app = DocumentQAApp.__new__(DocumentQAApp)
    clean_env = {k: v for k, v in os.environ.items() if k != "RAG_FAST_PROFILE_PATH"}
    with patch.object(
        DocumentQAApp,
        "_get_settings_path",
        return_value=str(tmp_path / "settings.json"),
    ), patch.dict(os.environ, clean_env, clear=True):
        settings = app._load_settings()

    assert "fast_profile_path" not in settings


def test_chat_worker_routes_no_llm_error_through_classifier():
    """The llm=None guard must classify the real diagnostic and queue it.

    The guard reads ``llm_init_error`` (issue #53's diagnostic relay), builds
    the error, routes it through ``_classify_error(err, "query")``, and hands
    the result to ``message_queue.put`` — the worker thread never touches
    tkinter directly.
    """
    from app_gui import DocumentQAApp

    source = inspect.getsource(DocumentQAApp._ask_question)

    assert (
        "llm_init_error" in source
    ), "chat worker must surface the real load diagnostic (llm_init_error)"
    assert re.search(r"message_queue\.put\([^)]*_classify_error\(", source), (
        "the classified error must be queued via message_queue.put (worker "
        "threads must not call tkinter directly)"
    )
