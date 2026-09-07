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

    The assertion is scoped to the ``if not self.engine.llm:`` branch itself:
    the generic except handler also calls message_queue.put with a classified
    error, which would otherwise satisfy the check even if this branch
    regressed to a direct tkinter call.
    """
    from app_gui import DocumentQAApp

    source = inspect.getsource(DocumentQAApp._ask_question)
    lines = source.split("\n")

    branch_start = -1
    for i, line in enumerate(lines):
        if "if not self.engine.llm" in line:
            branch_start = i
            break
    assert branch_start >= 0, "query() must guard on `if not self.engine.llm`"
    branch_end = len(lines)
    for i in range(branch_start, len(lines)):
        if re.match(r"\s*return\b", lines[i]):
            branch_end = i + 1
            break
    branch = "\n".join(lines[branch_start:branch_end])

    assert "llm_init_error" in branch, (
        "the no-LLM branch must surface the real load diagnostic "
        "(llm_init_error), not a generic message"
    )
    assert re.search(r"message_queue\.put\([^)]*_classify_error\(", branch), (
        "the classified error must be queued via message_queue.put inside the "
        "no-LLM branch (worker threads must not call tkinter directly)"
    )
